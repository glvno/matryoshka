// SPDX-License-Identifier: GPL-3.0-only
// Hardware-derived candidates; editor examples live separately in factory/examples.json.
import SOURCE from '../factory/bank.json';
import AUDIT from '../factory/fx-audit.json';
import { setKind, kindOf, setSwitches, setTarget, switches } from './buttons';
import { addDrawer, convertLegacyBus, insertEffect, legacyStageName, promoteLegacyRows } from './fx-drawer';
import { fxBusOf, LEGACY_STAGE_ROWS, type FxStageKind } from './fx-legacy';
import { assembliesOf, bypassAssembly, exposePort, makeAssembly, parentOf, type AssemblyInst, type RowTarget } from './assembly';
import { sharedFilterFactory } from './factory-paraphony';
import { sharedCassiaContours } from './factory-cassia-sharing';
import { sharedAlgoContours } from './factory-algo-sharing';
import { sharedArticulationFactory } from './factory-shared-articulation';
import { fitCanvasFactory } from './factory-canvas-fit';
import { FACTORY_KITS, withKitPatterns } from './factory-kit-patterns';
import { applyFactoryLayout } from './factory-layout';
import { clearAllPatterns } from './pattern-ops';
import { DEFS } from './modules';
import { addModule, connect, disconnect, removeModule, type Endpoint, type Patch } from './patch';

