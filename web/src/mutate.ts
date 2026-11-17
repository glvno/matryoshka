// SPDX-License-Identifier: GPL-3.0-only
// Mutate and Randomize (#944, #1006): new values for the parameters of the chosen cards, as a sound-design tool. Mutate
// moves about one row in four (MUTATE_SHARE, at least MUTATE_LEAST), each by up to ± the amount of its range, and changes a
// switch or a choice with a chance equal to the amount; Randomize puts every row anywhere in its range. Both move in the
// space macro ranges and the morph move in (octaves for a logarithmic parameter, paramUnit), stay between a macro range's
// From and To, keep to the row's range (rowRange) and steps (stepToward), never reach a stretch past max, and leave alone
// what is locked, what the FM-1 sets when the patch loads, and the modules that play rather than sound (MUTATE_SKIP). A
// level row never ends above the larger of its value and its default, so a result is never suddenly loud. Pitch rows
// (pitchRows) stay as they are unless "Mutate pitch" is on, and then move only by musical steps. A row of an engine with
// factory presets may take a preset's value instead of noise (MutateOptions.pools). A category (#1033) brings the rows
// whose role the wiring shows (roleRows: envelopes, cutoff, glide) into its profile's ranges (PROFILES) and leans the
// timbre its way. Make candidates with two or more keeps breeds (breedPatch). The editor applies the result as one undo
// step (Editor.mutate, Editor.makeCandidates). D-975, D-987, D-994, D-995.
import { assembliesOf, tiedTo, toDef, type AssemblyInst, type RowTarget } from './assembly';
import { ADSR_LONG, env8End, env8Sus, RATIOS, rowRange, SELECT_N, selectPos } from './modules';
import { INCREMENTS, RATE_CLOCK } from './rate-envelope';
import { LEVEL_ROWS } from './levels';
import { cardRows } from './preset-cards';
import { modulate, paramUnit, paramValue, rangeShare, topOf, type Cable, type ModuleDef, type ModuleInst, type ParamDef, type Patch } from './patch';
import { stepToward } from './value-input';

export type MutateMode = 'mutate' | 'randomize';

/** the amounts Mutate offers, a share of each parameter's range */
export const MUTATE_AMOUNTS = [0.05, 0.1, 0.25, 0.5] as const;
/** the amount until the user picks another (kept per browser by the host) */
export const MUTATE_DEFAULT = 0.1;
/** Mutate: the chance each row that is not a switch moves */
export const MUTATE_SHARE = 0.25;
/** Mutate: the fewest rows that move, when that many can */
export const MUTATE_LEAST = 2;
/** the chance a moving row of an engine with factory presets takes the value of one of them instead of noise */
export const PRESET_DRAW = 0.5;

/** the modules that play, route or show rather than sound: Mutate and Randomize never move them (Main's tempo, the master
 * level, the voices and key range, a pattern's length and rate, the arpeggio, the drum notes, the chords, a Scope) */
export const MUTATE_SKIP: Record<string, true> = { fm1: true, output: true, alloc: true, steps: true, arp: true, drummap: true, harm: true, scope: true, part: true };

/** the level rows besides `level` itself: the Mixer's inputs, the VCA's gain, the Dynamics' make-up gain */
const LEVELS: Record<string, readonly string[]> = { mixer: ['l1', 'l2', 'l3', 'l4'], vca: ['gain'], dyn: ['gain'] };
/** a level row: Mutate and Randomize never raise it above the larger of its value and its default */
export const isLevel = (type: string, param: string): boolean => param === 'level' || !!LEVELS[type]?.includes(param);

/** a switch or a choice: a toggle, a choice list, or a small whole-number row with no unit (a voice count, a Selector's
 *  position, a sequence's length) */
export const isSwitch = (pd: ParamDef): boolean => !!pd.toggle || !!pd.choices || ((pd.step ?? 0) >= 1 && !pd.unit && pd.max - pd.min <= 16);

/** how a pitch row moves with "Mutate pitch" on: a parameter's own `pitch` (patch.ts), or `offset` for a value row that adds
 *  octaves to a pitch (by an octave, a fifth up or a fourth down); `held` never moves */
export type PitchKind = NonNullable<ParamDef['pitch']> | 'offset';

/** the inputs that set a pitch */
const PITCH_INPUTS: Record<string, readonly string[]> = { osc: ['pitch'], string: ['pitch'], wavetable: ['pitch'], grain: ['pitch'], comb: ['pitch'], modal: ['pitch'], pd: ['pitch'], steps: ['transpose'] };
/** the modules a pitch passes through on its way to a pitch input (through their signal inputs) */
const THROUGH: Record<string, true> = { scale: true, math: true, select: true, range: true, matrix: true, mixer: true, glide: true, quant: true, sh: true, shreg: true, xfade: true };
/** inputs that pass no pitch through a module: positions, clocks, triggers, the parameter inputs */
const NOT_THROUGH: Record<string, true> = { pos: true, clock: true, reset: true, trig: true, gate: true, p1: true, p2: true };
/** the rows of a value module that carry its output's pitch when it reaches a pitch input: `offset` adds octaves, `held`
 *  scales or picks (a gain, a Selector's position, a Quantizer's scale), which no musical step keeps in tune */
const VALUE_ROWS: Record<string, (param: string) => PitchKind | undefined> = {
  const: (q) => (q === 'value' ? 'offset' : undefined),
  scale: (q) => (q === 'offset' ? 'offset' : q === 'gain' ? 'held' : undefined),
  math: (q) => (q === 'off' ? 'offset' : q === 'ka' || q === 'kb' ? 'held' : undefined),
  select: (q) => (/^v\d+$/.test(q) ? 'offset' : q === 'pos' || q === 'count' ? 'held' : undefined),
  seq: (q) => (/^s\d+$/.test(q) ? 'offset' : undefined),
  range: (q) => (['inlo', 'inhi', 'outlo', 'outhi', 'curve'].includes(q) ? 'held' : undefined),
  matrix: () => 'held',
  mixer: (q) => (/^l\d$/.test(q) ? 'held' : undefined),
  quant: (q) => (q === 'scale' || q === 'root' ? 'held' : undefined),
};

/**
 * The pitch rows of `p`: a parameter marked `pitch` in its definition, and a value row (VALUE_ROWS) of a module whose
 * output reaches a pitch input, directly, through other modules a pitch passes through, or through a parameter input
 * mapped to a pitch row. Undefined: not a pitch row.
 */
export function pitchRows(p: Patch, defs: Record<string, ModuleDef>): (m: ModuleInst, param: string) => PitchKind | undefined {
  return pitchPaths(p, defs).kind;
}

