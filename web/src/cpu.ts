// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's CPU load of a patch (core 0's: the second core takes a split poly group's odd parts, #271), estimated from a
// table of costs (cpu-costs.json). The table comes from counting the
// fixed-point engine's instructions on an rv32im model (tools/cpu, `npm run cpu-costs`), calibrated on the factory patches
// measured on the test rig (a scale plus a fixed time per block, and a factor for each factory engine: `rig`); a table
// measured on the FM-1 itself can replace it (`source`). Every figure here is an estimate.
import TABLE from './cpu-costs.json';
import { DEFS, LFO_RANGE_K, MATRIX_N, matrixPin, STACKS, TRACK_POLY } from './modules';
import { allModules, assembliesOf, parentOf } from './assembly';
import { flawOf, hasMorph, type ModuleInst, type Patch } from './patch';
import { deviceView } from './poly';
import './device-shown';   // (what the FM-1 shows, for the device compile pass)

/** what changes a module's cost: a choice / switch / small integer (its measured values, the nearest one counts), a number
 * being above its minimum (the oscillator's FM index turns FM mode on), a number across its range (measured points,
 * interpolated: the oscillator's pitch), a patched input, a patched output */
export type CostDim =
  | { param: string; values: number[] }
  | { param: string; above: number }
  | { param: string; points: number[] }
  /** exact fast paths, followed by one cell for every other value */
  | { param: string; exact: number[] }
  | { input: string }
  | { output: string };

export interface TypeCost {
  /** cycles per block: the module's own work and its parameter update, with nothing patched and every setting at its default */
  run: number;
  cv: number;
  dims?: CostDim[];
  /** run cost for every combination of the dims' values (row major, the first dim slowest) */
  grid?: number[];
  /** dims left out of the grid (too many combinations): cycles added per value, measured with everything else at default */
  extra?: { dim: CostDim; add: number[] }[];
  /** cycles added when the pitch input moves every sample (not just from the keyboard), per unison copy */
  moving?: number;
  /** a delay: cycles added while its time moves (a cable or the morph on `time`: the read position glides, #484) */
  glide?: number;
  /** oscillator pitch-conversion work for each unison count (1..5), measured with that many copies */
  movingCopies?: number[];
  /** cycles saved when the first output is not patched (nor the outputs FIRST_ALSO lists): work only it needs, the least any
   * other output saves when the module is heard through it alone; more with some inputs patched (firstOffWith: the filter's
   * second stage also works out its own coefficients while the cv moves) */
  firstOff?: number;
  firstOffWith?: Record<string, number>;
  /** cycles saved beyond firstOff when this output is the only one patched (the filter's lp12 alone: engine.c filter_run
   * skips the high pass and the stores to the other ports) */
  alone?: Record<string, number>;
  /** an oscillator: cycles its summed phase modulation adds (#518: pm2, pm3 or the index input patched), over the FM path
   * one patched pm input runs (OSC_PM_SUM) */
  pmSum?: number;
  /** a Steps track that Main's keys pass through (a cable into its keys in): cycles per key sounding through it, counted
   * for as many keys as the patch's largest poly group has parts (the worst case the checks hold too) */
  thru?: number;
  /** a Matrix (#525, engine.c m_matrix): `run` counts one output read with no pin in use; `out` the cycles each further
   * output read adds, `pins[k - 1]` what an output with k pins in use adds (a pin in use: its input patched, its amount off 0
   * or moved by a cable) */
  matrix?: { out: number; pins: number[] };
}

/** a Matrix's cost over its `run` (TypeCost.matrix): its outputs read and, in each, its pins in use */
export function matrixCost(m: ModuleInst, t: NonNullable<TypeCost['matrix']>, inputs: Set<string>, outputs: Set<string>, moved: Set<string>): number {
  let add = -t.out;
  for (let o = 1; o <= MATRIX_N; o++) {
    if (!outputs.has(`out${o}`)) continue;
    add += t.out;
    let k = 0;
    for (let i = 1; i <= MATRIX_N; i++) if (inputs.has(`in${i}`) && (paramOf(m, matrixPin(i, o)) !== 0 || moved.has(matrixPin(i, o)))) k++;
    if (k) add += t.pins[k - 1];
  }
  return add;
}