/** Original card bindings, including selectors controlling an existing effect. Row indices are zero-based. */
export const factoryFxAudit = AUDIT;
export const melodicFactoryNames = AUDIT.map(entry => entry.name);
export const factoryFile = (index: number, name: string): string => `${String(index).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;

export interface FactoryCandidate { name: string; patch: Patch }
export interface FactoryMeasurementOptions {
  voices?: number;
  omit?: readonly FxStageKind[];
  paraphony?: 'shared-filter' | 'shared-articulation' | 'shared-contours' | 'shared-operator4';
  harmonizer?: 'removed';
  bankName?: string;
  canvasCaptions?: 'short';
  /** A protected drum kit gains the master FX bus, its stages bypassed, with no other change (owner 2026-11-19, D-1200).
   * The only measurement option a protected patch takes, with `omit`. */
  drumRack?: true;
  /** A protected drum kit gains an FX drawer on its card of these Library effects (module types, in chain order, the
   * 1.27 forms of fx-drawer.ts insertEffect), each off, with no other change (owner via Main 2026-11-25, D-1055). The
   * only option a protected patch takes besides drumRack / omit, never with them. */
  drawer?: readonly string[];
}
export type FactoryMeasurementProfile = Readonly<Record<string, FactoryMeasurementOptions>>;

export interface SelectedFactoryOptions extends FactoryMeasurementOptions {
  configurationId: string;
  /** Owner-approved final Output that brings the patch as it is onto the factory loudness rule (#448, levels.ts): a pure
   * gain after everything, which moves every preset of the patch by the same factor. Melodic selections only. */
  outputLevel?: number;
}

/** Owner-approved factory selections.
 * Omissions apply only to added FX; intrinsic effects and original DSP remain.
 * Configuration IDs identify evidence, never runtime FX recognition.
 */
export const selectedFactoryProfile: Readonly<Record<string, SelectedFactoryOptions>> = {
  'Monolith D': { configurationId: 'selected-monolith-d' },
  'Silver Box': { configurationId: 'selected-silver-box' },
  'Shush 101': { configurationId: 'selected-shush-101' },
  // (drive joins at six voices ahead of voices 7-8: owner in chat 2026-11-15, "let's add distortion to algo four", D-1200)
  'Algo Four': { configurationId: 'algo-four-v7-drive-chorus-delay-reverb', outputLevel: 0.88 },
  'Oracle V': { omit: ['drive'], configurationId: 'oracle-v-v4-chorus-delay-reverb' },
  Canvas: { omit: ['drive', 'chorus', 'reverb'], harmonizer: 'removed', canvasCaptions: 'short', configurationId: 'canvas-original-delay-no-harm' },
  'Expander S': { configurationId: 'expander-s-v4-drive-chorus-delay-reverb', outputLevel: 0.68 },
  // (drive omitted to make room for the pin board's tile names: owner in chat 2026-11-15, "briefcase 3: drop drive", D-1052)
  'Briefcase 3': { omit: ['drive'], harmonizer: 'removed', configurationId: 'briefcase-3-pin-board-chorus-delay-no-harm' },
  // (each of the next four gains its missing stage, bypassed, so its presets sound as before: issue #937, D-1200)
  Wanderer: { configurationId: 'wanderer-v2-drive-chorus-delay-reverb' },
  // (drive joins at four voices, as the fifth voice does not fit: owner in chat 2026-11-16, "agree with amended effects order", D-1200)
  'Cassia 1': { configurationId: 'cassia-1-v5-drive-chorus-delay-reverb' },
  'Vernon 100': { configurationId: 'vernon-100-v2-drive-chorus-delay-reverb' },
  'Sallen 20': { harmonizer: 'removed', configurationId: 'sallen-20-v2-drive-chorus-delay-reverb-no-harm' },
  // (drive joins beside its own Juno chorus, Delay and Reverb, bypassed, at six voices: owner 2026-11-19, D-1200)
  'Hera 4': { bankName: 'Hera 6', configurationId: 'hera-6-v6-drive-chorus-delay-reverb', outputLevel: 0.39 },
  'Io 4': { configurationId: 'selected-io-4' },
  // (a shared rack on the FX page, Drive and Reverb, every stage bypassed: owner 2026-11-19, D-1200. No chorus, and Delay
  // does not fit the FM-1's 3,840 bytes beside them)
  '808 Kit': { drumRack: true, omit: ['chorus', 'delay'], configurationId: '808-kit-drive-reverb' },
  // (an FX drawer on the kit card, a stereo Drive and a crossfading Reverb, both off: owner via Main 2026-11-25, D-1055)
  '909 Kit': { drawer: ['shape', 'reverb'], configurationId: '909-kit-drawer-drive-reverb' },
};

/** Selected names in source order, without building the patch graphs. */
export const selectedFactoryNames = SOURCE.map(({ name }) => selectedFactoryProfile[name]?.bankName ?? name);

/** The approved bank shared by browser defaults, numeric exports and firmware. The patches of UNSHIPPED_PATTERNS ship
 *  without their patterns and songs; `full` keeps them, as bank.json holds them (test and measurement material only). Each
 *  patch's top-level cards sit as Tidy lays them out (factory-layout.ts), which sets its FM-1 page order too */
export function buildSelectedFactoryBank(opts: { full?: boolean } = {}): FactoryCandidate[] {
  const measurements = Object.fromEntries(Object.entries(selectedFactoryProfile).map(([name, { configurationId: _id, outputLevel: _level, ...options }]) => [name, options]));
  const bank = buildFactoryBank(measurements);
  for (const [sourceName, options] of Object.entries(selectedFactoryProfile)) {
    if (options.outputLevel === undefined) continue;
    if (!AUDIT.some(entry => entry.name === sourceName)) throw new Error(`${sourceName}: protected drums/drones keep their source Output`);
    if (!Number.isFinite(options.outputLevel) || options.outputLevel <= 0 || options.outputLevel > 1)
      throw new Error(`${sourceName}: selected Output must be within the Output's range`);
    const patch = bank.find(entry => entry.name === (options.bankName ?? sourceName))!.patch;
    patch.modules.find(module => module.type === 'output')!.params.level = options.outputLevel;
  }
  for (const c of bank) applyFactoryLayout(c.patch, c.name);
  return opts.full ? bank : shippedFactoryBank(bank);
}

/** the factory patches that ship without the patterns and songs they had up to 1.24.1 (owner 2026-11-21, #1202 G8). The
 *  bank in full keeps them only as test and measurement material: the CPU checks, the level and headroom checks, the golden
 *  kits and the kits' own tests play the patches with them, as the owner heard them */
export const UNSHIPPED_PATTERNS: readonly string[] = ['808 Kit', '909 Kit', 'Verona Drum 1', 'Scrounge', 'Silver Box'];

/** the bank as it ships, from the bank in full: each patch of UNSHIPPED_PATTERNS without its patterns and songs */
export function shippedFactoryBank(full: readonly FactoryCandidate[]): FactoryCandidate[] {
  for (const name of UNSHIPPED_PATTERNS) if (!full.some((c) => c.name === name)) throw new Error(`${name}: no such factory patch`);
  return full.map((c) => {
    if (!UNSHIPPED_PATTERNS.includes(c.name)) return c;
    const patch = structuredClone(c.patch);
    clearAllPatterns(patch);
    return { name: c.name, patch };
  });
}