/** pitchRows, with the modules whose output reaches a pitch input (`reach`) */
function pitchPaths(p: Patch, defs: Record<string, ModuleDef>): { reach: Set<number>; kind: (m: ModuleInst, param: string) => PitchKind | undefined } {
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  const reach = new Set<number>();
  const kind = (m: ModuleInst, param: string): PitchKind | undefined =>
    defs[m.type]?.params.find((q) => q.name === param)?.pitch ?? (reach.has(m.id) ? VALUE_ROWS[m.type]?.(param) : undefined);
  const feedsPitch = (c: Cable): boolean => {
    const to = byId.get(c.to.module);
    if (!to) return false;
    if (PITCH_INPUTS[to.type]?.includes(c.to.port)) return true;
    if (c.to.port === 'p1' || c.to.port === 'p2') return !!to.map?.[c.to.port]?.some((q) => kind(to, q) !== undefined);
    return reach.has(to.id) && !!THROUGH[to.type] && !NOT_THROUGH[c.to.port];
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const c of p.cables) if (!reach.has(c.from.module) && feedsPitch(c)) reach.add(c.from.module), (grew = true);
  }
  return { reach, kind };
}

/** is this parameter locked: on its own (the row's ⋮ menu), by its card, or by an assembly it is a member of (at any depth) */
export function isLocked(p: Patch, m: ModuleInst, param: string): boolean {
  if (m.mutateLockAll || m.mutateLock?.includes(param)) return true;
  const asms = assembliesOf(p);
  const seen = new Set<AssemblyInst>();
  for (let a = asms.find((x) => x.modules.includes(m.id)); a && !seen.has(a); a = asms.find((x) => x.children?.includes(a!.id))) {
    if (a.mutateLockAll) return true;
    seen.add(a);
  }
  return false;
}

/** lock or unlock one parameter (its ⋮ menu); false when nothing changed */
export function setParamLock(m: ModuleInst, param: string, on: boolean): boolean {
  const list = m.mutateLock ?? [];
  if (list.includes(param) === on) return false;
  const next = on ? [...list, param] : list.filter((x) => x !== param);
  if (next.length) m.mutateLock = next;
  else delete m.mutateLock;
  return true;
}

/** the cards Mutate and Randomize act on: module cards (every parameter of each) and assembly cards (the rows each shows) */
export interface MutateScope { modules: number[]; assemblies: number[] }

/** the cards Make candidates acts on with none selected: every module card outside an assembly and every top-level assembly
 *  card (its rows). The modules inside an assembly move only when their own card is selected (D-987). */
export function cardScope(p: Patch): MutateScope {
  const asms = assembliesOf(p);
  const inside = new Set(asms.flatMap((a) => a.modules));
  const nested = new Set(asms.flatMap((a) => a.children ?? []));
  return { modules: p.modules.filter((m) => !inside.has(m.id)).map((m) => m.id), assemblies: asms.filter((a) => !nested.has(a.id)).map((a) => a.id) };
}

export interface MutateOptions {
  /** "Mutate pitch" is on: pitch rows move, by musical steps only */
  pitch?: boolean;
  /** Mutate: the chance each row that is not a switch moves (MUTATE_SHARE) */
  share?: number;
  /** the values an engine's factory presets give a row, by `module:param`: a row that moves takes one of them with the
   *  chance PRESET_DRAW instead of noise (never a pitch row) */
  pools?: ReadonlyMap<string, readonly number[]>;
  /** the sound category aimed at (#1033): its role rows go into its ranges (PROFILES) and timbre leans its way; absent or
   *  'any': no aim */
  category?: Category;
  /** the patch a category's cutoff range is measured from (the patch before a run of Mutates, the parent of candidates);
   *  absent: the patch mutated */
  anchor?: Patch;
}

export interface MutateResult {
  /** the patch with the new values (a copy; the input is left alone) */
  patch: Patch;
  /** how many parameters changed */
  moved: number;
  /** with a category: how many rows (or tied rows) in the scope it gave a range (role rows) */
  roles?: number;
}

const key = (t: RowTarget): string => `${t.module}:${t.param}`;

/** engine card rows that set up the instrument rather than its sound, by the last part of their card key: a reference tone
 *  (Monolith D's A-440), the voice mode and assignment, and the keyboard's octave */
export const HOLD_ROWS = /^(a-440|poly\/mono|unison|assign|octave)$/;

/** the engine card rows Mutate, Randomize, preset draws and breeding never move (#1020): each factory engine's output
 *  level rows (levels.ts LEVEL_ROWS, set per preset by the factory loudness rule) and the set-up rows of HOLD_ROWS */
export function heldRows(p: Patch): Set<string> {
  const held = new Set<string>();
  for (const a of assembliesOf(p)) {
    const levels = LEVEL_ROWS[a.name ?? ''] ?? [];
    for (const r of cardRows(toDef(p, a))) {
      const last = r.key.split(' / ').pop() ?? '';
      if (levels.includes(r.key) || HOLD_ROWS.test(last)) held.add(key(a.params[r.i]));
    }
  }
  return held;
}

// ---- steer by role (#1033): a category aims Mutate and Make candidates at a kind of sound. Each row's role comes from the
// wiring, as a pitch row's does: the loudness envelope (it reaches a VCA on the way from a sound source to the Output), the
// tone envelope (it reaches a filter's cutoff, a PD Osc's DCW or the level of an FM modulator), the cutoff of a filter on
// that way, and the time of a slew limiter on the way to a pitch input. A category gives each role a range (PROFILES).

/** the sound categories; 'any' aims at nothing (Mutate as without a category) */
export const CATEGORIES = ['any', 'lead', 'stab', 'pluck', 'pad', 'bass', 'keys', 'drone'] as const;
export type Category = (typeof CATEGORIES)[number];
/** an envelope's job: the sound's loudness, or its tone */
export type EnvRole = 'amp' | 'tone';
/** an envelope's stages: attack, decay, sustain, release */
export type Stage = 'a' | 'd' | 's' | 'r';
export type Role = `${EnvRole}-${Stage}` | 'cutoff' | 'glide';
/** a low and a high end */
export type Span = readonly [number, number];

/** a category's ranges: envelope times in seconds (an attack's rise; a decay's or release's fall of 99 %, 40 dB), sustain
 *  levels 0..1, the cutoff in octaves from the anchor's (MutateOptions.anchor), the glide time in seconds. `nudge` (-1..1)
 *  leans the timbre rows of BRIGHT darker or brighter. */
export interface Profile { amp: Record<Stage, Span>; tone: Record<Stage, Span>; cutoff: Span; glide: Span; nudge: number }