export interface CpuTable {
  /** where the numbers come from */
  source: string;
  /** the table's unit per microsecond on the FM-1 */
  cyclesPerUs: number;
  /** the second core (#271): what an idle one costs core 0 a block (us), and the share of a split poly group's odd parts
   * that comes off core 0 (fitted on the rig: scripts/cpu-costs.ts CORES) */
  cores?: { idleUs: number; splitEff: number; survey: string };
  /** the time per block the counted engine leaves out (the rest of the audio interrupt: key scan, USB poll), whatever the patch */
  fixedUs: number;
  /** the time the audio interrupt has per block (128 frames at 44118 Hz) */
  blockUs: number;
  /** the note the costs were counted at, through a module's pitch input (with nothing patched there a module plays C4, 60:
   * its `coarse` counts that much lower) */
  note: number;
  /** fixed costs: per rendered block, per Output module, per module instance */
  block: number;
  output: number;
  node: number;
  /** summing several cables into one input: per summed input, per source */
  sum: { port: number; source: number };
  /** parameter inputs (per block): per connected p1 / p2 or routed side input, per parameter it moves (linear / log), per
   * parameter while the patch has a morph B side */
  cv: { pin: number; lin: number; log: number; morph: number };
  /** a bypassed module copies its through input: per patched output */
  bypass: number;
  types: Record<string, TypeCost>;
  /** whole patches counted by the emulator, which the model must match (cpu.test.ts) */
  checks: { name: string; cycles: number }[];
  /** how the scale was found */
  calibration: Record<string, number | string>;
  /** the test rig's survey of the factory patches (scripts/cpu-costs.ts RIG): per factory engine (a top-level assembly of
   * that name), the factor on its modules' cycles that makes the estimate read what the rig measured for its factory patch
   * (its steady peak; the scale and the fixed time per block are fitted on every patch together) */
  rig?: { engines: Record<string, number>; survey: string };
}

export const CPU: CpuTable = TABLE as CpuTable;

/** above this the estimate warns: the table is an estimate, not a measurement */
export const CPU_WARN = 0.8;
/** the most a factory patch's VOICES top lets its estimate reach (D-870, scripts/factory-build.ts voiceTops): the estimate
 * reads the rig's steady peak, and the overload guard drops a voice when its mean passes 90 % of the half buffer
 * (D-362); the mean runs a few points under the peak, which leaves that much for note starts and the transport */
export const CPU_VOICE_TOP = 0.9;

export interface CpuModule {
  id: number;
  type: string;
  /** instances: the parts of its poly assembly */
  copies: number;
  /** its cycles, with its factory engine's rig factor (CpuTable.rig) */
  cycles: number;
}

export interface CpuEstimate {
  /** the estimate with one core (core 1 held: update mode, or given up by its fallback) */
  oneCoreUs: number;
  /** every module's cycles, as one core renders them, as counted (without the rig's factors: the emulator's count,
   * cpu.test.ts) */
  cycles: number;
  /** the cycles the second core takes off core 0 (#271, engine.c render_split): in a poly group of 2 or more parts, the
   * odd parts of each module but a Steps (with the rig's factors) */
  split: number;
  /** the poly groups whose parts are split (each hands work over and waits for it) */
  splitGroups: number;
  /** on core 0, with the second core (cores 2) or without it (1) */
  us: number;
  /** fraction of the block's time */
  use: number;
  /** per module, the costliest first */
  modules: CpuModule[];
}

const nearest = (values: number[], v: number): number => values.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

const paramOf = (m: ModuleInst, name: string): number => m.params[name] ?? DEFS[m.type].params.find((p) => p.name === name)?.default ?? 0;

