// SPDX-License-Identifier: GPL-3.0-only
// The CPU cost table (src/cpu-costs.json) for the editor's estimate (src/cpu.ts). Counts the fixed-point engine on an rv32im
// model (tools/cpu: build.sh builds it, rv32.mjs runs it) module by module:
//   - every module type alone, every setting changed one at a time (alone and with every input patched), to find what changes
//     its cost (dims); the settings that do are measured in all combinations (grid), numbers at the points where their cost
//     bends (the editor interpolates);
//   - the shared costs: summing inputs, parameter inputs, morph, bypass, the render loop per module and per block;
//   - the scale: frozen constants fitted to a survey of the factory patches on the FM-1 (SURVEY, below); the M1-0.2 engine's
//     303 Acid and the kernels of firmware/src/bench.c, both measured there earlier, are counted again as cross-checks;
//   - whole factory patches, as checks of the model (cpu.test.ts).
// Kits hold C5 (a square or saw oscillator costs more the higher it plays). Run from web/: npm run cpu-costs
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
// @ts-ignore: plain JavaScript modules
import { pool } from '../../tools/cpu/pool.mjs';
import { cpuEstimate, FIRST_ALSO, type CostDim, type CpuTable, type TypeCost } from '../src/cpu';
import { DEFS } from '../src/modules';
import { encodePatch } from '../src/patchbin';
import { addModule, connect, EDITOR_ONLY, fromUnit, newPatch, type ModuleInst, type ParamDef, type Patch } from '../src/patch';
import { cpuChecks, startEvents } from '../src/cpu-checks';

const ROOT = new URL('../../', import.meta.url).pathname;
execSync('tools/cpu/build.sh', { cwd: ROOT, stdio: 'inherit' });
const ELF = { prof: 'prof', plain: 'plain', old: 'old', bench: 'bench' } as const;
const POOL = pool(Object.fromEntries(Object.keys(ELF).map((k) => [k, `${ROOT}build/cpu/${k}.elf`])));
const NOTE = 72; // C5

const BLOCK_US = 2901; // 128 frames at 44118 Hz (DEVICE_SR)
const OLD_PEAK = 0.12; // 303 Acid on M1-0.2: 11 % typical, 12 % peak of the half buffer (ISR time incl. key scan and USB)
/** The scale, frozen (not fitted on each run: a faster engine would bend it against an old survey). Fitted by
 * scripts/cpu-rig-fit.ts to the test rig's survey of every factory patch on the combined 1.12 development firmware
 * (docs/measurements/2026-11-09-rig-integration.md): least squares of the rig's steady peak on the estimate at the scale
 * before (233.4 cycles / us + 23 us, fitted to the FM-1's survey of 2026-10-20). A new survey after large engine or
 * firmware changes replaces it (run cpu-rig-fit.ts, then npm run cpu-costs). */
const SURVEY = {
  cyclesPerUs: 195.8,
  fixedUs: 270,
  survey: 'docs/measurements/cpu-survey-2026-11-09-rig-integration.json and -run.json (CI run 42673451565, default switches, all 30 factory patches)',
  fit: 'rig us = 1.192 x estimate before + 242 us (the 5 patches without an engine of their own: Init, Simple FM, Plucked String, 909 Kit, <7PH), so 233.4 / 1.192 cycles per us plus 1.192 x 23 + 242 us a block; the second core idle cost 1.192 x 24 us',
};
/** The second core. Its idle cost to core 0 is fitted to the test rig's surveys of every factory patch (docs/measurements/
 * 2026-11-05-rig-second-core.md) against release-1.10's head before #271 (the one-core firmware): the median, over the
 * patches that do not split, of the steady 8-key time on the dual-core build minus on that one (24 us; from -31 to +80).
 * Its saving (#802) is fitted to the two-core schedule's firmware with the second core's work refused (tools/m1_link.py
 * cores split off) against the same firmware with it: 0.75 x the modelled saving (schedule.ts scheduleTime) stays under
 * every patch's measured saving (the patches that shed voices on one core left out), so the estimate never promises more
 * room than the FM-1 has. */
const CORES = {
  idleUs: 29,   // (24 us at the scale before, cpu-rig-fit.ts)
  splitEff: 0.75,
  survey: 'docs/measurements/cpu-survey-2026-11-14-rig-steps-split-off.json against -steps.json (CI run 43571432090); the idle cost: -2026-11-05-rig-release-1.10-head.json against -rig-merged-split.json',
};
/** Each factory engine's factor on its modules' cycles (src/cpu.ts CpuTable.rig), fitted by scripts/cpu-rig-fit.ts to the
 * test rig's survey of the 1.14 bank on the firmware with Steps' quiet samples in one pass (#802, at SURVEY's scale): the
 * smallest that makes the estimate read at least the rig's steady peak for every voice count its factory patch played on
 * the rig, transport stopped and running. The counted engine misses what the FM-1 spends beyond its instructions (its
 * caches and memory, the hardware's own timing, how the two cores share the block), and that differs from engine to
 * engine: the factors run from 0.61 to 1.06. The patches outside the 1.14 bank (basic poly, drift poly, mono lead,
 * supersaw stack) keep the factors of the 2026-11-09 survey. */
