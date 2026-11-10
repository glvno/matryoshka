import { chainedHarmonizer, keyFeed, keyReach, keyRouteError } from './key-routing';
// SPDX-License-Identifier: GPL-3.0-only
// Block-based patch engine. Pure TypeScript with no DOM or Web Audio dependency, so it runs in
// an AudioWorklet, in tests, and (as the reference) next to the firmware port.
//
// Polyphony: a poly assembly (poly.ts) runs its member modules once per voice of the Voice allocator that feeds it, each
// copy (instance) with its own state, buffers and effective parameters. The engine runs the patch's device form
// (poly.ts deviceView): each allocator is a Part module in every group it drives, and each group allocates the notes. Everything else runs once and plays the shared keyboard (the Main module's pitch / gate / vel: one note, the last
// held). A module reading another group's per-part output gets the sum over those parts; a per-part module reading a
// shared output gets that one buffer.

import { CLICK_ACCENT_HZ, CLICK_HZ, CLICK_MS, clickSample, ONCE_BAR, type DrumMapState, dropRows, stepsGo, stepsTurnAt, stepsPattern, type StepsSong, driftSeed, ENVELOPE_TYPES, flawQ16, IMPLS, instSeed, PANEL_BUTTONS, type StepsState, TEMPO_MAX, TEMPO_MIN, voicingSetting, walkHold, walkInit, walkStep, type Ctx, type ModuleImpl, type Voice, type Walk } from './modules';
import { defaultMap, FLAW_TARGETS, flawOf, MAX_PARTS, modulate, type ParamDef, type PartFlaw, morphValue, paramValue, processingOrder, rangeShare, SOURCES, type Cable, type Patch, type PolyCfg, type Range, type Source, takesKey, thruInput } from './patch';
import { ALLOC, deviceView, keysInto, VOICING_CABLE_INPUTS } from './poly';
import { armView, type DeviceKey } from './arm';
import { kindOf, switches, toggleTargets } from './buttons';
import { fixNotes, PATTERNS_MAX, SONGS_MAX, type SongEntry, type StepNote } from './track';
import { lockPlan, lockValue } from './locks';
import { arpBlock, arpClear, arpInit, arpKeyOff, arpKeyOn, type ArpParams, type ArpState, PPQN } from './arpeggiator';
import { harmButton, harmButtonOf, harmChord, harmSnapshot, harmClear, harmInit, harmKey, type HarmParams, type HarmState } from './harmonizer';
import './device-shown';   // (what the FM-1 shows, for the device compile pass)

export const BLOCK = 128;

/**
 * A paraphonic group's mix (#125): a poly group whose parts do not gate their own sound (no cable from its Part's gate or
 * legato output to a module inside the group: the gate goes only to modules that run once, say one shared envelope) has
 * every part sounding all the time, played or not, so its audio summed into a module outside the group grew with the
 * voice count. Such a sum weighs each part by 1 / parts (Q16, as engine.c para_w), a fixed mixer: the level no longer
 * depends on the voices. A group that gates its parts is left alone (an unplayed part is silent, so one note sounds the
 * same at any voice count). Control and gate outputs are not weighed.
 */
function paraMix(nodes: Node[]): void {
  const gated = new Set<number>();
  for (const to of nodes)
    for (const s of to.sources)
      if (s.from.type === 'part' && s.from.group >= 0 && s.from.group === to.group && (s.fromPort === 'gate' || s.fromPort === 'legato')) gated.add(to.group);
  for (const to of nodes)
    for (const s of to.sources) {
      const g = s.from.group, parts = s.from.inst.length;
      const audio = s.from.impl.def.outputs.find((o) => o.name === s.fromPort)?.kind === 'audio';
      s.w = g >= 0 && g !== to.group && parts > 1 && audio && !gated.has(g) ? Math.round(65536 / parts) / 65536 : 1;
    }
}

/** A display snapshot, detached from the patch and the audio thread's mutable state. */
export type ParameterValues = { id: number; params: Record<string, number> }[];

/** what the tracks play (Engine.patternView): the selected pattern, the song (0 none), per track the pattern playing, the
 * queued one (-1 none) and the song entry (-1 none yet) */
export interface PatternView { pattern: number; song: number; tracks: { id: number; pat: number; queued: number; entry: number }[] }

/** one running copy of a module: one per part inside a poly assembly, else one */
interface Inst {
  /** instSeed of the module index and part: the Random module's seed, the same as the firmware's */
  seed: number;
  state: unknown;
  /** params after modulation, what the module reads */
  eff: Record<string, number>;
  /** Overrides captured by DSP for dedicated CV inputs, after the parameter matrix. */
  display: Record<string, number>;
  inp: Record<string, Float32Array>;
  /** Native DSP inputs: aliases of the raw buffers (kept apart from `inp` for the per-block parameter routes). */
  dspInp: Record<string, Float32Array>;
  out: Record<string, Float32Array>;
}

interface Node {
  id: number;
  type: string;
  impl: ModuleImpl;
  params: Record<string, number>;
  att: [number, number];
  map: Record<Source, string[]>;
  connected: Record<string, boolean>;
  /** its outputs something reads: a cable from it, or a probe / watch (probe marks it, so it is written from the next block) */
  used: Record<string, boolean>;
  inputRoutes: { port: string; params: string[]; mean: number }[];
  /** w: the weight a summed source adds with (paraMix), else 1 */
  sources: { port: string; from: Node; fromPort: string; w: number }[];
  /** the poly group it runs in (index in Engine.groups), -1: runs once */
  group: number;
  /** bypassed: run() copies `thru` (or silence) to the outputs instead of processing */
  bypass: boolean;
  thru: string | undefined;
  /** the B side of the morph (patch.ts paramsB), null without one */
  paramsB: Record<string, number> | null;
  /** macro ranges per pin (patch.ts ModuleInst.range) */
  range: [Record<string, Range>, Record<string, Range>];
  inst: Inst[];
  /** the parameters the part flaws move (FLAW_TARGETS), with their definitions */
  flawParams: { key: 'bright' | 'env' | 'level'; pd: ParamDef }[];
  /** the P-locks on it now (#524): per parameter the value a track's step locks it to, in place of `params` (null: none) */
  lock: Record<string, number> | null;
}

/** a Steps track's P-locks as it plays them (locks.ts lockPlan): per locked row the parameters it sets, per pattern its
 * locks, and the pattern and step it applied last (-2: apply again) */
interface LockRun {
  rows: { node: Node; pd: ParamDef }[][];
  pats: Map<number, { at: number; row: number; value: number }[]>;
  key: number;
}

/** a part: what its Part module outputs plus what the allocator needs */
interface VoiceState extends Voice {
  note: number;
  /** a key holds it (gate up) */
  on: boolean;
  onStamp: number;
  offStamp: number;
  /** the part was taken over while sounding: this block's gate starts with one low sample so envelopes restart */
  retrig: boolean;
  /** released and silent (partQuiet): its modules are skipped; skip: this block */
  idle?: boolean;
  skip?: boolean;
  /** the drift's random walk (driftSeed), stepped every block */
  walk: Walk;
}

/** an allocator and its parts: a poly assembly's, or the shared keyboard (one part, legato auto, last note) */
interface Group {
  /** the poly assembly's id and part count: a reload keeps the group (its notes) while these stay */
  key: string;
  cfg: PolyCfg;
  parts: VoiceState[];
  /** the held keys, oldest first (one part: the sounding key is chosen among them) */
  held: { note: number; vel: number }[];
  /** rotate: the part the next note tries first */
  rot: number;
  /** all held input keys, including keys whose voices were stolen or refused */
  down: number[];
  /** where its notes come from: -1 the keys (Main), else the id of the Arpeggiator or Steps module that feeds its allocator */
  src: number;
  /** its Voicing's assign and unison (0 off, 1 on, 2 share) as the patch sets them; cfg holds them as they play, moved by
   * `cv`, what the cables into its Part's assign and unison inputs carried at the end of the last block (#681) */
  base: [number, number];
  cv: [number, number];
}
/** a group's unison setting as one number: 0 off, 1 on, 2 share (engine.c grp_t unison) */
const unisonOf = (cfg: PolyCfg): number => (cfg.unisonShare ? 2 : cfg.unison ? 1 : 0);

/** an Arpeggiator module as it runs: its note logic (arpeggiator.ts) and the groups it plays. `feed`: the Steps track
 * cabled into its keys in (its id: it plays that track's notes, not Main's keys), -1 Main's keys. Bypassed it hands the
 * keys it hears straight on (`byp`: the bypass it last ran with; a change lets go of what it played: arpSwitched) */
interface ArpRun {
  node: Node;
  st: ArpState;
  clk: { hi: boolean };
  feed: number;
  byp: boolean;
}

/** a Harmonizer module as it runs (#598): its note logic (harmonizer.ts) and the groups it plays (DeviceGroup.src). It
 * hears Main's keys; bypassed it hands them straight on (`byp`: the bypass it last ran with; a change lets go of what it
 * played: harmSwitched) */
interface HarmRun {
  feed: number;
  node: Node;
  st: HarmState;
  byp: boolean;
}

/** idle parts (Engine.partQuiet): an output within this counts as silent (6 in Q16, engine.c IDLE_Q16); every IDLE_CHECK-th
 * block an idle part runs and is checked again, part v of group g in the blocks where (idleBlk + g MAX_PARTS + v) % IDLE_CHECK
 * is 0 (staggered, #434: parts that went idle together do not all run in one block) */
const IDLE = 6 / 65536;
const IDLE_CHECK = 32;

const newVoice = (index: number, parts: number, seed: number): VoiceState => ({
  pitch: 0, gate: 0, velocity: 0, keyTrig: false, low: false, high: false, unison: false, clock: false, run: false, tick: -1, ticks: 0, tickLen: 0, buttons: 0, bend: 0, mod: 0, at: 0, breath: 0, sustain: 0, foot: 0, index, parts, legato: 0, jump: 0, flaw: 0,
  note: -1, on: false, onStamp: 0, offStamp: 0, retrig: false, walk: walkInit(seed),
});
const KEYBOARD: PolyCfg = { parts: 1, assign: 0, legato: 0, priority: 0 };
/** g: the poly group's index (its parts' drift seeds), -1 for the shared keyboard */
const newGroup = (key: string, cfg: PolyCfg, g: number): Group => ({
  key, cfg: { ...cfg }, parts: Array.from({ length: cfg.parts }, (_, i) => newVoice(i, cfg.parts, driftSeed(g + 1, i))), held: [], rot: 0, down: [0, 0, 0, 0], src: -1,
  base: [cfg.assign, unisonOf(cfg)], cv: [0, 0],
});
/** the tempo without a Main module */
const TEMPO_DEFAULT = 120;
/** how often a part's drift picks a new target (Hz) */
export const DRIFT_RATE = 0.5;
const FLAW_KEYS3 = Object.keys(FLAW_TARGETS) as ('bright' | 'env' | 'level')[];