/** each category's profile (docs/measurements/2026-11-17-mutate-categories.md) */
export const PROFILES: Record<Exclude<Category, 'any'>, Profile> = {
  lead: { amp: { a: [0.001, 0.03], d: [0.1, 1], s: [0.6, 1], r: [0.03, 0.4] }, tone: { a: [0.001, 0.05], d: [0.1, 0.8], s: [0.3, 0.8], r: [0.05, 0.5] }, cutoff: [0, 1], glide: [0.001, 0.12], nudge: 1 },
  stab: { amp: { a: [0.001, 0.01], d: [0.08, 0.4], s: [0, 0.3], r: [0.03, 0.25] }, tone: { a: [0.001, 0.01], d: [0.05, 0.3], s: [0, 0.25], r: [0.03, 0.25] }, cutoff: [-0.25, 1], glide: [0.001, 0.01], nudge: 0.5 },
  pluck: { amp: { a: [0.001, 0.008], d: [0.15, 0.8], s: [0, 0.1], r: [0.08, 0.5] }, tone: { a: [0.001, 0.008], d: [0.06, 0.5], s: [0, 0.15], r: [0.05, 0.4] }, cutoff: [-0.5, 0.5], glide: [0.001, 0.01], nudge: 0.5 },
  pad: { amp: { a: [0.3, 2.5], d: [0.5, 3], s: [0.6, 1], r: [0.8, 4] }, tone: { a: [0.2, 3], d: [0.5, 4], s: [0.4, 1], r: [0.8, 4] }, cutoff: [-1.5, 0], glide: [0.001, 0.3], nudge: -1 },
  bass: { amp: { a: [0.001, 0.01], d: [0.1, 0.8], s: [0.4, 1], r: [0.02, 0.2] }, tone: { a: [0.001, 0.01], d: [0.08, 0.6], s: [0, 0.4], r: [0.02, 0.25] }, cutoff: [-1.5, 0], glide: [0.001, 0.08], nudge: -0.5 },
  keys: { amp: { a: [0.001, 0.012], d: [0.4, 2.5], s: [0.15, 0.6], r: [0.15, 0.8] }, tone: { a: [0.001, 0.02], d: [0.3, 2], s: [0.1, 0.5], r: [0.1, 0.8] }, cutoff: [-0.5, 0.5], glide: [0.001, 0.01], nudge: 0 },
  drone: { amp: { a: [0.5, 4], d: [1, 5], s: [0.85, 1], r: [1.5, 8] }, tone: { a: [1, 5], d: [1, 5], s: [0.5, 1], r: [1.5, 8] }, cutoff: [-1, 0.25], glide: [0.001, 0.6], nudge: -0.5 },
};

/** the timbre rows a category leans (Profile.nudge): 1, brighter as the row rises; -1, darker */
export const BRIGHT: Record<string, Record<string, 1 | -1>> = {
  osc: { pm: 1, pm2: 1, pm3: 1, fb: 1 }, pd: { dcw: 1 }, wavetable: { pm: 1 }, shape: { drive: 1 }, filter: { cutoff: 1, drive: 1 },
  ladder: { cutoff: 1, drive: 1 }, reverb: { damp: -1 }, string: { damp: -1 }, comb: { damp: -1 }, modal: { bright: 1, damp: -1 },
};
/** how far a category leans a timbre row, a share of the amount */
const LEAN = 0.5;

/** a role row: its role and what a value means for that role (seconds, a level, Hz), rising or falling with the value */
export interface RoleRow { role: Role; measure: (v: number) => number }

/** the roles of a patch's rows. A measure reads the patch's other values as they are when it is called, so a row moved
 *  before (a Long switch, a Selector that adds to a release) counts. */
export interface Roles {
  of(m: ModuleInst, param: string): RoleRow | undefined;
  /** every role of a row: a Macro that sets an envelope's decay and release through its parameter inputs has both */
  all(m: ModuleInst, param: string): RoleRow[];
  /** the rows a category holds: an envelope's switches that change which rows play which stage, a glide's fall time */
  holds(m: ModuleInst, param: string): boolean;
  /** each envelope with a role, by module id */
  envelopes: Map<number, EnvRole>;
}

/** the envelope modules */
export const ENVELOPES: Record<string, true> = { adsr: true, env: true, env8: true, rateenv: true };
/** the envelope switches a category holds: they change which rows play which stage (ADSR's Long only stretches the times,
 *  so it may move) */
const ENV_SHAPE: Record<string, readonly string[]> = { adsr: ['ads'], env8: ['sus', 'end'] };
/** the modules that make a sound from nothing */
const SOURCES: Record<string, true> = { osc: true, noise: true, wavetable: true, pd: true, string: true };
/** the modules whose output keeps moving by itself (a modulation source) */
const MOVING: Record<string, true> = { ...SOURCES, lfo: true, random: true, seq: true, sh: true, steps: true };
/** a sound source's inputs that change its tone rather than pass the sound on (phase modulation) */
const MOD_INPUTS: Record<string, true> = { pm: true, pm2: true, pm3: true };
/** the parameters of a module on the sound's way that set its tone, when a parameter input mapped to them is fed */
const TONE_PARAMS: Record<string, readonly string[]> = { filter: ['cutoff'], ladder: ['cutoff'], pd: ['dcw'], osc: ['pm', 'pm2', 'pm3'], wavetable: ['pos', 'pm'] };

/** seconds a Rate Env at raw rate `r` (0..63, key scaling left out) takes to fall 40 dB (427 of its 1024 steps) */
function rateFall(r: number): number {
  if (r < 2) return Infinity;
  let sum = 0;
  for (let k = 0; k < 8; k++) sum += (INCREMENTS[r] >>> (4 * k)) & 15;
  return Math.max(0.001, ((427 * 8) / sum) * 2 ** Math.max(0, 11 - (r >> 2)) / RATE_CLOCK);
}
/** seconds a Rate Env's attack at raw rate `r` takes to reach full level (as rate-envelope.ts counts it) */
function rateAttack(r: number): number {
  if (r >= 62) return 0.001;
  if (r < 2) return Infinity;
  let att = 1023, n = 0;
  for (; att > 0; n++) att += (~att * ((INCREMENTS[r] >>> (4 * (n & 7))) & 15)) >> 4;
  return Math.max(0.001, (n * 2 ** Math.max(0, 11 - (r >> 2))) / RATE_CLOCK);
}