const RIG = {
  engines: {
    '8 Lire': 0.65, '808 kit': 0.85, '909 kit': 0.74, 'Algo Four': 0.65, 'Briefcase 3': 0.82,
    'Canvas': 0.79, 'Cassia 1': 0.67, 'Elvira 2': 0.94, 'Expander S': 0.77,
    'Hera 4': 0.65, 'Io 4': 0.71, 'Meridian 8': 0.72, 'Monolith D': 0.76,
    'Oracle V': 0.72, 'Perun 4': 0.77, 'Sallen 20': 0.88, 'Scrounge': 0.8,
    'Silver Box': 1, 'Spokes 6': 0.81, 'Vernon 100': 0.61, 'Verona Drum 1': 0.89,
    'Wanderer': 1.06, 'basic poly': 0.92, 'drift poly': 0.92, 'mono lead': 1.28,
    'supersaw stack': 0.88,
  } as Record<string, number>,
  survey: 'docs/measurements/cpu-survey-2026-11-14-rig-steps.json and -run.json (CI run 43571432090, the 22 patches of the 1.14 bank)',
};
const BLOCKS = 24;
const SKIP = 3; // blocks before the maximum is taken for a module kit (the first notes, envelopes starting)

const ON = (n: number): number => (1 << 16) | n;
const RENDER = 3 << 16;
const events = (notes: number[]): number[] => [...notes.map(ON), ...Array(BLOCKS).fill(RENDER)];

type Stage = { sum: number; cv: number; run: number };
type Run = { totals: number[]; nodes: Map<string, Stage>[] };

type Blocks = { blocks: { total: number; nodes: Map<string, Stage> }[]; exit: number };
const emulate = (elf: string, patch: Uint8Array, ev: number[]): Promise<Blocks> => POOL.run(elf, patch, ev);
const run = async (elf: string, p: Patch, notes = [NOTE]): Promise<Run> => {
  const r = await emulate(elf, encodePatch(p, true), [...startEvents(p), ...events(notes)]);
  if (r.exit) throw new Error(`${p.name}: the engine refused the patch (${r.exit})`);
  return { totals: r.blocks.map((b) => b.total), nodes: r.blocks.map((b) => b.nodes) };
};
const peak = (xs: number[]): number => Math.max(...xs.slice(SKIP));

/** the cost of one hook (the cycles a stage counts when it does nothing) */
let HOOK = 0;
/** module `index`'s stages, part 0, each its maximum over the blocks, less the hook */
const stages = (r: Run, index: number, part = 0): Stage => {
  const pick = (k: keyof Stage): number => peak(r.nodes.map((n) => n.get(`${index}/${part}`)?.[k] ?? 0)) - HOOK;
  return { sum: Math.max(0, pick('sum')), cv: Math.max(0, pick('cv')), run: Math.max(0, pick('run')) };
};

// ------------------------------------------------------------------ a module alone

interface KitCfg {
  params?: Record<string, number>;
  inputs?: string[];
  outputs?: string[];
  /** the output that goes to the Output module (default: the first one) */
  primary?: string;
  /** what feeds the inputs: an oscillator (edges every few samples) or the Main gate (high for whole blocks) */
  feed?: 'osc' | 'gate';
  /** an LFO adds to the pitch input: it moves every sample (the oscillator works out its increments only when the pitch moves) */
  moving?: boolean;
  /** an LFO into p1, the pin set on this parameter (a delay's time that keeps moving: its read position glides) */
  pinTo?: string;
}

/** Main + the module + Output, its first output into the Output, a pitch input always fed by the Main pitch (the played note
 * sets the cost of a square or saw), `inputs` fed (gate inputs by the Main gate, the rest by `feed`), `outputs` also patched */