/** Explicit measurement reductions only; the unselected bank retains every original allocation and interface. */
function reduceVoices(p: Patch, voices: number, minimum: number): void {
  const poly = p.modules.filter(m => m.type === 'alloc' && m.params.voices > 1);
  if (!Number.isInteger(voices) || voices < minimum || !poly.length || poly.some(m => voices > m.params.voices)) {
    throw new Error(`${p.name}: voices must be an integer from ${minimum} through each original polyphonic allocation`);
  }
  for (const m of poly) {
    m.params.voices = voices;
    for (const a of p.assemblies ?? []) {
      for (const row of a.params) {
        if (row.module === m.id && row.param === 'voices') row.top = Math.min(row.top ?? voices, voices);
      }
    }
  }
}

/** Remove the mono chord player without removing Steps, Arp or their key path. */
function removeHarmony(p: Patch): void {
  for (const harm of p.modules.filter(m => m.type === 'harm')) {
    const inputs = p.cables.filter(c => c.to.module === harm.id);
    const outputs = p.cables.filter(c => c.from.module === harm.id);
    if (inputs.length !== 1 || inputs[0].to.port !== 'keys' || outputs.some(c => c.from.port !== 'keys' || c.to.port !== 'keys')) {
      throw new Error(`${p.name}: unsupported Harmony keys route`);
    }
    const from = { ...inputs[0].from }, destinations = outputs.map(c => ({ ...c.to }));
    for (const m of p.modules) {
      const panel = m.panel;
      if (!panel) continue;
      for (const [key, target] of Object.entries(panel.targets ?? {})) if ('module' in target && target.module === harm.id) {
        panel.toggle = panel.toggle?.filter(k => k !== key);
        panel.on = panel.on?.filter(k => k !== key);
        delete panel.targets?.[key];
        if (panel.kinds) panel.kinds[key] = 'nothing';
        delete panel.labels?.[key];
        delete panel.pages?.[key];
      }
    }
    removeModule(p, harm.id);
    for (const to of destinations) if (!connect(p, DEFS, from, to)) throw new Error(`${p.name}: cannot reconnect Harmony keys`);
  }
}