/** the rows that play an envelope's stages, with what a value means: seconds, or a level 0..1 */
function envelopeStages(m: ModuleInst): { param: string; stage: Stage; measure: (v: number) => number; deps?: string[] }[] {
  const p = m.params, out: { param: string; stage: Stage; measure: (v: number) => number; deps?: string[] }[] = [];
  const add = (param: string, stage: Stage, measure = (v: number): number => v, deps?: string[]): void => void out.push({ param, stage, measure, deps });
  if (m.type === 'adsr') {
    const k = (): number => ((p.long ?? 0) >= 0.5 ? ADSR_LONG : 1);   // (read when measured: Long may move first)
    add('a', 'a');   // (Long stretches the decay and the release only: modules.ts adsr)
    add('d', 'd', (v) => v * k());
    add('s', 's');
    // (ADS: the release falls at the decay's time, so the decay row plays the release too)
    if ((p.ads ?? 0) < 0.5) add('r', 'r', (v) => v * k());
    else add('d', 'r', (v) => v * k());
  } else if (m.type === 'env') {
    // (a linear fall sounds longer than an exponential one of the same time: at a quarter of the way down it is 2.5
    // times later; the decay is R2 and R3 together, read with the other as it is)
    const lin = (): number => (Math.round(p.curve ?? 0) === 1 ? 2.5 : 1);
    add('r1', 'a');
    add('r2', 'd', (v) => (v + (p.r3 ?? 1)) * lin());
    add('r3', 'd', (v) => ((p.r2 ?? 0.3) + v) * lin());
    // (one-shot skips the sustain: roleRows reads it as 0 then; the one-shot switch, or what sets it, plays the sustain too)
    add('l3', 's', (v) => v, ['shot']);
    add('r4', 'r', (v) => v * lin());
  } else if (m.type === 'env8') {
    const end = env8End(p.end ?? 3), hs = env8Sus(Math.round(p.sus ?? 2), end);
    add('r1', 'a');
    // (several steps make one stage: its time is theirs together, each read with the others as they are)
    const total = (from: number, to: number, k: number, v: number): number => {
      let t = v;
      for (let j = from; j <= to; j++) if (j !== k) t += p[`r${j}`] ?? 0.2;
      return t;
    };
    for (let k = 2; k <= (hs || end); k++) add(`r${k}`, 'd', (v) => total(2, hs || end, k, v));
    if (hs) {
      add(`l${hs}`, 's');
      for (let k = hs + 1; k <= end; k++) add(`r${k}`, 'r', (v) => total(hs + 1, end, k, v));
    }
  } else if (m.type === 'rateenv') {
    add('ar', 'a', (v) => rateAttack(2 * Math.round(v)));
    add('d1r', 'd', (v) => rateFall(2 * Math.round(v)));
    add('d1l', 's', (v) => {
      const down = 15 - Math.round(v);   // (3 dB a step; D1L 0 is 93 dB down)
      return 2 ** (-(down === 15 ? 31 : down) / 2);
    });
    add('rr', 'r', (v) => rateFall(4 * Math.round(v) + 2));
  }
  return out;
}

/**
 * The roles of `p`'s rows (#1033). The sound's way: from a sound source (SOURCES) through any cable but a gate's, into
 * any input but a gate's (a String's exciter is the only input of a source it passes) to the Output; port kinds do not
 * decide it, as effects carry sound through Math and Attenuverter modules. An FM modulator: a module from a source that
 * reaches a phase modulation input of a source on the way or of another modulator. An envelope's output is followed
 * through the modules off the way (not
 * through gate inputs, sources or other envelopes): reaching a VCA on the way (or a level row mapped to a parameter
 * input there) makes it the loudness envelope; reaching a filter's cutoff, a PD Osc's DCW, an oscillator's FM index or
 * a VCA of a modulator makes it a tone envelope. Loudness wins. A Multimode filter's or Ladder's cutoff on the way is a
 * cutoff row; a slew limiter on the way to a pitch input gives its time the glide role.
 */