function kit(type: string, cfg: KitCfg = {}): { p: Patch; m: ModuleInst } {
  const p = newPatch(DEFS, `cpu ${type}`);
  const main = p.modules[0], out = p.modules[1];
  const m = type === 'fm1' ? main : type === 'output' ? out : addModule(p, DEFS[type], 300, 0);
  Object.assign(m.params, cfg.params ?? {});
  const def = DEFS[type];
  let src: ModuleInst | undefined;
  if (m !== main && def.inputs.some((i) => i.name === 'pitch')) connect(p, DEFS, { module: main.id, port: 'pitch' }, { module: m.id, port: 'pitch' });
  if (cfg.moving) connect(p, DEFS, { module: addModule(p, DEFS.lfo, 0, 600).id, port: 'out' }, { module: m.id, port: 'pitch' });
  if (cfg.pinTo) {
    connect(p, DEFS, { module: addModule(p, DEFS.lfo, 0, 900).id, port: 'out' }, { module: m.id, port: 'p1' });
    m.map!.p1 = [cfg.pinTo];
    m.map!.p2 = [];
  }
  for (const name of cfg.inputs ?? []) {
    if (name === 'pitch') continue;
    if ((name === 'gate' || cfg.feed === 'gate') && m !== main) connect(p, DEFS, { module: main.id, port: 'gate' }, { module: m.id, port: name });
    else {
      src ??= addModule(p, DEFS.osc, 0, 300);
      connect(p, DEFS, { module: src.id, port: 'out' }, { module: m.id, port: name });
    }
  }
  if (type === 'arp' || type === 'harm') {
    // an Arpeggiator (a Harmonizer the same) is heard through the group it plays (its keys cables are gone on the device, device-compile.ts keeps
    // a group's Arpeggiator): Main keys -> it -> an allocator whose gate reaches the Output
    const alloc = addModule(p, DEFS.alloc, 600, 0);
    connect(p, DEFS, { module: main.id, port: 'keys' }, { module: m.id, port: 'keys' });
    connect(p, DEFS, { module: m.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
    connect(p, DEFS, { module: alloc.id, port: 'gate' }, { module: out.id, port: 'l' });
  } else if (m !== out && def.outputs.length) connect(p, DEFS, { module: m.id, port: cfg.primary ?? def.outputs[0].name }, { module: out.id, port: 'l' });
  for (const name of cfg.outputs ?? []) connect(p, DEFS, { module: m.id, port: name }, { module: out.id, port: 'r' });
  return { p, m };
}

const cache = new Map<string, Promise<Stage>>();
const measureFed = (type: string, cfg: KitCfg): Promise<Stage> => {
  const key = `${type} ${JSON.stringify(cfg)}`;
  let r = cache.get(key);
  if (!r) {
    const { p, m } = kit(type, cfg);
    r = run(ELF.prof, p).then((x) => stages(x, p.modules.indexOf(m)));
    cache.set(key, r);
  }
  return r;
};
/** the module's stages in a kit (each configuration counted once): with inputs patched, the worse of the two feeds (a clock
 * divider works hardest while its clock is high, an oscillator's sync on many edges) */
const measure = async (type: string, cfg: KitCfg = {}): Promise<Stage> => {
  if (!cfg.inputs?.length) return measureFed(type, cfg);
  const [a, b] = await Promise.all([measureFed(type, { ...cfg, feed: 'osc' }), measureFed(type, { ...cfg, feed: 'gate' })]);
  return { sum: Math.max(a.sum, b.sum), cv: Math.max(a.cv, b.cv), run: Math.max(a.run, b.run) };
};
const runs = (type: string, cfgs: KitCfg[]): Promise<number[]> => Promise.all(cfgs.map((c) => measure(type, c).then((x) => x.run)));

/** a parameter's values to try: every value of a choice / switch / small integer, else points across its range (just above
 * the minimum too: some modules change mode when a value leaves 0) */
function tries(pd: ParamDef): { values: number[]; discrete: boolean } {
  if (pd.choices) return { values: pd.choices.map((_, i) => i), discrete: true };
  if (pd.toggle) return { values: [0, 1], discrete: true };
  if (pd.step && pd.step >= 1 && pd.max - pd.min <= 8) {
    const values: number[] = [];
    for (let v = pd.min; v <= pd.max; v += pd.step) values.push(v);
    return { values, discrete: true };
  }
  const eps = Math.max(pd.step ?? 0, (pd.max - pd.min) * 0.01);
  const values = [pd.min, pd.log ? pd.min * 1.01 : pd.min + eps, ...[0.25, 0.5, 0.75, 1].map((u) => fromUnit(pd, u))];
  return { values: [...new Set(values.map((v) => +v.toPrecision(6)))], discrete: false };
}

/** the points of a cost curve that linear interpolation needs (every curve in `costs` within `thr`); the first two stay
 * when the cost steps there */
function bends(values: number[], costs: number[][], thr: number, step: boolean): number[] {
  const keep = values.map((_, i) => i);
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = step ? 2 : 1; k < keep.length - 1; k++) {
      const [a, i, b] = [keep[k - 1], keep[k], keep[k + 1]];
      const w = (values[i] - values[a]) / (values[b] - values[a]);
      if (costs.every((c) => Math.abs(c[a] + w * (c[b] - c[a]) - c[i]) <= thr)) {
        keep.splice(k, 1);
        changed = true;
        break;
      }
    }
  }
  return keep.map((i) => values[i]);
}