/** where a module's setting falls along a dim: [index into the dim's values, weight], two for a number between two points */
function place(d: CostDim, m: ModuleInst, inputs: Set<string>, outputs: Set<string>, moved: Set<string>, shift: number): [number, number][] {
  if ('exact' in d) {
    const i = moved.has(d.param) ? -1 : d.exact.indexOf(Math.round(paramOf(m, d.param) * 65536) / 65536);
    return [[i < 0 ? d.exact.length : i, 1]];
  }
  if ('values' in d) {
    const v = paramOf(m, d.param);
    return [[d.values.indexOf(nearest(d.values, v)), 1]];
  }
  if ('above' in d) return [[moved.has(d.param) || paramOf(m, d.param) > d.above ? 1 : 0, 1]];
  if ('points' in d) {
    const pts = d.points;
    let v = paramOf(m, d.param) + (d.param === 'coarse' ? shift : 0);
    if (moved.has(d.param) && v <= pts[0] && pts.length > 1) v = pts[1];
    if (v <= pts[0]) return [[0, 1]];
    for (let i = 1; i < pts.length; i++)
      if (v <= pts[i]) {
        const w = (v - pts[i - 1]) / (pts[i] - pts[i - 1]);
        return [[i - 1, 1 - w], [i, w]];
      }
    return [[pts.length - 1, 1]];
  }
  if ('input' in d) return [[inputs.has(d.input) ? 1 : 0, 1]];
  return [[outputs.has(d.output) ? 1 : 0, 1]];
}

export const dimSize = (d: CostDim): number => ('values' in d ? d.values.length : 'points' in d ? d.points.length : 'exact' in d ? d.exact.length + 1 : 2);

/** the run cost of one instance of `m`; `moved`: the parameters a parameter input or the morph moves (a mode that turns on
 * above a minimum counts as on then: the modulation may take it there) */
/** an oscillator's inputs that make it sum its phase modulation (#518, engine.c osc_pm) */
const OSC_PM_SUM = ['pm2', 'pm3', 'index'];

export function runCost(m: ModuleInst, t: TypeCost, inputs: Set<string>, outputs: Set<string>, moved: Set<string> = new Set(), note = CPU.note): number {
  const shift = DEFS[m.type]?.inputs.some((i) => i.name === 'pitch') && !inputs.has('pitch') ? 60 - note : 0;
  // a choice a parameter input or the morph moves counts at its costliest value: the modulation may take it there (a
  // Phase Distortion wave a Selector moves into the resonances)
  const worst = (d: CostDim): boolean => 'values' in d && moved.has(d.param);
  let c = t.run;
  if (t.dims && t.grid) {
    const parts = t.dims.map((d) => place(d, m, inputs, outputs, moved, shift));
    const sizes = t.dims.map(dimSize);
    const all = t.dims.map((d, k) => (worst(d) ? Array.from({ length: sizes[k] }, (_, i) => i) : null));
    const cost = (k: number, at: number): number => {
      if (k === parts.length) return t.grid![at];
      const each = all[k];
      if (each) return Math.max(...each.map((i) => cost(k + 1, at * sizes[k] + i)));
      let s = 0;
      for (const [i, w] of parts[k]) if (w) s += w * cost(k + 1, at * sizes[k] + i);
      return s;
    };
    c = cost(0, 0);
  }
  for (const { dim, add } of t.extra ?? []) {
    if (worst(dim)) c += Math.max(...add);
    else for (const [i, w] of place(dim, m, inputs, outputs, moved, shift)) c += w * add[i];
  }
  return c;
}

/** modules whose output may move every sample (a noisy or audio-rate signal; a glide, an envelope or a Random walk while it
 * moves, which can be all the time: a slow or modulated glide is, and the estimate is a worst case) */
const MOVERS = new Set(['osc', 'pd', 'noise', 'wavetable', 'string', 'grain', 'glide', 'adsr', 'env', 'env8', 'rateenv', 'random']);

/** outputs that need the same work as the first output (TypeCost.firstOff): the filter's mix is made from its lp24 */
export const FIRST_ALSO: Record<string, string[]> = { filter: ['mix'] };

/** the most a signal from module `id` changes per sample, in Q16 steps (Infinity: it may change every sample by any
 * amount): an LFO by its slope (rate x depth; sample & hold steps a few times a second), a Scale by its input's times its
 * gain, a Constant and the Main module per block; anything else as fast as the fastest thing feeding it */