export function roleRows(p: Patch, defs: Record<string, ModuleDef>): Roles {
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  const portKind = (type: string, port: string, dir: 'inputs' | 'outputs'): string | undefined => defs[type]?.[dir].find((x) => x.name === port)?.kind;
  // a Selector passes only the input its position picks: its own, plus what a cable brings from a Selector or an Offset
  // nothing moves (Algo Four's algorithm picks its routing so); a moving position passes every input
  const fixedOut = (id: number, port: string, depth: number): number | undefined => {
    const x = byId.get(id);
    if (!x || port !== 'out' || depth > 8 || p.cables.some((c) => c.to.module === id && c.to.port !== 'pos')) return undefined;
    if (x.type === 'const') return x.params.value ?? 0;
    const k = x.type === 'select' ? position(x, depth + 1) : undefined;
    return k === undefined ? undefined : x.params[`v${k}`] ?? 0;
  };
  const position = (x: ModuleInst, depth = 0): number | undefined => {
    let cv = 0;
    for (const c of p.cables) {
      if (c.to.module !== x.id) continue;
      if (c.to.port === 'pos') {
        const v = fixedOut(c.from.module, c.from.port, depth);
        if (v === undefined) return undefined;
        cv += v;
      } else if ((c.to.port === 'p1' || c.to.port === 'p2') && x.map?.[c.to.port]?.includes('pos')) return undefined;
    }
    return selectPos(x.params.pos ?? 1, x.params.count ?? SELECT_N, cv);
  };
  const positions = new Map(p.modules.filter((m) => m.type === 'select').map((m) => [m.id, position(m)]));
  const picked = (x: ModuleInst, port: string): boolean => {
    const k = positions.get(x.id);
    return x.type !== 'select' || !/^in\d$/.test(port) || k === undefined || port === `in${k}`;
  };
  const audio = p.cables.filter((c) => {
    const f = byId.get(c.from.module), t = byId.get(c.to.module);
    return !!f && !!t && portKind(f.type, c.from.port, 'outputs') !== 'gate' && !['gate', 'keys'].includes(portKind(t.type, c.to.port, 'inputs') ?? '') && (!SOURCES[t.type] || c.to.port === 'exc') && picked(t, c.to.port);
  });
  // (an envelope into a VCA's gain off the way, over a moving signal, shapes that signal: an LFO's delay, not a sound's)
  const overMoving = (x: ModuleInst): boolean => x.type === 'vca' && p.cables.some((c) => c.to.module === x.id && c.to.port === 'in' && MOVING[byId.get(c.from.module)?.type ?? '']);
  const spread = (start: Iterable<number>, forward: boolean): Set<number> => {
    const seen = new Set(start);
    for (let grew = true; grew;) {
      grew = false;
      for (const c of audio) {
        const [a, b] = forward ? [c.from.module, c.to.module] : [c.to.module, c.from.module];
        if (seen.has(a) && !seen.has(b)) seen.add(b), (grew = true);
      }
    }
    return seen;
  };
  const fromSources = spread(p.modules.filter((m) => SOURCES[m.type]).map((m) => m.id), true);
  const toOutput = spread(p.modules.filter((m) => m.type === 'output').map((m) => m.id), false);
  const sound = new Set([...fromSources].filter((id) => toOutput.has(id)));
  const modulator = new Set<number>();
  for (let size = -1; size !== modulator.size;) {
    size = modulator.size;
    const into = p.cables.filter((c) => MOD_INPUTS[c.to.port] && SOURCES[byId.get(c.to.module)?.type ?? ''] && (sound.has(c.to.module) || modulator.has(c.to.module)));
    for (const id of spread(into.map((c) => c.from.module), false)) if (fromSources.has(id) && !sound.has(id)) modulator.add(id);
  }
  // the Selectors whose position decides a role: those an envelope passes through, and those a fixed Selector or Offset
  // positions (an algorithm's routing)
  const routing = new Set(p.cables.filter((c) => c.to.port === 'pos' && byId.get(c.to.module)?.type === 'select').map((c) => c.to.module));
  const envelopes = new Map<number, EnvRole>();
  for (const e of p.modules) {
    if (!ENVELOPES[e.type]) continue;
    let amp = false, tone = false;
    const seen = new Set([e.id]), queue = [e.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const c of p.cables) {
        const x = c.from.module === id ? byId.get(c.to.module) : undefined;
        if (!x) continue;
        const q = c.to.port, mapped = q === 'p1' || q === 'p2' ? x.map?.[q] ?? [] : [];
        if (sound.has(x.id) || modulator.has(x.id)) {
          if ((x.type === 'vca' && (q === 'cv' || q === 'in')) || mapped.some((n) => isLevel(x.type, n))) {
            if (sound.has(x.id)) amp = true;
            else tone = true;
          } else if (((x.type === 'filter' || x.type === 'ladder') && q === 'cv') || (x.type === 'pd' && q === 'dcw') || (x.type === 'osc' && q === 'index') || mapped.some((n) => TONE_PARAMS[x.type]?.includes(n))) tone = true;
          continue;
        }
        const kind = portKind(x.type, q, 'inputs');
        if (x.type === 'select' && /^in\d$/.test(q)) routing.add(x.id);
        if (seen.has(x.id) || ENVELOPES[x.type] || SOURCES[x.type] || kind === 'gate' || kind === 'keys' || !picked(x, q) || (q === 'cv' && overMoving(x))) continue;
        seen.add(x.id);
        queue.push(x.id);
      }
    }
    if (amp || tone) envelopes.set(e.id, amp ? 'amp' : 'tone');
  }
  const rows = new Map<string, RoleRow[]>(), held = new Set<string>();
  const addRole = (id: number, param: string, row: RoleRow): void => void rows.set(`${id}:${param}`, [...(rows.get(`${id}:${param}`) ?? []), row]);
  // (a category holds those positions, and every row of a fixed Selector or Offset that sets one, so a Mutate or a breed
  // keeps each row's role)
  const holdRouting = (id: number, depth: number): void => {
    const x = byId.get(id);
    if (!x || depth > 8 || positions.get(id) === undefined) return;
    held.add(`${id}:pos`).add(`${id}:count`);
    for (const c of p.cables) {
      const f = c.to.module === id && c.to.port === 'pos' ? byId.get(c.from.module) : undefined;
      if (!f) continue;
      for (const pd of defs[f.type]?.params ?? []) held.add(`${f.id}:${pd.name}`);
      if (f.type === 'select') holdRouting(f.id, depth + 1);
    }
  };
  for (const id of routing) holdRouting(id, 0);
  // what a parameter input brings from sources nothing moves: a Macro's or an Offset's value, a Selector's value at its
  // position; read when measured, so a row moved before counts; a moving source counts 0
  const livePos = (x: ModuleInst, depth: number): number => {
    let cv = 0;
    for (const c of p.cables) if (c.to.module === x.id && c.to.port === 'pos') cv += liveOut(c.from.module, c.from.port, depth + 1);
    return selectPos(x.params.pos ?? 1, x.params.count ?? SELECT_N, cv);
  };
  const liveOut = (id: number, port: string, depth = 0): number => {
    const x = byId.get(id);
    if (!x || depth > 8) return 0;
    if (x.type === 'macro' || x.type === 'const') return x.params.value ?? 0;
    if (x.type === 'select' && /^g\d$/.test(port)) return livePos(x, depth) === Number(port.slice(1)) ? 1 : 0;   // (a position's gate)
    if (x.type !== 'select' || port !== 'out' || p.cables.some((c) => c.to.module === id && /^in\d$/.test(c.to.port))) return 0;
    return x.params[`v${livePos(x, depth)}`] ?? 0;
  };
  const fed = (m: ModuleInst, pin: 'p1' | 'p2'): Cable[] => p.cables.filter((c) => c.to.module === m.id && c.to.port === pin);
  /** a parameter's value as the engine plays it, its parameter inputs added (Engine.applyCv, for fixed sources) */
  const effective = (m: ModuleInst, q: string): number => {
    const pd = defs[m.type].params.find((x) => x.name === q)!;
    let base = m.params[q] ?? pd.default, mod = 0, touched = false, rv = 0;
    let ranged: readonly number[] | undefined;
    (['p1', 'p2'] as const).forEach((pin, s) => {
      const from = fed(m, pin);
      if (!from.length || !m.map?.[pin]?.includes(q)) return;
      const v = from.reduce((sum, c) => sum + liveOut(c.from.module, c.from.port), 0) * (m.att?.[s] ?? 1);
      const r = m.range?.[pin]?.[q];
      if (r) (ranged = r), (rv += rangeShare(r, v));
      else (mod += v), (touched = true);
    });
    if (ranged) base = paramValue(pd, ranged[0] + Math.min(1, Math.max(0, rv)) * (ranged[1] - ranged[0]));
    return touched ? modulate(pd, base, mod) : base;
  };
  /** measure with `x`'s `param` at `v` for the moment */
  const at = (x: ModuleInst, param: string, v: number, f: () => number): number => {
    const was = x.params[param];
    x.params[param] = v;
    try {
      return f();
    } finally {
      x.params[param] = was;
    }
  };
  for (const [id, job] of envelopes) {
    const m = byId.get(id)!;
    for (const s of envelopeStages(m)) {
      const role: Role = `${job}-${s.stage}`;
      // (a one-shot Env L/R has no sustain: it reads 0)
      const heard = (): number => (s.deps?.includes('shot') && effective(m, 'shot') >= 0.5 ? 0 : s.measure(effective(m, s.param)));
      addRole(id, s.param, { role, measure: (v) => at(m, s.param, v, heard) });
      // (a stage set through a parameter input: the Macro, Offset or Selector feeding it plays the stage too, as Monolith
      // D's decay rows and DECAY ON do, and Canvas's envelope mode through the one-shot switch)
      for (const q of [s.param, ...(s.deps ?? [])]) for (const pin of ['p1', 'p2'] as const) {
        if (!m.map?.[pin]?.includes(q)) continue;
        for (const c of fed(m, pin)) {
          const x = byId.get(c.from.module)!;
          const param = x.type === 'macro' || x.type === 'const' ? 'value' : x.type === 'select' && positions.get(x.id) !== undefined && !routing.has(x.id) ? 'pos' : undefined;
          const fixed = x.type !== 'select' || /^g\d$/.test(c.from.port) || !p.cables.some((k) => k.to.module === x.id && /^in\d$/.test(k.to.port));
          if (param && fixed) addRole(x.id, param, { role, measure: (v) => at(x, param, v, heard) });
          // (a Selector's values feed the stage too, the one at its position now; the others only once it moves there)
          if (param === 'pos' && fixed && c.from.port === 'out') for (let k = 1; k <= SELECT_N; k++) addRole(x.id, `v${k}`, { role, measure: (v) => at(x, `v${k}`, v, heard) });
        }
      }
    }
    for (const q of ENV_SHAPE[m.type] ?? []) held.add(`${id}:${q}`);
  }
  for (const id of sound) if (byId.get(id)!.type === 'filter' || byId.get(id)!.type === 'ladder') addRole(id, 'cutoff', { role: 'cutoff', measure: (v) => v });
  for (const id of pitchPaths(p, defs).reach) {
    if (byId.get(id)?.type !== 'glide') continue;
    addRole(id, 'time', { role: 'glide', measure: (v) => v });
    held.add(`${id}:fall`);
  }
  return { of: (m, param) => rows.get(`${m.id}:${param}`)?.[0], all: (m, param) => rows.get(`${m.id}:${param}`) ?? [], holds: (m, param) => held.has(`${m.id}:${param}`), envelopes };
}