const GRID_MAX = 16384;
/** more settings a type's choices are tried in: the Delay's heads (#660) cost only with Tape on */
const CHOICE_CONTEXTS: Record<string, KitCfg[]> = { delay: [{ params: { tape: 1 } }] };
/** settings with exact fast paths in engine.c (cpu.ts CostDim exact): those values, then one ordinary value counted for
 * every other (a Scale's or VCA's gain of 0 or 1; a fully wet Chorus or Reverb drops its dry and mix products) */
const EXACT: Record<string, Record<string, { exact: number[]; other: number }>> = {
  scale: { gain: { exact: [0, 1], other: 0.37 } },
  vca: { gain: { exact: [0, 1], other: 0.37 } },
  chorus: { mix: { exact: [1], other: 0.5 } },
  reverb: { mix: { exact: [1], other: 0.5 } },
};
/** settings left out of the dims search, counted another way (cpu.ts OSC_PM_SUM): the oscillator's summed phase modulation
 * (#518) runs its FM path as one patched pm input does, plus the summing loop (TypeCost.pmSum); as dims they would push
 * its wave and pitch out of the grid */
const FOLDED: Record<string, { params: string[]; inputs: string[] }> = { osc: { params: ['pm2', 'pm3'], inputs: ['pm2', 'pm3', 'index'] } };
/** types whose outputs each cost the same whatever else is patched (a constant fill per output): their outputs are
 * additive, not dimensions of the grid (the Drum map's sixteen would make a grid of 2^14 points; the Selector's eight gates; the Shift register's ten) */
const ADDITIVE_OUTPUTS = new Set(['drummap', 'select', 'shreg']);
/** `order`: where the setting stands in the definition, so that equal effects sort the same on every run (the probes finish
 * in any order) */
type Dim = { dim: CostDim; values: number[]; effect: number; order: number; set: (cfg: KitCfg, v: number) => void };

/** a Matrix (#525): its cost is its columns (TypeCost.matrix), not a grid of its sixteen pins: out1 read with k pins in use
 * (in1..ink patched, their pins at 0.5) over none, and out2 read too, with none */
async function matrixCost(): Promise<TypeCost> {
  const base = await measure('matrix');
  const ins = ['in1', 'in2', 'in3', 'in4'];
  const pins = await Promise.all([1, 2, 3, 4].map(async (k) =>
    Math.round((await measure('matrix', { inputs: ins.slice(0, k), params: Object.fromEntries(ins.slice(0, k).map((_, i) => [`i${i + 1}o1`, 0.5])) })).run - base.run)));
  const out = Math.round((await measure('matrix', { outputs: ['out2'] })).run - base.run);
  return { run: Math.round(base.run), cv: Math.round(base.cv), matrix: { out, pins } };
}