/** Build unqualified candidates, optionally reducing polyphony or omitting additional new FX for measurement. */
export function buildFactoryBank(profile: FactoryMeasurementProfile = {}): FactoryCandidate[] {
  for (const name of Object.keys(profile)) {
    if (!SOURCE.some(entry => entry.name === name)) throw new Error(`Unknown factory candidate: ${name}`);
    if (profile[name].omit?.some(kind => !['drive', 'chorus', 'delay', 'reverb'].includes(kind))) {
      throw new Error(`${name}: unknown omitted FX stage`);
    }
  }
  const names = SOURCE.map(entry => profile[entry.name]?.bankName ?? entry.name);
  if (names.some(name => !name.trim()) || new Set(names).size !== names.length) throw new Error('Factory bank names must be nonempty and unique');
  return SOURCE.map(({ name, patch }: { name: string; patch: unknown }) => {
    let p = name === 'Canvas' ? fitCanvasFactory(patch as Patch) : structuredClone(patch) as Patch;
    const audit = AUDIT.find(entry => entry.name === name);
    const options = profile[name];
    const keys = Object.keys(options ?? {});
    const allowed = options?.drawer ? ['drawer'] : options?.drumRack ? ['drumRack', 'omit'] : [];
    if (!audit && keys.some(key => !allowed.includes(key))) {
      throw new Error(`${name}: protected drums/drones cannot use a measurement profile`);
    }
    if ((options?.drumRack || options?.drawer) && !FACTORY_KITS.some(kit => kit.patch === name)) throw new Error(`${name}: a drum rack needs a factory drum kit`);
    if (options?.harmonizer && (!audit || audit.voices.length !== 1 || audit.voices[0].voices !== 1)) {
      throw new Error(`${name}: Harmony removal is limited to originally monophonic instruments`);
    }
    if (options?.canvasCaptions && name !== 'Canvas') throw new Error(`${name}: Canvas captions require Canvas`);
    if (options?.voices !== undefined) reduceVoices(p, options.voices, name === 'Expander S' ? 1 : 3);
    // Protected drums/drones never pass through validation, FX, player or button rewriting; a drum kit gets its pattern set
    // and, when selected, the factory FX drawer (nothing else of the kit changes).
    if (!audit) {
      const kit = withKitPatterns(p);
      return { name, patch: options?.drumRack ? withFxDrawer(kit, options.omit ?? []) : options?.drawer ? withKitDrawer(kit, options.drawer) : kit };
    }
    if (options?.paraphony === 'shared-filter') p = sharedFilterFactory(p);
    else if (options?.paraphony === 'shared-articulation') p = sharedArticulationFactory(p);
    else if (options?.paraphony === 'shared-contours' && name === 'Cassia 1') p = sharedCassiaContours(p);
    else if (options?.paraphony === 'shared-contours' && name === 'Algo Four') p = sharedAlgoContours(p);
    else if (options?.paraphony === 'shared-operator4' && name === 'Algo Four') p = sharedAlgoContours(p, '4');
    else if (options?.paraphony) throw new Error(`${name}: unsupported sharing trial ${options.paraphony}`);
    const main = p.modules.find(m => m.type === 'fm1')!;
    const arp = p.modules.find(m => m.type === 'arp')!;
    let harmony = p.modules.find(m => m.type === 'harm');
    if (!harmony) {
      const feed = p.cables.find(c => c.to.module === arp.id && c.to.port === 'keys')!;
      let track = p.modules.find(m => m.id === feed.from.module && m.type === 'steps');
      if (!track) {
        track = addModule(p, DEFS.steps, 20, Math.max(...p.modules.map(m => m.y)) + 300);
        track.name = 'PATTERN';
        track.notes = [];
        disconnect(p, feed);
        connect(p, DEFS, feed.from, { module: track.id, port: 'keys' });
      } else {
        disconnect(p, feed);
      }
      harmony = addModule(p, DEFS.harm, track.x + 380, track.y);
      harmony.params.type = 0;
      connect(p, DEFS, { module: track.id, port: 'keys' }, { module: harmony.id, port: 'keys' });
      connect(p, DEFS, { module: harmony.id, port: 'keys' }, { module: arp.id, port: 'keys' });
    }
    harmony.bypass = true;
    arp.bypass = true;
    // Harmony vacates the prototype's EDIT binding.
    const editTarget = main.panel?.targets?.edit;
    if (editTarget && 'module' in editTarget && editTarget.module === harmony.id) {
      setKind(p, 'edit', 'nothing');
      delete main.panel!.labels?.edit;
    }
    setKind(p, 'arp', 'bypass');
    setTarget(p, 'arp', { module: arp.id });
    setSwitches(p, 'arp', true);
    setKind(p, 'lfo', 'bypass');
    setTarget(p, 'lfo', { module: harmony.id });
    setSwitches(p, 'lfo', true);
    main.panel!.labels = { ...main.panel?.labels, lfo: 'BYP HARM' };
    // Preserve Sallen's SWITCH and Canvas's PULSER gate on EDIT; FX always opens the FX drawer.
    const fxCables = p.cables.filter(c => c.from.module === main.id && c.from.port === 'fx');
    if (fxCables.length) {
      setKind(p, 'edit', kindOf(main.panel, 'fx'));
      setSwitches(p, 'edit', switches(main.panel, 'fx'));
      if (main.panel?.on?.includes('fx')) main.panel.on.push('edit');
      main.panel!.labels!.edit = main.panel?.labels?.fx ?? 'PULSER';
      delete main.panel!.labels!.fx;
      for (const cable of fxCables) cable.from.port = 'edit';
    }
    p = withFxDrawer(p, [...new Set([...(audit.omit as FxStageKind[]), ...(options?.omit ?? [])])]);
    if (options?.harmonizer === 'removed') removeHarmony(p);
    if (options?.canvasCaptions) p = fitCanvasFactory(p, options.canvasCaptions);
    if (options?.bankName) {
      p.name = options.bankName;
      for (const a of p.assemblies ?? []) if (a.label === name) a.label = options.bankName;
    }
    return { name: options?.bankName ?? name, patch: p };
  });
}

/** The factory FX (D-888): the master FX bus without the omitted stages, every stage bypassed, made into an FX drawer
 * (fx-drawer.ts convertLegacyBus), so the patch plays sample for sample as the bus did; the FM-1's FX button opens it. */