/** the range a category gives a role row, in the row's measure: the cutoff's octaves from `anchor` (the anchor patch's
 *  value of the row) in Hz */
export function roleSpan(profile: Profile, role: Role, anchor: number): Span {
  if (role === 'cutoff') return [anchor * 2 ** profile.cutoff[0], anchor * 2 ** profile.cutoff[1]];
  if (role === 'glide') return profile.glide;
  const [job, stage] = role.split('-') as [EnvRole, Stage];
  return profile[job][stage];
}

/** the values of `rd` whose measure lies in `span` (the measure rises or falls with the value), low end first; null: none */
export function spanValues(rd: ParamDef, measure: (v: number) => number, span: Span): Span | null {
  const inside = (v: number): boolean => {
    const x = measure(v);
    return x >= span[0] - 1e-9 && x <= span[1] + 1e-9;
  };
  const step = rd.step ?? 0;
  if (step >= 1) {
    // (a Selector's positions need not rise or fall with the measure: the longest run of positions inside)
    let best: Span | null = null, run: number | null = null;
    for (let v = rd.min; v <= rd.max + 1e-9; v += step) {
      if (!inside(v)) run = null;
      else if (run === null) run = v;
      if (run !== null && (!best || v - run > best[1] - best[0])) best = [run, v];
    }
    return best;
  }
  if (measure(rd.max) < measure(rd.min)) return spanValues(rd, (v) => -measure(v), [-span[1], -span[0]]);
  // the values either side of where the measure passes `edge` (reaches it, or goes over it), by halving the unit range
  const cross = (edge: number, over: boolean): [number, number] => {
    let a = 0, b = 1;
    for (let k = 0; k < 48; k++) {
      const mid = (a + b) / 2, x = measure(paramValue(rd, mid));
      if (over ? x > edge : x >= edge) b = mid;
      else a = mid;
    }
    return [paramValue(rd, a), paramValue(rd, b)];
  };
  const lo = measure(rd.min) >= span[0] ? rd.min : cross(span[0], false)[1];
  const hi = measure(rd.max) <= span[1] ? rd.max : cross(span[1], true)[0];
  return lo <= hi && inside(lo) && inside(hi) ? [lo, hi] : null;
}

/** the value of a row whose measure comes nearest to `span` (in octaves for a time, in level otherwise), as a span of
 *  that one value: a whole-step row's nearest step, a continuous row's nearer end (its measure rises or falls) */
function nearestStep(rd: ParamDef, measure: (v: number) => number, span: Span): Span | null {
  const off = (x: number): number => (x >= span[0] && x <= span[1] ? 0 : x < span[0] ? (x > 0 && span[0] > 0 ? Math.log2(span[0] / x) : span[0] - x) : x > 0 && span[1] > 0 ? Math.log2(x / span[1]) : x - span[1]);
  const step = rd.step ?? 0;
  const values = step >= 1 ? Array.from({ length: Math.floor((rd.max - rd.min) / step + 1e-9) + 1 }, (_, k) => rd.min + k * step) : [rd.min, rd.max];
  let best: number | null = null;
  for (const v of values) if (best === null || off(measure(v)) < off(measure(best)) - 1e-12) best = v;
  return best === null ? null : [best, best];
}

/** `v` on the row's steps (counted from its low end), kept inside `span` when a step there exists */
function onStep(rd: ParamDef, v: number, span: Span): number {
  const step = rd.step ?? 0;
  if (!step) return v;
  const at = (k: number): number => Number((rd.min + k * step).toPrecision(12));
  let x = at(Math.round((v - rd.min) / step));
  if (x < span[0]) x = at(Math.ceil((span[0] - rd.min) / step - 1e-9));
  if (x > span[1]) x = at(Math.floor((span[1] - rd.min) / step + 1e-9));
  return x;
}

/** a whole-number ratio or 0.5: where a Ratio may go with "Mutate pitch" on */
const MUSICAL_RATIO = RATIOS.map((r) => r === 0.5 || Number.isInteger(r));

/** the row targets of the cards in `scope`: every parameter of a module card, the rows of an assembly card */
function scopeTargets(p: Patch, scope: MutateScope, defs: Record<string, ModuleDef>): RowTarget[][] {
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  return [
    ...scope.modules.map((id) => {
      const m = byId.get(id);
      return m && defs[m.type] ? defs[m.type].params.map((pd) => ({ module: id, param: pd.name })) : [];
    }),
    ...scope.assemblies.map((id) => assembliesOf(p).find((a) => a.id === id)?.params.map((r) => ({ module: r.module, param: r.param })) ?? []),
  ];
}

/** one row, or rows a card row ties (#357), that may move, with what a move needs; `target`: a category's range for a role
 *  row, in the row's unit space within its macro ranges, and `span` the same in values */
interface Row { group: RowTarget[]; m: ModuleInst; pd: ParamDef; rd: ParamDef; from: number; lo: number; hi: number; kind?: PitchKind; pool?: readonly number[]; target?: Span; span?: Span; role?: boolean }

/**
 * Mutate or randomize the parameters of `scope` in a copy of `p`. `amount`: Mutate's largest move, a share of the range
 * (Randomize ignores it); `rnd` gives 0..1. Parameters that card rows tie (#357) move as one, and stay put when any of them
 * is locked. A value outside min..max (a stretch) stays as it is. Pitch rows stay unless `opts.pitch`. With a category
 * (`opts.category`), every role row (roleRows) that is outside the category's range moves into it, one inside moves
 * within it, the envelope switches and glide fall times the roles hold stay, and the timbre rows of BRIGHT lean the
 * category's way.
 */