async function typeCost(type: string): Promise<TypeCost> {
  if (type === 'matrix') return matrixCost();
  const def = DEFS[type];
  const base = await measure(type);
  const thr = Math.max(0.03 * base.run, 100);
  const pins = new Set(def.inputs.filter((i) => i.pin).map((i) => i.name));
  const folded = FOLDED[type];
  const allInputs = def.inputs.filter((i) => !pins.has(i.name) && i.name !== 'pitch' && !folded?.inputs.includes(i.name)).map((i) => i.name);
  const dims: Dim[] = [];
  const setParam = (name: string) => (cfg: KitCfg, v: number): void => void (cfg.params = { ...cfg.params, [name]: v });
  // 1. choices, switches, small integers: alone and with every input patched
  const numbers: ParamDef[] = [];
  await Promise.all(
    def.params.map(async (pd, order) => {
      if (folded?.params.includes(pd.name)) return;
      const ex = EXACT[type]?.[pd.name];
      if (ex) {
        const values = [...ex.exact, ex.other];
        const effect = await effectOf(type, (v) => ({ [pd.name]: v }), values, [{}, { inputs: allInputs }]);
        dims.push({ dim: { param: pd.name, exact: ex.exact }, values, effect, order, set: setParam(pd.name) });
        return;
      }
      const t = tries(pd);
      if (!t.discrete) return void numbers.push(pd);
      const effect = await effectOf(type, (v) => ({ [pd.name]: v }), t.values, [{}, { inputs: allInputs }, ...(CHOICE_CONTEXTS[type] ?? [])]);
      if (effect > thr) dims.push({ dim: { param: pd.name, values: t.values }, values: t.values, effect, order, set: setParam(pd.name) });
    }),
  );
  // 2. numbers, in the same two contexts and with each value of the choices found (a saw's cost does not depend on its pitch,
  // a square's does): a step just above the minimum and flat after it is a mode (on / off), else a curve through its bends
  const contexts: KitCfg[] = [{}, { inputs: allInputs }, ...dims.flatMap((d) => d.values.map((v) => ({ params: { [(d.dim as { param: string }).param]: v } })))];
  const modes: { name: string; min: number; ref: number }[] = [];
  await Promise.all(
    numbers.map(async (pd) => {
      const t = tries(pd);
      const order = def.params.indexOf(pd);
      const curves = await Promise.all(contexts.map((c) => runs(type, t.values.map((v) => ({ ...c, params: { ...c.params, [pd.name]: v } })))));
      const effect = Math.max(...curves.map((c) => Math.max(...c) - Math.min(...c)));
      if (effect <= thr) return;
      const step = curves.some((c) => Math.abs(c[1] - c[0]) > thr);
      const flat = curves.every((c) => c.slice(1).every((x) => Math.abs(x - c[1]) <= thr));
      if (step && flat) {
        const ref = pd.default > pd.min ? pd.default : t.values[1];
        modes.push({ name: pd.name, min: pd.min, ref });
        dims.push({ dim: { param: pd.name, above: pd.min }, values: [0, 1], effect, order, set: (cfg, on) => setParam(pd.name)(cfg, on ? ref : pd.min) });
      } else {
        const points = bends(t.values, curves, thr, step);
        dims.push({ dim: { param: pd.name, points }, values: points, effect, order, set: setParam(pd.name) });
      }
    }),
  );
  // 3. inputs, alone and with each mode on (an oscillator's pm input does nothing until its pm index is above 0; its feedback
  // would hide that, it turns on the same FM mode)
  const off = Object.fromEntries(modes.map((q) => [q.name, q.min]));
  const modeContexts: KitCfg[] = [{}, { inputs: allInputs }, ...modes.map((q) => ({ params: { ...off, [q.name]: q.ref } }))];
  const flag = (cfg: KitCfg, key: 'inputs' | 'outputs', name: string, on: number): void => void (on && (cfg[key] = [...(cfg[key] ?? []), name]));
  await Promise.all(
    allInputs.map(async (name, i) => {
      const effects = await Promise.all(modeContexts.map(async (c) => {
        const inputs = (c.inputs ?? []).filter((x) => x !== name);
        return Math.abs((await measure(type, { ...c, inputs: [...inputs, name] })).run - (await measure(type, { ...c, inputs })).run);
      }));
      const effect = Math.max(...effects);
      if (effect > thr) dims.push({ dim: { input: name }, values: [0, 1], effect, order: 1000 + i, set: (cfg, on) => flag(cfg, 'inputs', name, on) });
    }),
  );
  await Promise.all(
    def.outputs.slice(1).map(async (output, i) => {
      const effect = Math.abs((await measure(type, { outputs: [output.name] })).run - base.run);
      if (effect > thr) dims.push({ dim: { output: output.name }, values: [0, 1], effect, order: 2000 + i, set: (cfg, on) => flag(cfg, 'outputs', output.name, on) });
    }),
  );
  // 4. every combination of the dims; the smallest effects become additive when there are too many
  dims.sort((a, b) => b.effect - a.effect || a.order - b.order);
  const extra: Dim[] = [];
  if (ADDITIVE_OUTPUTS.has(type)) for (let i = dims.length - 1; i >= 0; i--) if ('output' in dims[i].dim) extra.unshift(...dims.splice(i, 1));
  while (dims.reduce((n, d) => n * d.values.length, 1) > GRID_MAX) extra.unshift(dims.pop()!);
  const out: TypeCost = { run: Math.round(base.run), cv: Math.round(base.cv) };
  // the oscillator's summed phase modulation: all three pm inputs and the index patched against pm alone, the worse of the
  // sine operator path and the general one (a square)
  if (type === 'osc') {
    const sum = await Promise.all([0, 3].map(async (wave) => {
      const [all, one] = await Promise.all([
        measure(type, { params: { wave, pm: 1, pm2: 1, pm3: 1 }, inputs: ['pm', 'pm2', 'pm3', 'index'] }),
        measure(type, { params: { wave, pm: 1 }, inputs: ['pm'] }),
      ]);
      return all.run - one.run;
    }));
    out.pmSum = Math.max(0, Math.round(Math.max(...sum)));
  }
  // a delay whose time keeps moving: its read position glides (engine.c dly_glide) instead of the plain loops; the worse of
  // free and ping-pong, less the pin's own cost (cv)
  if (type === 'delay') {
    const glide = await Promise.all([{}, { pingpong: 1 }].map(async (params) => {
      const [moved, held] = await Promise.all([measure(type, { params, pinTo: 'time' }), measure(type, { params })]);
      return moved.run - held.run;
    }));
    out.glide = Math.max(0, Math.round(Math.max(...glide)));
  }
  // a pitch that moves every sample (an LFO, a glide, an envelope into it), per copy of a unison oscillator
  if (def.inputs.some((i) => i.name === 'pitch')) {
    const moving = Math.round((await measure(type, { moving: true })).run - base.run);
    if (moving > thr) out.moving = moving;
    // The unison loop has its own pitch-conversion overhead. Multiplying the single-copy difference undercounts it.
    if (type === 'osc') out.movingCopies = await Promise.all([1, 2, 3, 4, 5].map(async (unison) => {
      const waves = def.params.find((p) => p.name === 'wave')!.choices!.map((_, i) => i);
      const costs = await Promise.all(waves.map(async (wave) => {
        const params = { unison, wave };
        return (await measure(type, { params, moving: true })).run - (await measure(type, { params })).run;
      }));
      return Math.max(0, Math.round(Math.max(...costs)));
    }));
  }
  // work only the first output needs (the filter's second stage feeds lp24 and mix): saved when the module is heard through
  // another output instead. Counted on the outputs that share the module's work: not those with a cost of their own (dims or
  // extras: a Math output's own pass), whose discount for the first would follow from how many are patched, nor those
  // cpu.ts FIRST_ALSO lists. Each counted alone against patched beside the first: firstOff is the least they save, alone
  // what one of them saves beyond that (the filter's lp12 alone skips its high pass and band pass, engine.c filter_run)
  const own = new Set([...dims, ...extra].flatMap((d) => ('output' in d.dim ? [d.dim.output] : [])));
  const others = type === 'fm1' ? [] : def.outputs.slice(1).map((o) => o.name).filter((o) => !own.has(o) && !(FIRST_ALSO[type] ?? []).includes(o));
  if (others.length) {
    const saved = async (o: string, inputs: string[] = []): Promise<number> =>
      (await measure(type, { inputs, outputs: [o] })).run - (await measure(type, { inputs, primary: o })).run;
    const offs = await Promise.all(others.map((o) => saved(o)));
    const least = Math.min(...offs);
    const off = least > thr ? Math.round(least) : 0;
    if (off) {
      out.firstOff = off;
      const general = others[offs.indexOf(least)];
      const withIn: Record<string, number> = {};
      await Promise.all(
        allInputs.map(async (name) => {
          const more = Math.round((await saved(general, [name])) - off);
          if (more > thr) withIn[name] = more;
        }),
      );
      if (Object.keys(withIn).length) out.firstOffWith = withIn;
    }
    const alone = Object.fromEntries(others.map((o, i) => [o, Math.round(offs[i] - off)]).filter(([, v]) => (v as number) > thr));
    if (Object.keys(alone).length) out.alone = alone;
  }
  if (dims.length) {
    out.dims = dims.map((d) => d.dim);
    const cells: KitCfg[] = [];
    const walk = (i: number, cfg: KitCfg): void => {
      if (i === dims.length) return void cells.push(cfg);
      for (const v of dims[i].values) {
        const next = structuredClone(cfg);
        dims[i].set(next, v);
        walk(i + 1, next);
      }
    };
    walk(0, {});
    out.grid = (await runs(type, cells)).map(Math.round);
  }
  if (extra.length)
    out.extra = await Promise.all(
      extra.map(async (d) => ({
        dim: d.dim,
        add: (await runs(type, d.values.map((v) => { const cfg: KitCfg = {}; d.set(cfg, v); return cfg; }))).map((c) => Math.round(c - base.run)),
      })),
    );
  return out;
}