function withFxDrawer(source: Patch, omit: readonly FxStageKind[]): Patch {
  const main = source.modules.find(m => m.type === 'fm1')!;
  if (source.cables.some(c => c.from.module === main.id && c.from.port === 'fx')) throw new Error(`${source.name}: FX is cabled`);
  return convertLegacyBus(withFxBus(source, { omit }));
}

/** A kit's FX drawer of the 1.27 forms on its one card: `types`' Library effects in chain order, each off (its switch's
 * own form, bypassAssembly: none of its members was off, so all come back with it). Off, the kit plays sample for sample
 * as without it (kit-drawer.test.ts); the FM-1's FX button opens the rack. */
function withKitDrawer(p: Patch, types: readonly string[]): Patch {
  const cards = assembliesOf(p).filter((a) => !parentOf(p, a.id) && !a.drawer && !a.chain);
  if (cards.length !== 1) throw new Error(`${p.name}: a kit's FX drawer is for its one card`);
  const drawer = addDrawer(p, cards[0].id);
  for (const type of types) {
    const e = insertEffect(p, drawer, { type });
    bypassAssembly(p, e, true);
    // (`kept` after `bypass`, as the editor's card check writes them: the factory patch is what the editor opens, #465)
    const kept = e.kept!;
    delete e.kept;
    e.kept = kept;
  }
  return p;
}

const BUS_KINDS: readonly FxStageKind[] = ['drive', 'chorus', 'delay', 'reverb'];

/**
 * The factory master FX bus of D-888 as the releases before 1.26.3 built it (the stages but the omitted ones, every
 * stage bypassed; omit all four to leave the graph unchanged). The factory patches and the golden kits that had one make
 * it, then turn it into an FX drawer (fx-drawer.ts convertLegacyBus): the same modules in the same order with the same
 * cables, so they play sample for sample as before (scripts/fxdrawer-proof.ts).
 */