export function mutatePatch(p: Patch, scope: MutateScope, mode: MutateMode, amount: number, defs: Record<string, ModuleDef>, rnd: () => number = Math.random, opts: MutateOptions = {}): MutateResult {
  const out = structuredClone(p);
  const byId = new Map(out.modules.map((m) => [m.id, m]));
  const pdOf = (t: RowTarget): ParamDef | undefined => {
    const m = byId.get(t.module);
    return m && defs[m.type]?.params.find((q) => q.name === t.param);
  };
  const pitchOf = pitchRows(out, defs);
  const pick = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))];
  const seen = new Set<string>(), held = heldRows(out);
  const profile = opts.category && opts.category !== 'any' ? PROFILES[opts.category] : undefined;
  const roles = profile && roleRows(out, defs);
  /** a role row's range in its values (every role of every tied row at once) and in its unit space within its macro
   *  ranges, from the patch's values now; undefined: none, or the roles' ranges do not meet */
  const aim = (group: RowTarget[], rd: ParamDef, lo: number, hi: number): { span: Span; target: Span } | undefined => {
    let span: Span | undefined;
    for (const g of group) {
      const gm = byId.get(g.module)!, gpd = pdOf(g)!;
      for (const role of roles ? roles.all(gm, g.param) : []) {
        const anchor = opts.anchor?.modules.find((x) => x.id === g.module)?.params[g.param] ?? gm.params[g.param] ?? gpd.default;
        const grd = rowRange(gm.type, gm.params, gpd), want = roleSpan(profile!, role.role, anchor);
        // (a switch with no position inside, such as DECAY ON before its decay row has moved: the nearest position, so
        // the rows after it can reach the range)
        const s = spanValues(grd, role.measure, want) ?? nearestStep(grd, role.measure, want);
        if (s) span = span ? [Math.max(span[0], s[0]), Math.min(span[1], s[1])] : s;
      }
    }
    if (!span || span[0] > span[1]) return undefined;
    const [a, b] = [paramUnit(rd, span[0]), paramUnit(rd, span[1])];
    // (a range the macro ranges leave out: the nearest end they allow)
    return { span, target: a > hi ? [hi, hi] : b < lo ? [lo, lo] : [Math.max(lo, a), Math.min(hi, b)] };
  };
  const rows: Row[] = [];
  for (const t of scopeTargets(out, scope, defs).flat()) {
    if (seen.has(key(t))) continue;
    const group = tiedTo(out, t.module, t.param);
    for (const g of group) seen.add(key(g));
    if (group.some((g) => {
      const m = byId.get(g.module), pd = pdOf(g);
      return !m || !pd || MUTATE_SKIP[m.type] || pd.fixed || pd.screen || pd.onScreen || held.has(key(g)) || isLocked(out, m, g.param) || !!roles?.holds(m, g.param);
    })) continue;
    const kinds = group.map((g) => pitchOf(byId.get(g.module)!, g.param)).filter((k): k is PitchKind => !!k);
    const kind = kinds.includes('held') ? 'held' : kinds[0];
    if (kind && (!opts.pitch || kind === 'held')) continue;
    const m = byId.get(t.module)!, pd = pdOf(t)!;
    const from = m.params[pd.name] ?? pd.default;
    if (from < pd.min || from > pd.max) continue;
    // in the unit space of the row's range (a Selector's positions in use, a Delay's time its line holds: rowRange),
    // between the ends of the parameter's macro ranges in use (positions in its own range)
    const rd = rowRange(m.type, m.params, pd);
    let lo = 0, hi = 1;
    for (const pin of ['p1', 'p2'] as const) {
      const r = m.map?.[pin]?.includes(pd.name) ? m.range?.[pin]?.[pd.name] : undefined;
      if (!r) continue;
      const [a, b] = [paramUnit(rd, paramValue(pd, r[0])), paramUnit(rd, paramValue(pd, r[1]))];
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    }
    if (lo > hi) [lo, hi] = [hi, lo];   // (two macro ranges that do not overlap: between their nearest ends)
    let pool = kind ? undefined : group.map((g) => opts.pools?.get(key(g))).find((x) => x?.length);
    const role = !!profile && !!roles && !kind && group.some((g) => roles.all(byId.get(g.module)!, g.param).length > 0);
    const aimed = role ? aim(group, rd, lo, hi) : undefined;
    const span = aimed?.span, target = aimed?.target;
    if (span) {
      pool = pool?.filter((x) => x >= span[0] - 1e-9 && x <= span[1] + 1e-9);
      if (!pool?.length) pool = undefined;
    }
    rows.push({ group, m, pd, rd, from, lo, hi, kind, pool, target, span, role });
  }
  // which rows move: every one for Randomize; for Mutate a share of the rows and the switches by the amount, at least
  // MUTATE_LEAST (rows first)
  let moving = rows;
  let chosen: Set<Row> | undefined;
  if (mode === 'mutate') {
    const share = opts.share ?? MUTATE_SHARE;
    const ch = new Set(rows.filter((r) => rnd() < (!r.kind && !r.role && isSwitch(r.pd) ? amount : share)));
    // (a role row outside its category's range always moves)
    for (const r of rows) if (r.span && (r.from < r.span[0] - 1e-9 || r.from > r.span[1] + 1e-9)) ch.add(r);
    for (const sw of [false, true]) {
      const rest = rows.filter((r) => !ch.has(r) && (!r.kind && !r.role && isSwitch(r.pd)) === sw);
      while (ch.size < MUTATE_LEAST && rest.length) ch.add(rest.splice(Math.min(rest.length - 1, Math.floor(rnd() * rest.length)), 1)[0]);
    }
    // (with a category, every role row is looked at again once the switches have moved: one a moved switch took out of
    // its range moves too)
    moving = rows.filter((r) => ch.has(r) || (profile && r.role));
    chosen = ch;
  }
  // (with a category, switches first: a role row's range is worked out when it moves, with a Long or a DECAY ON that
  // moved before it counted)
  if (profile) moving = [...moving.filter((r) => isSwitch(r.pd)), ...moving.filter((r) => !isSwitch(r.pd))];
  const inBounds = (r: Row, v: number): boolean => {
    if (v < r.rd.min || v > r.rd.max) return false;
    const u = paramUnit(r.rd, v);
    return u >= r.lo - 1e-9 && u <= r.hi + 1e-9;
  };
  /** values set exactly (a musical step), not rounded to the row's steps afterwards */
  const exact = new Set<string>();
  const set: RowTarget[] = [];
  for (const r of moving) {
    const { m, pd, rd, from, lo, hi } = r;
    if (r.role) ({ span: r.span, target: r.target } = aim(r.group, rd, lo, hi) ?? { span: undefined, target: undefined });
    // (a role row the category cannot place stays: moving it by chance could take a stage it shares out of reach)
    if (r.role && !r.span) continue;
    if (chosen && !chosen.has(r) && !(r.span && (from < r.span[0] - 1e-9 || from > r.span[1] + 1e-9))) continue;
    let v: number | undefined;
    if (r.kind) {
      if (r.kind === 'semitones' || r.kind === 'offset') {
        // (aimed at bass, with "Mutate pitch" on: an octave down only, so the register goes low)
        const all = opts.category === 'bass' ? [r.kind === 'semitones' ? -12 : -1] : r.kind === 'semitones' ? [12, -12, 7, -5] : [1, -1, 7 / 12, -5 / 12];
        const steps = all.map((d) => from + d).filter((x) => inBounds(r, x));
        if (steps.length) v = pick(steps);
      } else if (r.kind === 'ratio') {
        const at = Math.round(from);
        const ok = RATIOS.map((_, i) => i).filter((i) => i !== at && MUSICAL_RATIO[i] && inBounds(r, i));
        // Mutate: the nearest musical ratio above or below; Randomize: any
        const near = mode === 'randomize' ? ok : [Math.max(-1, ...ok.filter((i) => i < at)), Math.min(Infinity, ...ok.filter((i) => i > at))].filter((i) => i >= 0 && i < RATIOS.length);
        if (near.length) v = pick(near);
      } else {
        const cents = (mode === 'randomize' ? 1 : amount) * 10;
        const x = Math.round(from + (rnd() * 2 - 1) * cents);
        v = Math.min(rd.max, Math.max(rd.min, x));
        if (!inBounds(r, v)) v = undefined;
      }
      if (v === undefined) continue;
      for (const g of r.group) exact.add(key(g));
    } else if (r.pool && rnd() < PRESET_DRAW) {
      const x = pick(r.pool);
      v = paramValue(rd, Math.min(hi, Math.max(lo, paramUnit(rd, Math.min(rd.max, Math.max(rd.min, x))))));
      if (r.span) for (const g of r.group) exact.add(key(g));
    } else if (r.target && r.span) {
      // into the range (from its nearer half) when outside, else within it by up to the amount; Randomize: anywhere in it
      const [a, b] = r.target, u = paramUnit(rd, from);
      const x = mode === 'randomize' ? a + rnd() * (b - a) : u < a - 1e-9 ? a + (rnd() * (b - a)) / 2 : u > b + 1e-9 ? b - (rnd() * (b - a)) / 2 : Math.min(b, Math.max(a, u + (rnd() * 2 - 1) * amount));
      v = onStep(rd, paramValue(rd, x), r.span);
      for (const g of r.group) exact.add(key(g));
    } else if (mode === 'mutate' && isSwitch(pd)) {
      // another of its values, by chance (chosen above), not by distance
      const step = Math.max(1, pd.step ?? 1);
      const others: number[] = [];
      for (let x = rd.min; x <= rd.max + 1e-9; x += step) if (Math.abs(x - from) > 1e-9 && inBounds(r, x)) others.push(x);
      if (!others.length) continue;
      v = pick(others);
    } else {
      // (a category leans a timbre row of BRIGHT its way: the move's middle shifts, Randomize favours one end)
      const lean = profile ? profile.nudge * (BRIGHT[m.type]?.[pd.name] ?? 0) : 0;
      const u = Math.min(hi, Math.max(lo, paramUnit(rd, from)));
      v = paramValue(rd, mode === 'randomize' ? lo + (lean ? rnd() ** 2 ** (-lean / 2) : rnd()) * (hi - lo) : Math.min(hi, Math.max(lo, u + (rnd() * 2 - 1) * amount + lean * amount * LEAN)));
    }
    if (isLevel(m.type, pd.name)) v = Math.min(v, Math.max(from, pd.default));
    for (const g of r.group) {
      const gpd = pdOf(g)!;
      byId.get(g.module)!.params[g.param] = Math.min(topOf(gpd), Math.max(gpd.min, v));
      set.push(g);
    }
  }
  // (several rows can set one stage: an envelope's own row and the Macro or Selector added through its parameter input.
  // Once all have moved, a role row the others took out of its range comes back to its nearest end, so each stage ends
  // in its range)
  if (profile) for (let pass = 0, again = true; again && pass < 3; pass++) {
    again = false;
    for (const r of rows) {
      const a = r.role ? aim(r.group, r.rd, r.lo, r.hi) : undefined;
      const now = r.m.params[r.pd.name] ?? r.pd.default;
      if (!a || (now >= a.span[0] - 1e-9 && now <= a.span[1] + 1e-9)) continue;
      const v = onStep(r.rd, paramValue(r.rd, Math.min(a.target[1], Math.max(a.target[0], paramUnit(r.rd, now)))), a.span);
      for (const g of r.group) {
        const gpd = pdOf(g)!;
        byId.get(g.module)!.params[g.param] = Math.min(topOf(gpd), Math.max(gpd.min, v));
        exact.add(key(g));
        if (!set.some((t) => key(t) === key(g))) set.push(g);
      }
      again = true;
    }
  }
  // the rows' own ranges and steps, once every new value is in: a Selector's position within its new count, a Delay's time
  // within what its line holds with its new ping-pong (rowRange)
  let moved = 0;
  for (const t of set) {
    const m = byId.get(t.module)!, pd = pdOf(t)!;
    const from = p.modules.find((x) => x.id === t.module)!.params[t.param] ?? pd.default;
    const rd = rowRange(m.type, m.params, pd);
    const v = Math.min(rd.max, Math.max(rd.min, m.params[t.param]));
    m.params[t.param] = exact.has(key(t)) ? v : stepToward(rd, from, v, { hi: rd.max });
    if (m.params[t.param] !== from) moved++;
  }
  return profile ? { patch: out, moved, roles: rows.filter((r) => r.span).length } : { patch: out, moved };
}