/** the largest change of the run cost over `values` of a setting, in any of the contexts */
async function effectOf(type: string, params: (v: number) => Record<string, number>, values: number[], contexts: KitCfg[]): Promise<number> {
  const curves = await Promise.all(contexts.map((c) => runs(type, values.map((v) => ({ ...c, params: { ...c.params, ...params(v) } })))));
  return Math.max(...curves.map((c) => Math.max(...c) - Math.min(...c)));
}

// ------------------------------------------------------------------ the shared costs

async function hookCost(): Promise<number> {
  const { p } = kit('const');
  const r = await run(ELF.prof, p);
  return Math.min(...p.modules.map((_, i) => peak(r.nodes.map((n) => n.get(`${i}/0`)?.sum ?? 0))));
}

/** summing: a Scale's input fed by 2 and by 5 Constants */
async function sumCost(): Promise<CpuTable['sum']> {
  const at = async (k: number): Promise<number> => {
    const { p, m } = kit('scale');
    for (let i = 0; i < k; i++) {
      const c = addModule(p, DEFS.const, 0, 100 * i);
      connect(p, DEFS, { module: c.id, port: 'out' }, { module: m.id, port: 'in' });
    }
    return stages(await run(ELF.prof, p), p.modules.indexOf(m)).sum;
  };
  const [a, b] = await Promise.all([at(2), at(5)]);
  const source = (b - a) / 3;
  return { port: Math.round(a - 2 * source), source: Math.round(source) };
}