function slope(p: Patch, id: number, seen = new Set<number>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  const m = p.modules.find((x) => x.id === id);
  if (!m) return 0;
  if (MOVERS.has(m.type)) return Infinity;
  if (m.type === 'lfo') {
    const wave = Math.round(m.params.wave ?? 0);
    const ins = p.cables.filter((c) => c.to.module === id);
    const clocked = ins.some((c) => c.to.port === 'clk' || c.to.port === 'reset');
    if (wave === 4 && !clocked) return 0;                                            // sample & hold: a step per cycle, whatever its rate
    if (ins.length || wave === 2 || wave === 3) return Infinity;                    // modulated (a knob may turn the rate up), or a saw / square edge
    const sync = (m.params.sync ?? 0) >= 0.5;
    const range = Math.round(m.params.range ?? 0);
    const rate = !sync && range === 3 ? (m.params.wide ?? 4) : (m.params.rate ?? 4);
    const k = sync ? 1 : LFO_RANGE_K[range] ?? 1; // (the free rate's range)
    return (4 * rate * k * Math.abs(m.params.depth ?? 1) * 65536) / 44118; // a triangle's slope (a sine's is lower)
  }
  if (m.type === 'const' || m.type === 'fm1' || m.type === 'part') return 0;
  const inputs = p.cables.filter((c) => c.to.module === id).map((c) => slope(p, c.from.module, seen));
  const fastest = inputs.length ? Math.max(...inputs) : 0;
  if (m.type === 'scale') return (m.params.gain ?? 1) === 0 ? 0 : Number.isFinite(fastest) ? fastest * Math.abs(m.params.gain ?? 1) : fastest;
  return fastest;
}

/** does a signal from module `id` change about every sample (the oscillator works out its increments only when the pitch moves)? */
const keepsMoving = (p: Patch, id: number): boolean => slope(p, id) >= 0.5;

/** cores: 2, the FM-1 since #271 (core 0's time: the split poly groups' odd parts on core 1, plus an idle second core's
 * cost); 1 as with core 1 held */