export class Engine {
  private nodes = new Map<number, Node>();
  private order: Node[] = [];
  private outputs: Node[] = [];
  /** the shared keyboard (the Main module, Part modules outside poly assemblies) */
  private kb: Group = newGroup('kb', KEYBOARD, -1);
  /** the poly assemblies' allocators, in polyGroups order */
  private groups: Group[] = [];
  /** the Part modules a cable moves the assign or unison of (#681), in group order (voicingCables) */
  private modeParts: Node[] = [];
  private stamp = 0;
  /** the patch as loaded (an allocator's setting changes the groups: setParam reloads it) */
  private src: Patch | null = null;
  private compiled = false;
  /** the clock: 24 ppqn ticks so far (from the Main module's tempo, or MIDI clock while it comes in), the internal
   * clock's remainder (in 1 / (60 sr) of a tick), MIDI clock ticks not yet counted, and the transport */
  private ticks = 0;
  /** blocks mod IDLE_CHECK (never reset, engine.c idle_blk): which idle parts run their check */
  private idleBlk = 0;
  private tickAcc = 0;
  private extTicks = 0;
  private ext = false;
  /** the global tempo (D-907, tempo.ts; engine.c tempo_glo): every patch plays at it while set, null: the Main module's */
  tempoGlobal: number | null = null;
  /** MIDI clock: samples since its last tick, and per tick as last measured (0: not yet) */
  private extSince = 0;
  private extLen = 0;
  private running = false;
  /** play once (#632, playOnce): 0 not, 1 counting in, 2 playing; ticks counted into the count-in, its first block to
   * come (beat 1's click on its first sample); the click sounding: its sample (-1 none) and half period in samples */
  private once = 0;
  private cin = 0;
  private cinFirst = false;
  private clickK = -1;
  private clickHalf = 1;
  /** the click of this render (both count-ins), added after the patch is held to full scale (engine.c eng_click_mix: on
   * the FM-1 the analog output's only, D-820; the browser has the one output) */
  private clickBuf = new Float32Array(0);
  /** REC's count-in click (D-803, countIn; engine.c eng_count_in): the request (the ticks then, the bars), taken once the
   * transport runs; then the bar it starts on and the one it ends on, in ticks from the transport's start */
  private cinReq: { at: number; bars: number } | null = null;
  private cinOn = false;
  private cinFrom = 0;
  private cinEnd = 0;
  /** the transport as the last block had it, and the ticks when it last started (engine.c E.run_ticks) */
  private ran = false;
  private runTicks = 0;
  /** the FM-1's patch buttons (bit i = PANEL_BUTTONS[i]): held, or switched on */
  private buttons = 0;
  /** per patch button: the modules a Toggle bypasses (buttons.ts toggleTargets), null for the other kinds; and whether it switches */
  private btnTargets: (number[] | null)[] = [];
  private btnSwitch: boolean[] = [];
  private arps: ArpRun[] = [];
  private harms: HarmRun[] = [];
  private harmById = new Map<number, HarmRun>();
  /** while anything is armed, the Harmonizers that hear Main's keys (a keys cable from Main into theirs); null: all */
  private harmHears: Set<number> | null = null;
  /** the performance controls (pitch bend -1..1, mod wheel 0..1, channel aftertouch 0..1): one set, every part sees it */
  private ctl = { bend: 0, mod: 0, at: 0, breath: 0, sustain: 0, foot: 0 };
  /** the Main module, and the morph position of the current block (its morph parameter plus the block mean of its morph input, one block late) */
  private main: Node | null = null;
  private morphT = 0;
  private hasB = false;

  constructor(readonly sampleRate: number) {}

  /** the part count of the first poly assembly (1 without one), for tests and displays */
  get nvoices(): number {
    return this.groups[0]?.parts.length ?? 1;
  }

  /** the shared keyboard's note (what the Main module plays) */
  get voice(): Voice {
    return this.kb.parts[0];
  }

  /** the notes the first poly assembly's parts hold (the shared keyboard without one): -1 = none, gate up or down */
  voiceNotes(): { note: number; on: boolean }[] {
    return (this.groups[0] ?? this.kb).parts.map((v) => ({ note: v.note, on: v.on }));
  }

  private newInst(impl: ModuleImpl, seed: number): Inst {
    const state = impl.init(this.sampleRate);
    impl.seed?.(state, seed);
    return {
      seed,
      state,
      eff: {},
      display: {},
      dspInp: {},
      inp: Object.fromEntries(impl.def.inputs.map((p) => [p.name, new Float32Array(BLOCK)])),
      out: Object.fromEntries(impl.def.outputs.map((p) => [p.name, new Float32Array(BLOCK)])),
    };
  }

  /** Install a patch. Modules whose id, type and copy count are unchanged keep their running state; so do poly groups. */
  /** `compile`: run the device compile pass first (device-compile.ts: what the FM-1 runs; the editor keeps every module running, unplugged ones show their live values too) */
  load(source: Patch, compile = false): void {
    const routingError = keyRouteError(source);
    if (routingError) throw new Error(routingError);
    this.src = source;
    this.compiled = compile;
    source = armView(source, this.armedKeys); // the armed devices hear Main's keys, the others not (#190); unchanged while none is
    this.keyPatch = source;
    const { patch, groups: pg } = deviceView(source, compile);
    const oldGroups = new Map(this.groups.map((g) => [g.key, g]));
    const groupOf = new Map<number, number>();
    pg.forEach((x, i) => x.modules.forEach((id) => groupOf.set(id, i)));
    // the groups whose Part has a cable into its assign or unison input (#681): they keep what it carried
    const typeOf = new Map(patch.modules.map((m) => [m.id, m.type]));
    const cabled = new Set(patch.cables.filter((c) => typeOf.get(c.to.module) === 'part' && VOICING_CABLE_INPUTS.includes(c.to.port)).map((c) => groupOf.get(c.to.module) ?? -1));
    this.groups = pg.map((x, i) => {
      const old = oldGroups.get(x.key);
      const g = old ?? newGroup(x.key, x.cfg, i);
      const was = { ...g.cfg };
      g.cfg = { ...x.cfg };
      g.base = [x.cfg.assign, unisonOf(x.cfg)];
      if (!cabled.has(i)) g.cv = [0, 0];
      this.voicingSet(g);
      // a change of unison mode regroups the parts (unisonSwitch); a new unison count while in unison takes the held keys again
      if (old && unisonOf(was) !== unisonOf(g.cfg)) this.unisonSwitch(g, unisonOf(was));
      else if (old && g.cfg.unison && was.unisonParts !== g.cfg.unisonParts) this.monoUpdate(g);
      g.src = x.src ?? -1;
      for (const v of g.parts) v.idle = false; // the patch changed: every part runs and is judged again
      return g;
    });
    const next = new Map<number, Node>();
    const mainSeq = source.modules.find((m) => m.type === 'fm1')?.seq;
    this.song.song = mainSeq?.song ?? 0;
    this.song.songs = (mainSeq?.songs ?? []).map((x) => x.map((e) => ({ ...e })));
    this.pattern = mainSeq?.pattern ?? 0;
    for (const [mi, m] of patch.modules.entries()) {
      const impl = IMPLS[m.type];
      if (!impl) throw new Error(`unknown module type "${m.type}"`);
      const group = groupOf.get(m.id) ?? -1;
      const ninst = group >= 0 ? this.groups[group].parts.length : 1;
      const old = this.nodes.get(m.id);
      const keep = old && old.type === m.type && old.inst.length === ninst;
      const node: Node = keep
        ? old!
        : {
            id: m.id,
            type: m.type,
            impl,
            params: {},
            att: [1, 1],
            map: defaultMap(impl.def),
            connected: {},
            used: {},
            inputRoutes: [],
            sources: [],
            group,
            bypass: false,
            thru: thruInput(impl.def),
            paramsB: null,
            range: [{}, {}],
            inst: Array.from({ length: ninst }, (_, v) => this.newInst(impl, instSeed(mi, v))),
            flawParams: FLAW_KEYS3.flatMap((key) => (FLAW_TARGETS[key][m.type] ?? []).map((name) => ({ key, pd: impl.def.params.find((q) => q.name === name)! }))),
            lock: null,
          };
      node.lock = null;
      node.group = group;
      node.params = { ...m.params };
      node.att = m.att ? [m.att[0], m.att[1]] : [1, 1];
      node.map = Object.fromEntries(SOURCES.map((s) => [s, [...(m.map?.[s] ?? [])]])) as Record<Source, string[]>;
      node.bypass = !!m.bypass;
      node.paramsB = m.paramsB && m.type !== 'fm1' ? { ...m.paramsB } : null;
      node.range = [{ ...(m.range?.p1 ?? {}) }, { ...(m.range?.p2 ?? {}) }];
      node.inputRoutes = Object.entries(m.inputMap ?? {}).map(([port, params]) => ({ port, params: [...params], mean: 0 }));
      for (const inst of node.inst) inst.dspInp = { ...inst.inp };
      if (m.type === 'steps')
        for (const inst of node.inst) {
          const st = inst.state as StepsState;
          st.pats = [{ notes: (m.notes ?? []).map((n) => ({ ...n })) }, ...(m.patterns ?? []).map((x) => (x ? { ...x, notes: (x.notes ?? []).map((n) => ({ ...n })) } : null))];
          st.song = this.song;
          if (!keep) {
            st.pat = Math.min(PATTERNS_MAX - 1, Math.max(0, mainSeq?.pattern ?? 0));
            st.songPos = -1;
          }
          stepsGo(st, st.pat);
        }
      node.sources = [];
      node.connected = {};
      node.used = {};
      next.set(m.id, node);
    }
    for (const c of patch.cables) {
      const to = next.get(c.to.module)!;
      const from = next.get(c.from.module)!;
      to.sources.push({ port: c.to.port, from, fromPort: c.from.port, w: 1 });
      to.connected[c.to.port] = true;
      from.used[c.from.port] = true;
    }
    this.nodes = next;
    paraMix([...next.values()]);
    const { order } = processingOrder(patch);
    this.order = order.map((id) => next.get(id)!);
    this.outputs = this.order.filter((n) => n.type === 'output');
    this.modeParts = this.order.filter((n) => n.type === 'part' && n.group >= 0 && VOICING_CABLE_INPUTS.some((port) => n.connected[port])).sort((a, b) => a.group - b.group);
    this.main = this.order.find((n) => n.type === 'fm1') ?? null;
    this.hasB = this.order.some((n) => n.paramsB);
    const mainInst = patch.modules.find((m) => m.type === 'fm1');   // the switched-on buttons the patch was saved with
    this.buttons = PANEL_BUTTONS.reduce((mask, b, i) => (mainInst?.panel?.on?.includes(b) && mainInst.panel.toggle?.includes(b) ? mask | (1 << i) : mask), 0);
    const srcPanel = source.modules.find((m) => m.type === 'fm1')?.panel;
    this.btnTargets = PANEL_BUTTONS.map((b) => (kindOf(srcPanel, b) === 'bypass' ? toggleTargets(source, b).filter((id) => next.has(id)) : null));
    this.btnSwitch = PANEL_BUTTONS.map((b) => switches(srcPanel, b));
    this.syncToggles();
    const oldArps = new Map(this.arps.map((a) => [a.node.id, a]));
    this.arps = this.order.filter((n) => n.type === 'arp').map((node) => {
      const old = oldArps.get(node.id);
      const fed = keyFeed(source, node);
      const feed = fed ? fed.type === 'fm1' ? -1 : fed.id : -2;
      return old ? { ...old, node, feed } : { node, st: arpInit(), clk: { hi: false }, feed, byp: node.bypass };
    });
    // while anything is armed an Arpeggiator hears Main's keys only through a keys cable from Main (an armed device's)
    const mainKeysTo = keyReach(source, source.modules.find(m => m.type === 'fm1')?.id ?? -1);
    this.arpHears = this.armedKeys.length ? new Set(this.arps.filter((a) => mainKeysTo.has(a.node.id)).map((a) => a.node.id)) : null;
    this.arpById = new Map(this.arps.map((a) => [a.node.id, a]));
    const oldHarms = new Map(this.harms.map((h) => [h.node.id, h]));
    this.harms = this.order.filter((n) => n.type === 'harm').map((node) => {
      const old = oldHarms.get(node.id);
      const from = keyFeed(source, node);
      const feed = from ? from.type === 'fm1' ? -1 : from.id : -2;
      return old ? { ...old, node, feed } : { node, feed, st: harmInit(), byp: node.bypass };
    });
    this.harmHears = this.armedKeys.length ? new Set(this.harms.filter((h) => mainKeysTo.has(h.node.id)).map((h) => h.node.id)) : null;
    this.harmById = new Map(this.harms.map((h) => [h.node.id, h]));
    this.tracks = this.order.filter((n) => n.type === 'steps');
    for (const t of this.tracks) (t.inst[0].state as StepsState).coalesce = chainedHarmonizer(source);
    for (const id of this.thruHeld.keys()) if (!this.tracks.some(n => n.id === id)) this.thruHeld.delete(id);
    this.lockRuns = new Map(lockPlan(source, patch).map((t) => [
      next.get(patch.modules[t.track].id)!,
      {
        rows: t.rows.map((r) => r.map(([i, j]) => { const node = next.get(patch.modules[i].id)!; return { node, pd: node.impl.def.params[j] }; })),
        pats: new Map(t.pats.map((x) => [x.p, x.locks])),
        key: -2,
      },
    ]));
    // tracks whose keys in a cable from Main's keys feeds: those keys pass through them while no track is armed (#138)
    this.maps = this.order.filter((n) => n.type === 'drummap').flatMap((node) => {
      const m = source.modules.find((x) => x.id === node.id);
      const from = m && keysInto(source, m);
      return from ? [{ st: node.inst[0].state as DrumMapState, src: from.type === 'fm1' ? -1 : from.id }] : [];
    });
    // a track that plays a Drum map (directly or through the Arpeggiator it feeds) is never shifted by a song (engine.c
    // eng_steps_drummap)
    for (const node of this.tracks)
      (node.inst[0].state as StepsState).drum = this.maps.some(x => keyReach(source, node.id).has(x.src));
    for (const a of this.arps) if (a.byp !== a.node.bypass) this.arpSwitched(a); // (an edit switched it while the patch reloaded)
    for (const h of this.harms) if (h.byp !== h.node.bypass) this.harmSwitched(h);
  }