/**
 * Breed a candidate from two or more kept snapshots (D-987): each card of `scope` takes its rows from one of `keeps`,
 * chosen at random per card, so a card's rows stay together and no value is a blend; then a Mutate at half the amount
 * moves some of them. A row whose module is not in every keep, and a locked row, keeps its value in `p` (the patch on
 * screen). `moved`: how many parameters differ from `p`.
 */
export function breedPatch(p: Patch, keeps: readonly Patch[], scope: MutateScope, amount: number, defs: Record<string, ModuleDef>, rnd: () => number = Math.random, opts: MutateOptions = {}): MutateResult {
  const bred = structuredClone(p);
  const byId = new Map(bred.modules.map((m) => [m.id, m]));
  const keepMods = keeps.map((k) => new Map(k.modules.map((m) => [m.id, m]))), held = heldRows(bred);
  // (with a category, the rows that decide the roles stay as on screen, as a Mutate keeps them)
  const roles = opts.category && opts.category !== 'any' ? roleRows(bred, defs) : undefined;
  for (const card of scopeTargets(bred, scope, defs)) {
    if (!card.length) continue;
    const parent = keepMods[Math.min(keeps.length - 1, Math.floor(rnd() * keeps.length))];
    for (const t of card) for (const g of tiedTo(bred, t.module, t.param)) {
      const m = byId.get(g.module), pd = m && defs[m.type]?.params.find((q) => q.name === g.param);
      if (!m || !pd || MUTATE_SKIP[m.type] || pd.fixed || pd.screen || pd.onScreen || held.has(key(g)) || isLocked(bred, m, g.param) || roles?.holds(m, g.param)) continue;
      if (keepMods.some((k) => k.get(g.module)?.type !== m.type)) continue;
      m.params[g.param] = parent.get(g.module)!.params[g.param] ?? pd.default;
    }
  }
  const out = mutatePatch(bred, scope, 'mutate', amount / 2, defs, rnd, opts).patch;
  let moved = 0;
  for (const m of out.modules) {
    const was = p.modules.find((x) => x.id === m.id);
    for (const pd of defs[m.type]?.params ?? []) if ((m.params[pd.name] ?? pd.default) !== (was?.params[pd.name] ?? pd.default)) moved++;
  }
  return { patch: out, moved };
}