/** parameter inputs, on a filter: p1 patched moving nothing, the resonance (linear), the cutoff (log); morph per parameter */
async function cvCost(): Promise<CpuTable['cv']> {
  const at = async (map: string[] | null, morph = false): Promise<number> => {
    const { p, m } = kit('filter');
    if (map) {
      const c = addModule(p, DEFS.lfo, 0, 200);
      connect(p, DEFS, { module: c.id, port: 'out' }, { module: m.id, port: 'p1' });
      m.map!.p1 = map;
      m.map!.p2 = [];
    }
    if (morph) m.paramsB = { ...m.params };
    return stages(await run(ELF.prof, p), p.modules.indexOf(m)).cv;
  };
  const [none, pin, lin, log, morph] = await Promise.all([at(null), at([]), at(['res']), at(['cutoff']), at(null, true)]);
  return {
    pin: Math.round(pin - none),
    lin: Math.round(lin - pin),
    log: Math.round(log - pin),
    morph: Math.round((morph - none) / DEFS.filter.params.length),
  };
}

/** a bypassed filter with one output patched */
async function bypassCost(): Promise<number> {
  const { p, m } = kit('filter', { inputs: ['in'] });
  m.bypass = true;
  return Math.round(stages(await run(ELF.prof, p), p.modules.indexOf(m)).run);
}

/** a Steps track that Main's keys pass through (its keys in cabled from Main, keys out into a Voicing): its cost per key
 * sounding through it (the track follows each one every sample), from none and four held */