export function withFxBus(source: Patch, options: { omit?: readonly FxStageKind[] } = {}): Patch {
  const p: Patch = structuredClone(source);
  if (fxBusOf(p, DEFS)) return p;
  const kinds = BUS_KINDS.filter((kind) => !options.omit?.includes(kind));
  if (!kinds.length) return p;
  const outputs = p.modules.filter((m) => m.type === 'output');
  if (outputs.length !== 1) throw new Error('FX bus needs exactly one master Output');
  const output = outputs[0];
  const original = p.cables.filter((c) => c.to.module === output.id && (c.to.port === 'l' || c.to.port === 'r'));
  const left = original.filter((c) => c.to.port === 'l');
  const right = original.filter((c) => c.to.port === 'r');
  if (!left.length && !right.length) throw new Error('FX bus needs a connected master Output');
  const x = Math.max(...p.modules.map((m) => m.x), 0) + 320;
  const y = Math.min(...p.modules.map((m) => m.y), 20);
  const end = (module: number, port: string): Endpoint => ({ module, port });
  // Direct members precede stage members, preserving one contiguous allModules device-member run.
  const corrections = new Map<FxStageKind, number>();
  for (const kind of kinds.filter((k) => k === 'chorus' || k === 'delay')) {
    const m = addModule(p, DEFS.math, x + corrections.size * 320, y + 1680);
    Object.assign(m.params, { ka: 0.25, kb: 0.25, off: 0 });
    corrections.set(kind, m.id);
  }
  const wire = (from: Endpoint, to: Endpoint): void => {
    if (!connect(p, DEFS, from, to)) throw new Error(`Cannot connect FX bus ${from.module}:${from.port} to ${to.module}:${to.port}`);
  };
  const stages: { kind: FxStageKind; members: number[]; inputs: Endpoint[]; rows: RowTarget[][] }[] = [];
  let previous: Endpoint[][] = [];
  for (const [i, kind] of kinds.entries()) {
    let members: number[];
    let inputs: Endpoint[];
    let rows: RowTarget[][];
    let next: Endpoint[][];
    if (kind === 'reverb') {
      const kernel = addModule(p, DEFS.reverb, x + i * 320, y);
      kernel.params.mix = 1;
      const dry = [0, 1].map((ch) => addModule(p, DEFS.scale, x + i * 320, y + (ch + 1) * 280));
      const send = addModule(p, DEFS.math, x + i * 320, y + 840);
      Object.assign(send.params, { ka: 0.5, kb: 0.5, off: 0 });
      const mix = addModule(p, DEFS.macro, x + i * 320, y + 1120);
      mix.params.value = DEFS.reverb.params.find((pd) => pd.name === 'mix')!.default;
      const wet = addModule(p, DEFS.math, x + i * 320, y + 1400);
      Object.assign(wet.params, { ka: 1, kb: 1, off: 0 });
      members = [kernel.id, ...dry.map((m) => m.id), send.id, mix.id, wet.id];
      for (const id of members) p.modules.find((m) => m.id === id)!.bypass = true;
      dry.forEach((m, ch) => wire(end(m.id, 'out'), end(send.id, ch ? 'b' : 'a')));
      wire(end(send.id, 'add'), end(kernel.id, 'in'));
      wire(end(kernel.id, 'out'), end(wet.id, 'a'));
      wire(end(mix.id, 'out'), end(wet.id, 'b'));
      inputs = dry.map((m) => end(m.id, 'in'));
      // The dry channels never collapse or depend on the wet control. Generic Math bypass silences the wet return.
      next = dry.map((m) => [end(m.id, 'out'), end(wet.id, 'mul')]);
      rows = LEGACY_STAGE_ROWS.reverb.map((param) => [{ module: param === 'mix' ? mix.id : kernel.id, param: param === 'mix' ? 'value' : param }]);
    } else {
      const targets = [0, 1].map((ch) => {
        const m = addModule(p, DEFS[kind === 'drive' ? 'shape' : kind], x + i * 320, y + ch * 560);
        m.bypass = true;
        if (kind === 'drive') Object.assign(m.params, { drive: 1, level: 1 });
        if (kind === 'delay') Object.assign(m.params, { length: 500, rate: 0 });
        return m.id;
      });
      members = targets;
      inputs = targets.map((id) => end(id, 'in'));
      rows = LEGACY_STAGE_ROWS[kind].map((param) => targets.map((module) => ({ module, param })));
      if (kind === 'chorus' || kind === 'delay') {
        // C=.25*(Ar+Bl-Al-Br); L=Al+C, R=Br+C. Native stereo on mono, identity at every bypassed mix.
        const [first, second] = kind === 'chorus' ? ['l', 'r'] : ['out', 'r'];
        const [a, b] = targets;
        const taps = [end(a, first), end(a, second), end(b, first), end(b, second)];
        const helper = corrections.get(kind)!;
        for (const tap of [taps[1], taps[2]]) wire(tap, end(helper, 'a'));
        for (const tap of [taps[0], taps[3]]) wire(tap, end(helper, 'b'));
        next = [[taps[0], end(helper, 'sub')], [taps[3], end(helper, 'sub')]];
      } else next = targets.map((id) => [end(id, 'out')]);
    }
    if (previous.length) inputs.forEach((to, ch) => previous[ch].forEach((from) => wire(from, to)));
    else [left, right.length ? right : left].forEach((cables, ch) => cables.forEach((c) => wire(c.from, inputs[ch])));
    previous = next;
    stages.push({ kind, members, inputs, rows });
  }
  for (const c of original) disconnect(p, c);
  previous.forEach((sources, ch) => sources.forEach((from) => wire(from, end(output.id, ch ? 'r' : 'l'))));
  const children = stages.map((stage) => {
    const a = makeAssembly(p, stage.members, legacyStageName(stage.kind));
    promoteLegacyRows(p, a, stage.rows, stage.kind);
    for (const input of stage.inputs) exposePort(a, 'in', input.module, input.port);
    // The group switch's own form (bypassAssembly): no member was off before it, so all come back on with it.
    a.bypass = true;
    a.kept = [];
    return a;
  });
  const root = makeAssembly(p, [...corrections.values()], 'FX', children.map((a) => a.id));
  for (const input of stages[0].inputs) exposePort(root, 'in', input.module, input.port, undefined, p);
  for (const stage of stages) {
    promoteLegacyRows(p, root, stage.rows, stage.kind);
    root.params.find((r) => r.module === stage.rows[0][0].module)!.head = legacyStageName(stage.kind);
  }
  if (!fxBusOf(p, DEFS)) throw new Error('FX bus construction did not produce a proven stereo master insert');
  return p;
}