export function cpuEstimate(source: Patch, table: CpuTable = CPU, cores: 1 | 2 = 2): CpuEstimate {
  // counted on what the FM-1 runs (poly.ts deviceView): an allocator is a Part in each group it drives
  const { patch: p, groups } = deviceView(source, true);
  const copies = new Map<number, number>();
  const groupOf = new Map<number, number>();
  groups.forEach((g, i) => g.modules.forEach((id) => (groupOf.set(id, i), copies.set(id, g.cfg.parts))));
  const ninst = (id: number): number => copies.get(id) ?? 1;
  const morph = hasMorph(p);
  // the rig's factor of each module of a factory engine (CpuTable.rig), by its id (deviceView keeps the source's ids)
  const factor = new Map<number, number>();
  for (const a of assembliesOf(source)) {
    const k = table.rig?.engines[a.name];
    if (k !== undefined && !parentOf(source, a.id)) for (const id of allModules(source, a)) factor.set(id, k);
  }
  let total = table.block, split = 0, counted = table.block;
  const splitGroups = new Set<number>();
  const modules: CpuModule[] = [];
  for (const m of p.modules) {
    const def = DEFS[m.type];
    const t = table.types[m.type];
    if (!def || !t) continue;
    const inputs = new Set<string>(), outputs = new Set<string>();
    const sources = new Map<string, number>();
    for (const c of p.cables) {
      if (c.to.module === m.id) {
        inputs.add(c.to.port);
        const n = groupOf.get(c.from.module) !== groupOf.get(m.id) ? ninst(c.from.module) : 1;
        sources.set(c.to.port, (sources.get(c.to.port) ?? 0) + n);
      }
      if (c.from.module === m.id) outputs.add(c.from.port);
    }
    let one = table.node + t.cv;
    for (const n of sources.values()) if (n >= 2) one += table.sum.port + n * table.sum.source;
    const moved = new Set<string>();
    if (def.paramInputs) {
      for (const pin of ['p1', 'p2'] as const)
        if (inputs.has(pin)) {
          one += table.cv.pin;
          for (const name of m.map?.[pin] ?? []) moved.add(name);
        }
      for (const names of Object.values(m.inputMap ?? {}))
        if (names.length) {
          one += table.cv.pin;
          for (const name of names) moved.add(name);
        }
      for (const name of moved) one += def.params.find((q) => q.name === name)?.log ? table.cv.log : table.cv.lin;
    }
    if (morph && m.type !== 'fm1') {
      one += table.cv.morph * def.params.length;
      for (const [name, v] of Object.entries(m.paramsB ?? {})) if (v !== m.params[name]) moved.add(name);
    }
    const group = groups[groupOf.get(m.id) ?? -1];
    if (!m.bypass && m.type === 'vca' && group) {
      let work = 0;
      const pd = def.params.find((p) => p.name === 'gain')!;
      const base = Math.round(paramOf(m, 'gain') * 65536);
      for (let part = 0; part < group.cfg.parts; part++) {
        // Match apply_flaws: the level scales the Q16 base gain before the gain fast path is chosen.
        const level = flawOf(group.cfg, part).level;
        const scaled = Math.floor(base * Math.floor(level * 65536 / 100) / 65536) / 65536;
        const gain = Math.max(pd.min, Math.min(pd.max, scaled));
        work += runCost({ ...m, params: { ...m.params, gain } }, t, inputs, outputs, moved, table.note);
      }
      one += work / group.cfg.parts;
    } else if (!m.bypass && m.type === 'osc' && OSC_PM_SUM.some((i) => inputs.has(i))) {
      // the summed phase modulation (#518, engine.c osc_pm): the FM path as with pm patched, when any patched index is above 0
      const on = (['pm', 'pm2', 'pm3'] as const).some((k) => inputs.has(k) && (paramOf(m, k) > 0 || moved.has(k)));
      one += runCost({ ...m, params: { ...m.params, pm: on ? Math.max(1, paramOf(m, 'pm')) : 0 } }, t, new Set([...inputs, 'pm']), outputs, moved, table.note) + (on ? t.pmSum ?? 0 : 0);
    } else if (!m.bypass && t.matrix) one += t.run + matrixCost(m, t.matrix, inputs, outputs, moved);
    else one += m.bypass ? table.bypass * outputs.size : runCost(m, t, inputs, outputs, moved, table.note);
    if ((t.firstOff || t.alone) && !m.bypass && !outputs.has(def.outputs[0].name) && !(FIRST_ALSO[m.type] ?? []).some((o) => outputs.has(o))) {
      one -= (t.firstOff ?? 0) + Math.max(0, ...Object.entries(t.firstOffWith ?? {}).filter(([i]) => inputs.has(i)).map(([, v]) => v));
      if (outputs.size === 1) one -= t.alone?.[[...outputs][0]] ?? 0;
    }
    // a pitch input that keeps moving: something that never holds still reaches it (an envelope or a glide only moves for a moment)
    if (t.moving && !m.bypass && p.cables.some((c) => c.to.module === m.id && c.to.port === 'pitch' && keepsMoving(p, c.from.module))) {
      const copies = m.type === 'osc' ? Math.max(Math.round(m.params.unison ?? 1), STACKS[Math.round(m.params.stack ?? 0)]?.length ?? 1) : 1;
      one += t.movingCopies?.[copies - 1] ?? t.moving * copies;
    }
    if (t.glide && !m.bypass && moved.has('time')) one += t.glide;
    if (t.thru && m.type === 'steps' && inputs.has('keys')) one += t.thru * Math.min(TRACK_POLY, Math.max(1, ...groups.map((g) => g.cfg.parts)));
    if (m.type === 'output') (total += table.output), (counted += table.output);
    const k = ninst(m.id);
    counted += one * k;
    one *= factor.get(m.id) ?? 1;
    if (group && k >= 2 && m.type !== 'steps') {
      split += one * Math.floor(k / 2);
      splitGroups.add(groupOf.get(m.id)!);
    }
    modules.push({ id: m.id, type: m.type, copies: k, cycles: one * k });
    total += one * k;
  }
  modules.sort((a, b) => b.cycles - a.cycles);
  const oneCoreUs = total / table.cyclesPerUs + table.fixedUs;
  const c = table.cores;
  const us = cores === 2 && c ? oneCoreUs + c.idleUs - (c.splitEff * split) / table.cyclesPerUs : oneCoreUs;
  return { cycles: counted, split, splitGroups: splitGroups.size, oneCoreUs, us, use: us / table.blockUs, modules };
}