  /** the Harmonizers that hear Main's keys: all while nothing is armed, else the armed devices' */
  private keyHarms = (): HarmRun[] => this.harms.filter((h) => this.effSrc(h.feed) < 0 && this.effSrc(h.feed) !== -2 && (!this.harmHears || this.harmHears.has(h.node.id)));
  /** a bypassed Harmonizer that hears Main's keys: its groups play the keys straight, as Main's own */
  private harmPasses = (src: number): boolean => {
    const h = this.harmById.get(src);
    return !!h && h.node.bypass && this.keyHarms().includes(h);
  };
  private harmParams(h: HarmRun): HarmParams {
    const p = h.node.params;
    return { type: p.type ?? 0, sus: p.sus ?? 0, ext: p.ext ?? 0, voicing: p.voicing ?? 0, lock: p.lock ?? 0, split: p.split ?? 60 };
  }
  private thruHeld = new Map<number, Set<number>>();
  private thruRoom(need: number): boolean {
    const queued = this.tracks.reduce((n, t) => n + (t.inst[0].state as StepsState).thru.length / 2, 0);
    const reserved = [...this.thruHeld.values()].reduce((n, held) => n + held.size, 0);
    return queued + reserved + need <= 128;
  }
  private harmRoom(h: HarmRun, notes: number[]): boolean {
    let need = 0;
    for (const t of this.tracks) if (this.src && keyFeed(this.src, t)?.id === h.node.id)
      for (const n of notes) if (!h.st.count[n]) need += this.thruHeld.get(t.id)?.has(n) ? 1 : 2;
    return this.thruRoom(need);
  }
  /** a Harmonizer's note into its groups (an arpeggiator's way: their key range judges it) */
  private harmOn(h: HarmRun, note: number, vel: number): void {
    this.processorKeys(h.node.id, note, vel);
    this.mapKeys(h.node.id, note | 128, Math.round(vel * 127));
    for (const g of this.groups) if (this.effSrc(g.src) === h.node.id && takesKey(g.cfg, note)) this.groupOn(g, note, vel);
  }
  private harmOff(h: HarmRun, note: number): void {
    this.processorKeys(h.node.id, note, 0);
    this.mapKeys(h.node.id, note, 0);
    for (const g of this.groups) if (this.effSrc(g.src) === h.node.id) this.groupOff(g, note);
  }
  /** a Harmonizer's groups let go of every note (its roots too; its buttons and latch stay) */
  private harmDrop(h: HarmRun): void {
    for (const r of [...h.st.roots]) harmKey(h.st, r.key, false, this.harmParams(h), false, () => {}, n => this.harmOff(h, n), notes => this.harmRoom(h, notes));
    h.st.roots = [];
    h.st.count.fill(0);
    for (const g of this.groups) {
      if (g.src !== h.node.id) continue;
      g.held = [];
      g.down.fill(0);
      for (const x of g.parts) {
        x.on = false;
        x.gate = 0;
        x.retrig = false;
        x.keyTrig = false;
      }
    }
  }
  /** a Harmonizer was switched (bypassed, or back): what it played lets go */
  private harmSwitched(h: HarmRun): void {
    h.byp = h.node.bypass;
    this.harmDrop(h);
  }

  /**
   * A chord button of the Harmonizers that hear Main's keys pressed or let go (#598; b: harmonizer.ts HARM_BUTTONS): the
   * FM-1's seven lowest keys while the keys reach one (engine.c eng_chord_button). The keys under a Harmonizer's split do
   * the same through noteOn.
   */
  private armedHarm(h: HarmRun): boolean {
    if (!this.src) return false;
    return this.keyHarms().includes(h) || this.fed.some(t => this.tracks.some(n => n.inst[0].state === t && keyReach(this.src!, n.id).has(h.node.id)));
  }
  chordButton(b: number, down: boolean, track?: number): void {
    if (track !== undefined) {
      const h = this.trackHarmony(track);
      if (h) harmButton(h.st, b, down, this.harmParams(h));
      return;
    }
    for (const h of this.harms) if (!h.node.bypass && (!this.armedKeys.length || this.armedHarm(h))) harmButton(h.st, b, down, this.harmParams(h));
  }

  private arpById = new Map<number, ArpRun>();
  /** a bypassed Arpeggiator that hears Main's keys: its groups and Drum maps play the keys straight, as Main's own */
  private passesMain = (a: ArpRun | undefined): boolean => !!a && a.node.bypass && this.effSrc(a.feed) === -1 && this.keyArps().includes(a);
  /** where the notes of a group or Drum map fed by `src` (-1 Main's keys, else a module id) come from now: a bypassed
   * Arpeggiator's are its own source's (-1 Main's keys, a track's id), -2 nothing (it does not hear Main's keys now) */
  private effSrc(src: number): number {
    for (let i = 0; i < 3; i++) {
      const a = this.arpById.get(src) ?? this.harmById.get(src);
      if (!a || !a.node.bypass) return src;
      src = a.feed;
    }
    return src;
  }

  /** an Arpeggiator was switched (bypassed, or back): what it played lets go, its groups' parts and its Drum maps' rows
   * (the keys held stay with it: switched on it plays them) */
  private arpSwitched(a: ArpRun): void {
    a.byp = a.node.bypass;
    a.st.cur = -1;
    a.st.running = false;
    for (const x of this.maps) if (x.src === a.node.id) dropRows(x.st);
    for (const g of this.groups) {
      if (g.src !== a.node.id) continue;
      g.held = [];
      g.down.fill(0);
      for (const x of g.parts) {
        x.on = false;
        x.gate = 0;
        x.retrig = false;
        x.keyTrig = false;
      }
    }
  }

  /** Pass a generated note to the next processor. Generated pitches are always roots, never split-zone controls. */
  private processorKeys(src: number, note: number, vel: number, snapshot?: ReadonlyMap<number, number>): void {
    for (const a of this.arps) if (this.effSrc(a.feed) === src) {
      if (vel) arpKeyOn(a.st, note, vel, this.arpParams(a));
      else arpKeyOff(a.st, note, this.arpParams(a));
    }
    for (const h of this.harms) if (this.effSrc(h.feed) === src && !h.node.bypass)
      harmKey(h.st, note, !!vel, this.harmParams(h), false, n => this.harmOn(h, n, vel), n => this.harmOff(h, n), notes => this.harmRoom(h, notes), snapshot?.get(h.node.id) ?? 0);
    for (const t of this.tracks) {
      const from = this.src && keyFeed(this.src, t);
      if (from && this.effSrc(from.id) === src) this.thru(t.id, note, Math.round(vel * 127));
    }
  }

  /** the Steps tracks Main's keys reach by a cable into their keys in */
  private keyPatch: Patch | null = null;
  private get fed(): StepsState[] {
    return this.tracks.filter(node => {
      const from = this.keyPatch && keyFeed(this.keyPatch, node);
      return from && (from.type === 'fm1' || this.effSrc(from.id) === -1);
    }).map(node => node.inst[0].state as StepsState);
  }