async function thruCost(): Promise<number> {
  const p = newPatch(DEFS, 'cpu steps thru');
  const main = p.modules[0], out = p.modules[1];
  const st = addModule(p, DEFS.steps, 300, 0);
  const alloc = addModule(p, DEFS.alloc, 600, 0);
  alloc.params.voices = 8;
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: st.id, port: 'keys' });
  connect(p, DEFS, { module: st.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  connect(p, DEFS, { module: alloc.id, port: 'gate' }, { module: out.id, port: 'l' });
  const at = p.modules.indexOf(st);
  const [none, four] = await Promise.all([run(ELF.prof, p, []), run(ELF.prof, p, [NOTE, NOTE + 4, NOTE + 7, NOTE + 11])].map((r) => r.then((x) => stages(x, at).run)));
  return Math.max(0, Math.round((four - none) / 4));
}

/** the plain engine's whole block against the hooked stages: the render loop per module, the Output's mix, the rest */
async function loopCosts(types: Record<string, TypeCost>): Promise<{ block: number; node: number; output: number }> {
  const own = (t: string): number => types[t].run + types[t].cv;
  const total = async (p: Patch): Promise<number> => peak((await run(ELF.plain, p)).totals);
  const base = newPatch(DEFS, 'cpu loop');
  const many = structuredClone(base);
  const sink = many.modules.find((m) => m.type === 'output')!;
  // heard (into the Output), or the compile pass drops them (device-compile.ts); the Output's input sum is taken off again
  for (let i = 0; i < 10; i++) connect(many, DEFS, { module: addModule(many, DEFS.const, 0, 100 * i).id, port: 'out' }, { module: sink.id, port: 'l' });
  const two = structuredClone(base);
  addModule(two, DEFS.output, 0, 300);
  const [t0, t10, t2, summed] = await Promise.all([total(base), total(many), total(two), run(ELF.prof, many).then((r) => stages(r, many.modules.indexOf(sink)).sum)]);
  const node = (t10 - summed - t0 - 10 * own('const')) / 10;
  const output = t2 - t0 - node - own('output');
  const block = t0 - 2 * node - output - own('fm1') - own('output');
  return { block: Math.round(block), node: Math.round(node), output: Math.round(output) };
}

// ------------------------------------------------------------------ the scale

async function calibration(): Promise<CpuTable['calibration']> {
  const [old, bench] = await Promise.all([emulate(ELF.old, new Uint8Array(0), events([60])), emulate(ELF.bench, new Uint8Array(0), [])]);
  const oldPeak = peak(old.blocks.map((b) => b.total));
  const kernel = bench.blocks.map((b) => b.total / 16);
  return {
    method: 'a scale and a fixed time per block, and a factor per factory engine (rig), fitted to the factory patches measured on the test rig (survey, fit)',
    survey: SURVEY.survey,
    fit: SURVEY.fit,
    acidM102CyclesPerUs: Math.round(oldPeak / (OLD_PEAK * BLOCK_US)),
    acidM102Note: '303 Acid of M1-0.2 (b907693), one note held, peak cycles per block = 12 % of 2901 us (the ISR peak measured on the FM-1): the scale before the survey',
    acidM102Cycles: oldPeak,
    benchMac4CyclesPerUs: Math.round(kernel[0] / 9),
    benchSvfCyclesPerUs: Math.round(kernel[1] / 8),
    benchNote: 'firmware/src/bench.c kernels (4x Q15 MAC 9 us, Q15 SVF 8 us per block, rounded down) give the same scale within a few %',
    note: `module kits hold note ${NOTE}; a square or saw oscillator costs more the higher it plays`,
  };
}

// ------------------------------------------------------------------ the table

HOOK = await hookCost();
const names = Object.keys(DEFS).filter((t) => !EDITOR_ONLY.has(t)); // the Scope never runs on the FM-1
const costs = await Promise.all(names.map(typeCost));
const types: Record<string, TypeCost> = Object.fromEntries(names.map((n, i) => [n, costs[i]]));
for (const type of names) {
  const t = types[type];
  const show = (d: CostDim): string => ('values' in d ? `${d.param}[${d.values.length}]` : 'above' in d ? `${d.param}>${d.above}` : 'points' in d ? `${d.param}~${d.points.length}` : 'exact' in d ? `${d.param}=${d.exact.join('/')}/other` : 'input' in d ? `in:${d.input}` : `out:${d.output}`);
  console.log(`${type.padEnd(10)} run ${String(t.run).padStart(7)}  cv ${String(t.cv).padStart(5)}${t.dims ? `  ${t.dims.map(show).join(' ')} (${t.grid!.length})` : ''}${t.extra ? `  + ${t.extra.map((e) => show(e.dim)).join(' ')}` : ''}${t.matrix ? `  an output +${t.matrix.out}, pins in use +${t.matrix.pins.join(' / ')}` : ''}`);
}
const [cal, loop, sum, cv, bypass, thru] = await Promise.all([calibration(), loopCosts(types), sumCost(), cvCost(), bypassCost(), thruCost()]);
types.steps.thru = thru;
console.log(`steps thru ${thru} per key`);
const { cyclesPerUs, fixedUs } = SURVEY;
const table: CpuTable = {
  source: 'estimate: the fixed-point engine counted on an rv32im model (tools/cpu), calibrated on the factory patches measured on the test rig (2026-11-09)',
  cyclesPerUs,
  fixedUs,
  cores: CORES,
  rig: RIG,
  blockUs: BLOCK_US,
  note: NOTE,
  ...loop,
  sum,
  cv,
  bypass,
  types,
  checks: [],
  calibration: cal,
};

// whole patches: the plain engine's peak against the model
const checks = cpuChecks(NOTE).map(({ name, patch, notes }): [string, Patch, number[]] => [name, patch, notes]);
// a check's peak includes the note-on block: envelopes and glides moving there are what the FM-1 must keep up with. The
// patch loads one silent block before the notes, as on the FM-1 (a patch is loaded before it is played): the load block
// works out what the engine then keeps until a setting changes (#289), which is no part of playing. A patch with a Steps
// track counts with its transport running (startEvents)
const checkRun = async (p: Patch, notes: number[]): Promise<number> => {
  const r = await emulate(ELF.plain, encodePatch(p, true), [RENDER, ...startEvents(p), ...notes.map(ON), ...Array(BLOCKS).fill(RENDER)]);
  if (r.exit) throw new Error(`${p.name}: the engine refused the patch (${r.exit})`);
  return Math.max(...r.blocks.slice(1).map((b) => b.total));
};
const totals = await Promise.all(checks.map(([, p, notes]) => checkRun(p, notes)));
let worst = 0;
checks.forEach(([name, p], i) => {
  const cycles = totals[i];
  table.checks.push({ name, cycles });
  const est = cpuEstimate(p, table).cycles;
  const err = est / cycles - 1;
  worst = Math.max(worst, Math.abs(err));
  console.log(`${name.padEnd(28)} ${String(cycles).padStart(8)}  model ${String(Math.round(est)).padStart(8)}  ${(100 * err).toFixed(1).padStart(6)} %  load ${((100 * (cycles / cyclesPerUs + fixedUs)) / BLOCK_US).toFixed(0)} %`);
});
console.log(`scale ${cyclesPerUs} cycles/us + ${fixedUs} us (303 Acid ${cal.acidM102CyclesPerUs}, bench ${cal.benchMac4CyclesPerUs}, ${cal.benchSvfCyclesPerUs}); worst model error ${(100 * worst).toFixed(1)} %`);
writeFileSync(new URL('../src/cpu-costs.json', import.meta.url), JSON.stringify(table, null, 1) + '\n');
await POOL.close();
