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
import { cpuEstimate, type CostDim, type CpuTable, type TypeCost } from '../src/cpu';
import { DEFS } from '../src/modules';
import { encodePatch } from '../src/patchbin';
import { addModule, connect, EDITOR_ONLY, fromUnit, newPatch, type ModuleInst, type ParamDef, type Patch } from '../src/patch';
import { cpuChecks } from '../src/cpu-checks';

const ROOT = new URL('../../', import.meta.url).pathname;
execSync('tools/cpu/build.sh', { cwd: ROOT, stdio: 'inherit' });
const ELF = { prof: 'prof', plain: 'plain', old: 'old', bench: 'bench' } as const;
const POOL = pool(Object.fromEntries(Object.keys(ELF).map((k) => [k, `${ROOT}build/cpu/${k}.elf`])));
const NOTE = 72; // C5

const BLOCK_US = 2901; // 128 frames at 44118 Hz (DEVICE_SR)
const OLD_PEAK = 0.12; // 303 Acid on M1-0.2: 11 % typical, 12 % peak of the half buffer (ISR time incl. key scan and USB)
/** The scale, frozen (not fitted on each run: a faster engine would bend it against an old survey). The 17 factory patches
 * measured on the FM-1 (docs/measurements/cpu-survey-2026-10-20.json) against the estimate at the old scale (243 cycles / us
 * from the 303 Acid alone): device % = 1.041 x estimate % + 0.8. So 243 / 1.041 cycles per us, plus 0.8 % of the block the
 * engine does not count (the rest of the audio interrupt: key scan, USB poll). A new survey after large engine changes
 * replaces both. */
const SURVEY = {
  cyclesPerUs: 233.4,
  fixedUs: 23,
  survey: 'docs/measurements/cpu-survey-2026-10-20.json, CI run 39541520839 (device-diag)',
  fit: 'device % = 1.041 x estimate + 0.8, 17 patches, peak of rest / 1 / 4 / 8 notes',
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
  const r = await emulate(elf, encodePatch(p, true), events(notes));
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
  for (const name of cfg.inputs ?? []) {
    if (name === 'pitch') continue;
    if ((name === 'gate' || cfg.feed === 'gate') && m !== main) connect(p, DEFS, { module: main.id, port: 'gate' }, { module: m.id, port: name });
    else {
      src ??= addModule(p, DEFS.osc, 0, 300);
      connect(p, DEFS, { module: src.id, port: 'out' }, { module: m.id, port: name });
    }
  }
  if (type === 'arp') {
    // an Arpeggiator is heard through the group it plays (its keys cables are gone on the device, device-compile.ts keeps
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
/** types whose outputs each cost the same whatever else is patched (a constant fill per output): their outputs are
 * additive, not dimensions of the grid (the Drum map's sixteen would make a grid of 2^14 points; the Selector's eight gates) */
const ADDITIVE_OUTPUTS = new Set(['drummap', 'select']);
/** `order`: where the setting stands in the definition, so that equal effects sort the same on every run (the probes finish
 * in any order) */
type Dim = { dim: CostDim; values: number[]; effect: number; order: number; set: (cfg: KitCfg, v: number) => void };

async function typeCost(type: string): Promise<TypeCost> {
  const def = DEFS[type];
  const base = await measure(type);
  const thr = Math.max(0.03 * base.run, 100);
  const pins = new Set(def.inputs.filter((i) => i.pin).map((i) => i.name));
  const allInputs = def.inputs.filter((i) => !pins.has(i.name) && i.name !== 'pitch').map((i) => i.name);
  const dims: Dim[] = [];
  const setParam = (name: string) => (cfg: KitCfg, v: number): void => void (cfg.params = { ...cfg.params, [name]: v });
  // 1. choices, switches, small integers: alone and with every input patched
  const numbers: ParamDef[] = [];
  await Promise.all(
    def.params.map(async (pd, order) => {
      if ((type === 'scale' || type === 'vca') && pd.name === 'gain') {
        const values = [0, 1, .37];
        const effect = await effectOf(type, (v) => ({ gain: v }), values, [{}, { inputs: allInputs }]);
        dims.push({ dim: { param: 'gain', exact: [0, 1] }, values, effect, order, set: setParam('gain') });
        return;
      }
      const t = tries(pd);
      if (!t.discrete) return void numbers.push(pd);
      const effect = await effectOf(type, (v) => ({ [pd.name]: v }), t.values, [{}, { inputs: allInputs }]);
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
  // its second output instead (cpu.ts FIRST_ALSO lists outputs that need the same work)
  if (def.outputs.length > 1 && type !== 'fm1') {
    const second = def.outputs[1].name;
    const off = Math.round(base.run - (await measure(type, { primary: second })).run);
    if (off > thr) {
      out.firstOff = off;
      const withIn: Record<string, number> = {};
      await Promise.all(
        allInputs.map(async (name, i) => {
          const more = Math.round((await measure(type, { inputs: [name] })).run - (await measure(type, { inputs: [name], primary: second })).run) - off;
          if (more > thr) withIn[name] = more;
        }),
      );
      if (Object.keys(withIn).length) out.firstOffWith = withIn;
    }
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
    method: 'a scale and a fixed time per block, fitted to the factory patches measured on the FM-1 (survey, fit)',
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
  console.log(`${type.padEnd(10)} run ${String(t.run).padStart(7)}  cv ${String(t.cv).padStart(5)}${t.dims ? `  ${t.dims.map(show).join(' ')} (${t.grid!.length})` : ''}${t.extra ? `  + ${t.extra.map((e) => show(e.dim)).join(' ')}` : ''}`);
}
const [cal, loop, sum, cv, bypass, thru] = await Promise.all([calibration(), loopCosts(types), sumCost(), cvCost(), bypassCost(), thruCost()]);
types.steps.thru = thru;
console.log(`steps thru ${thru} per key`);
const { cyclesPerUs, fixedUs } = SURVEY;
const table: CpuTable = {
  source: 'estimate: the fixed-point engine counted on an rv32im model (tools/cpu), calibrated on 17 factory patches measured on the FM-1 (2026-10-20)',
  cyclesPerUs,
  fixedUs,
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
// works out what the engine then keeps until a setting changes (#289), which is no part of playing
const checkRun = async (p: Patch, notes: number[]): Promise<number> => {
  const r = await emulate(ELF.plain, encodePatch(p, true), [RENDER, ...notes.map(ON), ...Array(BLOCKS).fill(RENDER)]);
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