  /** the Drum maps that take keys (#137) and from where: -1 Main's keys, else a Steps module's id */
  private maps: { st: DrumMapState; src: number }[] = [];

  /** a note on (key | 0x80, velocity 1..127) or off (key, 0) into the Drum maps fed by `src`, taken at their next block */
  private mapKeys(src: number, key: number, vel: number): void {
    for (const x of this.maps) if (this.effSrc(x.src) === src) x.st.ev.push(key, vel);
  }

  /** the Steps modules, in processing order (their keys go out in this order: engine.c the same) */
  private tracks: Node[] = [];
  /** the tracks with P-locks (#524) */
  private lockRuns = new Map<Node, LockRun>();

  /**
   * A track's P-locks after its block (#524; engine.c locks_step, the same rule): while it plays (the transport runs, or a
   * clock is in clk; not bypassed) and its playhead moved to another step or pattern, its locked rows go back to their
   * normal values and the locks of the step it is on (of the pattern it plays: one it has not got plays its first's) set
   * theirs. The modules after it in the processing order play them from this block, the others from the next.
   */
  private locksStep(node: Node): void {
    const run = this.lockRuns.get(node);
    if (!run) return;
    const s = node.inst[0].state as StepsState;
    const p = s.pats[s.pat] ? s.pat : 0;
    const key = !node.bypass && s.pos >= 0 && (s.run || node.connected.clk) ? p * 64 + s.pos : -1;
    if (key === run.key) return;
    run.key = key;
    for (const row of run.rows) for (const t of row) if (t.node.lock) delete t.node.lock[t.pd.name];
    if (key < 0) return;
    for (const l of run.pats.get(p) ?? [])
      if (l.at === s.pos)
        for (const t of run.rows[l.row]) (t.node.lock ??= {})[t.pd.name] = lockValue(t.pd, l.value);
  }

  /**
   * The notes the Steps tracks started and ended in the last block, into the groups they play (DeviceGroup.src), in
   * order; a group's key range judges them, as an arpeggiator's. A part that a track's note let go and one of its notes
   * took again in the same delivery restarts its envelopes (its gate had no low sample); a note that starts while another
   * still sounds is legato, as the allocator's legato setting says.
   */
  private trackKeys(): void {
    for (const node of this.tracks) {
      const st = node.inst[0].state as StepsState;
      if (!st.ev.length) continue;
      const gs = this.groups.filter((g) => this.effSrc(g.src) === node.id);
      const freed = gs.map(() => 0);
      for (let i = 0; i < st.ev.length; i += 2) {
        this.mapKeys(node.id, st.ev[i], st.ev[i + 1]);
        const key = st.ev[i] & 0x7f;
        this.processorKeys(node.id, key, st.ev[i] & 0x80 ? st.ev[i + 1] / 127 : 0, st.evSnapshot[i / 2]);
        gs.forEach((g, gi) => {
          if (!(st.ev[i] & 0x80)) {
            const was = g.parts.map((x) => x.on);
            this.groupOff(g, key);
            g.parts.forEach((x, v) => {
              if (was[v] && !x.on) freed[gi] |= 1 << v;
            });
          } else if (takesKey(g.cfg, key)) {
            this.groupOn(g, key, st.ev[i + 1] / 127);
            g.parts.forEach((x, v) => {
              if (x.on && x.note === key && x.onStamp === this.stamp && (freed[gi] >> v) & 1) x.retrig = true;
            });
          }
        });
      }
      st.ev.length = 0;
      st.evSnapshot.length = 0;
    }
  }

  private arpParams(a: ArpRun): ArpParams {
    const p = a.node.params;
    return { mode: p.mode ?? 0, rate: p.rate ?? 4, octaves: p.octaves ?? 1, gate: p.gate ?? 0.5, latch: p.latch ?? 0 };
  }

  /** the groups an arpeggiator plays */
  private arpGroups(a: ArpRun): Group[] {
    return this.groups.filter((g) => g.src === a.node.id);
  }

  /** the morph position the current block uses (for tests) */
  get morph(): number {
    return this.morphT;
  }

  /**
   * The buffer an output wrote in the last block, for a scope probe (and a sidebar watch). A module that runs once per
   * part: an audio output is the sum over the parts (what a cable from it carries, what is heard), a control / gate
   * output the newest held part's (the part the parameter displays follow; a sum of pitches or gates means nothing).
   */
  probe(id: number, port: string): Float32Array | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.used[port] = true;
    if (node.group < 0 || node.inst.length < 2) return node.inst[0]?.out[port] ?? null;
    if (node.impl.def.outputs.find((o) => o.name === port)?.kind !== 'audio')
      return node.inst[this.shownPart(this.groups[node.group])]?.out[port] ?? null;
    const sum = (this.probeSums[`${id}:${port}`] ??= new Float32Array(BLOCK));
    sum.fill(0);
    for (const b of this.probeVoices(id, port) ?? []) for (let i = 0; i < BLOCK; i++) sum[i] += b[i];
    return sum;
  }

  /**
   * The scope's per-voice view (#54): what each copy of a module that runs once per voice wrote in the last block, voice
   * by voice (V1 first); null for a module that runs once. An audio output of a voice skipped this block (idle,
   * partQuiet) reads silence, so the copies always sum to `probe`'s trace; a control output keeps its last block.
   * The buffers are the engine's own: copy them before the next render.
   */
  probeVoices(id: number, port: string): Float32Array[] | null {
    const node = this.nodes.get(id);
    if (node) node.used[port] = true;
    if (!node || node.group < 0 || node.inst.length < 2) return null;
    const audio = node.impl.def.outputs.find((o) => o.name === port)?.kind === 'audio';
    const parts = this.groups[node.group].parts;
    return node.inst.map((inst, v) => (audio && parts[v]?.skip) || !inst.out[port] ? this.silent : inst.out[port]);
  }
  /** a block of silence for probeVoices (never written) */
  private silent = new Float32Array(BLOCK);
  /**
   * An envelope's copies as they run, for its display (env-view.ts): stage and level of each copy (one per voice inside
   * a poly assembly) and which is the newest held one; null when the module has no stage state.
   */
  envStates(id: number): { stage: number; v: number; newest: boolean }[] | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    const newest = node.group >= 0 && node.inst.length > 1 ? this.shownPart(this.groups[node.group]) : 0;
    const out: { stage: number; v: number; newest: boolean }[] = [];
    for (const [i, inst] of node.inst.entries()) {
      const s = inst.state as { stage?: unknown; v?: unknown } | null;
      if (typeof s?.stage !== 'number' || typeof s.v !== 'number') return null;
      out.push({ stage: s.stage, v: s.v, newest: i === newest });
    }
    return out;
  }

  /** a Steps module's state, null if `id` is not one */
  private stepsOf(id: number): StepsState | null {
    const node = this.nodes.get(id);
    return node?.type === 'steps' ? (node.inst[0].state as StepsState) : null;
  }
  /** a Steps module's notes changed (ModuleInst.notes, track.ts), of pattern `pat` (0-based; absent: the one it plays):
   * no reload, the track plays on; the notes sounding end as they would */
  setTrack(id: number, notes: readonly StepNote[] | undefined, pat?: number): void {
    const s = this.stepsOf(id);
    if (!s) return;
    const p = Math.min(PATTERNS_MAX - 1, Math.max(0, pat ?? s.pat));
    while (s.pats.length <= p) s.pats.push(null);
    const x = s.pats[p];
    if (x) x.notes = fixNotes(notes) ?? [];
    else s.pats[p] = { notes: fixNotes(notes) ?? [] };
    s.notes = stepsPattern(s).notes;
  }
  /** the song state the tracks share (Main's `seq`) and the selected pattern */
  private song: StepsSong = { song: 0, songs: [] };
  private pattern = 0;
  /** the patch's pattern (0-based; track.ts SeqState.pattern): each track plays it from the end of its pass, at once while
   * the transport is stopped (from the next block) */
  setPattern(p: number): void {
    this.pattern = Math.min(PATTERNS_MAX - 1, Math.max(0, Math.round(p)));
    for (const node of this.tracks) {
      const s = node.inst[0].state as StepsState;
      s.queued = this.pattern;
    }
  }
  /** the songs' entries (Main's `seq.songs`) changed: each track goes on from the entry it plays */
  setSongs(songs: readonly SongEntry[][]): void {
    this.song.songs = songs.map((x) => x.map((e) => ({ ...e })));
  }
  /** the song that plays (0: none, the selected pattern; 1..SONGS_MAX): from the end of each track's pass, its first entry */
  setSong(n: number): void {
    this.song.song = Math.min(SONGS_MAX, Math.max(0, Math.round(n)));
    for (const node of this.tracks) {
      const s = node.inst[0].state as StepsState;
      s.songPos = -1;
      s.queued = this.song.song ? -1 : this.pattern;
    }
  }
  /** what the tracks play: the selected pattern, the song (0 none) and per track the pattern playing, the queued one (-1
   * none) and the song entry (-1 none yet) */
  patternView(): PatternView {
    return { pattern: this.pattern, song: this.song.song, tracks: this.tracks.map((n) => {
      const s = n.inst[0].state as StepsState;
      return { id: n.id, pat: s.pat, queued: s.queued, entry: this.song.song ? s.songPos : -1 };
    }) };
  }
  /** mute / unmute a Steps module (not part of the patch: a reload keeps it while the module stays) */
  setMute(id: number, on: boolean): void {
    const s = this.stepsOf(id);
    if (s) s.mute = on;
  }
  /** where every Steps module is (the step playing, -1 before the first) and whether it is muted, for the editor's grid */
  stepsView(): { id: number; pos: number; mute: boolean }[] {
    return this.order.filter((n) => n.type === 'steps').map((n) => {
      const s = n.inst[0].state as StepsState;
      return { id: n.id, pos: this.running || n.connected.clk ? s.pos : -1, mute: s.mute };
    });
  }

  /** the probes' sums over the parts, one buffer per probed output */
  private probeSums: Record<string, Float32Array> = {};

  /** the part of a group whose values a display shows: the newest held one, else the newest released */
  private shownPart(g: Group): number {
    let voice = 0;
    for (let i = 1; i < g.parts.length; i++) {
      const a = g.parts[i], b = g.parts[voice];
      if ((a.on && !b.on) || (a.on === b.on && a.onStamp > b.onStamp)) voice = i;
    }
    return voice;
  }

  /** Last rendered values. Per-part controls follow their poly assembly's newest held part, or its release. */
  parameterValues(): ParameterValues {
    const shown = this.groups.map((g) => this.shownPart(g));
    return this.order.map((node) => {
      const { eff, display } = node.inst[node.group >= 0 ? shown[node.group] : 0];
      const params = Object.fromEntries(node.impl.def.params.map((pd) => [
        pd.name, node.bypass ? node.params[pd.name] ?? pd.default : display[pd.name] ?? eff[pd.name] ?? node.params[pd.name] ?? pd.default,
      ]));
      if (node === this.main && this.hasB) params.morph = this.morphT;
      if (node === this.main && this.tempoGlobal !== null) params.tempo = this.tempoGlobal;   // (what plays, D-907)
      return { id: node.id, params };
    });
  }

  /** the morph position for the next block: the Main module's `morph` parameter plus the block mean of its morph input (what the input summed in the previous block) */
  private morphPosition(n: number): number {
    const m = this.main;
    if (!m) return 0;
    let t = m.params.morph ?? 0;
    if (m.connected.morph) {
      const b = m.inst[0].inp.morph;
      let s = 0;
      for (let i = 0; i < n; i++) s += b[i];
      t += s / n;
    }
    return Math.min(1, Math.max(0, t));
  }

  setParam(id: number, name: string, value: number): void {
    const m = this.src?.modules.find((x) => x.id === id);
    if (m?.type === ALLOC) {
      // the voice count, assign, legato, priority, unison: the groups change, the patch loads again (running modules keep their
      // state), as it plays now: a preset's rows set just before stay
      m.params[name] = value;
      const n = this.nodes.get(id);
      if (n) n.params[name] = value;
      this.load(this.liveSource(this.src!), this.compiled);
      return;
    }
    const n = this.nodes.get(id);
    if (n) n.params[name] = value;
  }

  setAtt(id: number, index: number, value: number): void {
    const n = this.nodes.get(id);
    if (n && (index === 0 || index === 1)) n.att[index] = value;
  }

  /** a macro range of pin `index` (0 p1, 1 p2) on a parameter, or none */
  setRange(id: number, index: number, name: string, range: Range | null): void {
    const n = this.nodes.get(id);
    if (!n || (index !== 0 && index !== 1)) return;
    if (range) n.range[index][name] = range[2] === 1 ? [range[0], range[1], 1] : [range[0], range[1]];
    else delete n.range[index][name];
  }

  /** bypass a module (its state is kept: it resumes where it stopped) */
  setBypass(id: number, on: boolean): void {
    const n = this.nodes.get(id);
    if (n && n.type !== 'fm1' && n.type !== 'output') n.bypass = on;
    const a = this.arpById.get(id);
    if (a && a.byp !== a.node.bypass) this.arpSwitched(a);
    const h = this.harmById.get(id);
    if (h && h.byp !== h.node.bypass) this.harmSwitched(h);
    this.syncToggles();
  }

  /** a switching Toggle is on while every module it bypasses is bypassed (a card's ⏻ moves it too); one that acts while
   * held is on while held */
  private syncToggles(): void {
    this.btnTargets.forEach((t, i) => {
      if (!t || !this.btnSwitch[i]) return;
      const on = t.length > 0 && t.every((id) => this.nodes.get(id)?.bypass);
      this.buttons = on ? this.buttons | (1 << i) : this.buttons & ~(1 << i);
    });
  }

  /**
   * A module whose output went NaN or infinite (a filter blown up by resonance and a hot input, a feedback loop) would keep
   * poisoning everything after it, because its state never recovers: silence its outputs and restart its state.
   */
  private guard(node: Node, inst: Inst, n: number): void {
    for (const name in inst.out) {
      const o = inst.out[name];
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(o[i]) && o[i] < 1e6 && o[i] > -1e6) continue;
        inst.state = node.impl.init(this.sampleRate);
        node.impl.seed?.(inst.state, inst.seed);
        for (const k in inst.out) inst.out[k].fill(0, 0, n);
        return;
      }
    }
  }

  /** Block-rate parameter modulation: side-input means add to their destinations; p1/p2 also apply their depth and macro ranges. */
  private applyCv(node: Node, inst: Inst, n: number): void {
    const pins: (number | null)[] = [null, null];
    if (node.impl.def.paramInputs)
      (['p1', 'p2'] as const).forEach((name, s) => {
        if (!node.connected[name]) return;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += inst.inp[name][i];
        pins[s] = (sum / n) * node.att[s];
      });
    for (const route of node.inputRoutes) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += inst.inp[route.port][i];
      route.mean = sum / n;
    }
    for (const pd of node.impl.def.params) {
      if (pd.fixed) {   // (set when the patch loads: the base value, ParamDef.fixed)
        inst.eff[pd.name] = node.params[pd.name] ?? pd.default;
        continue;
      }
      const a = node.lock?.[pd.name] ?? node.params[pd.name] ?? pd.default;   // (a P-lock in place of the normal value, #524)
      let base = node.paramsB && this.morphT > 0 ? morphValue(pd, a, node.paramsB[pd.name] ?? a, this.morphT) : a;
      let mod = 0;
      let touched = false;
      // a pin with a macro range on this parameter sets it: its value 0..1 lands between the two ends (replacing the base);
      // the other pin still adds as usual
      let ranged: Range | null = null;
      let rv = 0;
      (['p1', 'p2'] as const).forEach((name, s) => {
        if (pins[s] === null || !node.map[name].includes(pd.name)) return;
        const r = node.range[s][pd.name];
        if (r) {
          ranged = r;
          rv += rangeShare(r, pins[s]!);   // (a bipolar range reads the pin's −1..1 across its ends, #526)
        } else {
          mod += pins[s]!;
          touched = true;
        }
      });
      for (const route of node.inputRoutes) if (route.params.includes(pd.name)) {
        mod += route.mean;
        touched = true;
      }
      if (ranged) {
        const [lo, hi] = ranged as Range;
        base = paramValue(pd, lo + Math.min(1, Math.max(0, rv)) * (hi - lo));
      }
      inst.eff[pd.name] = touched ? modulate(pd, base, mod) : base;
    }
  }

  /** a part's flaws on its copy's effective parameters (after the modulation): the cutoffs, envelope times, VCA gains */
  private applyFlaws(node: Node, inst: Inst, f: PartFlaw): void {
    for (const { key, pd } of node.flawParams) {
      const v = inst.eff[pd.name];
      const k = key === 'bright' ? (f.bright ? Math.pow(2, f.bright / 12) : 1) : key === 'env' ? (100 + f.env) / 100 : f.level / 100;
      if (k !== 1) inst.eff[pd.name] = Math.min(pd.max, Math.max(pd.min, v * k));
    }
  }

  /**
   * A key on MIDI channel `ch` (1..16; the computer keys and the on-screen keyboard play on 1). The groups that take it
   * (takesKey: the allocator's channel and key range; one without a channel listens on `channel`), the shared keyboard
   * and the Arpeggiators (on `channel`) play it. The Harmonizers (on `channel`) take it as a chord button when it is one
   * of the seven under their split, else as a root; `root`: always as a root (the FM-1's keys, engine.c eng_harm_zone).
   */
  noteOn(note: number, velocity = 1, ch = 1, root = false): void {
    for (const g of this.keyGroups()) if ((g.src < 0 || this.passesMain(this.arpById.get(g.src)) || this.harmPasses(g.src)) && takesKey(g.cfg, note, ch, this.channel)) this.groupOn(g, note, velocity);
    if (this.listens(ch)) for (const h of this.keyHarms()) if (!h.node.bypass) harmKey(h.st, note, true, this.harmParams(h), !root, (n) => this.harmOn(h, n, velocity), (n) => this.harmOff(h, n), notes => this.harmRoom(h, notes));
    if (this.listens(ch)) for (const a of this.keyArps()) arpKeyOn(a.st, note, velocity, this.arpParams(a));
    if (this.listens(ch)) this.mapKeys(-1, note | 0x80, Math.max(1, Math.min(127, Math.round(velocity * 127))));
    if (this.listens(ch)) for (const n of this.tracks.filter(n => this.fed.includes(n.inst[0].state as StepsState)))
      if (this.entryNotes(n.id, note, true, root).length) this.thru(n.id, note, Math.round(velocity * 127));
  }

  noteOff(note: number, ch = 1, root = false): void {
    for (const g of this.keyGroups()) if ((g.src < 0 || this.passesMain(this.arpById.get(g.src)) || this.harmPasses(g.src)) && takesKey(g.cfg, note, ch, this.channel)) this.groupOff(g, note);
    if (this.listens(ch)) for (const h of this.keyHarms()) if (!h.node.bypass) harmKey(h.st, note, false, this.harmParams(h), !root, () => {}, (n) => this.harmOff(h, n), notes => this.harmRoom(h, notes));
    if (this.listens(ch)) for (const a of this.keyArps()) arpKeyOff(a.st, note, this.arpParams(a));
    if (this.listens(ch)) this.mapKeys(-1, note, 0);
    if (this.listens(ch)) for (const n of this.tracks.filter(n => this.fed.includes(n.inst[0].state as StepsState)))
      if (this.entryNotes(n.id, note, false, root).length) this.thru(n.id, note, 0);
  }

  /** the groups Main's keys may play: the shared keyboard (Main's pitch / gate) only while nothing is armed */
  private keyGroups = (): Group[] => (this.armedKeys.length ? this.groups : [this.kb, ...this.groups]);
  /** the Arpeggiators that hear Main's keys: all while nothing is armed, else the armed devices' */
  private keyArps = (): ArpRun[] => this.arps.filter((a) => this.effSrc(a.feed) === -1 && (!this.arpHears || this.arpHears.has(a.node.id)));
  private arpHears: Set<number> | null = null;

  /** the armed devices (#190; `a<id>` / `m<id>`, docs/ledger/vocabulary.md "Arm"), none: the cables decide */
  private armedKeys: DeviceKey[] = [];

  /**
   * Arm a set of devices (#190; a number arms that module alone, null none: #134's form). While any is armed Main's keys
   * (noteOn / noteOff: the computer keys, the on-screen keys, MIDI) go to every armed device's keys input, cable or not, and
   * to nothing else (not the shared keyboard, nor the devices only a cable from Main feeds); with none armed the cables
   * decide. A Steps track armed plays the keys through to what it plays (modules.ts steps), as a cable from Main's keys does
   * (#138). The keys held when the routing changes go quiet: the keys they sounded through let them go (a track's thru
   * notes end, the groups and the Arpeggiators let go of every key).
   */
  arm(devices: DeviceKey[] | number | null): void {
    const list = devices === null ? [] : typeof devices === 'number' ? [`m${devices}`] : [...new Set(devices)].sort();
    if (list.join() === this.armedKeys.join()) return;
    for (const node of this.tracks) this.thruOff(node.inst[0].state as StepsState);
    this.keysOff();
    this.armedKeys = list;
    if (this.src) this.load(this.liveSource(this.src), this.compiled);
  }

  /** the patch as it plays now: what setParam / setAtt / setRange / setBypass / setTrack changed since it was loaded put
   * back into a copy, so a reload (arming) does not undo them */
  private liveSource(src: Patch): Patch {
    return {
      ...src,
      modules: src.modules.map((m) => {
        const n = this.nodes.get(m.id);
        if (!n) return m;
        const out = { ...m, params: { ...m.params, ...n.params }, att: [n.att[0], n.att[1]] as [number, number], range: { p1: { ...n.range[0] }, p2: { ...n.range[1] } } };
        if (n.bypass) out.bypass = true;
        else delete out.bypass;
        if (m.type === 'steps') {
          const st = n.inst[0].state as StepsState;
          const notes = (st.pats[0]?.notes ?? []).map((x) => ({ ...x }));
          if (notes.length) out.notes = notes;
          else delete out.notes;
          const pats = st.pats.slice(1).map((x) => (x ? { ...x, notes: x.notes.map((y) => ({ ...y })) } : null));
          while (pats.length && !pats[pats.length - 1]) pats.pop();
          if (pats.length) out.patterns = pats.map((x) => (x ? { ...(x.notes.length ? { notes: x.notes } : {}), ...(x.len !== undefined ? { len: x.len } : {}), ...(x.rate !== undefined ? { rate: x.rate } : {}), ...(x.locks?.length ? { locks: x.locks } : {}) } : null));
          else delete out.patterns;
        }
        return out;
      }),
    };
  }

  /** The selected track's harmony, on either side; capture expands only the upstream side. */
  private trackHarmony(id: number): HarmRun | undefined {
    return this.src ? this.harms.find(h => !h.node.bypass && (keyReach(this.src!, h.node.id).has(id) || keyReach(this.src!, id).has(h.node.id))) : undefined;
  }

  /** A cursor-entry gesture, before audition. Empty means a chord control, never a note/advance. */
  entryNotes(id: number, note: number, down: boolean, root = false): number[] {
    const h = this.trackHarmony(id);
    if (h && !root) {
      const held = h.st.buttonKeys[note];
      const b = down ? harmButtonOf(note, this.harmParams(h)) : held ? held - 1 : -1;
      if (b >= 0) {
        h.st.buttonKeys[note] = down ? b + 1 : 0;
        if (down || !h.st.buttonKeys.includes(b + 1)) harmButton(h.st, b, down, this.harmParams(h));
        return [];
      }
    }
    return h && this.src && keyReach(this.src, h.node.id).has(id) ? harmChord(h.st, note, this.harmParams(h)) : [note];
  }

  /** live recording on the armed track (#135): while the track runs, the notes played through it are recorded (the editor
   * takes them: takeRecorded); off: the notes still held are recorded when let go */
  setRec(id: number, on: boolean): void {
    const s = this.stepsOf(id);
    if (s) s.rec = on;
  }

  /** the notes the tracks recorded since the last call, by track, with the time round the pattern each was played on */
  takeRecorded(): { id: number; loop: number; note: StepNote }[] {
    const out: { id: number; loop: number; note: StepNote }[] = [];
    for (const node of this.tracks) {
      const s = node.inst[0].state as StepsState;
      for (const x of s.took) out.push({ id: node.id, loop: x.loop, note: x.note });
      s.took.length = 0;
    }
    return out;
  }

  /** a note into a track's keys in, armed or not (the roll's keys, to hear the instrument: #136); vel 0 lets it go */
  thru(id: number, note: number, vel: number): void {
    const s = this.stepsOf(id);
    if (!s) return;
    const held = this.thruHeld.get(id) ?? new Set<number>();
    if (vel > 0) {
      if (!this.thruRoom(held.has(note) ? 1 : 2)) return;
      held.add(note);
    } else if (!held.delete(note)) return;
    this.thruHeld.set(id, held);
    const snapshot = new Map<number, number>();
    if (vel > 0 && this.src) {
      const downstream = keyReach(this.src, id);
      this.harms.forEach(h => {
        if (!h.node.bypass && downstream.has(h.node.id)) snapshot.set(h.node.id, harmSnapshot(h.st, this.harmParams(h)));
      });
    }
    s.thruSnapshot.push(snapshot);
    s.thru.push(vel > 0 ? (note & 0x7f) | 0x80 : note & 0x7f, vel > 0 ? Math.max(1, Math.min(127, Math.round(vel))) : 0);
  }

  /** a track's keys played through end (at its next block) */
  private thruOff(s: StepsState | null): void {
    const t = this.tracks.find(n => n.inst[0].state === s);
    if (t) for (const note of [...(this.thruHeld.get(t.id) ?? [])]) this.thru(t.id, note, 0);
  }

  /** the keys' own listeners let go of every key: the shared keyboard, the groups that play the keys, the Arpeggiators */
  private keysOff(): void {
    for (const x of this.maps) if (this.effSrc(x.src) === -1) dropRows(x.st);
    for (const t of this.fed) this.thruOff(t);
    for (const a of this.arps) {
      arpClear(a.st);
      a.st.cur = -1;
      a.st.running = false;
    }
    for (const h of this.harms) {
      this.harmDrop(h);
      harmClear(h.st);
    }
    for (const g of [this.kb, ...this.groups]) {
      if (g.src >= 0 && !this.passesMain(this.arpById.get(g.src)) && !this.harmPasses(g.src)) continue;
      g.held = [];
      g.down.fill(0);
      for (const x of g.parts) {
        x.on = false;
        x.gate = 0;
        x.retrig = false;
        x.keyTrig = false;
      }
    }
  }

  /** the device's MIDI channel (1..16, 0 = every channel): the shared keyboard, the Arpeggiators and the allocators
   * without a channel of their own play its keys (engine.c eng_midi_channel; MENU > MIDI CHANNEL on the FM-1) */
  channel = 0;
  private listens = (ch: number): boolean => !this.channel || this.channel === ch;

  /** an arpeggiator's note into its groups; a part it lands on restarts its envelopes (one note after another, also
   * at gate 100 %, where the next note follows the last in the same block) */
  private arpOn(a: ArpRun, note: number, vel: number): void {
    this.mapKeys(a.node.id, note | 0x80, Math.max(1, Math.min(127, Math.round(vel * 127))));
    for (const g of this.arpGroups(a)) {
      if (!takesKey(g.cfg, note)) continue; // an arpeggiated allocator's key range judges the arpeggiator's notes
      this.groupOn(g, note, vel);
      for (const x of g.parts) if (x.on && x.note === note && x.onStamp === this.stamp) x.retrig = true;
    }
  }

  /**
   * A note for one group. One part: the key joins the held list and the sounding key is chosen among them (monoUpdate).
   * Several: the key already down on a part keeps it; else a free part by the assign mode (rotate: the next in turn;
   * lowest: the lowest-numbered; reuse: a free part whose last note was the key, else the one free the longest); with none free
   * one is taken over by priority (last: the oldest note; low / high: the highest / lowest note, only for a lower / higher
   * key; otherwise the key does not sound). A taken-over part restarts its envelopes unless legato is on.
   */
  private groupOn(g: Group, note: number, velocity: number): void {
    if (g.cfg.assign === 3 && g.down.every((bits) => bits === 0)) g.rot = 0;
    g.down[note >>> 5] |= 1 << (note & 31);
    for (const x of g.parts) x.keyTrig = true;
    if (g.parts.length === 1 || g.cfg.unison) {
      g.held = g.held.filter((h) => h.note !== note);
      g.held.push({ note, vel: velocity });
      this.monoUpdate(g);
      return;
    }
    const vs = g.parts;
    const n = vs.length;
    const over = vs.some((x) => x.on && x.note !== note); // another key is down: this note overlaps it
    let v = vs.findIndex((x) => x.on && x.note === note);
    if (v < 0) {
      const free = vs.map((x, i) => (x.on ? -1 : i)).filter((i) => i >= 0);
      if (free.length) {
        const mode = g.cfg.assign;
        if (mode === 0 || mode === 3) {
          for (let k = 0; k < n && v < 0; k++) if (!vs[(g.rot + k) % n].on) v = (g.rot + k) % n;
          g.rot = (v + 1) % n;
        } else if (mode === 1) v = free[0];
        else v = free.find((i) => vs[i].note === note) ?? free.reduce((a, i) => (vs[i].offStamp < vs[a].offStamp ? i : a), free[0]);
      } else {
        if (g.cfg.steal === false) return;
        const pr = g.cfg.priority;
        v = 0;
        for (let i = 1; i < n; i++) {
          const better = pr === 1 ? vs[i].note > vs[v].note : pr === 2 ? vs[i].note < vs[v].note : vs[i].onStamp < vs[v].onStamp;
          if (better) v = i;
        }
        if ((pr === 1 && note > vs[v].note) || (pr === 2 && note < vs[v].note)) return;
      }
    }
    const x = vs[v];
    // a taken-over part restarts its envelopes unless legato is on
    if (x.on && g.cfg.legato !== 2) x.retrig = true;
    x.legato = over ? 1 : 0;
    x.jump = (note - 60) / 12 - x.pitch;
    x.note = note;
    x.pitch = (note - 60) / 12;
    x.velocity = velocity;
    x.gate = 1;
    x.on = true;
    x.onStamp = ++this.stamp;
  }

  private groupOff(g: Group, note: number): void {
    g.down[note >>> 5] &= ~(1 << (note & 31));
    if (g.parts.length === 1 || g.cfg.unison) {
      g.held = g.held.filter((h) => h.note !== note);
      this.monoUpdate(g);
      return;
    }
    for (const x of g.parts)
      if (x.on && x.note === note) {
        x.on = false;
        x.gate = 0;
        x.offStamp = ++this.stamp;
      }
  }

  /** MIDI clock (0xF8): one tick, counted while the clock is external (clockExternal) */
  clockTick(): void {
    if (this.ext) this.extTicks++;
  }

  /** MIDI clock comes in: it drives the clock instead of the Main module's tempo */
  clockExternal(on: boolean): void {
    this.ext = on;
    this.extTicks = 0;
    this.extSince = 0;
    this.extLen = 0;
  }

  /** the transport (PLAY, MIDI Start / Stop): the Main module's run output, and its clock output pulses only while it runs.
   * It ends play once (#632) where it is: on, the transport runs on as if PLAY had started it */
  transport(on: boolean): void {
    if (this.once) this.onceEnd();
    if (on && !this.running) this.tickAcc = 0;
    this.running = on;
    if (!on) this.countIn(0); // (a stop ends REC's count-in click, asked for or counting)
  }

  /** REC's count-in click (D-803; engine.c eng_count_in, the same): a click on each beat of `bars` bars from the transport's
   * start or, running already at `at` (the clock's ticks then), from the next bar line, as the FM-1's REC counts them
   * (seq_ui.c seq_cin_poll); 0 bars: none. The editor's own REC has no count-in: the FM-1 tab asks for it */
  countIn(bars: number, at = this.ticks): void {
    this.cinReq = { at: at >>> 0, bars };
  }

  /** play once (#632; engine.c eng_play_once, the same): the transport stops, a bar of four beats is counted in on the
   * clock with a click on each beat (CLICK_*: beat 1 higher), from the next block's first sample; then the transport
   * starts and each Steps track the clock steps plays its pattern once, or the song's entries once each, and plays no
   * step after; when every such track is done the transport stops by itself */
  playOnce(): void {
    this.running = false;
    for (const node of this.tracks) (node.inst[0].state as StepsState).once = 0;
    this.once = 1;
    this.cin = 0;
    this.cinFirst = true;
    this.tickAcc = 0;
  }
  /** play once: 0 not, 1 counting in, 2 playing */
  get onceState(): number {
    return this.once;
  }
  private onceEnd(): void {
    this.once = 0;
    for (const node of this.tracks) (node.inst[0].state as StepsState).once = 0;
  }
  /** play once's count-in is over: the transport starts, each track the clock steps counts its passes */
  private onceStart(): void {
    this.once = 2;
    this.running = true;
    this.tickAcc = 0;
    const song = this.song.song > 0 ? this.song.songs[this.song.song - 1]?.length ?? 0 : 0;
    for (const node of this.tracks) (node.inst[0].state as StepsState).once = node.connected.clk ? 0 : (song || 1) + 2;
  }

  /** a patch button (PANEL_BUTTONS index) held or switched: the host does the switching, the engine keeps the state */
  /** patch button i is on (held, or switched on): a Toggle bypasses its modules while on */
  setButton(i: number, on: boolean): void {
    if (i < 0 || i >= PANEL_BUTTONS.length) return;
    const was = (this.buttons >> i) & 1;
    this.buttons = on ? this.buttons | (1 << i) : this.buttons & ~(1 << i);
    const t = this.btnTargets[i];
    if (t && was !== (on ? 1 : 0)) for (const id of t) this.setBypass(id, on);
  }

  get buttonMask(): number {
    return this.buttons;
  }

  get transportRunning(): boolean {
    return this.running;
  }

  /** pitch bend, -1..1: +-2 semitones on every pitch output, and the Main module's bend output */
  bend(v: number): void {
    this.ctl.bend = Math.max(-1, Math.min(1, v));
  }

  /** channel aftertouch, 0..1: the Main module's at output */
  aftertouch(v: number): void {
    this.ctl.at = Math.max(0, Math.min(1, v));
  }

  /** a control change: CC 1 / 2 / 64 / 65 drive Main mod / breath / sustain / foot; CC 22 its morph, CC 80..86 hold / release its
   * patch buttons (64 and up: on); others are ignored (CC 16..19, the knobs, edit the device page in focus: the editor's) */
  cc(n: number, v: number): void {
    const x = Math.max(0, Math.min(1, v / 127));
    const main = (name: string): void => {
      for (const node of this.nodes.values()) if (node.type === 'fm1') node.params[name] = x;
    };
    if (n === 1) this.ctl.mod = x;
    else if (n === 2) this.ctl.breath = x;
    else if (n === 64) this.ctl.sustain = x;
    else if (n === 65) this.ctl.foot = x;
    else if (n === 22) main('morph');
    else if (n >= 80 && n < 80 + PANEL_BUTTONS.length) this.setButton(n - 80, v >= 64);
  }

  allNotesOff(): void {
    for (const node of this.tracks) this.thruOff(node.inst[0].state as StepsState);
    for (const x of this.maps) dropRows(x.st);
    for (const h of this.harms) harmClear(h.st);
    for (const a of this.arps) {
      arpClear(a.st);
      a.st.cur = -1;
      a.st.running = false;
    }
    for (const g of [this.kb, ...this.groups]) {
      g.held = [];
      g.down.fill(0);
      for (const x of g.parts) {
        x.on = false;
        x.gate = 0;
        x.retrig = false;
        x.keyTrig = false;
      }
    }
  }

  /** a group's assign and unison as they play: the patch's, moved by its cables (modules.ts voicingSetting) */
  private voicingSet(g: Group): void {
    const a = voicingSetting(g.base[0], g.cv[0], 3), u = voicingSetting(g.base[1], g.cv[1], 2);
    if (a !== g.cfg.assign) g.cfg.assign = a;
    if (u !== unisonOf(g.cfg)) {
      g.cfg.unison = u > 0;
      g.cfg.unisonShare = u === 2;
    }
  }

  /**
   * The end of a block (#681): what the cables into each Part's assign and unison inputs carry, their first sample (summed
   * as the Part's input would be), sets its group's assign and unison for the keys of the next block (engine.c
   * group_cables).
   */
  private voicingCables(): void {
    for (const node of this.modeParts) {
      const g = this.groups[node.group];
      const cv: [number, number] = [0, 0];
      for (const s of node.sources) {
        const k = VOICING_CABLE_INPUTS.indexOf(s.port);
        if (k < 0) continue;
        const fg = s.from.group;
        if (fg >= 0 && fg !== node.group) for (const inst of s.from.inst) cv[k] += s.w === 1 ? inst.out[s.fromPort][0] : inst.out[s.fromPort][0] * s.w;
        else cv[k] += s.from.inst[0].out[s.fromPort][0];
      }
      g.cv = cv;
      const was = unisonOf(g.cfg);
      this.voicingSet(g);
      if (unisonOf(g.cfg) !== was) this.unisonSwitch(g, was);
    }
  }

  /**
   * A group's unison mode changed from `from` (0 off, 1 on, 2 share). Into unison: the notes its parts play, oldest first,
   * become the held keys, and the parts take them as unison does. Out of it: the parts keep their notes until their keys
   * are let go, and new keys are handed out polyphonically. Between on and share: the held keys again. One part: nothing
   * changes (it plays the held keys either way). (engine.c unison_switch)
   */
  private unisonSwitch(g: Group, from: number): void {
    if (g.parts.length === 1) return;
    if (!from) {
      g.held = [];
      for (const x of g.parts.filter((p) => p.on).sort((a, b) => a.onStamp - b.onStamp))
        if (!g.held.some((h) => h.note === x.note)) g.held.push({ note: x.note, vel: x.velocity });
      this.monoUpdate(g);
    } else if (!unisonOf(g.cfg)) g.held = [];
    else this.monoUpdate(g);
  }

  /**
   * One part: the gate stays up while any key is down; the sounding key is the last, lowest or highest held (priority). A
   * change of key while the gate is up is a legato transition: the legato output goes to 1 and, with legato off, the
   * envelopes restart (one low gate sample); auto and on keep them running.
   */
  private monoUpdate(g: Group): void {
    if (g.cfg.unisonShare) { this.sharedUnison(g); return; }
    const { legato, priority } = g.cfg;
    let top = g.held[g.held.length - 1];
    if (priority) for (const h of g.held) if (priority === 1 ? h.note < top.note : h.note > top.note) top = h;
    // Unison uses its own count without changing the polyphonic voice pool.
    const count = g.cfg.unison ? Math.min(g.parts.length, g.cfg.unisonParts || g.parts.length) : 1;
    // The same stamps let the display and allocator see one note.
    const stamp = this.stamp;
    let after = stamp;
    for (const [i, x] of g.parts.entries()) {
      this.stamp = stamp;
      this.monoPart(x, i < count ? top : undefined, legato);
      after = Math.max(after, this.stamp);
    }
    this.stamp = after;
  }

  /** Equal-sized stacks for selected held notes, in keyboard order. Spare voices release. */
  private sharedUnison(g: Group): void {
    const slots = Math.min(g.parts.length, g.cfg.unisonParts || g.parts.length);
    const { priority, legato } = g.cfg;
    const selected = (priority ? [...g.held].sort((a, b) => priority === 1 ? a.note - b.note : b.note - a.note).slice(0, slots)
      : g.held.slice(-slots)).sort((a, b) => a.note - b.note);
    const copies = selected.length ? Math.floor(slots / selected.length) : 0;
    const stamp = this.stamp;
    let after = stamp;
    g.parts.forEach((x, i) => {
      this.stamp = stamp;
      this.monoPart(x, copies && i < copies * selected.length ? selected[Math.floor(i / copies)] : undefined, legato);
      after = Math.max(after, this.stamp);
    });
    this.stamp = after;
  }

  private monoPart(x: VoiceState, top: { note: number; vel: number } | undefined, legato: number): void {
    if (top) {
      const p = (top.note - 60) / 12;
      if (!x.on || top.note !== x.note) {
        x.jump = p - x.pitch;
        x.legato = x.on ? 1 : 0;
        if (x.on && legato === 1) x.retrig = true;
        x.onStamp = ++this.stamp;
      }
      x.pitch = p;
      x.velocity = top.vel;
      x.gate = 1;
      x.note = top.note;
      x.on = true;
    } else {
      if (x.on) x.offStamp = ++this.stamp;
      x.gate = 0;
      x.on = false;
    }
  }

  /** the inputs of one instance: zero, then every cable added (another group's per-part output adds all its parts) */
  private gather(node: Node, inst: Inst, v: number, n: number): void {
    for (const name in inst.inp) inst.inp[name].fill(0, 0, n);
    for (const s of node.sources) {
      const dst = inst.inp[s.port];
      const g = s.from.group;
      if (g >= 0 && g !== node.group) {
        const w = s.w;
        for (const k of s.from.inst) {
          const src = k.out[s.fromPort];
          if (w === 1) for (let i = 0; i < n; i++) dst[i] += src[i];
          else for (let i = 0; i < n; i++) dst[i] += src[i] * w;
        }
      } else {
        const src = s.from.inst[g >= 0 ? v : 0].out[s.fromPort];
        for (let i = 0; i < n; i++) dst[i] += src[i];
      }
    }
  }

  private run(node: Node, inst: Inst, voice: VoiceState, out: Record<string, Float32Array>, n: number): void {
    if (node.bypass) {
      const src = node.thru ? inst.inp[node.thru] : undefined;
      for (const name in out) if (src) out[name].set(src.subarray(0, n));
      else out[name].fill(0, 0, n);
      return;
    }
    const ctx: Ctx = { sr: this.sampleRate, n, inp: inst.dspInp, out, connected: node.connected, used: node.used, p: inst.eff, voice, display: inst.display };
    node.impl.process(ctx, inst.state);
    if ((node.type === 'fm1' || node.type === 'part') && voice.retrig) out.gate[0] = 0; // one low sample: a taken-over part's envelopes see a new gate
  }

  /** Render `left.length` frames (any length; processed in blocks of up to BLOCK). */
  /**
   * Is part v of poly group g idle (engine.c part_quiet, the same rule)? Its envelopes (ADSR / level envelope, at least one)
   * have all finished (ENVELOPE_TYPES) and every output leaving the group stayed within IDLE (6 in Q16) for the whole block.
   */
  private partQuiet(g: number, v: number): boolean {
    let envs = 0;
    for (const node of this.order) {
      if (node.group !== g || !ENVELOPE_TYPES.has(node.type)) continue;
      if ((node.inst[v].state as { stage: number }).stage !== 0) return false;
      envs++;
    }
    if (!envs) return false;
    for (const node of this.order) {
      if (node.group === g) continue;
      for (const s of node.sources) {
        if (s.from.group !== g) continue;
        const o = s.from.inst[v].out[s.fromPort];
        for (let i = 0; i < BLOCK; i++) if (o[i] > IDLE || o[i] < -IDLE) return false;
      }
    }
    return true;
  }

  private partSilence(g: number, v: number): void {
    for (const node of this.order) {
      if (node.group === g) continue;
      for (const s of node.sources) if (s.from.group === g) s.from.inst[v].out[s.fromPort].fill(0);
    }
  }

  render(left: Float32Array, right: Float32Array): void {
    const total = left.length;
    left.fill(0);
    right.fill(0);
    if (this.clickBuf.length < total) this.clickBuf = new Float32Array(total);
    const click = this.clickBuf;
    click.fill(0, 0, total);
    let clicked = false;
    const all = [this.kb, ...this.groups];
    for (let off = 0; off < total; off += BLOCK) {
      const n = Math.min(BLOCK, total - off);
      if (this.once === 1 && this.cin >= ONCE_BAR) this.onceStart();
      const start = this.running && !this.ran, was = this.ticks; // (REC's count-in: the ticks before this block's)
      if (start) this.runTicks = this.ticks;
      this.ran = this.running;
      // the clock: MIDI ticks while external, else the global tempo or the Main module's (bpm x 24 ticks a minute, in whole
      // bpm as the firmware does)
      const bpm = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(this.tempoGlobal ?? this.main?.params.tempo ?? TEMPO_DEFAULT)));
      let seen = false;
      // where this block's ticks fall (Steps modules start their steps there): MIDI clock ticks on the first sample, the
      // tempo's on the sample that completes the tick; and the samples per tick (measured between MIDI clock ticks)
      let tick = -1, nt = 0, tickLen = Math.floor((60 * this.sampleRate) / (bpm * PPQN));
      if (this.ext) {
        seen = this.extTicks > 0;
        if (seen) {
          tick = 0;
          nt = this.extTicks;
          if (this.extSince > 0) this.extLen = Math.floor(this.extSince / nt);
          this.extSince = 0;
        }
        if (this.extLen > 0) tickLen = this.extLen;
        this.extSince = Math.min(this.extSince + n, 1 << 23);
        this.ticks = (this.ticks + this.extTicks) >>> 0;
        this.extTicks = 0;
      } else {
        const whole = 60 * this.sampleRate, inc = bpm * PPQN;
        if (this.tickAcc + n * inc >= whole) tick = Math.ceil((whole - this.tickAcc) / inc) - 1;
        this.tickAcc += n * inc;
        while (this.tickAcc >= whole) {
          this.tickAcc -= whole;
          this.ticks = (this.ticks + 1) >>> 0;
          seen = true;
          nt++;
        }
      }
      const clock = seen && this.running; // the Main module's clock output: one pulse per block that saw a tick while running
      // play once's count-in (#632): beat 1's click on this block's first sample, then one on each 24th tick
      let clickAt = -1, accent = false;
      if (this.once === 1) {
        if (this.cinFirst) (clickAt = 0), (accent = true), (this.cinFirst = false);
        else if (seen) {
          const before = this.cin;
          this.cin += nt;
          if (this.cin < ONCE_BAR && Math.floor(this.cin / PPQN) > Math.floor(before / PPQN)) clickAt = Math.max(0, tick);
        }
      }
      // REC's count-in (D-803, as the FM-1's REC counts the bars): a click on each beat from the bar it starts on, beat 1 higher
      if (!this.running) this.cinOn = false;
      else {
        const r0 = (was - this.runTicks) >>> 0, r1 = (this.ticks - this.runTicks) >>> 0;
        if (this.cinReq) { // (asked for: taken once the transport runs)
          const at = (this.cinReq.at - this.runTicks) | 0;
          this.cinOn = this.cinReq.bars !== 0;
          this.cinFrom = at > 0 ? Math.ceil(at / ONCE_BAR) * ONCE_BAR : 0;
          this.cinEnd = this.cinFrom + this.cinReq.bars * ONCE_BAR;
          this.cinReq = null;
        }
        if (this.cinOn) {
          if (start && this.cinFrom === 0) (clickAt = 0), (accent = true); // (beat 1 on the start's first sample)
          for (let r = r0 + 1; r <= r1; r++)
            if (r >= this.cinFrom && r < this.cinEnd && r % PPQN === 0) (clickAt = Math.max(0, tick)), (accent = (r - this.cinFrom) % ONCE_BAR === 0);
          if (r1 >= this.cinEnd) this.cinOn = false;
        }
      }
      this.trackKeys();
      for (const a of this.arps)
        if (!a.node.bypass) // (bypassed it plays nothing of its own: the keys it hears went straight on)
          arpBlock(a.st, this.arpParams(a), n, this.ticks, a.node.connected.clk ? a.node.inst[0].inp.clk : null, a.clk, bpm, this.sampleRate,
            (note, vel) => this.arpOn(a, note, vel), (note) => { this.mapKeys(a.node.id, note, 0); for (const g of this.arpGroups(a)) this.groupOff(g, note); }, a.node.connected.rate ? a.node.inst[0].inp.rate : null);
      this.morphT = this.hasB ? this.morphPosition(n) : 0;
      const hold = walkHold(this.sampleRate, DRIFT_RATE);
      for (const g of this.groups)
        g.parts.forEach((x, v) => {
          const f = flawOf(g.cfg, v);
          walkStep(x.walk, hold); // every block, so the wander does not depend on the amount
          x.flaw = flawQ16(f.detune, f.drift, x.walk.y) / 65536;
        });
      for (const g of all) {
        let low = Infinity, high = -Infinity;
        for (const x of g.parts) if (x.on) { low = Math.min(low, x.note); high = Math.max(high, x.note); }
        for (const x of g.parts) {
          x.low = x.on && x.note === low;
          x.high = x.on && x.note === high;
          x.unison = !!g.cfg.unison;
          x.clock = clock;
          x.tick = this.running ? tick : -1;
          x.ticks = nt;
          x.tickLen = tickLen;
          x.run = this.running;
          x.buttons = this.buttons;
          x.bend = this.ctl.bend;
          x.mod = this.ctl.mod;
          x.at = this.ctl.at;
          x.breath = this.ctl.breath;
          x.sustain = this.ctl.sustain;
          x.foot = this.ctl.foot;
        }
      }
      // play once (D-820): where the last track still playing its passes ends them in this block (-1 not here); a shorter
      // track loops on until then (engine.c steps_once_at, the same)
      let onceAt = -1;
      if (this.once === 2)
        for (const node of this.tracks) {
          const st = node.inst[0].state as StepsState;
          if (st.once < 2) continue;
          const a = st.once === 2 ? stepsTurnAt(st, node.inst[0].eff, this.running, this.running ? tick : -1, nt, n) : -1;
          if (a < 0) { onceAt = -1; break; }
          onceAt = Math.max(onceAt, a);
        }
      for (const node of this.tracks) (node.inst[0].state as StepsState).onceAt = onceAt;
      // idle parts (partQuiet): woken by a note, else run every IDLE_CHECK-th block, each part in its own (staggered, #434)
      this.groups.forEach((g, gi) =>
        g.parts.forEach((x, v) => {
          if (x.idle && (x.gate > 0 || x.retrig)) x.idle = false;
          x.skip = !!x.idle && (this.idleBlk + gi * MAX_PARTS + v) % IDLE_CHECK !== 0;
        }),
      );
      this.idleBlk = (this.idleBlk + 1) % IDLE_CHECK;
      const kb = this.kb.parts[0];
      for (const node of this.order) {
        const parts = node.group >= 0 ? this.groups[node.group].parts : null;
        for (let v = 0; v < node.inst.length; v++) {
          if (parts?.[v].skip) continue;
          const inst = node.inst[v];
          this.gather(node, inst, v, n);
          this.applyCv(node, inst, n);
          if (parts && node.flawParams.length) this.applyFlaws(node, inst, flawOf(this.groups[node.group].cfg, v));
          this.run(node, inst, parts ? parts[v] : kb, inst.out, n);
          this.guard(node, inst, n);
        }
        if (node.type === 'steps') this.locksStep(node);
      }
      if (n === BLOCK)
        this.groups.forEach((g, gi) =>
          g.parts.forEach((x, v) => {
            if (x.skip) return;
            if (!x.gate && !x.retrig && this.partQuiet(gi, v)) {
              x.idle = true;
              this.partSilence(gi, v);
            } else x.idle = false;
          }),
        );
      for (const g of all) for (const x of g.parts) { x.retrig = false; x.keyTrig = false; }
      if (this.modeParts.length) this.voicingCables();
      for (const o of this.outputs) {
        const inst = o.inst[0];
        const lvl = inst.eff.level ?? 1;
        const l = inst.inp.l;
        const r = o.connected.r ? inst.inp.r : inst.inp.l;
        for (let i = 0; i < n; i++) {
          left[off + i] += l[i] * lvl;
          right[off + i] += r[i] * lvl;
        }
      }
      if (this.once === 2 && !this.tracks.some((t) => (t.inst[0].state as StepsState).once >= 2)) {
        this.onceEnd(); // (every track played its passes: the transport stops, from the next block)
        this.running = false;
      }
      if (clickAt >= 0 || this.clickK >= 0) { // the count-in's click, on both sides (engine.c eng_click_mix the same)
        const len = Math.floor((this.sampleRate * CLICK_MS) / 1000);
        clicked = true;
        for (let i = 0; i < n; i++) {
          if (i === clickAt) (this.clickK = 0), (this.clickHalf = Math.max(1, Math.floor(this.sampleRate / (2 * (accent ? CLICK_ACCENT_HZ : CLICK_HZ)))));
          if (this.clickK < 0) continue;
          click[off + i] = clickSample(this.clickK, len, this.clickHalf);
          if (++this.clickK >= len) this.clickK = -1;
        }
      }
    }
    for (let i = 0; i < total; i++) {
      left[i] = Number.isFinite(left[i]) ? Math.max(-1, Math.min(1, left[i])) : 0;
      right[i] = Number.isFinite(right[i]) ? Math.max(-1, Math.min(1, right[i])) : 0;
    }
    if (clicked) // (after the patch is held to full scale, as the FM-1 adds it to its analog output: D-820)
      for (let i = 0; i < total; i++) {
        left[i] = Math.max(-1, Math.min(1, left[i] + click[i]));
        right[i] = Math.max(-1, Math.min(1, right[i] + click[i]));
      }
  }
}

export type { Cable };
