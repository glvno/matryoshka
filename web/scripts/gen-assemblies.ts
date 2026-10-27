// SPDX-License-Identifier: GPL-3.0-only
// Writes the factory assemblies (src/assemblies/*.json) that are defined here as small patches: module grid positions,
// cables, the exposed ports (an input with `also` fans out to several inner inputs) and the promoted parameters.
// `voice` and `echo` are kept as files. Run from web/:  npx vite-node scripts/gen-assemblies.ts
import { writeFileSync } from 'node:fs';
import { DEFS, PD_RANGE_MAX, PD_WAVES } from '../src/modules';
import { defaultMap, defaultParams, rowDef, STEP_VEL, type ModuleInst, type PolyCards, type Source } from '../src/patch';
import { defIsEngine } from '../src/engines';
import { pinsToParams, type AssemblyDef, type NestedDef, type PortRef, type ParamRef } from '../src/assembly';

const OUT = new URL('../src/assemblies/', import.meta.url);
/** the touch plates of 8 Lire and Elvira 2: the white keys from F3 (the drum kits' rows, gen-presets.ts KIT_NOTES); their
 * Drum map repeats them over the keybed in blocks of eight white keys (`repeat`, #184: E2..E3, F3..F4, G4..G5, ..), a
 * black key playing the plate of the white key below it. PLATE_KEYS[1] is the F3 block. */
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const whiteFrom = (note: number, n: number): number[] => {
  const out: number[] = [];
  for (let k = note; out.length < n; k++) if (WHITE.includes(k % 12)) out.push(k);
  return out;
};
const PLATE_KEYS = [40, 53, 67, 81].map((start) => whiteFrom(start, 8));
const GX = 320;
const GY = 560;

interface B {
  /** add a module at grid column / row; returns its local id */
  add(type: string, col: number, row: number, params?: Record<string, number>, o?: { p1?: string; p2?: string; att?: [number, number] }): number;
  wire(a: number, ap: string, b: number, bp: string): void;
  input(label: string, module: number, port: string, ...also: [number, string][]): void;
  output(label: string, module: number, port: string): void;
  /** `col`: a new column of the card starts here; `head`: a heading above it; `span`: a display reaches across this many
   * columns (its own and those to the right); `inner`: the label on a nested card (which has no headings), when it differs */
  param(label: string, module: number, param: string, o?: { col?: boolean; head?: string; group?: boolean; span?: number; inner?: string }): void;
  /** a nested assembly (collapsed) of these modules at grid column / row; a top-level port or parameter of one of its
   * modules is shown on it too (a parent only shows what its children show) */
  nest(name: string, col: number, row: number, members: number[], poly?: PolyCards): void;
  /** an input of a nested assembly only (fed from inside the top level) */
  nestInput(label: string, module: number, port: string, ...also: [number, string][]): void;
  /** an output of a nested assembly only (read inside the top level, e.g. by a scope) */
  nestOutput(label: string, module: number, port: string): void;
  /** a parameter shown on a nested assembly only */
  nestParam(label: string, module: number, param: string): void;
  /** a factory assembly defined above (no nesting of its own) as a nested assembly at grid column / row, with the ports and
   * parameters it shows; returns its modules' ids here, by their ids in the definition */
  include(name: string, col: number, row: number, label?: string): Map<number, number>;
  /** the module with this id (to set what `add` does not: a Steps track's name and pattern, pins) */
  module(id: number): ModuleInst;
}

function build(name: string, category: string, f: (b: B) => void, poly?: PolyCards): AssemblyDef {
  const modules: ModuleInst[] = [];
  const cables: AssemblyDef['cables'] = [];
  const inputs: (PortRef & { also?: { module: number; port: string }[] })[] = [];
  const outputs: PortRef[] = [];
  const params: ParamRef[] = [];
  const nested: NestedDef[] = [];
  const nestedDefs = nested;
  const nestOf = (module: number): NestedDef | undefined => nested.find((n) => n.modules.includes(module));
  const check = (id: number, port: string, dir: 'inputs' | 'outputs'): void => {
    const m = modules[id - 1];
    if (!m || !DEFS[m.type][dir].some((p) => p.name === port)) throw new Error(`${name}: no ${dir} ${port} on module ${id}`);
  };
  const b: B = {
    add(type, col, row, p = {}, o = {}) {
      const def = DEFS[type];
      if (!def) throw new Error(`${name}: no module type ${type}`);
      for (const k of Object.keys(p)) if (!def.params.some((q) => q.name === k)) throw new Error(`${name}: ${type} has no parameter ${k}`);
      const map = defaultMap(def) as Record<Source, string[]>;
      map.k1 = map.k2 = map.k3 = map.k4 = [];
      if (o.p1) map.p1 = [o.p1];
      if (o.p2) map.p2 = [o.p2];
      const m: ModuleInst = { id: modules.length + 1, type, x: col * GX, y: row * GY, params: { ...defaultParams(def), ...p } };
      if (def.paramInputs) {
        m.att = o.att ?? [1, 1];
        m.map = map;
      }
      modules.push(m);
      return m.id;
    },
    wire(a, ap, bb, bp) {
      check(a, ap, 'outputs');
      check(bb, bp, 'inputs');
      cables.push({ from: { module: a, port: ap }, to: { module: bb, port: bp } });
    },
    input(label, module, port, ...also) {
      check(module, port, 'inputs');
      for (const [m, p] of also) check(m, p, 'inputs');
      const ref = { module, port, label, ...(also.length ? { also: also.map(([m, p]) => ({ module: m, port: p })) } : {}) };
      inputs.push(ref);
      for (const m of [module, ...also.map(([m]) => m)]) {
        const n = nestOf(m);
        if (n && !n.inputs.includes(ref)) n.inputs.push(ref);
      }
    },
    output(label, module, port) {
      check(module, port, 'outputs');
      outputs.push({ module, port, label });
      const n = nestOf(module);
      if (n && !n.outputs.some((r) => r.module === module && r.port === port)) n.outputs.push({ module, port, label });
    },
    param(label, module, param, o = {}) {
      const m = modules[module - 1];
      if (!m || !rowDef(DEFS[m.type], param)) throw new Error(`${name}: no parameter ${param} on module ${module}`);
      params.push({ module, param, label, ...(o.col && params.length ? { col: true as const } : {}), ...(o.head ? { head: o.head } : {}), ...(o.group && params.length ? { group: true as const } : {}), ...(o.span && o.span > 1 ? { span: o.span } : {}) });
      const n = nestOf(module);
      if (n && !n.params.some((r) => r.module === module && r.param === param)) n.params.push({ module, param, label: o.inner ?? label });
    },
    nestParam(label, module, param) {
      const m = modules[module - 1];
      const n = nestOf(module);
      if (!m || !rowDef(DEFS[m.type], param) || !n) throw new Error(`${name}: ${label} is not a parameter on a nested assembly`);
      n.params.push({ module, param, label });
    },
    include(from, col, row, label) {
      const d = defs.find((x) => x.name === from);
      if (!d || d.assemblies?.length) throw new Error(`${name}: cannot include ${from}`);
      const ids = new Map<number, number>();
      for (const src of d.modules) {
        const m: ModuleInst = { ...structuredClone(src), id: modules.length + 1, x: col * GX + src.x, y: row * GY + src.y };
        modules.push(m);
        ids.set(src.id, m.id);
      }
      for (const c of d.cables) b.wire(ids.get(c.from.module)!, c.from.port, ids.get(c.to.module)!, c.to.port);
      b.nest(label ?? from, col, row, [...ids.values()]);
      const nested = nestedDefs.at(-1)!;
      nested.name = from;
      for (const r of d.inputs as (PortRef & { also?: { module: number; port: string }[] })[])
        b.nestInput(r.label ?? r.port, ids.get(r.module)!, r.port, ...(r.also ?? []).map((a) => [ids.get(a.module)!, a.port] as [number, string]));
      for (const r of d.outputs) b.nestOutput(r.label ?? r.port, ids.get(r.module)!, r.port);
      for (const r of d.params) b.nestParam(r.label ?? r.param, ids.get(r.module)!, r.param);
      return ids;
    },
    module(id) {
      const m = modules[id - 1];
      if (!m) throw new Error(`${name}: no module ${id}`);
      return m;
    },
    nest(label, col, row, members, poly) {
      for (const m of members) if (!modules[m - 1] || nestOf(m)) throw new Error(`${name}: module ${m} cannot join ${label}`);
      nested.push({ id: nested.length + 1, name: label, label, x: col * GX, y: row * GY, open: false, modules: members, inputs: [], outputs: [], params: [], ...(poly ? { poly: { ...poly } } : {}) });
    },
    nestOutput(label, module, port) {
      check(module, port, 'outputs');
      const n = nestOf(module);
      if (!n) throw new Error(`${name}: ${label} is not on a nested assembly`);
      n.outputs.push({ module, port, label });
    },
    nestInput(label, module, port, ...also) {
      check(module, port, 'inputs');
      for (const [m, p] of also) check(m, p, 'inputs');
      const n = nestOf(module);
      if (!n || also.some(([m]) => nestOf(m) !== n)) throw new Error(`${name}: ${label} is not on one nested assembly`);
      n.inputs.push({ module, port, label, ...(also.length ? { also: also.map(([m, p]) => ({ module: m, port: p })) } : {}) });
    },
  };
  f(b);
  // drums are played by short trigs (a Steps track's gate is a fraction of a step): their level / rate envelopes are
  // one-shot, so the decay rows set the sound, not the trig's length
  if (category === 'Drums') for (const m of modules) if (m.type === 'env') m.params.shot = 1;
  return {
    format: 'matryoshka-assembly', version: 1, name, category, modules, cables, inputs, outputs, params,
    ...(nested.length ? { children: nested.map((n) => n.id), assemblies: nested } : {}),
    ...(poly ? { poly: { ...poly } } : {}),
  };
}

const defs: AssemblyDef[] = [];
/** category: the shelf of the editor's assembly browser (CATEGORIES in src/assemblies.ts) */
/** `poly`: a poly assembly (voice cards: its modules run once per voice of the Voice allocator that feeds them), with its flaws */
const asm = (name: string, category: string, f: (b: B) => void, poly?: PolyCards): void => {
  defs.push(build(name, category, f, poly));
};

// an FM operator: oscillator, DX-style level / rate envelope, VCA
asm('operator', 'Voices', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 0, level: 1 });
  const env = b.add('env', 1, 0, { l1: 1, r1: 0.002, l2: 0.6, r2: 0.3, l3: 0.4, r3: 1, l4: 0, r4: 0.3 });
  const vca = b.add('vca', 2, 0);
  b.wire(osc, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', osc, 'pitch');
  b.input('gate', env, 'gate');
  b.input('pm', osc, 'pm');
  b.input('level cv', vca, 'p1');
  b.output('out', vca, 'out');
  b.param('ratio', osc, 'coarse', { head: 'oscillator' });
  b.param('detune', osc, 'fine');
  b.param('index', osc, 'pm');
  b.param('feedback', osc, 'fb');
  b.param('level', vca, 'gain');
  for (const q of ['l1', 'r1', 'l2', 'r2', 'l3', 'r3', 'l4', 'r4']) b.param(q, env, q, q === 'l1' ? { head: 'envelope' } : {});
});

// two operators: a modulator with its own envelope into the carrier's phase, the carrier with its envelope
asm('fm pair', 'Voices', (b) => {
  const mod = b.add('osc', 0, 0, { wave: 0, coarse: 12, level: 1 });
  const menv = b.add('env', 1, 0, { l1: 1, r1: 0.002, l2: 0.3, r2: 0.4, l3: 0.2, r3: 1, l4: 0, r4: 0.3 });
  const mvca = b.add('vca', 2, 0);
  const car = b.add('osc', 0, 1, { wave: 0, pm: 3, level: 0.8 });
  const cenv = b.add('env', 1, 1, { l1: 1, r1: 0.003, l2: 0.7, r2: 0.3, l3: 0.6, r3: 1, l4: 0, r4: 0.4 });
  const cvca = b.add('vca', 2, 1);
  b.wire(mod, 'out', mvca, 'in');
  b.wire(menv, 'env', mvca, 'cv');
  b.wire(mvca, 'out', car, 'pm');
  b.wire(car, 'out', cvca, 'in');
  b.wire(cenv, 'env', cvca, 'cv');
  b.input('pitch', car, 'pitch', [mod, 'pitch']);
  b.input('gate', cenv, 'gate', [menv, 'gate']);
  b.output('out', cvca, 'out');
  b.param('index', car, 'pm');
  b.param('ratio', mod, 'coarse');
  b.param('feedback', mod, 'fb');
  b.param('mod decay', menv, 'r2');
  b.param('mod sustain', menv, 'l3');
  b.param('attack', cenv, 'r1');
  b.param('release', cenv, 'r4');
});

// a boom kick (808 style): a sine with a short, shallow pitch drop and a long decay, no click: five modules
asm('boom kick', 'Drums', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 0, coarse: -29, level: 1 });
  const penv = b.add('env', 1, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.04, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const sc = b.add('scale', 2, 0, { gain: 0.7, offset: 0 });
  const aenv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0.6, r2: 0.15, l3: 0, r3: 0.6, l4: 0, r4: 0.1 });
  const vca = b.add('vca', 1, 1);
  b.wire(penv, 'env', sc, 'in');
  b.wire(sc, 'out', osc, 'pitch');
  b.wire(osc, 'out', vca, 'in');
  b.wire(aenv, 'env', vca, 'cv');
  b.input('gate', aenv, 'gate', [penv, 'gate']);
  b.output('out', vca, 'out');
  b.param('tune', osc, 'coarse');
  b.param('drop', sc, 'gain');
  b.param('drop time', penv, 'r2');
  b.param('decay', aenv, 'r3');
});

// a kick (909 style): a sine with a fast pitch drop, a decaying amplitude envelope, a 1 ms noise click and a little drive
asm('kick', 'Drums', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 0, coarse: -26, level: 1 });
  const penv = b.add('env', 1, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.07, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const sc = b.add('scale', 2, 0, { gain: 2.5, offset: 0 });
  const aenv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0.5, r2: 0.12, l3: 0, r3: 0.35, l4: 0, r4: 0.05 });
  const vca = b.add('vca', 1, 1);
  const drive = b.add('shape', 2, 1, { drive: 1.6, mode: 0, level: 0.9 });
  const nz = b.add('noise', 3, 0, { level: 0.5 });
  const cenv = b.add('env', 3, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.002, l3: 0, r3: 0.002, l4: 0, r4: 0.002 });
  const cvca = b.add('vca', 4, 0);
  const mix = b.add('mixer', 4, 1, { l1: 1, l2: 0.6, l3: 0, l4: 0 });
  b.wire(penv, 'env', sc, 'in');
  b.wire(sc, 'out', osc, 'pitch');
  b.wire(osc, 'out', vca, 'in');
  b.wire(aenv, 'env', vca, 'cv');
  b.wire(nz, 'out', cvca, 'in');
  b.wire(cenv, 'env', cvca, 'cv');
  b.wire(vca, 'out', mix, 'in1');
  b.wire(cvca, 'out', mix, 'in2');
  b.wire(mix, 'out', drive, 'in');
  b.input('gate', aenv, 'gate', [penv, 'gate'], [cenv, 'gate']);
  b.output('out', drive, 'out');
  b.param('tune', osc, 'coarse');
  b.param('drop', sc, 'gain');
  b.param('drop time', penv, 'r2');
  b.param('decay', aenv, 'r3');
  b.param('punch', aenv, 'r2');
  b.param('click', mix, 'l2');
  b.param('drive', drive, 'drive');
});

// a clap: a noise band with a flam (a two-bump envelope on a 20 ms trigger) and a longer tail
asm('clap', 'Drums', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const flt = b.add('filter', 1, 0, { cutoff: 1200, res: 0.55 });
  const pl = b.add('pulse', 0, 1, { time: 0.02 });
  const fenv = b.add('env', 1, 1, { l1: 1, r1: 0.001, l2: 0.1, r2: 0.01, l3: 0.9, r3: 0.008, l4: 0, r4: 0.01 });
  const fvca = b.add('vca', 2, 0);
  const tenv = b.add('env', 2, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.12, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const tvca = b.add('vca', 3, 0, { gain: 0.7 });
  const mix = b.add('mixer', 3, 1, { l1: 0.9, l2: 0.9, l3: 0, l4: 0 });
  b.wire(nz, 'out', flt, 'in');
  b.wire(flt, 'bp', fvca, 'in');
  b.wire(flt, 'bp', tvca, 'in');
  b.wire(pl, 'out', fenv, 'gate');
  b.wire(fenv, 'env', fvca, 'cv');
  b.wire(tenv, 'env', tvca, 'cv');
  b.wire(fvca, 'out', mix, 'in1');
  b.wire(tvca, 'out', mix, 'in2');
  b.input('gate', pl, 'trig', [tenv, 'gate']);
  b.output('out', mix, 'out');
  b.param('tone', flt, 'cutoff');
  b.param('tail', tenv, 'r2');
  b.param('flam', fenv, 'r2');
  b.param('tail level', tvca, 'gain');
});

// a rim shot / cross-stick: a 2 ms strike into a short inharmonic modal body and a tuned comb for the stick
asm('rim', 'Drums', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.002 });
  const hit = b.add('scale', 0, 1, { gain: 0.06, offset: 0 });
  const md = b.add('modal', 1, 0, { coarse: 12, decay: 0.06, struct: 0.6, bright: 0.8, damp: 0.2 });
  const cb = b.add('comb', 2, 0, { coarse: 24, fb: 0.6, damp: 0.5, mix: 0.5 });
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.wire(md, 'out', cb, 'in');
  b.input('gate', pl, 'trig');
  b.output('out', cb, 'out');
  b.param('tune', md, 'coarse');
  b.param('decay', md, 'decay');
  b.param('stick', cb, 'mix');
  b.param('body', md, 'struct');
  b.param('hit', hit, 'gain');
});

// hi-hats: a detuned square cluster plus noise through a 7 kHz high pass; `gate` is the closed hat (short), `open` the open
// one (long), and the closed hat chokes the open one (a 250 ms pulse on the closed trigger shuts the open hat's VCA)
asm('hats', 'Drums', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 3, coarse: 38, level: 0.6, unison: 5, detune: 90, pw: 0.3 });
  const nz = b.add('noise', 1, 0, { level: 0.5 });
  const src = b.add('mixer', 2, 0, { l1: 0.7, l2: 0.7, l3: 0, l4: 0 });
  const flt = b.add('filter', 3, 0, { cutoff: 7000, res: 0.2 });
  const cenv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0.3, r2: 0.02, l3: 0, r3: 0.07, l4: 0, r4: 0.02 });
  const cvca = b.add('vca', 1, 1);
  const oenv = b.add('env', 2, 1, { l1: 1, r1: 0.001, l2: 0.4, r2: 0.05, l3: 0, r3: 0.45, l4: 0, r4: 0.05 });
  const ovca = b.add('vca', 3, 1);
  const choke = b.add('pulse', 0, 2, { time: 0.25 });
  const inv = b.add('scale', 1, 2, { gain: -1, offset: 1 });
  const cvca2 = b.add('vca', 2, 2);
  const mix = b.add('mixer', 3, 2, { l1: 0.9, l2: 0.9, l3: 0, l4: 0 });
  b.wire(osc, 'out', src, 'in1');
  b.wire(nz, 'out', src, 'in2');
  b.wire(src, 'out', flt, 'in');
  b.wire(flt, 'hp', cvca, 'in');
  b.wire(flt, 'hp', ovca, 'in');
  b.wire(cenv, 'env', cvca, 'cv');
  b.wire(oenv, 'env', ovca, 'cv');
  b.wire(choke, 'out', inv, 'in');
  b.wire(ovca, 'out', cvca2, 'in');
  b.wire(inv, 'out', cvca2, 'cv');
  b.wire(cvca, 'out', mix, 'in1');
  b.wire(cvca2, 'out', mix, 'in2');
  b.input('gate', cenv, 'gate', [choke, 'trig']);
  b.input('open', oenv, 'gate');
  b.output('out', mix, 'out');
  b.param('decay', cenv, 'r3');
  b.param('open decay', oenv, 'r3');
  b.param('tone', flt, 'cutoff');
  b.param('metal', src, 'l1');
  b.param('noise', src, 'l2');
});

// a cowbell: two squares a sixth apart through a band pass and a short envelope
asm('cowbell', 'Drums', (b) => {
  const o1 = b.add('osc', 0, 0, { wave: 3, coarse: 14, fine: -5, level: 0.7 });
  const o2 = b.add('osc', 0, 1, { wave: 3, coarse: 20, fine: 30, level: 0.7 });
  const mix = b.add('mixer', 1, 0, { l1: 0.7, l2: 0.7, l3: 0, l4: 0 });
  const flt = b.add('filter', 2, 0, { cutoff: 1000, res: 0.5 });
  const env = b.add('env', 1, 1, { l1: 1, r1: 0.001, l2: 0.3, r2: 0.02, l3: 0, r3: 0.3, l4: 0, r4: 0.03 });
  const vca = b.add('vca', 2, 1);
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(mix, 'out', flt, 'in');
  b.wire(flt, 'bp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('tune', o1, 'coarse');
  b.param('tune 2', o2, 'coarse');
  b.param('decay', env, 'r3');
  b.param('tone', flt, 'cutoff');
});

// a tom: a harmonic modal body struck by a 2 ms pulse, with a pitch drop; `tune` picks the size
asm('tom', 'Drums', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.002 });
  const hit = b.add('scale', 2, 0, { gain: 0.015, offset: 0 });
  const md = b.add('modal', 1, 0, { coarse: -12, decay: 0.5, struct: 0, bright: 0.4, damp: 0.5 });
  const denv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.08, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const sc = b.add('scale', 1, 1, { gain: 0.6, offset: 0 });
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.wire(denv, 'env', sc, 'in');
  b.wire(sc, 'out', md, 'pitch');
  b.input('gate', pl, 'trig', [denv, 'gate']);
  b.output('out', md, 'out');
  b.param('tune', md, 'coarse');
  b.param('decay', md, 'decay');
  b.param('drop', sc, 'gain');
  b.param('bright', md, 'bright');
  b.param('hit', hit, 'gain');
});

// a tabla / membrane: a slightly inharmonic modal head hit by a pulse and a noise slap; velocity opens `bright`, a slow
// envelope bends the pitch down (the bass drum's "ghe")
asm('tabla', 'Drums', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.0015 });
  const nz = b.add('noise', 1, 0, { level: 1 });
  const nenv = b.add('env', 2, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.008, l3: 0, r3: 0.01, l4: 0, r4: 0.01 });
  const nvca = b.add('vca', 3, 0, { gain: 0.3 });
  const exc = b.add('mixer', 0, 1, { l1: 0.03, l2: 0.03, l3: 0, l4: 0 });
  const md = b.add('modal', 1, 1, { coarse: -5, decay: 0.6, struct: 0.15, bright: 0.35, damp: 0.5 }, { p1: 'bright', att: [0.5, 1] });
  const denv = b.add('env', 2, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.25, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const sc = b.add('scale', 3, 1, { gain: 0.3, offset: 0 });
  b.wire(pl, 'out', exc, 'in1');
  b.wire(nz, 'out', nvca, 'in');
  b.wire(nenv, 'env', nvca, 'cv');
  b.wire(nvca, 'out', exc, 'in2');
  b.wire(exc, 'out', md, 'in');
  b.wire(denv, 'env', sc, 'in');
  b.wire(sc, 'out', md, 'pitch');
  b.input('gate', pl, 'trig', [nenv, 'gate'], [denv, 'gate']);
  b.input('vel', md, 'p1');
  b.input('pitch', md, 'pitch');
  b.output('out', md, 'out');
  b.param('tune', md, 'coarse');
  b.param('decay', md, 'decay');
  b.param('drop', sc, 'gain');
  b.param('drop time', denv, 'r2');
  b.param('slap', nvca, 'gain');
});

// a snare: a noise burst through a high pass and a short sine body, mixed
asm('snare', 'Drums', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const flt = b.add('filter', 1, 0, { cutoff: 1500, res: 0.3 });
  const nvca = b.add('vca', 2, 0);
  const nenv = b.add('env', 3, 0, { l1: 1, r1: 0.001, l2: 0.3, r2: 0.06, l3: 0, r3: 0.18, l4: 0, r4: 0.03 });
  const osc = b.add('osc', 0, 1, { wave: 0, coarse: -7, level: 1 });
  const bvca = b.add('vca', 1, 1);
  const benv = b.add('env', 2, 1, { l1: 1, r1: 0.001, l2: 0.2, r2: 0.05, l3: 0, r3: 0.08, l4: 0, r4: 0.03 });
  const mix = b.add('mixer', 3, 1, { l1: 0.8, l2: 0.6, l3: 0, l4: 0 });
  b.wire(nz, 'out', flt, 'in');
  b.wire(flt, 'hp', nvca, 'in');
  b.wire(nenv, 'env', nvca, 'cv');
  b.wire(osc, 'out', bvca, 'in');
  b.wire(benv, 'env', bvca, 'cv');
  b.wire(nvca, 'out', mix, 'in1');
  b.wire(bvca, 'out', mix, 'in2');
  b.input('gate', nenv, 'gate', [benv, 'gate']);
  b.output('out', mix, 'out');
  b.param('snap', flt, 'cutoff');
  b.param('decay', nenv, 'r3');
  b.param('noise', mix, 'l1');
  b.param('body', mix, 'l2', { group: true });
  b.param('body tune', osc, 'coarse');
});

// a hi-hat: noise through a high pass with a very short envelope
asm('hihat', 'Drums', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const flt = b.add('filter', 1, 0, { cutoff: 4000, res: 0.2 });
  const vca = b.add('vca', 2, 0, { gain: 0.8 });
  const env = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0.25, r2: 0.03, l3: 0, r3: 0.09, l4: 0, r4: 0.02 });
  b.wire(nz, 'out', flt, 'in');
  b.wire(flt, 'hp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('decay', env, 'r3');
  b.param('tone', flt, 'cutoff');
  b.param('level', vca, 'gain');
});

// a drum kit (#93, rebuilt for #137): keys in (a Steps track's keys out, or Main's keys) into a Drum map whose eight rows
// (General MIDI notes) play the factory drums, nested as cards: kick, snare, clap, the hats' closed and open gates (one
// hats assembly, so the open hat chokes), tom, rim, cowbell; two mixers. Each drum goes through a VCA whose cv is its
// row's velocity, gain 127 / 100, so a note at the default velocity (STEP_VEL 100) plays it at its own level (the hats
// follow the closed hat's velocity). The collapsed card shows the drums' main settings and the levels.
asm('drum kit', 'Drums', (b) => {
  const map = b.add('drummap', 0, 0, {});
  const mixA = b.add('mixer', 4, 0, { l1: 0.8, l2: 0.45, l3: 0.5, l4: 1 });
  const mixB = b.add('mixer', 4, 1, { l1: 0.35, l2: 0.45, l3: 0.35, l4: 0.3 });
  //            assembly     label      map rows (gate inputs)        settings                                      mixer, input
  const drums: [string, string, [number, string][], Record<string, number>, number, string][] = [
    ['boom kick', 'kick', [[1, 'gate']], {}, mixA, 'in1'],
    ['snare', 'snare', [[2, 'gate']], { 'body tune': 2, decay: 0.1, noise: 0.45, body: 0.75 }, mixA, 'in2'],
    ['clap', 'clap', [[3, 'gate']], {}, mixA, 'in3'],
    ['hats', 'hats', [[4, 'gate'], [5, 'open']], {}, mixB, 'in1'],
    ['tom', 'tom', [[6, 'gate']], {}, mixB, 'in2'],
    ['rim', 'rim', [[7, 'gate']], {}, mixB, 'in3'],
    ['cowbell', 'cowbell', [[8, 'gate']], {}, mixB, 'in4'],
  ];
  const rowOf = (from: string, ids: Map<number, number>, label: string): { module: number; param: string } => {
    const r = defs.find((d) => d.name === from)!.params.find((q) => q.label === label);
    if (!r) throw new Error(`drum kit: ${from} has no ${label}`);
    return { module: ids.get(r.module)!, param: r.param };
  };
  const shown: { label: string; at: { module: number; param: string } }[] = [];
  drums.forEach(([from, label, rows, settings, mix, port], i) => {
    const y = i * 0.55;
    const ids = b.include(from, 2, y, label);
    for (const [name, v] of Object.entries(settings)) {
      const r = rowOf(from, ids, name);
      b.module(r.module).params[r.param] = v;
    }
    for (const [row, input] of rows) {
      const into = defs.find((d) => d.name === from)!.inputs.find((q) => q.label === input)!;
      for (const t of [into, ...(into.also ?? [])]) b.wire(map, `g${row}`, ids.get(t.module)!, t.port);
    }
    const out = defs.find((d) => d.name === from)!.outputs[0];
    const vel = b.add('vca', 3, y, { gain: 127 / STEP_VEL });
    b.wire(ids.get(out.module)!, out.port, vel, 'in');
    b.wire(map, `v${rows[0][0]}`, vel, 'cv');
    b.wire(vel, 'out', mix, port);
    if (from === 'boom kick') shown.push({ label: 'kick tune', at: rowOf(from, ids, 'tune') }, { label: 'kick decay', at: rowOf(from, ids, 'decay') });
    if (from === 'snare') shown.push({ label: 'snare tone', at: rowOf(from, ids, 'body tune') }, { label: 'snare noise', at: rowOf(from, ids, 'noise') });
    if (from === 'clap') shown.push({ label: 'clap tail', at: rowOf(from, ids, 'tail') });
    if (from === 'hats') shown.push({ label: 'hat decay', at: rowOf(from, ids, 'decay') }, { label: 'open decay', at: rowOf(from, ids, 'open decay') });
    if (from === 'tom') shown.push({ label: 'tom tune', at: rowOf(from, ids, 'tune') });
    if (from === 'cowbell') shown.push({ label: 'cowbell tune', at: rowOf(from, ids, 'tune') });
  });
  b.wire(mixB, 'out', mixA, 'in4');
  b.input('keys', map, 'keys');
  b.output('out', mixA, 'out');
  const half = Math.ceil((shown.length + 3) / 2); // the knobs and the three levels in two columns
  shown.forEach(({ label, at }, i) => b.param(label, at.module, at.param, i === 0 ? { head: 'drums' } : i === half ? { col: true } : {}));
  b.param('kick level', mixA, 'l1');
  b.param('snare level', mixA, 'l2');
  b.param('hats level', mixB, 'l1');
});

// a plucked string with a tracking low pass for the body
asm('pluck', 'Voices', (b) => {
  const str = b.add('string', 0, 0, { decay: 2, damp: 0.3, burst: 0, level: 0.8 });
  const flt = b.add('filter', 1, 0, { cutoff: 3000, res: 0.1, track: 1 });
  b.wire(str, 'out', flt, 'in');
  b.input('pitch', str, 'pitch');
  b.input('gate', str, 'gate');
  b.input('exc', str, 'exc');
  b.output('out', flt, 'lp24');
  b.param('decay', str, 'decay');
  b.param('damp', str, 'damp');
  b.param('pick', str, 'burst');
  b.param('tone', flt, 'cutoff');
});

// a wavetable pad: slow sweep of the frame position, low pass, slow envelope
asm('wavetable pad', 'Voices', (b) => {
  const wt = b.add('wavetable', 0, 0, { bank: 2, pos: 0.3, level: 0.7 }, { p1: 'pos', att: [0.5, 1] });
  const lfo = b.add('lfo', 1, 0, { wave: 1, rate: 0.15, depth: 1 });
  const flt = b.add('filter', 2, 0, { cutoff: 2500, res: 0.2 });
  const env = b.add('adsr', 0, 1, { a: 0.4, d: 0.5, s: 0.8, r: 0.8 });
  const vca = b.add('vca', 1, 1);
  b.wire(lfo, 'out', wt, 'p1');
  b.wire(wt, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', wt, 'pitch');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('bank', wt, 'bank');
  b.param('position', wt, 'pos');
  b.param('sweep', lfo, 'rate');
  b.param('cutoff', flt, 'cutoff');
  b.param('attack', env, 'a');
  b.param('release', env, 'r');
});

// a sub bass: glide, a square an octave down, a dark tracking low pass
asm('sub bass', 'Voices', (b) => {
  const gl = b.add('glide', 0, 0, { time: 0.08 });
  const osc = b.add('osc', 1, 0, { wave: 3, coarse: -12, level: 0.8 });
  const flt = b.add('filter', 2, 0, { cutoff: 300, res: 0.3, track: 1 });
  const env = b.add('adsr', 0, 1, { a: 0.005, d: 0.2, s: 0.8, r: 0.1 });
  const vca = b.add('vca', 1, 1);
  b.wire(gl, 'out', osc, 'pitch');
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', gl, 'in');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('glide', gl, 'time');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  b.param('release', env, 'r');
});

// a vowel voice: a saw through the vowel filter swept by an LFO
asm('vowel voice', 'Voices', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 2, level: 0.8 });
  const vow = b.add('vowel', 1, 0, { vowel: 0, res: 0.6, level: 0.8 });
  const lfo = b.add('lfo', 2, 0, { wave: 1, rate: 0.3, depth: 1 });
  const sc = b.add('scale', 3, 0, { gain: 2, offset: 2 });
  const env = b.add('adsr', 0, 1, { a: 0.05, d: 0.3, s: 0.7, r: 0.3 });
  const vca = b.add('vca', 1, 1);
  b.wire(osc, 'out', vow, 'in');
  b.wire(lfo, 'out', sc, 'in');
  b.wire(sc, 'out', vow, 'vowel');
  b.wire(vow, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', osc, 'pitch');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('rate', lfo, 'rate');
  b.param('res', vow, 'res');
  b.param('depth', sc, 'gain');
  b.param('release', env, 'r');
});

// ---- the recipes of the factory patches (presets.ts voice() / toOut()), so a patch opens as a few cards

// one oscillator through a filter into a VCA with one ADSR (the filter's cv is exposed for an envelope or LFO)
asm('filter voice', 'Voices', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 2, level: 0.8 });
  const flt = b.add('filter', 1, 0, { cutoff: 1200, res: 0.3 });
  const env = b.add('adsr', 0, 1, { a: 0.01, d: 0.2, s: 0.6, r: 0.3 });
  const vca = b.add('vca', 1, 1);
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp12', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', osc, 'pitch');
  b.input('gate', env, 'gate');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('wave', osc, 'wave');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
});

// an oscillator into a VCA with an ADSR: the operator of the FM patches, a plain voice without a filter
asm('adsr operator', 'Voices', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 0, level: 0.8 });
  const env = b.add('adsr', 1, 0, { a: 0.01, d: 0.2, s: 0.6, r: 0.3 });
  const vca = b.add('vca', 2, 0);
  b.wire(osc, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', osc, 'pitch');
  b.input('gate', env, 'gate');
  b.input('pm', osc, 'pm');
  b.output('out', vca, 'out');
  b.param('wave', osc, 'wave');
  b.param('ratio', osc, 'coarse');
  b.param('index', osc, 'pm');
  b.param('level', osc, 'level');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
});

// noise through a filter into a VCA with an ADSR: wind, hats, sweeps
asm('noise voice', 'Voices', (b) => {
  const nz = b.add('noise', 0, 0, { level: 0.6 });
  const flt = b.add('filter', 1, 0, { cutoff: 2000, res: 0.4 });
  const env = b.add('adsr', 0, 1, { a: 0.01, d: 0.2, s: 0.5, r: 0.3 });
  const vca = b.add('vca', 1, 1);
  b.wire(nz, 'out', flt, 'in');
  b.wire(flt, 'bp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('gate', env, 'gate');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('color', nz, 'color');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
});

// two oscillators into a mixer, a filter and a VCA with an ADSR (a third oscillator can go into the mixer's in3)
asm('stack voice', 'Voices', (b) => {
  const o1 = b.add('osc', 0, 0, { wave: 2, level: 0.7 });
  const o2 = b.add('osc', 0, 1, { wave: 2, fine: 8, level: 0.7 });
  const mix = b.add('mixer', 1, 0, { l1: 0.7, l2: 0.7, l3: 0.7, l4: 0 });
  const flt = b.add('filter', 2, 0, { cutoff: 1500, res: 0.2 });
  const env = b.add('adsr', 1, 1, { a: 0.05, d: 0.3, s: 0.7, r: 0.4 });
  const vca = b.add('vca', 2, 1);
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(mix, 'out', flt, 'in');
  b.wire(flt, 'lp12', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', o1, 'pitch', [o2, 'pitch']);
  b.input('gate', env, 'gate');
  b.input('in3', mix, 'in3');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('detune', o2, 'fine');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
});

// a mono lead: one voice card fed by an allocator of one voice (so its legato and priority apply), whose portamento only
// acts on legato playing: the allocator's legato output lengthens the glide by `porta` of the time range while a note
// overlaps the one before
asm('mono lead', 'Voices', (b) => {
  const part = b.add('alloc', 0, 1, { voices: 1 });
  b.input('keys', part, 'keys');
  const gl = b.add('glide', 0, 0, { time: 0.001 }, { p1: 'time', att: [0.6, 1] });
  const osc = b.add('osc', 1, 0, { wave: 2, level: 0.8, unison: 2, detune: 6 });
  const flt = b.add('ladder', 2, 0, { cutoff: 1800, res: 0.35 });
  const env = b.add('adsr', 1, 1, { a: 0.005, d: 0.25, s: 0.6, r: 0.2 });
  const vca = b.add('vca', 2, 1);
  b.wire(part, 'pitch', gl, 'in');
  b.wire(part, 'legato', gl, 'p1');
  b.wire(part, 'gate', env, 'gate');
  b.wire(gl, 'out', osc, 'pitch');
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('porta', gl, 'time');
  b.param('curve', gl, 'curve');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  b.param('legato', part, 'legato');
  b.param('priority', part, 'priority');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
}, {});

// a supersaw pad of four voices: five detuned copies with the centre one held back (blend), an octave stacked on top, each
// voice panned by its index (spread across the stereo field by `width`)
asm('supersaw stack', 'Voices', (b) => {
  const part = b.add('alloc', 0, 2, { voices: 4 });
  b.input('keys', part, 'keys');
  const osc = b.add('osc', 0, 0, { wave: 2, level: 0.9, unison: 5, detune: 22, blend: 0.65, stack: 1 });
  const flt = b.add('filter', 1, 0, { cutoff: 3500, res: 0.15 });
  const env = b.add('adsr', 0, 1, { a: 0.02, d: 0.4, s: 0.75, r: 0.5 });
  const vca = b.add('vca', 1, 1);
  const width = b.add('scale', 1, 2, { gain: 0.6, offset: 0 });
  const pan = b.add('pan', 2, 0, { pan: 0 });
  b.wire(part, 'pitch', osc, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(part, 'index', width, 'in');
  b.wire(width, 'out', pan, 'pos');
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp12', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', pan, 'in');
  b.output('l', pan, 'l');
  b.output('r', pan, 'r');
  for (const q of ['unison', 'detune', 'blend', 'stack']) b.param(q, osc, q);
  b.param('cutoff', flt, 'cutoff');
  b.param('width', width, 'gain');
  b.param('voices', part, 'voices');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
}, {});

// an analog polysynth of four voices that has drifted out of spec: each oscillator's fine tune follows its own slow
// Random walk (a few cents), a fixed Random per voice card (its tolerance) offsets the cutoff and the decay. The cards'
// flaws (set by hand per card) add to that.
asm('drift poly', 'Voices', (b) => {
  const part = b.add('alloc', 0, 2, { voices: 4 });
  b.input('keys', part, 'keys');
  const w1 = b.add('random', 1, 2, { mode: 1, rate: 0.7 });
  const w2 = b.add('random', 2, 2, { mode: 1, rate: 0.9 });
  const tol = b.add('random', 3, 2, { mode: 0 });
  const o1 = b.add('osc', 0, 0, { wave: 2, level: 0.7 }, { p1: 'fine', att: [0.03, 1] });
  const o2 = b.add('osc', 0, 1, { wave: 3, pw: 0.45, level: 0.6, fine: 4 }, { p1: 'fine', att: [0.045, 1] });
  const mix = b.add('mixer', 1, 0, { l1: 0.7, l2: 0.6, l3: 0, l4: 0 });
  const flt = b.add('filter', 2, 0, { cutoff: 1400, res: 0.25 }, { p1: 'cutoff', att: [0.08, 1] });
  const env = b.add('adsr', 1, 1, { a: 0.008, d: 0.35, s: 0.55, r: 0.3 }, { p1: 'd', att: [0.06, 1] });
  const vca = b.add('vca', 2, 1);
  b.wire(part, 'pitch', o1, 'pitch');
  b.wire(part, 'pitch', o2, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(w1, 'out', o1, 'p1');
  b.wire(w2, 'out', o2, 'p1');
  b.wire(tol, 'out', flt, 'p1');
  b.wire(tol, 'out', env, 'p1');
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(mix, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.output('out', vca, 'out');
  b.param('voices', part, 'voices');
  b.param('drift rate', w1, 'rate');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
}, { flaws: [{ detune: 4, drift: 30, bright: 1, env: 5, level: 100 }, { detune: -6, drift: 45, bright: -2, env: -8, level: 95 }, { detune: 2, drift: 25, bright: 0, env: 12, level: 100 }, { detune: -3, drift: 35, bright: 3, env: -4, level: 92 }] });

// the plainest polysynth: a Voice allocator of four voices and their cards (saw, low pass, ADSR, VCA), each playing its own note
asm('basic poly', 'Voices', (b) => {
  const part = b.add('alloc', 0, 1, { voices: 4 });
  b.input('keys', part, 'keys');
  const osc = b.add('osc', 0, 0, { wave: 2, level: 0.8 });
  const flt = b.add('filter', 1, 0, { cutoff: 2000, res: 0.2 });
  const env = b.add('adsr', 1, 1, { a: 0.005, d: 0.3, s: 0.6, r: 0.3 });
  const vca = b.add('vca', 2, 0);
  b.wire(part, 'pitch', osc, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('voices', part, 'voices');
  b.param('wave', osc, 'wave');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
}, {});

// Oracle V, a classic five-voice analog polysynth built like the instrument: the keyboard's keys go into the Voice allocator (the Z80), which
// plays five voice cards, a poly assembly (about 95 % of the FM-1's estimated CPU). A card: oscillator A (saw / pulse, sync to B) and B, the 24 dB
// ladder low pass with its own ADSR (its cvamt is the envelope amount) and keyboard tracking, the amp ADSR, glide. The
// oscillators' levels are the mixer: they and the noise sum at the filter input. Poly Mod (off by default): the filter
// envelope into A's pitch, B into A's phase (FM). Outside the voices, once, as on the instrument: the noise source and
// Wheel Mod, an LFO through a VCA whose cv is the `wheel` input (plug Main's mod into it) into both oscillators' fine tune
// (per block: their pitch inputs stay still, which keeps the oscillators cheap; `vibrato` 0.24 = +-48 cents).
// The flaws are a mild out-of-tune set as on a well-kept vintage unit.
asm('Oracle V', 'Voices', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 5, depth: 1 });
  const wheel = b.add('vca', 0, 1);
  const vib = b.add('scale', 0, 2, { gain: 0.24, offset: 0 });
  const nz = b.add('noise', 1, 0, { level: 0 });
  const part = b.add('alloc', 1, 2, { voices: 5 });
  const gl = b.add('glide', 2, 1, { time: 0.001 });
  const oscB = b.add('osc', 2, 0, { wave: 2, level: 0.45, fine: 7 }, { p1: 'fine' });
  const oscA = b.add('osc', 3, 0, { wave: 2, level: 0.55 }, { p1: 'fine' });
  const polyEnv = b.add('scale', 3, 1, { gain: 0, offset: 0 });
  const sync = b.add('scale', 3, 2, { gain: 0, offset: 0 });
  const fenv = b.add('adsr', 4, 1, { a: 0.01, d: 0.6, s: 0.35, r: 0.4 });
  const flt = b.add('ladder', 5, 0, { cutoff: 600, res: 0.2, cvamt: 3.5 });
  const aenv = b.add('adsr', 5, 1, { a: 0.01, d: 0.5, s: 0.8, r: 0.4 });
  const vca = b.add('vca', 6, 0, { gain: 0.6 });
  // scopes on the card: the filter envelope against the filter, the voices summed, the LFO against oscillator A
  const fScope = b.add('scope', 7, 0, { time: 16 });
  const aScope = b.add('scope', 7, 1, { time: 16 });
  const mScope = b.add('scope', 7, 2, { time: 500 });
  b.nest('voice', 1, 1, [gl, oscB, oscA, polyEnv, sync, fenv, flt, aenv, vca], {
    flaws: [{ detune: 3, drift: 20, bright: 1, env: 4, level: 100 }, { detune: -4, drift: 25, bright: -1, env: -5, level: 97 }, { detune: 1, drift: 15, bright: 0, env: 6, level: 100 }, { detune: -2, drift: 20, bright: 2, env: -3, level: 95 }, { detune: 5, drift: 30, bright: -2, env: 2, level: 98 }],
  });
  b.wire(part, 'pitch', gl, 'in');
  b.wire(gl, 'out', oscA, 'pitch');
  b.wire(gl, 'out', oscB, 'pitch');
  b.wire(part, 'gate', fenv, 'gate');
  b.wire(part, 'gate', aenv, 'gate');
  b.wire(oscA, 'out', flt, 'in');
  b.wire(oscB, 'out', flt, 'in');
  b.wire(nz, 'out', flt, 'in');
  b.wire(fenv, 'env', flt, 'cv');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(aenv, 'env', vca, 'cv');
  // poly mod
  b.wire(fenv, 'env', polyEnv, 'in');
  b.wire(polyEnv, 'out', oscA, 'pitch');
  b.wire(oscB, 'out', oscA, 'pm');
  b.wire(oscB, 'out', sync, 'in');
  b.wire(sync, 'out', oscA, 'sync');
  // wheel mod
  b.wire(lfo, 'out', wheel, 'in');
  b.wire(wheel, 'out', vib, 'in');
  b.wire(vib, 'out', oscA, 'p1');
  b.wire(vib, 'out', oscB, 'p1');
  b.wire(flt, 'lp24', fScope, 'a');
  b.wire(vca, 'out', aScope, 'a');
  b.wire(lfo, 'out', mScope, 'a');
  b.wire(oscA, 'out', mScope, 'b');
  b.input('keys', part, 'keys');
  b.input('wheel', wheel, 'cv');
  b.nestInput('pitch', gl, 'in');
  b.nestInput('gate', fenv, 'gate', [aenv, 'gate']);
  b.nestInput('noise', flt, 'in');
  b.nestInput('vibrato', oscA, 'p1', [oscB, 'p1']);
  b.output('out', vca, 'out');
  b.nestOutput('filter', flt, 'lp24');
  b.nestOutput('osc A', oscA, 'out');
  // three columns, sectioned like the original's panel
  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('unison', part, 'unison');
  b.param('glide', gl, 'time');
  b.param('wave', oscA, 'wave', { head: 'osc A', inner: 'A wave' });
  b.param('pw', oscA, 'pw', { inner: 'A pw' });
  b.param('sync', sync, 'gain');
  b.param('wave', oscB, 'wave', { head: 'osc B', inner: 'B wave' });
  b.param('freq', oscB, 'coarse', { inner: 'B freq' });
  b.param('fine', oscB, 'fine', { inner: 'B fine' });
  b.param('A level', oscA, 'level', { head: 'mixer' });
  b.param('B level', oscB, 'level');
  b.param('noise', nz, 'level');
  b.param('out', aScope, 'view', { span: 3 }); // the voice sum across the card's foot
  b.param('cutoff', flt, 'cutoff', { col: true, head: 'filter' });
  b.param('res', flt, 'res');
  b.param('env amt', flt, 'cvamt');
  b.param('kbd track', flt, 'track');
  b.param('filter env', fenv, 'view');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, fenv, q, { inner: `filter ${q}` });
  b.param('filter', fScope, 'view');
  b.param('amp env', aenv, 'view', { col: true, head: 'amp' });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, aenv, q, { inner: `amp ${q}` });
  b.param('pmod env→A', polyEnv, 'gain', { head: 'mod' });
  b.param('pmod B→A', oscA, 'pm');
  b.param('lfo rate', lfo, 'rate');
  b.param('lfo wave', lfo, 'wave');
  b.param('vibrato', vib, 'gain');
  b.param('lfo / osc A', mScope, 'view');
});

// Monolith D, after the Minimoog Model D (its operation manual, Moog Music 1971-72): one voice (the allocator plays the
// lowest key held, single trigger), the controllers, the oscillator bank, the mixer, the 24 dB ladder with its contour and
// the loudness contour, laid out and named as the original's panel. The switches are Selectors:
//  - GLIDE on / off: the glided pitch or the key's. OSCILLATOR 3 CONTROL off takes oscillator 3 off the keyboard (it then
//    sits 2 octaves lower, so LO is sub-audio, and its FREQUENCY sweeps on its own).
//  - RANGE (LO, 32', 16', 8', 4', 2') adds octaves to an oscillator's pitch (LO: 2 octaves under 32'). WAVEFORM (triangle,
//    triangle/saw hybrid (reverse saw on oscillator 3), saw, square, wide and narrow rectangle) sets the oscillator's wave
//    and pulse width through its parameter inputs: value v gives wave 4 + 0.75v and pulse width 0.95 + 0.45v.
//  - KEYBOARD CONTROL (off, 1, 2, 1 + 2: none, a third, two thirds or all of the key's pitch into the cutoff) sets an
//    Attenuverter's gain through its pin.
//  - DECAY on makes each contour's release its decay time: a Macro per contour (its DECAY TIME, 0..1 over the decay's range
//    of 1 ms to 5 s) sets the ADSR's decay and, scaled to the same seconds, its release through the two pins; the switch's
//    -1 on the release's pin when off makes it the shortest.
//  - OSCILLATOR MODULATION and FILTER MODULATION pass the modulation mix (oscillator 3 or the noise, taken before the mixer's
//    volumes, through the MODULATION wheel VCA: plug Main's mod into `wheel`) to oscillators 1 and 2 or to the cutoff.
//  - A-440 adds the reference tone (a sine at A4) to the output.
// The ladder's cvamt is 1: the contour, the modulation and the keyboard each reach the cutoff through their own amount.
// TUNE and the PITCH wheel (half an octave: Main's bend, of which the key's pitch already carries 2 semitones; plug Main's
// bend into `bend`) are one Attenuverter. Left out, needing engine work (#351): the external input (audio input).
asm('Monolith D', 'Voices', (b) => {
  /** a module's parameter inputs: what each pin sets and their depths */
  const pins = (id: number, p1: string[], p2: string[], att: [number, number]): void => {
    const m = b.module(id);
    m.map = { ...m.map!, p1, p2 };
    m.att = att;
  };
  const part = b.add('alloc', 0, 3, { voices: 1, priority: 1 });
  const gl = b.add('glide', 0, 0, { time: 0.04 });
  const glOn = b.add('select', 0, 1, { count: 2, pos: 1 });
  const bend = b.add('scale', 0, 2, { gain: 1 / 3, offset: 0 });
  const o3ctl = b.add('select', 1, 3, { count: 2, pos: 2, v1: -2 });
  const range = (row: number, pos: number): number => b.add('select', 1, row, { count: 6, pos, v1: -4, v2: -2, v3: -1, v4: 0, v5: 1, v6: 2 });
  const wave = (row: number, pos: number): number => b.add('select', 2, row, { count: 6, pos, v1: -4, v2: row === 2 ? 1.333 : 0, v3: -2.667, v4: -1, v5: -1.556, v6: -1.889 });
  const osc = (row: number, p: Record<string, number>): number => {
    const o = b.add('osc', 3, row, { wave: 4, pw: 0.95, level: 1, ...p });
    pins(o, ['wave'], ['pw'], [0.25, 0.5]);
    return o;
  };
  const r1 = range(0, 4);
  const r2 = range(1, 4);
  const r3 = range(2, 3);
  const w1 = wave(0, 3);
  const w2 = wave(1, 3);
  const w3 = wave(2, 4);
  const o1 = osc(0, {});
  const o2 = osc(1, { fine: 6 });
  const o3 = osc(2, { fine: -4 });
  const nz = b.add('noise', 3, 3, { level: 1, color: 0 });
  // WHITE / PINK: a Selector's value into the noise's color through its pin (pink: the color's one-pole low pass at 0.6)
  const pink = b.add('select', 2, 3, { count: 2, pos: 1, v1: 0, v2: 0.6 });
  pins(nz, ['color'], [], [1, 1]);
  b.wire(pink, 'out', nz, 'p1');
  const mix = b.add('mixer', 4, 0, { l1: 0.45, l2: 0.4, l3: 0.3, l4: 0 });
  const src = b.add('xfade', 4, 3, { mix: 0 });
  const wheel = b.add('vca', 5, 3, { gain: 1 });
  const oscMod = b.add('select', 6, 3, { count: 2, pos: 1 });
  const fltMod = b.add('select', 6, 2, { count: 2, pos: 2 });
  // the gain moves by the pin's value x 8 (its range): 1/24, 1/12, 1/8 give a third, two thirds, all
  const kbd = b.add('select', 4, 2, { count: 4, pos: 4, v1: 0, v2: 0.042, v3: 0.083, v4: 0.125 });
  const kbdAmt = b.add('scale', 5, 2, { gain: 0, offset: 0 });
  pins(kbdAmt, ['gain'], [], [1, 1]);
  const decayOn = b.add('select', 7, 2, { count: 2, pos: 2, v1: -1, v2: 0 });
  // a contour: its DECAY TIME a Macro (0..1 = the decay's range, 1 ms to 5 s) into the ADSR's decay on pin 1 and its release
  // on pin 2 (scaled to the same seconds: the release's range reaches 8 s); the DECAY switch's -1 on pin 2 when off
  const contour = (col: number, p: { a: number; d: number; s: number }): [number, number] => {
    const env = b.add('adsr', col, 1, { a: p.a, s: p.s, d: 0.001, r: 0.001 });
    const dt = b.add('macro', col, 4, { value: Math.round((Math.log(p.d / 0.001) / Math.log(5000)) * 100) / 100 });
    pins(env, ['d'], ['r'], [1, Math.round((Math.log(5000) / Math.log(8000)) * 1000) / 1000]);
    b.wire(dt, 'out', env, 'p1');
    b.wire(dt, 'out', env, 'p2');
    b.wire(decayOn, 'out', env, 'p2');
    return [env, dt];
  };
  const [fenv, fDecay] = contour(5, { a: 0.005, d: 0.45, s: 0.35 });
  const amount = b.add('scale', 6, 1, { gain: 3, offset: 0 });
  const flt = b.add('ladder', 5, 0, { cutoff: 700, res: 0.3, cvamt: 1, track: 0, drive: 1.4 });
  const [aenv, aDecay] = contour(7, { a: 0.004, d: 0.3, s: 0.85 });
  const vca = b.add('vca', 6, 0, { gain: 0.7 });
  const a440 = b.add('osc', 7, 3, { wave: 0, coarse: 9, level: 0.25 });
  const a440On = b.add('select', 7, 0, { count: 2, pos: 1 });
  b.wire(part, 'pitch', gl, 'in');
  b.wire(part, 'pitch', glOn, 'in1');
  b.wire(gl, 'out', glOn, 'in2');
  for (const [o, r, w] of [[o1, r1, w1], [o2, r2, w2], [o3, r3, w3]]) {
    b.wire(r, 'out', o, 'pitch');
    b.wire(w, 'out', o, 'p1');
    b.wire(w, 'out', o, 'p2');
  }
  for (const s of [glOn, bend]) {
    b.wire(s, 'out', o1, 'pitch');
    b.wire(s, 'out', o2, 'pitch');
    b.wire(s, 'out', o3ctl, 'in2');
  }
  b.wire(o3ctl, 'out', o3, 'pitch');
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(o3, 'out', mix, 'in3');
  b.wire(nz, 'out', mix, 'in4');
  b.wire(mix, 'out', flt, 'in');
  b.wire(o3, 'out', src, 'a');
  b.wire(nz, 'out', src, 'b');
  b.wire(src, 'out', wheel, 'in');
  b.wire(wheel, 'out', oscMod, 'in2');
  b.wire(wheel, 'out', fltMod, 'in2');
  b.wire(oscMod, 'out', o1, 'pitch');
  b.wire(oscMod, 'out', o2, 'pitch');
  b.wire(glOn, 'out', kbdAmt, 'in');
  b.wire(kbd, 'out', kbdAmt, 'p1');
  b.wire(part, 'gate', fenv, 'gate');
  b.wire(part, 'gate', aenv, 'gate');
  b.wire(fenv, 'env', amount, 'in');
  for (const s of [amount, kbdAmt]) b.wire(s, 'out', flt, 'cv');
  b.wire(fltMod, 'out', flt, 'fm');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(aenv, 'env', vca, 'cv');
  b.wire(vca, 'out', a440On, 'in1');
  b.wire(vca, 'out', a440On, 'in2');
  b.wire(a440, 'out', a440On, 'in2');
  b.input('keys', part, 'keys');
  b.input('wheel', wheel, 'cv');
  b.input('bend', bend, 'in');
  b.output('out', a440On, 'out');
  b.param('tune', bend, 'offset', { head: 'controllers' });
  b.param('glide', gl, 'time');
  b.param('glide on', glOn, 'pos');
  b.param('mod mix', src, 'mix');
  b.param('osc mod', oscMod, 'pos');
  b.param('osc 3 ctrl', o3ctl, 'pos');
  b.param('decay on', decayOn, 'pos');
  b.param('osc 1 range', r1, 'pos', { head: 'oscillators' });
  b.param('osc 1 wave', w1, 'pos');
  b.param('osc 2 range', r2, 'pos', { group: true });
  b.param('osc 2 freq', o2, 'coarse');
  b.param('osc 2 fine', o2, 'fine');
  b.param('osc 2 wave', w2, 'pos');
  b.param('osc 3 range', r3, 'pos', { group: true });
  b.param('osc 3 freq', o3, 'coarse');
  b.param('osc 3 fine', o3, 'fine');
  b.param('osc 3 wave', w3, 'pos');
  b.param('osc 1', mix, 'l1', { col: true, head: 'mixer' });
  b.param('osc 2', mix, 'l2');
  b.param('osc 3', mix, 'l3');
  b.param('noise', mix, 'l4');
  b.param('white/pink', pink, 'pos');
  b.param('cutoff', flt, 'cutoff', { head: 'filter' });
  b.param('emphasis', flt, 'res');
  b.param('contour', amount, 'gain');
  b.param('kbd control', kbd, 'pos');
  b.param('filter mod', fltMod, 'pos');
  b.param('filter contour', fenv, 'view', { col: true, head: 'contours' });
  b.param('attack', fenv, 'a');
  b.param('decay', fDecay, 'value');
  b.param('sustain', fenv, 's');
  b.param('loudness contour', aenv, 'view');
  b.param('attack', aenv, 'a');
  b.param('decay', aDecay, 'value');
  b.param('sustain', aenv, 's');
  b.param('a-440', a440On, 'pos', { head: 'output' });
});
/** the names of the positions of a factory assembly's Selector rows (#358), by row label (every row of that label) */
const namePositions = (asmName: string, names: Record<string, string[]>): void => {
  const d = defs.find((x) => x.name === asmName)!;
  for (const r of d.params) if (r.label && names[r.label]) r.names = names[r.label];
};
{
  const OFF_ON = ['OFF', 'ON'];
  const RANGE = ['LO', "32'", "16'", "8'", "4'", "2'"];
  const WAVE = ['TRIANGLE', 'TRI/SAW', 'SAW', 'SQUARE', 'WIDE RECT', 'NARROW RECT'];
  namePositions('Monolith D', {
    'glide on': OFF_ON, 'osc mod': OFF_ON, 'osc 3 ctrl': OFF_ON, 'decay on': OFF_ON, 'filter mod': OFF_ON, 'a-440': OFF_ON,
    'kbd control': ['OFF', '1', '2', '1+2'], 'white/pink': ['WHITE', 'PINK'],
    'osc 1 range': RANGE, 'osc 2 range': RANGE, 'osc 3 range': RANGE, 'osc 1 wave': WAVE, 'osc 2 wave': WAVE, 'osc 3 wave': WAVE.map((w, i) => i === 1 ? 'REVERSE SAW' : w),
  });
}

// Silver Box, the voice of the Roland TB-303 (its owner's manual, and Robin Whittle's description of the stock circuit in
// the Devil Fish documents): one voice, a saw or square into the resonant 24 dB ladder, the main envelope (MEG, the decay
// envelope) through ENV MOD into the cutoff, the volume envelope (a fixed slow decay, cut short when the key lifts) on the
// VCA, and no distortion after the filter. Slide as on the original: a note played while the last is still held glides to
// it in a fixed time (the allocator's legato output opens the glide through its pin, about 50 ms). Accent: a key at
// velocity 115 or more (a Steps accent) is accented; the Logic module's `and` is the accent gate. An accented note's MEG
// runs with its shortest decay, 200 ms: a second ADSR on the accent gate, while the gate also pulls the first one's decay
// to its shortest through its pin (it adds a blip of about a millisecond). That MEG times ACCENT is the accent signal: it
// adds to the VCA's gain (its pin, up to half again at ACCENT 1) and, through the accent sweep circuit (a Slew limiter for the
// original's diode, 47 kOhm and 1 uF), to the cutoff. RESONANCE is a Macro that sets the ladder's resonance and the sweep's
// smoothing at once, as the original's resonance pot has a second gang in the sweep circuit: from 20 ms at 0 (the sweep
// follows the MEG) to 0.68 s at 10 (99 % of a 147 kOhm x 1 uF charge), so at high resonance consecutive accents build up.
// The ladder's cvamt is 1: ENV MOD and the accent each have their own amount. TUNING spans the knob's ±500 cents (the
// owner's manual, specifications, p. 89), more than the oscillator's fine tune reaches: a Macro (0..1, 0.5 in the middle)
// through an Attenuverter into the oscillator's pitch, x 54614 / 65536 octaves - 27307 / 65536 (both exact in Q16, so the
// middle plays exactly 0 in both engines: ±5 semitones to 0.006 cents). The sequencer is part of the instrument: a
// patch's Steps track is it (a pattern's pitch, accent, slide, tie and rest, octave, triplet time, tempo). Left out:
// MIX IN (needs audio input), the 64-pattern memory, the tracks that chain patterns with transpose, and song mode (#351).
asm('Silver Box', 'Voices', (b) => {
  const glideUnit = (t: number): number => Math.log(t / 0.001) / Math.log(5000);
  const part = b.add('alloc', 0, 1, { voices: 1, legato: 0 });
  const gl = b.add('glide', 1, 1, { time: 0.001 }, { p1: 'time', att: [0.45, 1] });
  const osc = b.add('osc', 1, 0, { wave: 2, level: 0.8, coarse: -12 }, { p1: 'wave' });
  const accOn = b.add('logic', 0, 2, { thresh: 0.9 });
  const meg = b.add('adsr', 2, 1, { a: 0.001, d: 0.3, s: 0, r: 0.05 }, { p1: 'd', att: [-1, 1] });
  const megAcc = b.add('adsr', 2, 2, { a: 0.001, d: 0.2, s: 0, r: 0.05 });
  const envMod = b.add('scale', 3, 1, { gain: 2.6, offset: 0 });
  const accent = b.add('scale', 3, 2, { gain: 1, offset: 0 });
  const sweep = b.add('glide', 4, 2, { time: 0.02 }, { p1: 'time', att: [Math.round((glideUnit(0.68) - glideUnit(0.02)) * 1000) / 1000, 1] });
  const res = b.add('macro', 4, 1, { value: 0.75 });
  const flt = b.add('ladder', 4, 0, { cutoff: 260, res: 0, cvamt: 1, drive: 1 }, { p1: 'res' });
  const aenv = b.add('adsr', 5, 1, { a: 0.002, d: 2.5, s: 0, r: 0.02 });
  const vca = b.add('vca', 5, 0, { gain: 0.8 }, { p1: 'gain', att: [0.25, 1] });
  const waveform = b.add('select', 1, -1, { count: 2, pos: 1, v1: 0, v2: 1 });
  b.wire(waveform, 'out', osc, 'p1'); // saw at the base; the second position adds up to the square at the range's top
  const tune = b.add('macro', 1, 2, { value: 0.5 });
  const tuneSpan = b.add('scale', 1, 3, { gain: 54614 / 65536, offset: -27307 / 65536 }); // 0..1 -> -5..+5 semitones
  b.wire(part, 'pitch', gl, 'in');
  b.wire(tune, 'out', tuneSpan, 'in');
  b.wire(tuneSpan, 'out', osc, 'pitch');
  b.wire(part, 'legato', gl, 'p1');
  b.wire(gl, 'out', osc, 'pitch');
  b.wire(part, 'vel', accOn, 'a');
  b.wire(part, 'gate', accOn, 'b');
  b.wire(part, 'gate', meg, 'gate');
  b.wire(accOn, 'and', meg, 'p1');
  b.wire(accOn, 'and', megAcc, 'gate');
  b.wire(meg, 'env', envMod, 'in');
  b.wire(megAcc, 'env', envMod, 'in');
  b.wire(megAcc, 'env', accent, 'in');
  b.wire(accent, 'out', sweep, 'in');
  b.wire(accent, 'out', vca, 'p1');
  b.wire(res, 'out', flt, 'p1');
  b.wire(res, 'out', sweep, 'p1');
  b.wire(osc, 'out', flt, 'in');
  b.wire(envMod, 'out', flt, 'cv');
  b.wire(sweep, 'out', flt, 'cv');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(part, 'gate', aenv, 'gate');
  b.wire(aenv, 'env', vca, 'cv');
  b.input('keys', part, 'keys');
  b.output('out', vca, 'out');
  b.param('waveform', waveform, 'pos', { head: 'tone' });
  b.param('tuning', tune, 'value');
  b.param('cut off freq', flt, 'cutoff');
  b.param('resonance', res, 'value');
  b.param('env mod', envMod, 'gain');
  b.param('decay', meg, 'd');
  b.param('accent', accent, 'gain');
});
namePositions('Silver Box', { waveform: ['SAW', 'SQUARE'] });

// Hera 6, a six-voice chorus polysynth after the Juno-106: the keys go into the Voice allocator, which plays six voice
// cards (a poly assembly). A card: one oscillator (saw or pulse; its pulse width follows the LFO by `pwm`) with a
// square sub-oscillator an octave below, the 24 dB low pass (a ladder: its cutoff updates per block, which keeps six
// cards cheap) swept by the one ADSR that also shapes the level. Once, as on the original: the noise, the LFO (into
// the oscillators' fine tune by `lfo → pitch`, into the filter by `lfo → filter`, into the pulse width by `pwm`), the
// high pass after the voices and the stereo chorus.
asm('Hera 6', 'Voices', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 3, depth: 1 });
  const vib = b.add('scale', 0, 1, { gain: 0, offset: 0 });
  const pwm = b.add('scale', 0, 2, { gain: 0.3, offset: 0 });
  const lflt = b.add('scale', 0, 3, { gain: 0, offset: 0 });
  const nz = b.add('noise', 1, 0, { level: 0 });
  const part = b.add('alloc', 1, 3, { voices: 6 });
  const osc = b.add('osc', 2, 0, { wave: 2, level: 0.55, pw: 0.5 }, { p1: 'fine', p2: 'pw' });
  const sub = b.add('osc', 2, 1, { wave: 3, coarse: -12, level: 0.25 }, { p1: 'fine' });
  const flt = b.add('ladder', 3, 0, { cutoff: 1400, res: 0.15, cvamt: 2.2, track: 1 });
  const env = b.add('adsr', 3, 1, { a: 0.01, d: 0.8, s: 0.6, r: 0.5 });
  const vca = b.add('vca', 4, 0, { gain: 1 });
  const hpf = b.add('filter', 5, 0, { cutoff: 20, res: 0 });
  const ch = b.add('chorus', 6, 0, { rate: 0.5, depth: 0.55, mix: 0.5 });
  const scope = b.add('scope', 7, 0, { time: 16 });
  b.nest('voice', 2, 2, [osc, sub, flt, env, vca], {
    flaws: [{ detune: 0, drift: 0, bright: 1, env: 2, level: 100 }, { detune: 0, drift: 0, bright: -1, env: -3, level: 98 }, { detune: 0, drift: 0, bright: 0, env: 4, level: 100 }, { detune: 0, drift: 0, bright: 1, env: -2, level: 97 }, { detune: 0, drift: 0, bright: -2, env: 1, level: 99 }, { detune: 0, drift: 0, bright: 2, env: -4, level: 100 }],
  });
  b.wire(part, 'pitch', osc, 'pitch');
  b.wire(part, 'pitch', sub, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(osc, 'out', flt, 'in');
  b.wire(sub, 'out', flt, 'in');
  b.wire(nz, 'out', flt, 'in');
  b.wire(env, 'env', flt, 'cv');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(lfo, 'out', vib, 'in');
  b.wire(lfo, 'out', pwm, 'in');
  b.wire(lfo, 'out', lflt, 'in');
  b.wire(vib, 'out', osc, 'p1');
  b.wire(vib, 'out', sub, 'p1');
  b.wire(pwm, 'out', osc, 'p2');
  b.wire(lflt, 'out', flt, 'cv');
  b.wire(vca, 'out', hpf, 'in');
  b.wire(hpf, 'hp', ch, 'in');
  b.wire(hpf, 'hp', scope, 'a');
  b.input('keys', part, 'keys');
  b.nestInput('pitch', osc, 'pitch', [sub, 'pitch']);
  b.nestInput('gate', env, 'gate');
  b.nestInput('noise', flt, 'in');
  b.nestInput('lfo', osc, 'p1', [sub, 'p1']);
  b.nestInput('pwm', osc, 'p2');
  b.output('l', ch, 'l');
  b.output('r', ch, 'r');
  b.nestOutput('out', vca, 'out');
  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('lfo rate', lfo, 'rate', { head: 'lfo' });
  b.param('lfo → pitch', vib, 'gain');
  b.param('pwm', pwm, 'gain');
  b.param('lfo → filter', lflt, 'gain');
  b.param('wave', osc, 'wave', { head: 'dco' });
  b.param('pw', osc, 'pw');
  b.param('sub', sub, 'level');
  b.param('noise', nz, 'level');
  b.param('hpf', hpf, 'cutoff', { col: true, head: 'filters' });
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  b.param('env', flt, 'cvamt');
  b.param('kybd', flt, 'track');
  b.param('envelope', env, 'view', { col: true, head: 'env' });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
  b.param('vca', vca, 'gain');
  b.param('chorus rate', ch, 'rate', { head: 'chorus' });
  b.param('chorus depth', ch, 'depth');
  b.param('chorus mix', ch, 'mix');
  b.param('out', scope, 'view');
});

// Cassia 1, a phase distortion polysynth after the Casio CZ-1 (waveforms,
// line select, DCO / DCW / DCA envelopes, key follow, vibrato, ring and noise modulation, velocity and aftertouch). It was
// Cassia 1 XL until the PD Osc and Env 8 modules (#351) made this version fit the FM-1 (D-348). The FM-1 plays two
// voices; the original CZ-1 plays eight with two lines and sixteen with one. The missing features are listed below.
// A voice has both lines, each one PD Osc (the CZ's eight waveforms, a second waveform on every other cycle, the DCW
// input) with its DCW and DCA envelopes; every envelope (the DCO's too) is an Env 8: eight rates and levels, a sustain
// step and an end step, as on the CZ.
//  - a line's waveforms (`wave`, `wave 2`) and resonance range are Offsets, once for all voices, that set the line's
//    PD Osc through its pins: wave on p1 (x 1/7, so the Offset's 0..7 is the wave), wave 2 on p2 (x 1/8), the range
//    through the pm input, routed to `range` (an Attenuverter makes it fifths of the range; the oscillator's own pm depth
//    is 0, so pm does no phase modulation). That lets 1 + 1' hand line 1's settings to line 2.
//  - the DCW: the line's DCW envelope plus key follow, velocity and aftertouch, summed into the PD Osc's dcw input.
// Line select (`line`, a Selector): 1 line 1, 2 line 2, 3 both (1 + 2). `1+1'` (0 / 1) makes line 2 play line 1's
// waveforms, range and DCW / DCA envelopes at line 2's pitch (`coarse`, `fine`): line 1'. Line 2's ring modulation
// (times line 1) and noise modulation (times the noise) are Selectors too: 1 off, 2 on. The DCO envelope moves both
// lines' pitch by `depth` octaves; vibrato's wave (the CZ's saw down is a negative `vib depth`), rate, depth and delay;
// key follow lowers the DCW and DCA levels from C4; velocity opens the DCA (and the DCW by `vel dcw`); aftertouch reaches
// DCW, DCA and vibrato depth (the `at` input).
// Left out: the CZ has a DCO envelope per line (one here moves both); the CZ-1's velocity curves; its cartridge, tone
// mix / split and multi-timbral MIDI modes (hardware and memory). The rows are short (r1, l1 ..) and the mode switches
// are Selectors and Crossfaders, not Macros, to stay inside the FM-1's patch bytes (3,840) and 32 pages per device.
const CZ_STEPS = (s: [number, number][], sus: number, end: number): Record<string, number> => {
  const p: Record<string, number> = { sus, end };
  for (let k = 0; k < 8; k++) {
    const [r, l] = s[k] ?? [0.2, 0];
    p[`r${k + 1}`] = r;
    p[`l${k + 1}`] = l;
  }
  return p;
};
asm('Cassia 1', 'Voices', (b) => {
  const part = b.add('alloc', 0, 4, { voices: 2 });
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 5.5, depth: 1 });
  const vibS = b.add('scale', 0, 0.5, { gain: 0, offset: 0 }); // vib depth (negative: the CZ's saw down)
  const nz = b.add('noise', 0, 1, { level: 1, color: 0 });
  const scope = b.add('scope', 12, 0, { time: 16 });
  const atVib = b.add('scale', 0, 2.5, { gain: 0, offset: 0 });
  const atW = b.add('scale', 0, 3, { gain: 0, offset: 0 });
  const atA = b.add('scale', 0, 3.5, { gain: 0, offset: 0 });
  b.wire(lfo, 'out', vibS, 'in');
  const members: number[] = [];
  const add = (type: string, col: number, row: number, p: Record<string, number> = {}, o: { p1?: string; p2?: string; att?: [number, number] } = {}): number => {
    const id = b.add(type, col, row, p, o);
    members.push(id);
    return id;
  };
  type R = [number, string];
  // ---- a line's settings, once for all voices: Offsets; line 2's go through a Crossfader each that hands it line 1's in
  // 1 + 1' (pos 0: its own, 1: line 1's)
  const mode = b.add('const', 5, 0, { value: 0 });
  const consts = (col: number, wave: number): { wave: number; wave2: number; range: number } => ({
    wave: b.add('const', col, 0, { value: wave }),
    wave2: b.add('const', col, 0.3, { value: 0 }),
    range: b.add('const', col, 0.6, { value: 3 }),
  });
  const fifths = (from: R, col: number): R => {
    const s = b.add('scale', col, 1, { gain: 1 / PD_RANGE_MAX, offset: 0 });
    b.wire(from[0], from[1], s, 'in');
    return [s, 'out'];
  };
  const pick = (own: number, l1: number, row: number): R => {
    const x = b.add('xfade', 5, row, { mix: 0 });
    b.wire(own, 'out', x, 'a');
    b.wire(l1, 'out', x, 'b');
    b.wire(mode, 'out', x, 'pos');
    return [x, 'out'];
  };
  const k1 = consts(1, 0);
  const k2 = consts(2, PD_WAVES.indexOf('reso 1'));
  const c1 = { wave: [k1.wave, 'out'] as R, wave2: [k1.wave2, 'out'] as R, range: fifths([k1.range, 'out'], 1) };
  const c2 = { wave: pick(k2.wave, k1.wave, 0.3), wave2: pick(k2.wave2, k1.wave2, 0.6), range: fifths(pick(k2.range, k1.range, 0.9), 2) };

  // ---- per voice: pitch (DCO envelope, vibrato after its delay), key follow, velocity
  const pitch = add('scale', 1, 5, { gain: 1, offset: 0 });
  const dco = add('env8', 1, 5.5, CZ_STEPS([[0.05, 0], [0.3, 0], [0.5, 0]], 2, 3));
  const pdepth = add('scale', 1, 6, { gain: 1, offset: 0 });
  const vdel = add('adsr', 1, 7, { a: 0.6, d: 0.001, s: 1, r: 0.3 });
  const vgate = add('vca', 1, 7.5, { gain: 1 });
  const kfw = add('scale', 1, 8.5, { gain: -0.15, offset: 0 });
  const kfa = add('scale', 1, 9, { gain: -0.1, offset: 0 });
  const velW = add('scale', 1, 9.5, { gain: 0, offset: 0 });
  b.wire(part, 'gate', dco, 'gate');
  b.wire(dco, 'env', pdepth, 'in');
  b.wire(part, 'gate', vdel, 'gate');
  b.wire(vibS, 'out', vgate, 'in');
  b.wire(vdel, 'env', vgate, 'cv');
  b.wire(atVib, 'out', vgate, 'cv');
  b.wire(part, 'pitch', pitch, 'in');
  b.wire(pdepth, 'out', pitch, 'in');
  b.wire(vgate, 'out', pitch, 'in');
  b.wire(part, 'pitch', kfw, 'in');
  b.wire(part, 'pitch', kfa, 'in');
  b.wire(part, 'vel', velW, 'in');
  // ---- the envelopes: up to the sustain at step 3, then three steps down
  const DCA = CZ_STEPS([[0.01, 1], [0.4, 0.8], [2, 0.6], [0.15, 0.3], [0.3, 0.09], [0.4, 0]], 3, 6);
  const dcw1 = add('env8', 3, 0, CZ_STEPS([[0.05, 0.9], [0.6, 0.6], [1.5, 0.4], [0.15, 0.2], [0.3, 0.06], [0.4, 0]], 3, 6));
  const dca1 = add('env8', 3, 1, DCA);
  const dcw2 = add('env8', 4, 0, CZ_STEPS([[0.1, 0.7], [0.8, 0.4], [2, 0.25], [0.15, 0.125], [0.3, 0.04], [0.4, 0]], 3, 6));
  const dca2 = add('env8', 4, 1, DCA);
  for (const e of [dcw1, dca1, dcw2, dca2]) b.wire(part, 'gate', e, 'gate');
  // 1 + 1': line 2 takes line 1's envelopes
  const own = (e2: number, e1: number, row: number): R => {
    const s = add('select', 4, row, { pos: 1, count: 2, fade: 0 });
    b.wire(e2, 'env', s, 'in1');
    b.wire(e1, 'env', s, 'in2');
    b.wire(mode, 'out', s, 'pos');
    return [s, 'out'];
  };
  const dcwX = own(dcw2, dcw1, 2);
  const dcaX = own(dca2, dca1, 2.5);
  // ---- a line: its PD Osc (dcw: the envelope plus the touch) and its DCA (velocity, key follow, aftertouch on its gain)
  const line = (col: number, c: { wave: R; wave2: R; range: R }, dcw: R): number => {
    const pd = add('pd', col, 3, { wave: 0, wave2: 0, dcw: 0, range: 0, pm: 0, level: 1 }, { p1: 'wave', p2: 'wave2', att: [1 / 7, 1 / 8] });
    b.module(pd).inputMap = { pm: ['range'] };
    b.wire(c.wave[0], c.wave[1], pd, 'p1');
    b.wire(c.wave2[0], c.wave2[1], pd, 'p2');
    b.wire(c.range[0], c.range[1], pd, 'pm');
    b.wire(pitch, 'out', pd, 'pitch');
    for (const [m, port] of [dcw, [kfw, 'out'], [velW, 'out'], [atW, 'out']] as R[]) b.wire(m, port, pd, 'dcw');
    return pd;
  };
  const dcaVca = (col: number): number => {
    const vca = add('vca', col, 5, { gain: 0.075 }, { p1: 'gain', att: [0.225, 1] }); // velocity 1 reaches 0.3 a line, 0.6 both
    b.wire(part, 'vel', vca, 'p1');
    b.wire(kfa, 'out', vca, 'p1');
    b.wire(atA, 'out', vca, 'p1');
    return vca;
  };
  const pd1 = line(6, c1, [dcw1, 'env']);
  const pd2 = line(7, c2, dcwX);
  const v1 = dcaVca(6);
  const v2 = dcaVca(7);
  b.wire(pd1, 'out', v1, 'in');
  b.wire(dca1, 'env', v1, 'cv');
  // line 2's modulation before its DCA: ring (times line 1), then noise
  const ringV = add('vca', 9, 0, { gain: 1 });
  const ring = add('select', 9, 0.5, { pos: 1, count: 2, fade: 0 });
  const noiseV = add('vca', 9, 1, { gain: 1 });
  const noise = add('select', 9, 1.5, { pos: 1, count: 2, fade: 0 });
  b.wire(pd2, 'out', ringV, 'in');
  b.wire(pd1, 'out', ringV, 'cv');
  b.wire(pd2, 'out', ring, 'in1');
  b.wire(ringV, 'out', ring, 'in2');
  b.wire(ring, 'out', noiseV, 'in');
  b.wire(nz, 'out', noiseV, 'cv');
  b.wire(ring, 'out', noise, 'in1');
  b.wire(noiseV, 'out', noise, 'in2');
  b.wire(noise, 'out', v2, 'in');
  b.wire(dcaX[0], dcaX[1], v2, 'cv');
  // the line select: 1 line 1, 2 line 2, 3 both
  const sel = add('select', 10, 0.5, { pos: 3, count: 3, fade: 0 });
  b.wire(v1, 'out', sel, 'in1');
  b.wire(v2, 'out', sel, 'in2');
  b.wire(v1, 'out', sel, 'in3');
  b.wire(v2, 'out', sel, 'in3');
  b.wire(sel, 'out', scope, 'a');
  b.nest('voice', 3, 6, members, {});
  b.input('keys', part, 'keys');
  b.input('at', atVib, 'in', [atW, 'in'], [atA, 'in']);
  b.output('out', sel, 'out');

  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('line', sel, 'pos');
  b.param("1+1'", mode, 'value');
  b.param('vib wave', lfo, 'wave', { head: 'vibrato' });
  b.param('vib rate', lfo, 'rate');
  b.param('vib depth', vibS, 'gain');
  b.param('vib delay', vdel, 'a');
  const envRows = (e: number, head: string, col: boolean): void => {
    b.param(head, e, 'view', { head, ...(col ? { col: true } : {}) });
    for (let k = 1; k <= 8; k++) {
      b.param(`r${k}`, e, `r${k}`);
      b.param(`l${k}`, e, `l${k}`);
    }
    b.param('sus', e, 'sus');
    b.param('end', e, 'end');
  };
  envRows(dco, 'dco env', false);
  b.param('depth', pdepth, 'gain');
  b.param('dcw kf', kfw, 'gain', { head: 'touch' });
  b.param('dca kf', kfa, 'gain');
  b.param('vel dcw', velW, 'gain');
  b.param('at dcw', atW, 'gain');
  b.param('at dca', atA, 'gain');
  b.param('at vib', atVib, 'gain');
  for (const [n, k, dcw, dca] of [[1, k1, dcw1, dca1], [2, k2, dcw2, dca2]] as const) {
    b.param('wave', k.wave, 'value', { head: `line ${n}`, col: true });
    b.param('wave 2', k.wave2, 'value');
    b.param('res range', k.range, 'value');
    if (n === 2) {
      b.param('ring', ring, 'pos');
      b.param('noise', noise, 'pos');
      b.param('coarse', pd2, 'coarse');
      b.param('fine', pd2, 'fine');
    }
    envRows(dcw, `dcw ${n}`, true);
    envRows(dca, `dca ${n}`, true);
  }
  b.param('out', scope, 'view', { col: true });
});

// Sallen 20, after the Korg MS-20 (its owner's manual, 1978; the MS-20 mini's, which reproduces its circuit, for the key
// priority): the instrument as it plays with nothing patched, its panel's controls named as the original names them. One
// voice (the highest key held). Two VCOs: SCALE (footages, a Selector adding octaves) and WAVEFORM switches (Selectors that
// set the oscillator's wave and pulse width through its pins, and pick the noise for VCO 1's fourth position, the ring
// modulator, VCO 1 times VCO 2, for VCO 2's), VCO 1's PW, VCO 2's PITCH (semitones and cents). PORTAMENTO, MASTER TUNE (the
// offset of the EG 1 amount's Attenuverter). Frequency modulation of both VCOs by the MG's triangle (MG/T.EXT) and EG 1
// (EG1/EXT). The VCO mixer, then the resonant 6 dB high pass and the resonant 12 dB low pass in series, each with its own
// MG/T.EXT and EG2/EXT amounts (the filters' cvamt is 1), then the VCA on EG 2. EG 1: DELAY (a Pulse holds the gate off at
// the start, Math subtracts it), ATTACK, RELEASE (an ADSR at full sustain). EG 2: HOLD (a Pulse that keeps the gate up),
// ATTACK, DECAY, SUSTAIN, RELEASE. The MG: FREQUENCY, WAVEFORM. The patch panel's own sections, as its jacks (the
// assembly's outputs and inputs, to patch in the browser): the sample and hold (white noise in, clocked by the MG's
// rectangle), the noise generator's white and pink outputs, the MVCA (EG 1 normalled to its
// control, its signal input open), EG 1 and EG 2's reverse outputs, the control wheel (Main's mod wheel) and the momentary
// switch (Main's FX button), KBD CV and trigger, the MG's triangle and rectangle, and INITIAL GAIN into the VCA. The ESP
// (external signal processor) is a Follower: its SIGNAL IN is the assembly's `esp signal in` plus the SIGNAL IN row's choice
// of an internal signal (the FM-1 has no audio input, #274), its ESP ROUTE row patches one of its outputs (below), its rows SIGNAL LEVEL, LOW CUT FREQ, HIGH CUT FREQ, CV ADJUST and
// THRESHOLD LEVEL, its jacks the amplifier and band-pass outs, F-V CV OUT, ENV OUT and TRIG OUT. The jacks its manual patches
// them into are inputs too: VCO 1+2 CV IN (added to the keyboard's pitch), TRIGGER IN (a Logic or with the keyboard's gate,
// into both EGs) and INITIAL GAIN (the VCA); VCO 2 CV IN is not (VCO 2's pitch input is VCO 1+2's). Nothing is patched, so they do not change the sound; their outputs meet at
// the VCO mixer's unused third input, at 0, so they run on the FM-1 too (it leaves out a module nothing audible reads).
asm('Sallen 20', 'Voices', (b) => {
  const pins = (id: number, p1: string[], p2: string[], att: [number, number]): void => {
    const m = b.module(id);
    m.map = { ...m.map!, p1, p2 };
    m.att = att;
  };
  // (first: TRIG>EGS closes a loop through EG 1, VCO 1 and the ESP, and the loop's one block of delay goes on the cable
  // from the module processing reaches first, patch.ts processingOrder: this one, so the keyboard's path keeps no delay)
  const trigTo = b.add('logic', 7, 6, { thresh: 0.5 });
  const part = b.add('alloc', 0, 3, { voices: 1, priority: 2 });
  const gl = b.add('glide', 0, 0, { time: 0.001 });
  const s1 = b.add('select', 1, 0, { count: 4, pos: 3, v1: -2, v2: -1, v3: 0, v4: 1 }); // 32' 16' 8' 4'
  const s2 = b.add('select', 1, 1, { count: 4, pos: 2, v1: -1, v2: 0, v3: 1, v4: 2 }); // 16' 8' 4' 2'
  // VCO 1: triangle, saw, pulse (wave 1 + 3v), noise; VCO 2: saw, square (wave 2 + 3v), narrow pulse (g3 pulls the width to
  // 0.1), ring modulator
  const w1 = b.add('select', 2, 0, { count: 4, pos: 2, v1: 0, v2: 0.333, v3: 0.667, v4: 0.667 });
  const w2 = b.add('select', 2, 1, { count: 4, pos: 2, v1: 0, v2: 0.333, v3: 0.333, v4: 0.333 });
  const o1 = b.add('osc', 3, 0, { wave: 1, level: 1, pw: 0.5 });
  pins(o1, ['wave'], [], [1, 1]);
  const o2 = b.add('osc', 3, 1, { wave: 2, level: 1, pw: 0.5, coarse: 7 });
  pins(o2, ['wave'], ['pw'], [1, -0.444]);
  const nz = b.add('noise', 3, 2, { level: 1, color: 0 });
  const v1 = b.add('xfade', 4, 0, { mix: 0 });
  const ring = b.add('vca', 4, 2, { gain: 1 });
  const v2 = b.add('xfade', 4, 1, { mix: 0 });
  const mix = b.add('mixer', 5, 0, { l1: 0.5, l2: 0, l3: 0, l4: 0 });
  const hpf = b.add('filter', 6, 0, { cutoff: 60, res: 0.2, cvamt: 1, osc: 1 }); // osc: both MS-20 filters self-oscillate at full PEAK (Stinchcombe)
  const lpf = b.add('filter', 7, 0, { cutoff: 1600, res: 0.45, cvamt: 1, osc: 1 });
  const vca = b.add('vca', 8, 0, { gain: 0.75 });
  const delay = b.add('pulse', 1, 3, { time: 0.001 });
  const eg1Gate = b.add('math', 2, 3, { ka: 1, kb: 1, off: 0 });
  const eg1 = b.add('adsr', 3, 3, { a: 0.001, d: 0.001, s: 1, r: 0.3 });
  const hold = b.add('pulse', 4, 3, { time: 0.001 });
  const eg2 = b.add('adsr', 5, 3, { a: 0.005, d: 0.4, s: 0.45, r: 0.3 });
  const mg = b.add('lfo', 6, 3, { wave: 1, rate: 5, depth: 1 });
  const mgShape = b.add('macro', 7, 3, { value: 0.5 });
  b.wire(mgShape, 'out', mg, 'shape');
  const amt = (col: number, row: number, gain = 0): number => b.add('scale', col, row, { gain, offset: 0 });
  const egPitch = amt(3, 4);
  const mgPitch = amt(6, 4);
  const mgHp = amt(6, 1);
  const egHp = amt(5, 1, 0);
  const mgLp = amt(7, 1);
  const egLp = amt(7, 2, 2.5);
  b.wire(part, 'pitch', gl, 'in');
  for (const [o, s, w] of [[o1, s1, w1], [o2, s2, w2]]) {
    for (const src of [gl, s, egPitch, mgPitch]) b.wire(src, 'out', o, 'pitch');
    b.wire(w, 'out', o, 'p1');
  }
  b.wire(w2, 'g3', o2, 'p2');
  b.wire(o1, 'out', v1, 'a');
  b.wire(nz, 'out', v1, 'b');
  b.wire(w1, 'g4', v1, 'pos');
  b.wire(o1, 'out', ring, 'in');
  b.wire(o2, 'out', ring, 'cv');
  b.wire(o2, 'out', v2, 'a');
  b.wire(ring, 'out', v2, 'b');
  b.wire(w2, 'g4', v2, 'pos');
  b.wire(v1, 'out', mix, 'in1');
  b.wire(v2, 'out', mix, 'in2');
  b.wire(mix, 'out', hpf, 'in');
  b.wire(hpf, 'hp6', lpf, 'in'); // the MS-20's high pass is 6 dB per octave, resonant (Stinchcombe's MS-20 filter study)
  b.wire(lpf, 'lp12', vca, 'in');
  // the keyboard's gate or TRIGGER IN (the assembly input) triggers both EGs
  const trig = b.add('logic', 0, 4, { thresh: 0.5 });
  b.wire(part, 'gate', trig, 'a');
  b.wire(trig, 'or', delay, 'trig');
  b.wire(trig, 'or', eg1Gate, 'a');
  b.wire(delay, 'out', eg1Gate, 'b');
  b.wire(eg1Gate, 'sub', eg1, 'gate');
  b.wire(trig, 'or', hold, 'trig');
  b.wire(trig, 'or', eg2, 'gate');
  b.wire(hold, 'out', eg2, 'gate');
  b.wire(eg2, 'env', vca, 'cv');
  b.wire(eg1, 'env', egPitch, 'in');
  b.wire(mg, 'out', mgPitch, 'in');
  for (const [a, src, f] of [[mgHp, mg, hpf], [egHp, eg2, hpf], [mgLp, mg, lpf], [egLp, eg2, lpf]]) {
    b.wire(src, src === mg ? 'out' : 'env', a, 'in');
    b.wire(a, 'out', f, 'cv');
  }
  // the patch panel
  const sh = b.add('sh', 8, 3, { mode: 0 });
  const pink = b.add('noise', 0, 5, { level: 1, color: 0.6 });
  const mvca = b.add('vca', 1, 5, { gain: 1 });
  const eg1Rev = amt(2, 5, -1);
  const eg2Rev = amt(3, 5, -1);
  const wheel = amt(4, 5, 1);
  const sw = amt(5, 5, 1);
  const initGain = b.add('const', 6, 5, { value: 0 });
  const esp = b.add('esp', 7, 5, { level: 1, lowcut: 40, highcut: 2000, cvadj: 0, thresh: 0.1 });
  b.wire(nz, 'out', sh, 'in');
  b.wire(mg, 'pulse', sh, 'clock');
  b.wire(eg1, 'env', mvca, 'cv');
  b.wire(eg1, 'env', eg1Rev, 'in');
  b.wire(eg2, 'env', eg2Rev, 'in');
  b.wire(initGain, 'out', vca, 'cv');
  // The ESP on the FM-1 (no audio input there): SIGNAL IN picks what it hears (OFF, VCO 1 as its WAVEFORM switch makes
  // it, the white noise, the MG's triangle), summed with the browser's `esp signal in`. ESP ROUTE patches one of its
  // outputs as the manual does: F-V CV into VCO 2 CV IN (not VCO 1+2: VCO 1 would then follow itself), ENV into INITIAL
  // GAIN, TRIG into TRIGGER IN. Gates of the route's Selector open a VCA (or a Logic and) per route; OFF and OFF play as
  // before (the routes add 0).
  const espIn = b.add('select', 7, 4, { count: 4, pos: 1 });
  b.wire(v1, 'out', espIn, 'in2');
  b.wire(nz, 'out', espIn, 'in3');
  b.wire(mg, 'out', espIn, 'in4');
  b.wire(espIn, 'out', esp, 'in');
  const espRoute = b.add('select', 8, 4, { count: 4, pos: 1 });
  const fvTo = b.add('vca', 8, 5, { gain: 1 });
  const envTo = b.add('vca', 8, 6, { gain: 1 });
  b.wire(esp, 'pitch', fvTo, 'in');
  b.wire(espRoute, 'g2', fvTo, 'cv');
  b.wire(fvTo, 'out', o2, 'pitch');
  b.wire(esp, 'env', envTo, 'in');
  b.wire(espRoute, 'g3', envTo, 'cv');
  b.wire(envTo, 'out', vca, 'cv');
  b.wire(esp, 'trig', trigTo, 'a');
  b.wire(espRoute, 'g4', trigTo, 'b');
  b.wire(trigTo, 'and', trig, 'b');
  for (const [m, port] of [[mg, 'pulse'], [sh, 'out'], [pink, 'out'], [mvca, 'out'], [eg1Rev, 'out'], [eg2Rev, 'out'], [wheel, 'out'], [sw, 'out'], [esp, 'amp']] as const) b.wire(m, port, mix, 'in3');
  b.input('keys', part, 'keys');
  b.input('mvca in', mvca, 'in');
  b.input('wheel', wheel, 'in');
  b.input('switch', sw, 'in');
  b.input('esp signal in', esp, 'in');
  b.input('vco 1+2 cv in', o1, 'pitch', [o2, 'pitch']);
  b.input('trigger in', trig, 'b');
  b.input('initial gain', vca, 'cv');
  b.output('out', vca, 'out');
  b.output('s&h out', sh, 'out');
  b.output('white noise', nz, 'out');
  b.output('pink noise', pink, 'out');
  b.output('mvca out', mvca, 'out');
  b.output('eg1 normal', eg1, 'env');
  b.output('eg1 reverse', eg1Rev, 'out');
  b.output('eg2 normal', eg2, 'env');
  b.output('eg2 reverse', eg2Rev, 'out');
  b.output('mg triangle', mg, 'out');
  b.output('mg rectangle', mg, 'pulse');
  b.output('wheel out', wheel, 'out');
  b.output('switch out', sw, 'out');
  b.output('kbd cv', part, 'pitch');
  b.output('kbd trig', part, 'gate');
  b.output('esp amp out', esp, 'amp');
  b.output('esp bpf out', esp, 'bp');
  b.output('f-v cv out', esp, 'pitch');
  b.output('env out', esp, 'env');
  b.output('trig out', esp, 'trig');
  b.param('portamento', gl, 'time', { head: 'vco' });
  b.param('master tune', egPitch, 'offset');
  b.param('vco 1 scale', s1, 'pos');
  b.param('vco 1 wave', w1, 'pos');
  b.param('vco 1 pw', o1, 'pw');
  b.param('vco 2 scale', s2, 'pos', { group: true });
  b.param('vco 2 wave', w2, 'pos');
  b.param('vco 2 pitch', o2, 'coarse');
  b.param('vco 2 fine', o2, 'fine');
  b.param('mg/t.ext', mgPitch, 'gain', { head: 'freq mod' });
  b.param('eg1/ext', egPitch, 'gain');
  b.param('vco 1 level', mix, 'l1', { head: 'vco mixer' });
  b.param('vco 2 level', mix, 'l2');
  b.param('cutoff', hpf, 'cutoff', { col: true, head: 'highpass' });
  b.param('peak', hpf, 'res');
  b.param('mg/t.ext', mgHp, 'gain');
  b.param('eg2/ext', egHp, 'gain');
  b.param('cutoff', lpf, 'cutoff', { head: 'lowpass' });
  b.param('peak', lpf, 'res');
  b.param('mg/t.ext', mgLp, 'gain');
  b.param('eg2/ext', egLp, 'gain');
  b.param('eg 1', eg1, 'view', { col: true, head: 'eg 1' });
  b.param('delay', delay, 'time');
  b.param('attack', eg1, 'a');
  b.param('release', eg1, 'r');
  b.param('eg 2', eg2, 'view', { head: 'eg 2' });
  b.param('hold', hold, 'time');
  b.param('attack', eg2, 'a');
  b.param('decay', eg2, 'd');
  b.param('sustain', eg2, 's');
  b.param('release', eg2, 'r');
  b.param('frequency', mg, 'rate', { head: 'mg' });
  b.param('waveform', mgShape, 'value');
  b.param('initial gain', initGain, 'value', { head: 'patch panel' });
  b.param('signal in', espIn, 'pos', { head: 'esp' });
  b.param('signal level', esp, 'level');
  b.param('low cut', esp, 'lowcut');
  b.param('high cut', esp, 'highcut');
  b.param('cv adjust', esp, 'cvadj');
  b.param('threshold', esp, 'thresh');
  b.param('esp route', espRoute, 'pos');
});
namePositions('Sallen 20', {
  'vco 1 scale': ["32'", "16'", "8'", "4'"], 'vco 2 scale': ["16'", "8'", "4'", "2'"],
  'vco 1 wave': ['TRIANGLE', 'SAW', 'PULSE', 'NOISE'], 'vco 2 wave': ['SAW', 'SQUARE', 'NARROW', 'RING'],
  'signal in': ['OFF', 'VCO 1', 'NOISE', 'MG'], 'esp route': ['OFF', 'F-V>VCO 2', 'ENV>GAIN', 'TRIG>EGS'],
});

// Expander S, a four-voice polysynth of state-variable expander modules (after Oberheim's SEM and its Four Voice):
// the keys go into the Voice allocator, which plays four voice cards. A card: two oscillators (saw or pulse) into the
// 12 dB state-variable filter whose `mode` sweeps low pass, notch (halfway: low pass plus high pass) and high pass,
// envelope 1 into the cutoff (through a parameter input, so per block: the filter stays cheap), envelope 2 on the level, and the card's own place in the stereo field (`width`: each
// voice panned by its index, as the Four Voice's pan pots). Once: an LFO into the oscillators' fine tune (`vibrato`).
asm('Expander S', 'Voices', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 5, depth: 1 });
  const vib = b.add('scale', 0, 1, { gain: 0, offset: 0 });
  const part = b.add('alloc', 0, 2, { voices: 4 });
  const o1 = b.add('osc', 1, 0, { wave: 2, level: 0.5 }, { p1: 'fine' });
  const o2 = b.add('osc', 1, 1, { wave: 3, level: 0.4, pw: 0.4, fine: 5 }, { p1: 'fine' });
  const flt = b.add('filter', 2, 0, { cutoff: 1100, res: 0.35 }, { p1: 'cutoff' });
  const amt = b.add('scale', 2, 2, { gain: 0.25, offset: 0 });
  const mode = b.add('xfade', 3, 0, { mix: 0 });
  const env1 = b.add('adsr', 2, 1, { a: 0.01, d: 0.6, s: 0.4, r: 0.6 });
  const env2 = b.add('adsr', 3, 1, { a: 0.01, d: 0.6, s: 0.8, r: 0.6 });
  const vca = b.add('vca', 4, 0, { gain: 0.6 });
  const width = b.add('scale', 4, 1, { gain: 0.4, offset: 0 });
  const pan = b.add('pan', 5, 0, { pan: 0 });
  const scope = b.add('scope', 6, 0, { time: 16 });
  b.nest('voice', 1, 3, [o1, o2, flt, amt, mode, env1, env2, vca, width, pan], {
    flaws: [{ detune: 3, drift: 25, bright: 1, env: 3, level: 100 }, { detune: -4, drift: 30, bright: -1, env: -4, level: 96 }, { detune: 2, drift: 20, bright: 0, env: 5, level: 100 }, { detune: -2, drift: 25, bright: 2, env: -3, level: 97 }],
  });
  b.wire(part, 'pitch', o1, 'pitch');
  b.wire(part, 'pitch', o2, 'pitch');
  b.wire(part, 'gate', env1, 'gate');
  b.wire(part, 'gate', env2, 'gate');
  b.wire(part, 'index', width, 'in');
  b.wire(o1, 'out', flt, 'in');
  b.wire(o2, 'out', flt, 'in');
  b.wire(env1, 'env', amt, 'in');
  b.wire(amt, 'out', flt, 'p1');
  b.wire(flt, 'lp12', mode, 'a');
  b.wire(flt, 'hp', mode, 'b');
  b.wire(mode, 'out', vca, 'in');
  b.wire(env2, 'env', vca, 'cv');
  b.wire(vca, 'out', pan, 'in');
  b.wire(width, 'out', pan, 'pos');
  b.wire(lfo, 'out', vib, 'in');
  b.wire(vib, 'out', o1, 'p1');
  b.wire(vib, 'out', o2, 'p1');
  b.wire(vca, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.nestInput('pitch', o1, 'pitch', [o2, 'pitch']);
  b.nestInput('gate', env1, 'gate', [env2, 'gate']);
  b.nestInput('index', width, 'in');
  b.nestInput('vibrato', o1, 'p1', [o2, 'p1']);
  b.output('l', pan, 'l');
  b.output('r', pan, 'r');
  b.nestOutput('out', vca, 'out');
  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('unison', part, 'unison');
  b.param('width', width, 'gain');
  b.param('vco 1 wave', o1, 'wave', { head: 'oscillators' });
  b.param('vco 1 pw', o1, 'pw');
  b.param('vco 2 wave', o2, 'wave', { group: true });
  b.param('vco 2 pw', o2, 'pw');
  b.param('vco 2 freq', o2, 'coarse');
  b.param('vco 2 fine', o2, 'fine');
  b.param('vco 1', o1, 'level', { group: true });
  b.param('vco 2', o2, 'level');
  b.param('cutoff', flt, 'cutoff', { col: true, head: 'filter' });
  b.param('resonance', flt, 'res');
  b.param('mode', mode, 'mix');
  b.param('env 1 amt', amt, 'gain');
  b.param('env 1', env1, 'view', { head: 'envelopes' });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env1, q);
  b.param('env 2', env2, 'view', { col: true });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env2, q);
  b.param('lfo rate', lfo, 'rate', { head: 'lfo' });
  b.param('vibrato', vib, 'gain');
  b.param('out', scope, 'view');
});

// Algo Four, a four-operator FM polysynth after the 4-op Yamaha DX / TX family: the keys go into the Voice allocator,
// which plays three voice cards. A card: four operators (an oscillator, an envelope and a VCA each) in two
// stacks, operator 2 into the phase of operator 1 and operator 4 into operator 3; 1 and 3 are heard. Operator 4's
// `feedback` is off: above 0 it runs oversampled like a carrier (three voices then estimate over the FM-1's CPU).
// An operator's `ratio` is its frequency ratio in semitones above the note, `level` its output (for 2 and 4: how
// much they modulate), each carrier's `index` how far its phase follows its modulator. The carriers' envelopes are
// DX-style (rates are segment times, levels where each segment goes), the modulators' ADSRs (half the cost, so three
// voices fit). Patch the stacks differently on the expanded card for the
// other algorithms.
asm('Algo Four', 'Voices', (b) => {
  const part = b.add('alloc', 0, 2, { voices: 3 });
  const op: number[] = [];
  const env: number[] = [];
  const vca: number[] = [];
  const setup: [Record<string, number>, Record<string, number>, number][] = [
    [{ wave: 0, level: 1, pm: 2.2 }, { l1: 1, r1: 0.002, l2: 0.6, r2: 1.2, l3: 0.35, r3: 1, l4: 0, r4: 0.5 }, 0.5],
    [{ wave: 0, level: 1, coarse: 12 }, { l1: 1, r1: 0.002, l2: 0.4, r2: 0.6, l3: 0.2, r3: 2, l4: 0, r4: 0.4 }, 0.8],
    [{ wave: 0, level: 1, pm: 1.5 }, { l1: 1, r1: 0.002, l2: 0.5, r2: 0.25, l3: 0, r3: 0.6, l4: 0, r4: 0.3 }, 0.35],
    [{ wave: 0, level: 1, coarse: 45, fine: 70 }, { l1: 1, r1: 0.001, l2: 0.2, r2: 0.12, l3: 0, r3: 0.3, l4: 0, r4: 0.2 }, 0.6],
  ];
  // the modulators' envelopes are ADSRs (half the cost of a level / rate envelope), so three voices fit
  setup.forEach(([o, e, g], i) => {
    op.push(b.add('osc', 1 + i, 0, o));
    env.push(i % 2 === 0 ? b.add('env', 1 + i, 1, e) : b.add('adsr', 1 + i, 1, { a: e.r1, d: e.r2, s: e.l3, r: e.r4 }));
    vca.push(b.add('vca', 1 + i, 2, { gain: g }));
  });
  const mix = b.add('mixer', 5, 0, { l1: 0.7, l2: 0.7, l3: 0, l4: 0 });
  const scope = b.add('scope', 6, 0, { time: 16 });
  b.nest('voice', 1, 3, [...op, ...env, ...vca, mix], { flaws: [{ detune: 0, drift: 0, bright: 0, env: 0, level: 100 }, { detune: 0, drift: 0, bright: 0, env: 0, level: 100 }, { detune: 0, drift: 0, bright: 0, env: 0, level: 100 }] });
  for (let i = 0; i < 4; i++) {
    b.wire(part, 'pitch', op[i], 'pitch');
    b.wire(part, 'gate', env[i], 'gate');
    b.wire(op[i], 'out', vca[i], 'in');
    b.wire(env[i], 'env', vca[i], 'cv');
  }
  b.wire(vca[1], 'out', op[0], 'pm');
  b.wire(vca[3], 'out', op[2], 'pm');
  b.wire(vca[0], 'out', mix, 'in1');
  b.wire(vca[2], 'out', mix, 'in2');
  b.wire(mix, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.nestInput('pitch', op[0], 'pitch', [op[1], 'pitch'], [op[2], 'pitch'], [op[3], 'pitch']);
  b.nestInput('gate', env[0], 'gate', [env[1], 'gate'], [env[2], 'gate'], [env[3], 'gate']);
  b.output('out', mix, 'out');
  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('feedback', op[3], 'fb');
  b.param('stack 1→2 mix', mix, 'l1');
  b.param('stack 3→4 mix', mix, 'l2');
  for (let i = 0; i < 4; i++) {
    const n = i + 1;
    b.param(`ratio ${n}`, op[i], 'coarse', { col: true, head: `operator ${n}${i % 2 === 0 ? ' (carrier)' : ''}` });
    b.param(`detune ${n}`, op[i], 'fine');
    b.param(`level ${n}`, vca[i], 'gain');
    if (i % 2 === 0) b.param(`index ${n}`, op[i], 'pm');
    b.param(`env ${n}`, env[i], 'view');
    for (const q of i % 2 === 0 ? ['r1', 'l2', 'r2', 'l3', 'r4'] : ['a', 'd', 's', 'r']) b.param(`${q} ${n}`, env[i], q, { inner: `op${n} ${q}` });
  }
  b.param('out', scope, 'view');
});

// Canvas, after Buchla's Music Easel (the 208 Stored Program Sound Source and the 218 keyboard), one voice, its card the
// Easel's panel section by section (Allen Strange, "Programming and Metaprogramming in the Electro-Organism", the Easel's
// manual). The Easel's patch field (any control output into any control input by banana cords) does not fit the FM-1 as
// switchable routes; here it is a fixed patch: the sequencer into the complex oscillator's pitch, the envelope into the
// modulation index and both gate levels, the random voltage into the timbre, each through its processing control (`... proc`).
// Every other connection is the panel's own: the keyboard (through the portamento) into both oscillators by their keyboard
// switches; the trigger select switches choosing keyboard, pulser or sequencer triggers; the modulation
// switch; gate 2's source; the output mix.
// - Keyboard: `portamento` (a linear slew). The 218's arpeggiator is the patch's Arpeggiator (its own page, ARP). Its
//   preset voltage source and add to main switch are Canvas XL's only: they are played from touch plates the FM-1 has
//   not got, and their 210 bytes are what the players need to fit. Pressure is not patched.
// - Pulser: `trigger` (1 keyboard, 2 self, 3 sequencer), `mode` (1 triggered, 2 off, 3 once: once needs a button and does
//   nothing here), `period`. Its trigger comes at the end of the period: an Env L/R rises over the period (one shot) and a
//   Logic reads its end. Self mode retriggers it from its own end (128 samples later: the engines run in blocks). It
//   starts once a key has woken the voice (the engines leave a voice no key has played idle), then keeps itself running.
//   Its ramp output reaches nothing in the fixed patch, so it is Canvas XL's.
// - Sequential voltage source: `trigger` (1 keyboard, 2 pulser, 3 off), `stages` (1..3: 3, 4 or 5 stages), `voltage 1..5`
//   (0..1), `pulse 1..5` (the pulse sequence: a stage's trigger is sent unless its row is at -1). Two Sequencers on one
//   clock: the voltages, and the pulses (a step at -1 is a rest: no gate). `stages` sets both lengths through their pins.
// - Envelope generator: `trigger` (1 keyboard, 2 pulser, 3 sequencer), `mode` (1 sustained, 2 transient, 3 off),
//   `attack`, `sustain`, `decay`. An Env L/R: it rises over the attack (linear), holds for the sustain, then: sustained, it
//   holds while the trigger does; transient (one shot), it decays at once. Its decay is exponential (the Easel's is linear).
// - Random voltage: `trigger` (1 keyboard, 2 pulser, 3 sequencer): noise sampled by the trigger.
// - Modulation oscillator: `keyboard` (1 on, 2 off), `range` (1 -high, 2 +hi, 3 low: five octaves down; -high plays as
//   +hi: its reversed dial is not here), `frequency` (semitones), `fine tune` (a semitone either way: the Easel's spans
//   half an octave), `waveshape` (triangle, saw or square; the Oscillator's sine is not the Easel's), `modulation` (1 bal. ext: needs the preamp, silent here; 2 f.m. osc; 3 a.m. osc), `index`.
//   Frequency modulation is phase modulation; amplitude modulation multiplies the complex oscillator by 1 + index x mod osc.
// - Complex oscillator: `keyboard`, `polarity` (1 -, 2 +: the sign of the pitch processing), `pitch` (semitones), `fine
//   tune`, `timbre wave` (the timbre switch: triangle, saw or square), `timbre mix` (the timbre pot: sine to that
//   wave), `timbre` (the timbre offset: the wave folder's drive). One phase for both waves: two Oscillators on one pitch.
// - Dual lopass gate: per gate `mode` (1 lopass, 2 combination, 3 vca), `level` and its processing; gate 2's `source` (1
//   preamp: needs audio input, silent here; 2 mod osc; 3 gate 1). Each gate: a slew (the vactrol) into a 12 dB low pass (a
//   Ladder's) whose cutoff follows the level (20 Hz closed, 15 kHz open) and a VCA: lopass leaves the VCA open, vca the
//   filter.
// - Output: `chan a` (gate 1), `chan b` (gate 2, 180 degrees out of phase), `reverb` (our reverb, mono).
// Not here (the FM-1): the patch field and the inverter (Canvas XL's), the preamp / envelope detector (audio input); the
// trim pots. The switches are numbered: their names would cost about 280 of the 65 bytes left (#358's names are Canvas XL's).
asm('Canvas', 'Voices', (b) => {
  // ---- keyboard: MAIN = the keys through the portamento
  const part = b.add('alloc', 0, 0, { voices: 1 });
  const porta = b.add('glide', 1, 0, { time: 0.001, curve: 1 });
  b.wire(part, 'pitch', porta, 'in');
  // ---- pulser
  const pTrig = b.add('select', 2, 0, { count: 3, pos: 2 });
  const pMode = b.add('select', 2, 1, { count: 3, pos: 1 });
  const pEnv = b.add('env', 3, 0, { l1: 1, r1: 0.33, l2: 0, r2: 0.001, l3: 0, r3: 0.001, l4: 0, r4: 0.001, shot: 1 });
  const pEnd = b.add('logic', 3, 1, { thresh: 0.05 });
  b.wire(part, 'gate', pTrig, 'in1');
  b.wire(pEnd, 'not', pTrig, 'in2');
  b.wire(pTrig, 'out', pMode, 'in1');
  b.wire(pMode, 'out', pEnv, 'gate');
  b.wire(pEnv, 'env', pEnd, 'a');
  b.wire(pEnv, 'env', pEnd, 'b');
  // ---- sequential voltage source
  const sTrig = b.add('select', 5, 0, { count: 3, pos: 3 });
  const stages = b.add('select', 5, 1, { count: 3, pos: 3, v1: 0.3, v2: 0.443, v3: 0.586 });
  const seq = b.add('seq', 6, 0, { s1: 0, s2: 0.2, s3: 0.4, s4: 0.6, s5: 0.8, len: 1 }, { p1: 'len' });
  const seqP = b.add('seq', 6, 1, { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, len: 1 }, { p1: 'len' });
  b.wire(part, 'gate', sTrig, 'in1');
  b.wire(pEnd, 'not', sTrig, 'in2');
  for (const s of [seq, seqP]) {
    b.wire(sTrig, 'out', s, 'clock');
    b.wire(stages, 'out', s, 'p1');
  }
  // ---- envelope generator (the mode's gate 2 sets the one-shot pin: transient)
  const eTrig = b.add('select', 7, 0, { count: 3, pos: 1 });
  const eMode = b.add('select', 7, 1, { count: 3, pos: 2 });
  const env = b.add('env', 8, 0, { l1: 1, r1: 0.003, l2: 1, r2: 0.02, l3: 1, r3: 0.001, l4: 0, r4: 0.6, shot: 0 }, { p1: 'shot' });
  b.wire(part, 'gate', eTrig, 'in1');
  b.wire(pEnd, 'not', eTrig, 'in2');
  b.wire(seqP, 'gate', eTrig, 'in3');
  b.wire(eTrig, 'out', eMode, 'in1');
  b.wire(eTrig, 'out', eMode, 'in2');
  b.wire(eMode, 'out', env, 'gate');
  b.wire(eMode, 'g2', env, 'p1');
  // ---- random voltage
  const rTrig = b.add('select', 9, 0, { count: 3, pos: 2 });
  const nz = b.add('noise', 9, 1, { level: 1 });
  const rnd = b.add('sh', 10, 0, { mode: 0 });
  b.wire(part, 'gate', rTrig, 'in1');
  b.wire(pEnd, 'not', rTrig, 'in2');
  b.wire(seqP, 'gate', rTrig, 'in3');
  b.wire(nz, 'out', rnd, 'in');
  b.wire(rTrig, 'out', rnd, 'clock');
  // ---- modulation oscillator, and the modulation switch (gate 3: a.m., which moves the a.m. selector to its index)
  const mKbd = b.add('select', 11, 0, { count: 2, pos: 1 });
  const mRange = b.add('select', 11, 1, { count: 3, pos: 2, v1: 0, v2: 0, v3: -5 });
  const mosc = b.add('osc', 12, 0, { wave: 1, level: 1, coarse: 7 });
  const idx = b.add('scale', 12, 1, { gain: 1, offset: 0 }, { p1: 'gain', att: [0.25, 1] });
  const modSel = b.add('select', 13, 0, { count: 3, pos: 2 });
  const amDepth = b.add('math', 13, 1, { ka: 1, kb: 1, off: 0 });
  b.wire(porta, 'out', mKbd, 'in1');
  b.wire(mKbd, 'out', mosc, 'pitch');
  b.wire(mRange, 'out', mosc, 'pitch');
  b.wire(mosc, 'out', idx, 'in');
  b.wire(idx, 'out', modSel, 'in2');
  b.wire(idx, 'out', amDepth, 'a');
  b.wire(modSel, 'g3', amDepth, 'b');
  // ---- complex oscillator: the sine and the timbre switch's wave on one pitch, the timbre pot between them, the folder
  const cKbd = b.add('select', 14, 0, { count: 2, pos: 1 });
  const pPol = b.add('select', 14, 1, { count: 2, pos: 2, v1: -1, v2: 1 });
  const pProc = b.add('vca', 14, 2, { gain: 0 });
  const posc = b.add('osc', 15, 0, { wave: 0, level: 1, pm: 1.2 });
  const tw = b.add('osc', 15, 1, { wave: 2, level: 1, pm: 1.2 });
  const tMix = b.add('xfade', 16, 0, { mix: 0 });
  const fold = b.add('shape', 16, 1, { drive: 2.2, mode: 2, level: 1, stages: 2, sym: 0.1 }, { p1: 'drive' });
  const tProc = b.add('scale', 16, 2, { gain: 0, offset: 0 });
  const iProc = b.add('scale', 12, 2, { gain: 0, offset: 0 });
  const am = b.add('vca', 17, 0, { gain: 1 });
  b.wire(porta, 'out', cKbd, 'in1');
  b.wire(seq, 'out', pProc, 'in');
  b.wire(pPol, 'out', pProc, 'cv');
  for (const o of [posc, tw]) {
    b.wire(cKbd, 'out', o, 'pitch');
    b.wire(pProc, 'out', o, 'pitch');
    b.wire(modSel, 'out', o, 'pm');
  }
  b.wire(posc, 'out', tMix, 'a');
  b.wire(tw, 'out', tMix, 'b');
  b.wire(tMix, 'out', fold, 'in');
  b.wire(rnd, 'out', tProc, 'in');
  b.wire(tProc, 'out', fold, 'p1');
  b.wire(env, 'env', iProc, 'in');
  b.wire(iProc, 'out', idx, 'p1');
  b.wire(fold, 'out', am, 'in');
  b.wire(amDepth, 'mul', am, 'cv');
  // ---- dual lopass gate: per gate the level (offset + processing of the envelope) through the vactrol slew into a low
  // pass (20 Hz x 2^(9.6 x level)) and a VCA; the mode switch opens one or the other (lopass: the VCA open; vca: the filter)
  const gate = (col: number, ...inputs: [number, string][]) => {
    const lvl = b.add('scale', col, 2, { gain: 0.75, offset: 0 });
    const vac = b.add('glide', col, 3, { time: 0.04, curve: 0 });
    const cut = b.add('scale', col + 1, 3, { gain: 2.4, offset: 0 });
    const fSel = b.add('select', col + 1, 2, { count: 3, pos: 2, v3: 4 });
    const aSel = b.add('math', col + 2, 2, { ka: 1, kb: 1, off: 0 });
    const lpg = b.add('ladder', col + 2, 0, { cutoff: 20, res: 0.1, cvamt: 4 });
    const vca = b.add('vca', col + 3, 0, { gain: 1 });
    b.wire(env, 'env', lvl, 'in');
    b.wire(lvl, 'out', vac, 'in');
    b.wire(vac, 'out', cut, 'in');
    b.wire(cut, 'out', fSel, 'in1');
    b.wire(cut, 'out', fSel, 'in2');
    b.wire(fSel, 'out', lpg, 'cv');
    b.wire(vac, 'out', aSel, 'a');
    b.wire(fSel, 'g1', aSel, 'b');
    b.wire(aSel, 'max', vca, 'cv');
    for (const [m, port] of inputs) b.wire(m, port, lpg, 'in');
    b.wire(lpg, 'lp12', vca, 'in');
    return { lvl, fSel, vca };
  };
  const g1 = gate(18, [fold, 'out'], [am, 'out']);
  const src2 = b.add('select', 22, 4, { count: 3, pos: 3 });
  b.wire(mosc, 'out', src2, 'in2');
  b.wire(g1.vca, 'out', src2, 'in3');
  const g2 = gate(22, [src2, 'out']);
  b.module(g2.lvl).params.offset = 0;
  // ---- output: chan A, chan B (inverted: the gates are 180 degrees apart), the reverb
  const mix = b.add('math', 26, 0, { ka: 0.9, kb: 0, off: 0 });
  const rev = b.add('reverb', 27, 0, { size: 0.5, damp: 0.4, mix: 0.15, pre: 0, mod: 0.3 });
  const scope = b.add('scope', 28, 0, { time: 16 });
  b.wire(g1.vca, 'out', mix, 'a');
  b.wire(g2.vca, 'out', mix, 'b');
  b.wire(mix, 'sub', rev, 'in');
  b.wire(rev, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.output('out', rev, 'out');
  // ---- the card: the Easel's panel, left to right as the 208 lays it out, the 218 keyboard last
  b.param('trigger', sTrig, 'pos', { head: 'sequencer' });
  b.param('stages', stages, 'pos');
  for (const n of [1, 2, 3, 4, 5]) b.param(`voltage ${n}`, seq, `s${n}`);
  for (const n of [1, 2, 3, 4, 5]) b.param(`pulse ${n}`, seqP, `s${n}`);
  b.param('envelope', env, 'view', { col: true, head: 'envelope' });
  b.param('trigger', eTrig, 'pos');
  b.param('mode', eMode, 'pos');
  b.param('attack', env, 'r1');
  b.param('sustain', env, 'r2');
  b.param('decay', env, 'r4');
  b.param('trigger', pTrig, 'pos', { head: 'pulser' });
  b.param('mode', pMode, 'pos');
  b.param('period', pEnv, 'r1');
  b.param('trigger', rTrig, 'pos', { head: 'random' });
  b.param('keyboard', mKbd, 'pos', { col: true, head: 'mod osc' });
  b.param('range', mRange, 'pos');
  b.param('frequency', mosc, 'coarse');
  b.param('fine tune', mosc, 'fine');
  b.param('waveshape', mosc, 'wave', { group: true });
  b.param('modulation', modSel, 'pos');
  b.param('index', idx, 'gain');
  b.param('index proc', iProc, 'gain');
  b.param('keyboard', cKbd, 'pos', { col: true, head: 'complex osc' });
  b.param('polarity', pPol, 'pos');
  b.param('pitch', posc, 'coarse');
  b.param('fine tune', posc, 'fine');
  b.param('pitch proc', pProc, 'gain', { group: true });
  b.param('timbre wave', tw, 'wave');
  b.param('timbre mix', tMix, 'mix');
  b.param('timbre', fold, 'drive');
  b.param('timbre proc', tProc, 'gain');
  b.param('mode 1', g1.fSel, 'pos', { col: true, head: 'lopass gate' });
  b.param('level 1', g1.lvl, 'offset');
  b.param('level 1 proc', g1.lvl, 'gain');
  b.param('source 2', src2, 'pos', { group: true });
  b.param('mode 2', g2.fSel, 'pos');
  b.param('level 2', g2.lvl, 'offset');
  b.param('level 2 proc', g2.lvl, 'gain');
  b.param('chan a', mix, 'ka', { head: 'output' });
  b.param('chan b', mix, 'kb');
  b.param('reverb', rev, 'mix');
  b.param('portamento', porta, 'time', { col: true, head: 'keyboard' });
  b.param('out', scope, 'view');
});

// Wanderer, the ARP Odyssey (Rev 3: the 24 dB filter; ARP's Odyssey owner's manual 1976 and Korg's reissue manual),
// duophonic as the original: one Voicing of one voice on the lowest key held plays VCO 1, one on the highest plays VCO 2
// (one key plays both), and there is one filter, one high pass, one VCA, one ADSR and one AR. A one-sample notch in
// the held gate on every key press retriggers the envelopes, even for a middle key. Releases never retrigger.
// Each VCO is one Oscillator (its wave row is the audio mixer's saw / square switch; it also offers sine and triangle):
// the original has saw and pulse at once, which takes two per VCO and more patch bytes than the FM-1 holds (Wanderer XL
// has them). So the S/H mixer's VCO 1 source and VCO 2 square are the VCO as the mixer has it, and the ring and the sync
// take it through a comparator (a saw gives a 47.5 % pulse, without the pulse width). VCO 1's AUDIO / LF switch is a
// Selector: the keyboard, or 6 octaves down with the keys off (coarse then spans 0.26 to 65 Hz). The FM sliders are a
// Math per VCO (ka, kb: the two depths) after two source Selectors; PWM a source Selector and an Attenuverter into the
// width (once per block). SYNC: VCO 1 into VCO 2's sync, or nothing. The ring modulator is digital as on the original:
// the two VCOs' positive halves XORed (a Logic), at half the level of a VCO. The LFO is a sine; a Logic on it gives the
// square (0 / 1, `not`) and the square while a key is held (`and`, KYBD REPEAT). S/H mixer: a Math (the two levels), a
// source Selector (noise / VCO 2); the S&H, its trigger Selector (LFO / keyboard) and OUTPUT LAG (a Slew limiter). VCF:
// three modulation Selectors summed by a Mixer into the Ladder (4 octaves at full). VCA: AR / ADSR, its level and GAIN
// (an Attenuverter's gain and offset). The envelopes' triggers: the keyboard gate, or the LFO repeat (while a key is
// held, or always). Portamento: a Macro sets both Slew limiters' time (linear, per octave). The PPC's vibrato pad:
// Main's mod wheel scales the LFO sine into both VCOs. Not here: the external audio input (#351), the pedal and CV /
// gate / trigger jacks, the portamento footswitch (hardware). The bend is Main's (+-2 semitones), the transpose the
// FM-1's OCT buttons. Row names are short to leave patch bytes for the switches' position names (#358).
asm('Wanderer', 'Voices', (b) => {
  // ---- the keys: lowest -> VCO 1, highest -> VCO 2; portamento
  const lo = b.add('alloc', 0, 0, { voices: 1, priority: 1, legato: 2 });
  const hi = b.add('alloc', 0, 1, { voices: 1, priority: 2, legato: 2 });
  const gate = b.add('math', 0, 2); // held gate minus one-sample key press: retrigger only on presses
  const porta = b.add('macro', 0, 3, { value: 0 });
  const g1 = b.add('glide', 1, 0, { time: 0.001, curve: 1 }, { p1: 'time' });
  const g2 = b.add('glide', 1, 1, { time: 0.001, curve: 1 }, { p1: 'time' });
  const vib = b.add('vca', 1, 3, { gain: 0.05 });
  // ---- LFO (sine) and its square (0 / 1)
  const lfo = b.add('lfo', 0, 4, { wave: 0, rate: 6, depth: 1 });
  // ---- VCO 1
  const lf = b.add('select', 2, 0, { count: 2, pos: 1, v1: 0, v2: -6 });
  const fa1 = b.add('select', 2, 1, { count: 2, pos: 1 });
  const fb1 = b.add('select', 2, 2, { count: 2, pos: 1 });
  const fm1 = b.add('math', 2, 3, { ka: 0, kb: 0, off: 0 });
  const pws1 = b.add('select', 2, 4, { count: 2, pos: 1 });
  const pwm1 = b.add('scale', 2, 5, { gain: 0, offset: 0 });
  const o1 = b.add('osc', 3, 0, { wave: 2, level: 1, pw: 0.5 }, { p1: 'pw' });
  // ---- VCO 2
  const fa2 = b.add('select', 4, 1, { count: 2, pos: 1 });
  const fb2 = b.add('select', 4, 2, { count: 2, pos: 1 });
  const fm2 = b.add('math', 4, 3, { ka: 0, kb: 0, off: 0 });
  const pws2 = b.add('select', 4, 4, { count: 2, pos: 1 });
  const pwm2 = b.add('scale', 4, 5, { gain: 0, offset: 0 });
  const sync = b.add('select', 3, 2, { count: 2, pos: 1 });
  const o2 = b.add('osc', 5, 0, { wave: 3, level: 1, pw: 0.35, coarse: 12, fine: 4 }, { p1: 'pw' });
  // ---- sample and hold
  const nz = b.add('noise', 3, 3, { level: 1, color: 0 });
  const sh2 = b.add('select', 3, 5, { count: 2, pos: 1 });
  const shMix = b.add('math', 3, 6, { ka: 0, kb: 1, off: 0 });
  const shTrig = b.add('select', 4, 6, { count: 2, pos: 1 });
  const sh = b.add('sh', 5, 6, { mode: 0 });
  const lag = b.add('glide', 6, 6, { time: 0.001, curve: 0 });
  // ---- audio mixer
  const ring = b.add('logic', 6, 2, { thresh: 0.05 });
  const nr = b.add('select', 6, 3, { count: 2, pos: 1, v2: -0.5 });
  const mix = b.add('mixer', 7, 0, { l1: 0.45, l2: 0.35, l3: 0, l4: 0 });
  // ---- VCF, HPF, VCA
  const m1 = b.add('select', 7, 2, { count: 2, pos: 1 });
  const m2 = b.add('select', 7, 3, { count: 2, pos: 1 });
  const m3 = b.add('select', 7, 4, { count: 2, pos: 1 });
  const fmix = b.add('mixer', 8, 2, { l1: 0.25, l2: 0, l3: 0.6, l4: 0 });
  const flt = b.add('ladder', 8, 0, { cutoff: 900, res: 0.4, cvamt: 4, track: 0 });
  const hpf = b.add('filter', 9, 0, { cutoff: 40, res: 0 });
  const vcaSel = b.add('select', 9, 2, { count: 2, pos: 1 });
  const vcaAmt = b.add('scale', 9, 3, { gain: 1, offset: 0 });
  const vca = b.add('vca', 10, 0, { gain: 1 });
  // ---- envelopes and their triggers
  const adsr = b.add('adsr', 8, 4, { a: 0.005, d: 0.4, s: 0.4, r: 0.3 });
  const ar = b.add('adsr', 8, 5, { a: 0.004, d: 0.1, s: 1, r: 0.25 });
  const sq = b.add('logic', 1, 4, { thresh: 0.05 }); // a: the LFO's positive half; not: the square (0 / 1); and: KYBD REPEAT
  const rep = b.add('select', 6, 4, { count: 2, pos: 1 });
  const adsrT = b.add('select', 7, 5, { count: 2, pos: 1 });
  const arT = b.add('select', 7, 6, { count: 2, pos: 1 });
  const scope = b.add('scope', 11, 0, { time: 16 });

  // keys, gate, portamento, vibrato
  b.wire(lo, 'gate', gate, 'a');
  b.wire(lo, 'trig', gate, 'b');
  b.wire(lo, 'pitch', g1, 'in');
  b.wire(hi, 'pitch', g2, 'in');
  b.wire(porta, 'out', g1, 'p1');
  b.wire(porta, 'out', g2, 'p1');
  b.wire(lfo, 'out', vib, 'in');
  // VCO 1 pitch: the keys (or LF), fine, coarse and FM, vibrato
  b.wire(g1, 'out', lf, 'in1');
  b.wire(lfo, 'out', fa1, 'in1');
  b.wire(sq, 'not', fa1, 'in2');
  b.wire(lag, 'out', fb1, 'in1');
  b.wire(adsr, 'env', fb1, 'in2');
  b.wire(fa1, 'out', fm1, 'a');
  b.wire(fb1, 'out', fm1, 'b');
  for (const s of [lf, vib]) b.wire(s, 'out', o1, 'pitch');
  b.wire(fm1, 'add', o1, 'pitch');
  b.wire(lfo, 'out', pws1, 'in1');
  b.wire(adsr, 'env', pws1, 'in2');
  b.wire(pws1, 'out', pwm1, 'in');
  b.wire(pwm1, 'out', o1, 'p1');
  // VCO 2 pitch, sync
  b.wire(lfo, 'out', fa2, 'in1');
  b.wire(shMix, 'add', fa2, 'in2');
  b.wire(lag, 'out', fb2, 'in1');
  b.wire(adsr, 'env', fb2, 'in2');
  b.wire(fa2, 'out', fm2, 'a');
  b.wire(fb2, 'out', fm2, 'b');
  for (const s of [g2, vib]) b.wire(s, 'out', o2, 'pitch');
  b.wire(fm2, 'add', o2, 'pitch');
  b.wire(lfo, 'out', pws2, 'in1');
  b.wire(adsr, 'env', pws2, 'in2');
  b.wire(pws2, 'out', pwm2, 'in');
  b.wire(pwm2, 'out', o2, 'p1');
  b.wire(o1, 'out', sync, 'in2');
  b.wire(sync, 'out', o2, 'sync');
  // sample and hold
  b.wire(nz, 'out', sh2, 'in1');
  b.wire(o2, 'out', sh2, 'in2');
  b.wire(o1, 'out', shMix, 'a');
  b.wire(sh2, 'out', shMix, 'b');
  b.wire(shMix, 'add', sh, 'in');
  b.wire(sq, 'not', shTrig, 'in1');
  b.wire(gate, 'sub', shTrig, 'in2');
  b.wire(shTrig, 'out', sh, 'clock');
  b.wire(sh, 'out', lag, 'in');
  // audio mixer
  b.wire(o1, 'out', ring, 'a');
  b.wire(o2, 'out', ring, 'b');
  b.wire(nz, 'out', nr, 'in1');
  b.wire(ring, 'xor', nr, 'in2');
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(nr, 'out', mix, 'in3');
  // VCF, HPF, VCA
  b.wire(mix, 'out', flt, 'in');
  b.wire(g1, 'out', m1, 'in1');
  b.wire(shMix, 'add', m1, 'in2');
  b.wire(lag, 'out', m2, 'in1');
  b.wire(lfo, 'out', m2, 'in2');
  b.wire(adsr, 'env', m3, 'in1');
  b.wire(ar, 'env', m3, 'in2');
  b.wire(m1, 'out', fmix, 'in1');
  b.wire(m2, 'out', fmix, 'in2');
  b.wire(m3, 'out', fmix, 'in3');
  b.wire(fmix, 'out', flt, 'cv');
  b.wire(flt, 'lp24', hpf, 'in');
  b.wire(hpf, 'hp', vca, 'in');
  b.wire(ar, 'env', vcaSel, 'in1');
  b.wire(adsr, 'env', vcaSel, 'in2');
  b.wire(vcaSel, 'out', vcaAmt, 'in');
  b.wire(vcaAmt, 'out', vca, 'cv');
  b.wire(vca, 'out', scope, 'a');
  // envelope triggers: the keyboard gate, or the LFO repeat (KYBD REPEAT: while a key is held; AUTO REPEAT: always)
  b.wire(lfo, 'out', sq, 'a');
  b.wire(gate, 'sub', sq, 'b');
  b.wire(sq, 'and', rep, 'in1');
  b.wire(sq, 'not', rep, 'in2');
  for (const t of [adsrT, arT]) {
    b.wire(gate, 'sub', t, 'in1');
    b.wire(rep, 'out', t, 'in2');
  }
  b.wire(adsrT, 'out', adsr, 'gate');
  b.wire(arT, 'out', ar, 'gate');

  b.input('keys', lo, 'keys', [hi, 'keys']);
  b.input('wheel', vib, 'cv');
  b.output('out', vca, 'out');
  // the card, after the panel: VCO 1, VCO 2, LFO and S/H, the mixer, VCF / HPF / VCA, the envelopes
  b.param('kybd', lf, 'pos', { head: 'vco 1' });
  b.param('coarse', o1, 'coarse');
  b.param('fine', o1, 'fine');
  b.param('fm 1', fm1, 'ka');
  b.param('fm 1 src', fa1, 'pos');
  b.param('fm 2', fm1, 'kb');
  b.param('fm 2 src', fb1, 'pos');
  b.param('pulse width', o1, 'pw');
  b.param('pwm', pwm1, 'gain');
  b.param('pwm src', pws1, 'pos');
  b.param('coarse', o2, 'coarse', { col: true, head: 'vco 2' });
  b.param('fine', o2, 'fine');
  b.param('sync', sync, 'pos');
  b.param('fm 1', fm2, 'ka');
  b.param('fm 1 src', fa2, 'pos');
  b.param('fm 2', fm2, 'kb');
  b.param('fm 2 src', fb2, 'pos');
  b.param('pulse width', o2, 'pw');
  b.param('pwm', pwm2, 'gain');
  b.param('pwm src', pws2, 'pos');
  b.param('lfo freq', lfo, 'rate', { col: true, head: 'lfo · s/h' });
  b.param('s/h 1', shMix, 'ka');
  b.param('s/h 2', shMix, 'kb');
  b.param('s/h 2 src', sh2, 'pos');
  b.param('s/h trig', shTrig, 'pos');
  b.param('output lag', lag, 'time');
  b.param('portamento', porta, 'value');
  b.param('vco 1', mix, 'l1', { col: true, head: 'mixer' });
  b.param('vco 1 wave', o1, 'wave');
  b.param('vco 2', mix, 'l2');
  b.param('vco 2 wave', o2, 'wave');
  b.param('noise/ring', mix, 'l3');
  b.param('n/r src', nr, 'pos');
  b.param('noise', nz, 'color');
  b.param('vcf freq', flt, 'cutoff', { col: true, head: 'filters · vca' });
  b.param('resonance', flt, 'res');
  b.param('mod 1', fmix, 'l1');
  b.param('mod 1 src', m1, 'pos');
  b.param('mod 2', fmix, 'l2');
  b.param('mod 2 src', m2, 'pos');
  b.param('mod 3', fmix, 'l3');
  b.param('mod 3 src', m3, 'pos');
  b.param('hpf', hpf, 'cutoff');
  b.param('vca eg', vcaSel, 'pos');
  b.param('vca level', vcaAmt, 'gain');
  b.param('gain', vcaAmt, 'offset');
  b.param('ar', ar, 'view', { col: true, head: 'envelopes' });
  b.param('attack', ar, 'a');
  b.param('release', ar, 'r');
  b.param('ar trig', arT, 'pos');
  b.param('adsr', adsr, 'view');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, adsr, q);
  b.param('adsr trig', adsrT, 'pos');
  b.param('repeat', rep, 'pos');
  b.param('out', scope, 'view');
});
/** the Odyssey's switch positions (#358), on the rows of that label (the nth of them). All 18 fit the FM-1's patch bytes
 * with the Arpeggiator alone: the PATTERN track does not fit beside them (D-336's fallback) */
const WANDERER_SWITCHES: [string, number, string[]][] = [
  ['kybd', 0, ['audio', 'lf']], ['sync', 0, ['off', 'on']], ['fm 1 src', 0, ['sine', 'square']], ['fm 2 src', 0, ['s/h', 'adsr']],
  ['pwm src', 0, ['lfo', 'adsr']], ['fm 1 src', 1, ['sine', 's/h mix']], ['fm 2 src', 1, ['s/h', 'adsr']], ['pwm src', 1, ['lfo', 'adsr']],
  ['s/h 2 src', 0, ['noise', 'vco 2']], ['s/h trig', 0, ['lfo', 'kybd']], ['n/r src', 0, ['noise', 'ring']],
  ['mod 1 src', 0, ['kybd', 's/h mix']], ['mod 2 src', 0, ['s/h', 'lfo']], ['mod 3 src', 0, ['adsr', 'ar']], ['vca eg', 0, ['ar', 'adsr']],
  ['ar trig', 0, ['kybd', 'lfo']], ['adsr trig', 0, ['kybd', 'lfo']], ['repeat', 0, ['kybd', 'auto']],
];
{
  const d = defs.find((x) => x.name === 'Wanderer')!;
  for (const [label, nth, names] of WANDERER_SWITCHES) {
    const r = d.params.filter((q) => q.label === label)[nth];
    if (!r) throw new Error(`Wanderer: no row ${label}`);
    r.names = names;
  }
}

// Briefcase 3, after the EMS VCS3 (VCS3 Users Manual, EMS London) played from a keyboard, one voice; its card the VCS3's
// panel, its "matrix" card the control half of the VCS3's 16 x 16 pin matrix. The matrix: every source is a row (1 osc 1
// sine, 2 osc 1 ramp, 3 osc 2 square, 4 osc 2 triangle, 5 osc 3 square, 6 osc 3 triangle, 7 noise, 8 input amp 1, 9 input
// amp 2, 10 filter, 11 trapezoid, 12 envelope signal, 13 ring mod, 14 reverb, 15 joystick X, 16 joystick Y) and every
// input a column; a pin is named column then row, as the manual does ("I8", "N6"). Here columns I to P (the controls: I, J,
// K oscillator 1, 2, 3 frequency, L envelope decay, M reverb mix, N filter frequency, O, P output 1, 2 level) are Mixers,
// four sources each, one level per pin (0 out, 1 in; between, an attenuated pin). The signal columns (A meter, B, C the
// output amplifiers, D the envelope shaper's input, E, F the ring modulator's, G the reverb's, H the filter's) are fixed
// cables, the classic patch: oscillators 1 (both), 2 (square), the ring modulator and the noise into the filter (H1, H2,
// H3, H7, H13), the filter into the envelope shaper (D10), its signal into the reverb (G12), the reverb into both outputs
// (B14, C14); the ring modulator multiplies oscillator 1's ramp by oscillator 2's square (E2, F3). Briefcase 3 XL has all
// 256 pins. The pins are not on the FM-1's card: 120 rows would take about 1,260 of its 3,840 bytes; set them in the
// editor's matrix card.
// - The keyboard reaches the matrix as the VCS3 has it: through input amplifier 1 (row 8: the keys' pitch times its level,
//   0.25 by default, so pins I8 and J8 at 1 track the keys an octave per octave). Its gate fires the envelope shaper (the
//   ATTACK button). Input amplifier 2 (row 9) needs audio input: it has no row here.
// - Columns I, J, K move their oscillators by 4, 4 and 5 octaves for a source at full swing (the manual: 0.32 and 0.26 V
//   per octave against sources of about 1.5 V: 4.7 and 5.8). Their Attenuverters' offsets are the frequency dials: 8 octaves
//   each, around middle C (1 and 2: 16 Hz to 4.2 kHz) and 4 octaves below it (3: 1 Hz to 262 Hz); the VCS3's dials reach 1
//   Hz to 10 kHz and 0.025 to 500 Hz, the rest by control voltages, as its manual says they can be extended.
// - Column N moves the filter 4 octaves for a source at full swing (the Ladder's most; the manual's 0.2 V per octave would
//   be 7.5). Column L moves the decay time by 0.28 of its range (about 3.7 octaves: 0.4 V per octave), column M the reverb
//   mix by 0.375 (-2 V none, +2 V all). Columns O and P lower the output levels as a source rises (the manual: the
//   trapezoid's attack fades the output amplifier, while on a frequency it glides up).
// - Oscillator 2 and 3's shape is the square's width; it does not turn their triangle into a ramp (a triangle with a
//   symmetry control is missing). Oscillator 1's shape (the sine bent either way) is missing too.
// - The envelope shaper: an Env L/R that rises for `attack`, holds for `on` and then while the key is held, then falls for
//   `decay` (the manual's manual mode, with the keys as the ATTACK button; its decay reaches 10 s of the VCS3's 15). Its
//   automatic repeat (`off`) is missing: Env L/R does not loop. `signal` is the level of the shaped signal (row 12),
//   `trapezoid` the level of the trapezoid (row 11), which rests at minus its level and rises to plus it while on.
// - The filter: a Ladder (24 dB per octave; the VCS3's is 18), `response` its resonance (it oscillates near the top).
// - Each output amplifier: its level (the knob plus column O or P) on a VCA, and its filter (`filter 1`, `filter 2`: a
//   low pass turning into a high pass, where the VCS3's cuts treble or bass with a flat centre). Output 1 is the left
//   channel, 2 the right: the VCS3's speaker and headphone outputs, which do not pan; the pan knobs (for its line
//   outputs) are Briefcase 3 XL's. A level pulled below zero by a control comes back inverted (the VCS3's stops at silence).
// - The joystick: `x` and `y` are its position (rows 15, 16); its two range knobs are Briefcase 3 XL's (bytes).
asm('Briefcase 3', 'Voices', (b) => {
  const part = b.add('alloc', 0, 3, { voices: 1 });
  // ---- the oscillators: each output its own Oscillator on its column's pitch (one phase: the same pitch, the same start)
  const o1s = b.add('osc', 1, 0, { wave: 0, level: 0.6 });
  const o1r = b.add('osc', 1, 1, { wave: 2, level: 0.5 });
  const o2s = b.add('osc', 1, 2, { wave: 3, level: 0.35, pw: 0.5 });
  const o2t = b.add('osc', 1, 3, { wave: 1, level: 0 });
  const o3s = b.add('osc', 1, 4, { wave: 3, level: 0, pw: 0.5, coarse: -48 });
  const o3t = b.add('osc', 1, 5, { wave: 1, level: 1, coarse: -48 });
  const fI = b.add('scale', 0, 0, { gain: 4, offset: 0 });
  const fJ = b.add('scale', 0, 1, { gain: 4, offset: 0.59 });
  const fK = b.add('scale', 0, 2, { gain: 5, offset: -4 });
  for (const [f, oscs] of [[fI, [o1s, o1r]], [fJ, [o2s, o2t]], [fK, [o3s, o3t]]] as const) for (const o of oscs) b.wire(f, 'out', o, 'pitch');
  const nz = b.add('noise', 2, 2, { level: 0, color: 0 });
  const in1 = b.add('scale', 0, 4, { gain: 0.25, offset: 0 });
  b.wire(part, 'pitch', in1, 'in');
  const ring = b.add('vca', 2, 1, { gain: 0.3 });
  b.wire(o1r, 'out', ring, 'in');
  b.wire(o2s, 'out', ring, 'cv');
  const flt = b.add('ladder', 2, 0, { cutoff: 2140, res: 0.55, cvamt: 4, track: 0 });
  for (const s of [o1s, o1r, o2s, ring, nz]) b.wire(s, 'out', flt, 'in');
  const fLvl = b.add('mixer', 3, 0, { l1: 1, l2: 0, l3: 0, l4: 0 });
  b.wire(flt, 'lp24', fLvl, 'in1');
  // ---- the envelope shaper: decay is column L's (a pin on r4)
  const env = b.add('env', 3, 1, { l1: 1, r1: 0.02, l2: 1, r2: 0.6, l3: 1, r3: 0.001, l4: 0, r4: 1.4 }, { p1: 'r4', att: [0.28, 1] });
  b.wire(part, 'gate', env, 'gate');
  const sig = b.add('vca', 3, 2, { gain: 1.8 });
  b.wire(fLvl, 'out', sig, 'in');
  b.wire(env, 'env', sig, 'cv');
  const trap = b.add('scale', 4, 1, { gain: 2, offset: -1 });
  b.wire(env, 'env', trap, 'in');
  const trapL = b.add('mixer', 4, 2, { l1: 1, l2: 0, l3: 0, l4: 0 });
  b.wire(trap, 'out', trapL, 'in1');
  // ---- the reverb: mix is column M's (a pin)
  const rev = b.add('reverb', 5, 0, { size: 0.45, damp: 0.25, mix: 0.25, pre: 0, mod: 0.6 }, { p1: 'mix', att: [0.375, 1] });
  b.wire(sig, 'out', rev, 'in');
  const revL = b.add('mixer', 5, 1, { l1: 1, l2: 0, l3: 0, l4: 0 });
  b.wire(rev, 'out', revL, 'in1');
  // ---- the joystick
  const jx = b.add('const', 4, 3, { value: 0 });
  const jy = b.add('const', 4, 4, { value: 0 });
  // ---- the output amplifiers: the level knob plus its column (inverted), a VCA, the output filter
  const amp = (k: number) => {
    const lvl = b.add('scale', 6, k, { gain: -1, offset: 0.7 });
    const vca = b.add('vca', 7, k, { gain: 1 });
    const tone = b.add('filter', 8, k, { cutoff: 1500, res: 0, morph: 0.15 });
    b.wire(lvl, 'out', vca, 'cv');
    b.wire(revL, 'out', vca, 'in');
    b.wire(vca, 'out', tone, 'in');
    return { lvl, tone };
  };
  const out1 = amp(0), out2 = amp(1);
  const scope = b.add('scope', 9, 0, { time: 16 });
  b.wire(out1.tone, 'mix', scope, 'a');
  b.input('keys', part, 'keys');
  b.output('l', out1.tone, 'mix');
  b.output('r', out2.tone, 'mix');
  // ---- the card: the panel
  b.param('frequency', fI, 'offset', { head: 'osc 1' });
  b.param('sine', o1s, 'level');
  b.param('ramp', o1r, 'level');
  b.param('frequency', fJ, 'offset', { head: 'osc 2' });
  b.param('shape', o2s, 'pw');
  b.param('square', o2s, 'level');
  b.param('triangle', o2t, 'level');
  b.param('frequency', fK, 'offset', { head: 'osc 3' });
  b.param('shape', o3s, 'pw');
  b.param('square', o3s, 'level');
  b.param('triangle', o3t, 'level');
  b.param('colour', nz, 'color', { col: true, head: 'noise' });
  b.param('level', nz, 'level');
  b.param('input 1', in1, 'gain');
  b.param('ring mod', ring, 'gain');
  b.param('frequency', flt, 'cutoff', { head: 'filter' });
  b.param('response', flt, 'res');
  b.param('level', fLvl, 'l1');
  b.param('envelope', env, 'view', { col: true, head: 'envelope' });
  b.param('attack', env, 'r1');
  b.param('on', env, 'r2');
  b.param('decay', env, 'r4');
  b.param('signal', sig, 'gain');
  b.param('trapezoid', trapL, 'l1');
  b.param('mix', rev, 'mix', { head: 'reverb' });
  b.param('level', revL, 'l1');
  b.param('filter 1', out1.tone, 'morph', { col: true, head: 'output' });
  b.param('level 1', out1.lvl, 'offset');
  b.param('filter 2', out2.tone, 'morph');
  b.param('level 2', out2.lvl, 'offset');
  b.param('x', jx, 'value', { head: 'joystick' });
  b.param('y', jy, 'value');
  b.param('out', scope, 'view');
  // ---- the matrix's control columns: per column four Mixers (rows 1-8, 10-16: row 9 has no source here), on the matrix card
  const rows: [number, string, string][] = [
    [o1s, 'out', 'osc 1 sine'], [o1r, 'out', 'osc 1 ramp'], [o2s, 'out', 'osc 2 square'], [o2t, 'out', 'osc 2 triangle'],
    [o3s, 'out', 'osc 3 square'], [o3t, 'out', 'osc 3 triangle'], [nz, 'out', 'noise'], [in1, 'out', 'input 1'], [0, '', 'input 2'],
    [fLvl, 'out', 'filter'], [trapL, 'out', 'trapezoid'], [sig, 'out', 'env signal'], [ring, 'out', 'ring mod'], [revL, 'out', 'reverb'],
    [jx, 'out', 'stick x'], [jy, 'out', 'stick y'],
  ];
  const cols: [string, number, string][] = [['I', fI, 'in'], ['J', fJ, 'in'], ['K', fK, 'in'], ['L', env, 'p1'], ['M', rev, 'p1'], ['N', flt, 'cv'], ['O', out1.lvl, 'in'], ['P', out2.lvl, 'in']];
  /** the classic patch's pins: the keys into oscillators 1 and 2 and the filter, oscillator 3 into oscillator 1 and the
   * filter, the trapezoid into the filter */
  const PINS: Record<string, number> = { I8: 1, J8: 1, I6: 0.03, N8: 1, N6: 0.125, N11: 0.3125 };
  const live = rows.map((r, i) => [r, i + 1] as const).filter(([r]) => r[0]);
  const mixers: number[] = [];
  const pins: [string, number, string][] = [];
  cols.forEach(([c, dst, port], ci) => {
    for (let k = 0; k < live.length; k += 4) {
      const mx = b.add('mixer', 10 + ci, k / 4, { l1: 0, l2: 0, l3: 0, l4: 0 });
      mixers.push(mx);
      b.wire(mx, 'out', dst, port);
      live.slice(k, k + 4).forEach(([[m, from, name], n], j) => {
        b.wire(m, from, mx, `in${j + 1}`);
        b.module(mx).params[`l${j + 1}`] = PINS[`${c}${n}`] ?? 0;
        pins.push([`${c}${n} ${name}`, mx, `l${j + 1}`]);
      });
    }
  });
  b.nest('matrix', 10, 5, mixers);
  for (const [label, mx, l] of pins) b.nestParam(label, mx, l);
});

// Io 4, a four-voice polysynth after the Roland Jupiter-4, from its owner's manual ("JP-4 OWNER'S MANUAL '82 AUG.": the
// panel drawings, the functions of the components and the specifications). The card is the JP-4's panel, one row per
// slider, knob or switch, under its section names; a switch is a Selector row whose positions carry the panel's legends
// (the specifications' names: 16' 8' 4', 50% .. 10%, NORM / WIDE, LFO / OFF / BEND, NORMAL / 1 OCT DOWN, OFF / ON).
// A voice (four, as the JP-4's four modules): the VCO (WAVE FORM: 1 OFF, 2 SAW, 3 SQUARE, 4 PULSE; RANGE 1 16', 2 8',
// 3 4'; SUB, a square one octave down, 1 off, 2 on; MOD, the LFO into the pitch), the pulse width (PW 1..4 = 50, 40, 20,
// 10 %; PW MODE 1 MANUAL: that width, 2 MOD: the LFO swings the width from 50 % down to it), NOISE (1 off, 2 on) into the
// resonant 24 dB low pass (a ladder: LPF CUTOFF, RES; KYBD FOLLOW 1..4 = 10, 40, 70, 100 %; MOD, the LFO; ENV MOD and
// POLARITY 1 normal, 2 inverted, of the VCF's own ADSR), then the VCA with its own ADSR and LEVEL. The manual's
// specifications list two envelope generators, "for the VCF, VCA", and its panel drawing shows an A D S R set in each
// section. Once for all voices: the LFO (WAVE FORM 1 sine, 2 square, 3 saw, 4 reverse saw; RATE on the LFO's wide range,
// 0.0008 to 55 Hz, where the JP-4's specifications give 0.1 to 80 Hz: the LFO goes no higher), the non-resonant HPF
// (after the voices: one cutoff for all, so the same filter), the ensemble (our chorus, 1 off, 2 on).
// The modifier section: TRIGGER (RATE clocks the noise sample & hold into the cutoffs, VCF MOD its depth, and the
// arpeggio: the `arp clock` output, which the factory patch plugs into its Arpeggiator); DELAY / BEND (DELAY TIME, the
// LFO's fade-in after a key from no key held; LFO BEND offsets the LFO rate, NORM / WIDE its reach, 1 normal 1 octave,
// 2 wide 4 octaves: the manual gives no figures); the lever: the FM-1's pitch bend is the lever's BEND, its mod wheel the
// lever's LFO depth, LFO MOD (the depth at full wheel) and BEND SENS (the reach: VCO 1 octave, VCF 2 octaves, VCA about
// one unit of gain), with the three switches 1 LFO, 2 OFF, 3 BEND for VCO, VCF and VCA (the part's own 2-semitone bend is
// taken back out of the keys); PORTAMENTO (time; switch 1 off, 2 on: a slew per voice, each voice gliding from its own last
// note); TRANSPOSE (1 normal, 2 one octave down); TUNING (+-50 cents: 0.04 octave). The KEY ASSIGNMENT MODE is two rows
// of the Voice allocator: `assign` rotate is POLY I, lowest POLY II; `unison` on is UNISON I (all four voices on the
// lowest key held); SHARE is UNISON II (four voices on one key, two each on two keys, one each on three or four).
// HOLD (1 off, 2 on): a voice whose key is let go keeps its gate while its VCA envelope still sounds.
// The combined four-position assignment control still uses separate assign/unison rows. EXT CLOCK, the VCF CONT, EXP and DAMPER pedals, the memories and VOLUME
// (the patch's level) are hardware or storage. The LFO's rate reaches 55 Hz (the JP-4's 80 Hz).
import { BEND_OCT } from '../src/modules';
/** Io 4 and Vernon 100 have many small modules: lay them all out on the grid in the order they were added, eight a row */
const gridAll = (b: B): void => {
  for (let id = 1; ; id++) {
    let m: ModuleInst;
    try {
      m = b.module(id);
    } catch {
      return;
    }
    m.x = ((id - 1) % 8) * GX;
    m.y = Math.floor((id - 1) / 8) * GY;
  }
};
asm('Io 4', 'Voices', (b) => {
  // ---- the keys
  const part = b.add('alloc', 1, 4, { voices: 4, assign: 0, priority: 1, unison: 0 });
  const held = b.add('alloc', 0, 4, { voices: 1, legato: 2 }); // high while any key is held: the LFO delay's gate
  const transSel = b.add('select', 0, 5, { count: 2, pos: 1, v1: 0, v2: -1 });
  const keyOffs = b.add('math', 0.5, 5, { ka: -BEND_OCT, kb: 1, off: 0 }); // the bend taken back out, plus the transpose
  b.wire(transSel, 'out', keyOffs, 'b');
  const portaSel = b.add('select', 0, 6, { count: 2, pos: 1, v1: -1, v2: 0 }); // 1 off: the slew's time at its 1 ms floor
  const holdSel = b.add('select', 0, 6.5, { count: 2, pos: 1, v1: -4, v2: 0.4999 });
  // ---- the LFO: wave (the reverse saw is the saw times -1), rate and its bend, the delay
  // RATE: the fast range, the rate row x 2, 0.04 .. 80 Hz (the JP-4's top is 80 Hz; the card and the FM-1 show the rate it runs at)
  const lfo = b.add('lfo', 0, 0, { wave: 0, range: 2, rate: 2.25, depth: 1 }, { p1: 'rate', p2: 'wave' });
  const lfoWave = b.add('select', 0, 0.5, { count: 4, pos: 1, v1: 0, v2: 0.75, v3: 0.5, v4: 0.5 }); // x 4: wave 0 3 2 2
  b.wire(lfoWave, 'out', lfo, 'p2');
  const lfoSig = b.add('math', 0.5, 0.5, { ka: -2, kb: 1, off: 1 }); // (1 - 2 x rev saw) x the LFO
  b.wire(lfoWave, 'g4', lfoSig, 'a');
  b.wire(lfo, 'out', lfoSig, 'b');
  const bendSel = b.add('select', 0, 1, { count: 2, pos: 1, v1: 1 / Math.log2(40 / 0.02), v2: 4 / Math.log2(40 / 0.02) }); // octaves of the rate's span
  const lfoBend = b.add('scale', 0.5, 1, { gain: 0, offset: 0 }); // LFO BEND: -1 .. 1 the reach down or up
  b.wire(bendSel, 'out', lfoBend, 'in');
  b.wire(lfoBend, 'out', lfo, 'p1');
  const delayEnv = b.add('adsr', 0, 1.5, { a: 0.001, d: 0.001, s: 1, r: 8 });
  b.wire(held, 'gate', delayEnv, 'gate');
  const delayed = b.add('vca', 0.5, 1.5, { gain: 1 });
  b.wire(lfoSig, 'mul', delayed, 'in');
  b.wire(delayEnv, 'env', delayed, 'cv');
  const vib = b.add('scale', 0, 2, { gain: 0, offset: 0 });
  b.wire(delayed, 'out', vib, 'in');
  const lflt = b.add('scale', 0.5, 2, { gain: 0, offset: 0 });
  b.wire(delayed, 'out', lflt, 'in');
  // ---- the VCO's switches, once for all voices
  const waveSel = b.add('select', 1, 0, { count: 4, pos: 4, v1: 0, v2: 1, v3: 1, v4: 1 }); // the oscillator's level: 0 on OFF
  const pwStep = b.add('select', 1, 0.5, { count: 4, pos: 2, v1: 0, v2: 0.1 / 0.9, v3: 0.3 / 0.9, v4: 0.4 / 0.9 });
  const pwMode = b.add('select', 1, 1, { count: 2, pos: 2, v1: 1, v2: 0 }); // MANUAL: 1, MOD: the LFO
  b.wire(delayed, 'out', pwMode, 'in2');
  const pwDepth = b.add('math', 1.5, 1, { ka: 0.5, kb: 1, off: 0.5 }); // the step's width below 50 %, x 1 or x (1 + LFO) / 2
  b.wire(pwMode, 'out', pwDepth, 'a');
  b.wire(pwStep, 'out', pwDepth, 'b');
  const waveKind = b.add('select', 1.5, 0, { count: 2, pos: 1, v1: 0, v2: 1 / 3 }); // SQUARE or PULSE: x 3 into the wave, saw 2 -> square 3
  b.wire(waveSel, 'g3', waveKind, 'pos');
  b.wire(waveSel, 'g4', waveKind, 'pos');
  const pulseOn = b.add('select', 1, 1.5, { count: 2, pos: 1 }); // the width only on PULSE (its gate moves this to 2)
  b.wire(waveSel, 'g4', pulseOn, 'pos');
  b.wire(pwDepth, 'mul', pulseOn, 'in2');
  const subSel = b.add('select', 1, 2, { count: 2, pos: 1, v1: 0, v2: 1 });
  const rangeSel = b.add('select', 1, 2.5, { count: 3, pos: 2, v1: -1, v2: 0, v3: 1 });
  const vcoMod = b.add('scale', 1.5, 2.5, { gain: 1, offset: 0 }); // RANGE, MOD, the lever; `offset` is TUNING
  b.wire(rangeSel, 'out', vcoMod, 'in');
  b.wire(vib, 'out', vcoMod, 'in');
  const nz = b.add('noise', 1, 3, { level: 0.5 });
  const noiseSel = b.add('select', 1.5, 3, { count: 2, pos: 1 });
  b.wire(nz, 'out', noiseSel, 'in2');
  // ---- the VCF's switches
  const kybdSel = b.add('select', 1, 3.5, { count: 4, pos: 4, v1: 0.1 / 8, v2: 0.4 / 8, v3: 0.7 / 8, v4: 1 / 8 }); // x 8: the gain's span
  const polSel = b.add('select', 1.5, 3.5, { count: 2, pos: 1, v1: 0, v2: -2 / 8 });
  // ---- the trigger: a square clock, the noise sampled on it into the cutoffs
  const trig = b.add('lfo', 2, 4, { wave: 3, rate: 6, depth: 1 });
  const trigSh = b.add('sh', 2.5, 4, { mode: 0 });
  b.wire(nz, 'out', trigSh, 'in');
  b.wire(trig, 'out', trigSh, 'clock');
  const trigAmt = b.add('scale', 3, 4, { gain: 0, offset: 0 });
  b.wire(trigSh, 'out', trigAmt, 'in');
  const fsum = b.add('scale', 3.5, 4, { gain: 2, offset: 0 }); // the cutoffs' shared modulation, 2 octaves a unit
  b.wire(lflt, 'out', fsum, 'in');
  b.wire(trigAmt, 'out', fsum, 'in');
  // ---- the lever: its LFO (the mod wheel's depth) or its BEND, for VCO, VCF and VCA
  const leverLfo = b.add('vca', 2, 5, { gain: 0.1 });
  b.wire(lfoSig, 'mul', leverLfo, 'in');
  const bendSens = b.add('scale', 2.5, 5, { gain: 2 / 12, offset: 0 });
  const lever = [0, 1, 2].map((k) => {
    const s = b.add('select', 3 + k * 0.5, 5, { count: 3, pos: k === 0 ? 3 : 2 });
    b.wire(leverLfo, 'out', s, 'in1');
    b.wire(bendSens, 'out', s, 'in3');
    return s;
  });
  const [leverVco, leverVcf, leverVca] = lever;
  b.wire(leverVco, 'out', vcoMod, 'in');
  b.wire(leverVcf, 'out', fsum, 'in');
  // ---- a voice
  const glide = b.add('glide', 2, 0, { time: 0.15, curve: 0 }, { p1: 'time' });
  const osc = b.add('osc', 3, 0, { wave: 2, level: 0.6, pw: 0.5 }, { p1: 'wave', p2: 'pw', att: [1, -1] });
  const sub = b.add('osc', 3, 0.5, { wave: 3, level: 0, coarse: -12 }, { p1: 'level', att: [0.5, 1] });
  const waveVca = b.add('vca', 3.5, 0, { gain: 1 });
  const flt = b.add('ladder', 4, 0, { cutoff: 1800, res: 0.25, cvamt: 2, track: 0 }, { p2: 'cutoff', att: [1, 1 / Math.log2(800)] }); // p2: 1 octave a unit
  const envF = b.add('adsr', 4, 1, { a: 0.02, d: 0.6, s: 0.55, r: 0.6 });
  const polarity = b.add('scale', 4.5, 1, { gain: 1, offset: 0 }, { p1: 'gain' });
  const kybd = b.add('scale', 4.5, 0.5, { gain: 0, offset: 0 }, { p1: 'gain' });
  const envA = b.add('adsr', 5, 1, { a: 0.02, d: 0.6, s: 0.8, r: 0.6 });
  const vca = b.add('vca', 5, 0, { gain: 1 });
  const hold = b.add('logic', 5.5, 1, { thresh: 0.5 });
  b.nest('voice', 2, 2, [glide, osc, sub, waveVca, flt, envF, polarity, kybd, envA, vca, hold], {
    flaws: [{ detune: 3, drift: 25, bright: 1, env: 2, level: 100 }, { detune: -4, drift: 30, bright: -1, env: -3, level: 98 }, { detune: 2, drift: 20, bright: 0, env: 4, level: 100 }, { detune: -2, drift: 28, bright: 2, env: -2, level: 97 }],
  });
  b.wire(part, 'pitch', glide, 'in');
  b.wire(keyOffs, 'add', glide, 'in');
  b.wire(portaSel, 'out', glide, 'p1');
  for (const o of [osc, sub]) {
    b.wire(glide, 'out', o, 'pitch');
    b.wire(vcoMod, 'out', o, 'pitch');
  }
  b.wire(waveKind, 'out', osc, 'p1');
  b.wire(pulseOn, 'out', osc, 'p2');
  b.wire(subSel, 'out', sub, 'p1');
  b.wire(osc, 'out', waveVca, 'in');
  b.wire(waveSel, 'out', waveVca, 'cv');
  b.wire(waveVca, 'out', flt, 'in');
  b.wire(sub, 'out', flt, 'in');
  b.wire(noiseSel, 'out', flt, 'in');
  b.wire(envF, 'env', polarity, 'in');
  b.wire(polSel, 'out', polarity, 'p1');
  b.wire(polarity, 'out', flt, 'cv');
  b.wire(glide, 'out', kybd, 'in');
  b.wire(kybdSel, 'out', kybd, 'p1');
  b.wire(kybd, 'out', flt, 'p2');
  b.wire(fsum, 'out', flt, 'p2');
  b.wire(part, 'gate', hold, 'a');
  b.wire(holdSel, 'out', hold, 'b');
  b.wire(envA, 'env', hold, 'b');
  b.wire(hold, 'or', envF, 'gate');
  b.wire(hold, 'or', envA, 'gate');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(envA, 'env', vca, 'cv');
  // ---- once: the HPF, the ensemble
  const hpf = b.add('filter', 6, 0, { cutoff: 40, res: 0 });
  const ens = b.add('chorus', 7, 0, { rate: 0.6, depth: 0.5, mix: 0 }, { p1: 'mix' });
  const ensSel = b.add('select', 7, 1, { count: 2, pos: 2, v1: 0, v2: 0.45 });
  b.wire(ensSel, 'out', ens, 'p1');
  const scope = b.add('scope', 8, 0, { time: 16 });
  const leverGain = b.add('scale', 5.5, 3, { gain: 0.5, offset: 1 }); // 1 + the lever's VCA (about one unit of gain at full)
  b.wire(leverVca, 'out', leverGain, 'in');
  const allVca = b.add('vca', 5.5, 2.5, { gain: 1 });
  b.wire(vca, 'out', allVca, 'in');
  b.wire(leverGain, 'out', allVca, 'cv');
  b.wire(allVca, 'out', hpf, 'in');
  b.wire(hpf, 'hp', ens, 'in');
  b.wire(hpf, 'hp', scope, 'a');
  b.input('keys', part, 'keys', [held, 'keys']);
  b.input('bend', keyOffs, 'a', [bendSens, 'in']);
  b.input('wheel', leverLfo, 'cv');
  b.nestInput('pitch', glide, 'in');
  b.nestInput('gate', hold, 'a');
  b.output('l', ens, 'l');
  b.output('r', ens, 'r');
  b.output('arp clock', trig, 'out');
  b.nestOutput('out', vca, 'out');
  // ---- the card: the JP-4's panel
  b.param('range', rangeSel, 'pos', { head: 'vco' });
  b.param('sub', subSel, 'pos');
  b.param('mod', vib, 'gain');
  b.param('pw mode', pwMode, 'pos');
  b.param('pw', pwStep, 'pos');
  b.param('wave form', waveSel, 'pos');
  b.param('noise', noiseSel, 'pos');
  b.param('hpf cutoff', hpf, 'cutoff', { col: true, head: 'vcf' });
  b.param('lpf cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  b.param('kybd follow', kybdSel, 'pos');
  b.param('mod', lflt, 'gain');
  b.param('env mod', flt, 'cvamt');
  b.param('polarity', polSel, 'pos');
  b.param('vcf env', envF, 'view', { group: true });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, envF, q);
  b.param('vca env', envA, 'view', { col: true, head: 'vca' });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, envA, q);
  b.param('level', vca, 'gain');
  b.param('wave form', lfoWave, 'pos', { head: 'lfo' });
  b.param('rate', lfo, 'rate');
  b.param('rate', trig, 'rate', { col: true, head: 'trigger' });
  b.param('vcf mod', trigAmt, 'gain');
  b.param('delay time', delayEnv, 'a', { head: 'delay/bend' });
  b.param('lfo bend', lfoBend, 'gain');
  b.param('norm/wide', bendSel, 'pos');
  b.param('bend sens', bendSens, 'gain', { head: 'bend/mod' });
  b.param('lfo mod', leverLfo, 'gain');
  b.param('vco', leverVco, 'pos');
  b.param('vcf', leverVcf, 'pos');
  b.param('vca', leverVca, 'pos');
  b.param('portamento', glide, 'time', { col: true, head: 'portamento' });
  b.param('switch', portaSel, 'pos');
  b.param('transpose', transSel, 'pos', { head: 'keys' });
  b.param('tuning', vcoMod, 'offset');
  b.param('assign', part, 'assign');
  b.param('unison', part, 'unison');
  b.param('hold', holdSel, 'pos');
  b.param('ensemble', ensSel, 'pos');
  b.param('out', scope, 'view');
  gridAll(b);
});
{
  // the panel's legends, row by row in card order (two rows are called WAVE FORM: the VCO's, then the LFO's). The FM-1's
  // 3,840 bytes hold no more: the OFF / ON switches (sub, noise, portamento, hold, ensemble) stay numbered, 1 OFF, 2 ON
  const LEVER = ['LFO', 'OFF', 'BEND'];
  const names: [string, string[]][] = [
    ['range', ["16'", "8'", "4'"]], ['pw mode', ['MANUAL', 'MOD']], ['pw', ['50%', '40%', '20%', '10%']],
    ['wave form', ['OFF', 'SAW', 'SQUARE', 'PULSE']], ['kybd follow', ['10%', '40%', '70%', '100%']],
    ['polarity', ['NORM', 'INV']], ['wave form', ['SINE', 'SQUARE', 'SAW', 'REV SAW']], ['norm/wide', ['NORM', 'WIDE']],
    ['vco', LEVER], ['vcf', LEVER], ['vca', LEVER], ['transpose', ['NORMAL', '-1 OCT']],
  ];
  const d = defs.find((x) => x.name === 'Io 4')!;
  let at = 0;
  for (const [label, n] of names) {
    at = d.params.findIndex((r, i) => i >= at && r.label === label && r.param === 'pos');
    if (at < 0) throw new Error(`Io 4: no switch row ${label}`);
    d.params[at++].names = n;
  }
}

// Vernon 100, a duophonic synth after the EML ElectroComp 100 (made in Vernon, Connecticut). After the panel, not a
// manual: no manual for the 100 was found. The panel (a 100's photos and a redrawn 100 panel) gives the controls; the
// EML 101's owner's and service manuals give how the controls the two share behave. The card is the 100's panel, one
// row per knob or switch under its section names; a switch is a Selector row (1, 2, .. in the panel's order) until
// Selectors name their positions (#358).
// The keyboard sends two pitches and one gate: KB1 the lowest key held, KB2 the highest (one key: both), the gate high
// while any key is (one-voice Voice allocators, low and high priority; a key added under a held one does not retrigger).
// KEYBOARD CONTROL: KEYS/OCT COARSE (fully down 12 keys an octave, up to about 60) and FINE scale both pitches;
// PORTAMENTO glides both (slews; its knob reaches 5 s).
// OSCILLATOR 1 (pitch source or control: HI / LO, 1 HI audio, 2 LO a hundred times slower): COLOR 1 falling ramp,
// 2 ramp, 3 triangle, 4 square, 5 narrow pulse; TUNE; CONTROL MODE 1 OSC 4 / EXT, 2 ENV 1, 3 KB (KB1), CONTROL SENS the
// depth of the first two. OSCILLATORS 2, 3, 4 (Wavetables on the EML COLOR bank: triangle, sloped square, square, saw,
// then double saw an octave up; OCTAVE; TUNE): 2 plays KB1, CONTROL MODE 1 KB1, 2 KB1 + MIX; 3 plays KB2, 1 KB2, 2 KB2 + MIX, 3 MIX;
// 4 1 OSC 3 (oscillator 3's control), 2 MAN (its OCTAVE and TUNE alone), 3 MIX; its OCTAVE 1 LO (sub-audio), -1, 0, +1.
// MIX is the OSCILLATOR MIXER: two centre-zero knobs, OSC 1 <- 0 -> ENV 1 and OSC 4 / EXT <- 0 -> ENV 2 (one octave at
// full). The FILTER INPUT MIXER: OSC 2, OSC 3, OSC 4 / EXT, and the noise knob WHITE <- 0 -> PINK. The FILTER: 12 dB
// state variable, CUT OCTAVE 1 -1, 2 0, 3 +1; TUNE (the cutoff); RESONANCE; MODE 1 LP, 2 BP, 3 HP, 4 BR. FILTER
// CONTROL: OSC 1 <- 0 -> ENV 1 and OSC 4 / EXT <- 0 -> ENV 2 (four octaves at full), and the key it follows, 1 KB1,
// 2 KB2 (one octave per octave). ENVELOPES 1 and 2: ATTACK, DECAY, SUSTAIN; the SUSTAIN switch (1 ON, 2 OFF; one for
// both): on, a released key's envelope falls at its decay time, off at once. The AMPLITUDE SHAPER: its envelope, 1 ENV 1,
// 2 ENV 2. The OUTPUT MIXER: AMP SHAPER and OSC 3 / EXT (oscillator 3 around the filter and the shaper).
// A centre-zero knob is a Math (`off`, -1 .. 1): its min and max, times the two sources. Its OSC side reaches the
// destination with that oscillator's polarity; the panel does not say which way the original's does.
// Unsure (no 100 manual): whether the filter MODE sweeps between its legends (LP at both ends of the knob suggests it)
// or switches (here it switches); the COLOR knob's transition positions (its wave order follows the 101 owner's manual,
// pp. 9-10, and the service notes identify the endpoint as double saw); the ranges of TUNE,
// the mixers' depths and the envelopes; whether a key added under a held one retriggers the gate.
// Not here: the PREAMP (an external input: the FM-1 has no audio in for a patch, #351), the jacks and multiples
// (patching: the editor's own cables). The FM-1's pitch bend still bends both keys (2 semitones), as on every patch.
asm('Vernon 100', 'Voices', (b) => {
  // ---- the keyboard: KB1 (lowest), KB2 (highest), the gate; keys / octave; portamento
  const kb1 = b.add('alloc', 0, 0, { voices: 1, priority: 1, legato: 2 });
  const kb2 = b.add('alloc', 0, 0.5, { voices: 1, priority: 2, legato: 2 });
  const keysOct = b.add('math', 0.5, 0, { ka: 0.97, kb: 0.97, off: 0 }); // min = KB1, max = KB2, scaled
  const m = b.module(keysOct);
  m.map = { ...m.map!, p1: ['ka', 'kb'], p2: ['ka', 'kb'] };
  m.att = [-0.1, 0.0075]; // COARSE: x 1 .. x 0.2 (12 .. 60 keys an octave); FINE: +-3 % around its middle
  b.wire(kb1, 'pitch', keysOct, 'a');
  b.wire(kb2, 'pitch', keysOct, 'b');
  const coarse = b.add('macro', 0, 1, { value: 0 });
  const fine = b.add('macro', 0.5, 1, { value: 0.5 });
  b.wire(coarse, 'out', keysOct, 'p1');
  b.wire(fine, 'out', keysOct, 'p2');
  const porta = b.add('macro', 0, 1.5, { value: 0 });
  const [g1, g2] = [0, 1].map((k) => {
    const g = b.add('glide', 1, k * 0.5, { time: 0.001, curve: 0 }, { p1: 'time' });
    b.wire(porta, 'out', g, 'p1');
    b.wire(keysOct, k ? 'max' : 'min', g, 'in');
    return g;
  });
  // ---- the envelopes on the one gate; decay (a Macro: decay and, with the sustain switch on, release)
  const susSel = b.add('select', 0, 3, { count: 2, pos: 1 });
  const envs = [0, 1].map((k) => {
    const e = b.add('adsr', 1 + k, 3, { a: k ? 0.005 : 0.01, d: 0.001, s: k ? 0.8 : 0.35, r: 0.001 }, { p1: 'd', p2: 'r', att: [1, Math.log2(5000) / Math.log2(8000)] });
    b.wire(kb1, 'gate', e, 'gate');
    const dec = b.add('macro', 1 + k, 3.5, { value: Math.log(k ? 300 : 500) / Math.log(5000) });
    b.wire(dec, 'out', e, 'p1');
    const rel = b.add('math', 1.5 + k, 3.5, { ka: 1, kb: 1, off: 0 }); // the decay while the switch is on, else 0
    b.wire(dec, 'out', rel, 'a');
    b.wire(susSel, 'g1', rel, 'b');
    b.wire(rel, 'mul', e, 'p2');
    return { e, dec };
  });
  const [env1, env2] = envs.map((x) => x.e);
  // ---- a centre-zero knob: `off` in -1 .. 1, the left source times its min (negated), the right one times its max
  const centre = (col: number, row: number, left: [number, string], right: [number, string], k: number, depth: number): { knob: number; outs: number[] } => {
    const knob = b.add('math', col, row, { ka: 1, kb: 1, off: k });
    const l = b.add('math', col + 0.5, row, { ka: depth, kb: -1, off: 0 });
    b.wire(left[0], left[1], l, 'a');
    b.wire(knob, 'min', l, 'b');
    const r = b.add('math', col + 0.5, row + 0.5, { ka: depth, kb: 1, off: 0 });
    b.wire(right[0], right[1], r, 'a');
    b.wire(knob, 'max', r, 'b');
    return { knob, outs: [l, r] };
  };
  // ---- oscillator 1: its colour (wave on p1: x 3; the narrow pulse's width on p2; the falling ramp the ramp times -1)
  const o1 = b.add('osc', 3, 0, { wave: 0, level: 1, pw: 0.5 }, { p1: 'wave', p2: 'pw', att: [1, -0.4 / 0.9] });
  const color1 = b.add('select', 3, 0.5, { count: 5, pos: 3, v1: 2 / 3, v2: 2 / 3, v3: 1 / 3, v4: 1, v5: 1 });
  b.wire(color1, 'out', o1, 'p1');
  b.wire(color1, 'g5', o1, 'p2');
  const o1sig = b.add('math', 3.5, 0, { ka: -2, kb: 1, off: 1 });
  b.wire(color1, 'g1', o1sig, 'a');
  b.wire(o1, 'out', o1sig, 'b');
  const hilo = b.add('select', 3, 1, { count: 2, pos: 2, v1: -2, v2: -2 - Math.log2(100) });
  b.wire(hilo, 'out', o1, 'pitch');
  const ctl1 = b.add('select', 3, 1.5, { count: 3, pos: 2 });
  const sens1 = b.add('scale', 3.5, 1.5, { gain: 0, offset: 2.9 }); // CONTROL SENS; `offset` is TUNE
  b.wire(ctl1, 'out', sens1, 'in');
  b.wire(sens1, 'out', o1, 'pitch');
  const kb1o1 = b.add('math', 3.5, 1, { ka: 1, kb: 1, off: 0 }); // KB1 in the KB position
  b.wire(ctl1, 'g3', kb1o1, 'a');
  b.wire(g1, 'out', kb1o1, 'b');
  b.wire(kb1o1, 'mul', o1, 'pitch');
  // ---- oscillators 2, 3, 4
  const wt = (col: number, pos: number): number => b.add('wavetable', col, 0, { bank: 4, pos, level: 1 });
  const [w2, w3, w4] = [wt(5, 0.45), wt(6, 0.45), wt(7, 0.3)];
  b.wire(w4, 'out', ctl1, 'in1');
  b.wire(env1, 'env', ctl1, 'in2');
  // the oscillator mixer (MIX)
  const om1 = centre(4, 2, [o1sig, 'mul'], [env1, 'env'], 0, 1);
  const om2 = centre(4, 3, [w4, 'out'], [env2, 'env'], 0, 1);
  const mix = b.add('scale', 5, 2.5, { gain: 1, offset: 0 });
  for (const o of [...om1.outs, ...om2.outs]) b.wire(o, 'mul', mix, 'in');
  const osc = (w: number, col: number, count: number, ins: [number, string][][], octs: number[], octPos: number): { ctl: number; oct: number; tune: number } => {
    const ctl = b.add('select', col, 1, { count, pos: 1 });
    ins.forEach((srcs, j) => srcs.forEach(([mm, port]) => b.wire(mm, port, ctl, `in${j + 1}`)));
    const oct = b.add('select', col, 1.5, { count: octs.length, pos: octPos, ...Object.fromEntries(octs.map((v, j) => [`v${j + 1}`, v])) });
    const tune = b.add('const', col, 2, { value: 0 });
    for (const s of [ctl, oct, tune]) b.wire(s, 'out', w, 'pitch');
    return { ctl, oct, tune };
  };
  const os2 = osc(w2, 5, 2, [[[g1, 'out']], [[g1, 'out'], [mix, 'out']]], [-1, 0, 1], 2);
  const os3 = osc(w3, 6, 3, [[[g2, 'out']], [[g2, 'out'], [mix, 'out']], [[mix, 'out']]], [-1, 0, 1], 2);
  const os4 = osc(w4, 7, 3, [[], [], [[mix, 'out']]], [-7, -1, 0, 1], 3);
  b.wire(os3.ctl, 'out', os4.ctl, 'in1');
  b.module(os4.ctl).params.pos = 2;
  // ---- noise (WHITE <- 0 -> PINK: the level its distance from 0, pink to the right)
  const nz = b.add('noise', 4, 4, { level: 0, color: 0 }, { p1: 'level', p2: 'color' });
  const nKnob = b.add('math', 4.5, 4, { ka: 1, kb: 1, off: 0 });
  b.wire(nKnob, 'abs', nz, 'p1');
  b.wire(nKnob, 'cmp', nz, 'p2');
  // ---- the filter input mixer, the filter, its mode, its control
  const inMix = b.add('mixer', 8, 0, { l1: 0.7, l2: 0.7, l3: 0, l4: 1 });
  b.wire(w2, 'out', inMix, 'in1');
  b.wire(w3, 'out', inMix, 'in2');
  b.wire(w4, 'out', inMix, 'in3');
  b.wire(nz, 'out', inMix, 'in4');
  const flt = b.add('filter', 9, 0, { cutoff: 1100, res: 0.35, cvamt: 1, track: 0 });
  b.wire(inMix, 'out', flt, 'in');
  const mode = b.add('select', 10, 0, { count: 4, pos: 1, fade: 5 });
  for (const [j, port] of ['lp12', 'bp', 'hp', 'notch'].entries()) b.wire(flt, port, mode, `in${j + 1}`);
  const cutOct = b.add('select', 9, 1, { count: 3, pos: 2, v1: -1, v2: 0, v3: 1 });
  b.wire(cutOct, 'out', flt, 'cv');
  const fc1 = centre(8, 2, [o1sig, 'mul'], [env1, 'env'], 0.55, 4);
  const fc2 = centre(8, 3, [w4, 'out'], [env2, 'env'], 0, 4);
  for (const o of [...fc1.outs, ...fc2.outs]) b.wire(o, 'mul', flt, 'cv');
  const kbSel = b.add('select', 9, 1.5, { count: 2, pos: 2 });
  b.wire(g1, 'out', kbSel, 'in1');
  b.wire(g2, 'out', kbSel, 'in2');
  b.wire(kbSel, 'out', flt, 'cv');
  // ---- the amplitude shaper, the output mixer
  const ampSel = b.add('select', 10, 1, { count: 2, pos: 2 });
  b.wire(env1, 'env', ampSel, 'in1');
  b.wire(env2, 'env', ampSel, 'in2');
  const vca = b.add('vca', 11, 0, { gain: 1 });
  b.wire(mode, 'out', vca, 'in');
  b.wire(ampSel, 'out', vca, 'cv');
  const outMix = b.add('mixer', 12, 0, { l1: 0.8, l2: 0, l3: 0, l4: 0 });
  b.wire(vca, 'out', outMix, 'in1');
  b.wire(w3, 'out', outMix, 'in2');
  const scope = b.add('scope', 13, 0, { time: 16 });
  b.wire(outMix, 'out', scope, 'a');
  b.input('keys', kb1, 'keys', [kb2, 'keys']);
  b.output('out', outMix, 'out');
  // ---- the card: the 100's panel
  b.param('color', color1, 'pos', { head: 'oscillator 1' });
  b.param('tune', sens1, 'offset');
  b.param('hi / lo', hilo, 'pos');
  b.param('control sens', sens1, 'gain');
  b.param('control mode', ctl1, 'pos');
  b.param('osc 1 / env 1', om1.knob, 'off', { head: 'osc mixer' });
  b.param('osc 4 / env 2', om2.knob, 'off');
  b.param('keys/oct crs', coarse, 'value', { head: 'keyboard' });
  b.param('keys/oct fine', fine, 'value');
  b.param('portamento', porta, 'value');
  const oscRows = (n: number, o: { ctl: number; oct: number; tune: number }, w: number): void => {
    b.param('control mode', o.ctl, 'pos', { col: n === 2, head: `oscillator ${n}` });
    b.param('octave', o.oct, 'pos');
    b.param('tune', o.tune, 'value');
    b.param('color', w, 'pos');
  };
  oscRows(2, os2, w2);
  oscRows(3, os3, w3);
  oscRows(4, os4, w4);
  b.param('osc 2', inMix, 'l1', { col: true, head: 'filter input' });
  b.param('osc 3', inMix, 'l2');
  b.param('osc 4 / ext', inMix, 'l3');
  b.param('white / pink', nKnob, 'off');
  b.param('cut octave', cutOct, 'pos', { head: 'filter' });
  b.param('tune', flt, 'cutoff');
  b.param('resonance', flt, 'res');
  b.param('mode', mode, 'pos');
  b.param('osc 1 / env 1', fc1.knob, 'off', { head: 'filter control' });
  b.param('osc 4 / env 2', fc2.knob, 'off');
  b.param('kb1 / kb2', kbSel, 'pos');
  b.param('env 1', env1, 'view', { col: true, head: 'envelope 1' });
  b.param('attack', env1, 'a');
  b.param('decay', envs[0].dec, 'value');
  b.param('sustain', env1, 's');
  b.param('env 2', env2, 'view', { head: 'envelope 2' });
  b.param('attack', env2, 'a');
  b.param('decay', envs[1].dec, 'value');
  b.param('sustain', env2, 's');
  b.param('sustain on/off', susSel, 'pos');
  b.param('env 1 / env 2', ampSel, 'pos', { head: 'amplitude shaper' });
  b.param('amp shaper', outMix, 'l1', { head: 'output mixer' });
  b.param('osc 3 / ext', outMix, 'l2');
  b.param('out', scope, 'view');
  gridAll(b);
});

/** the touch plates' Drum map: the eight rows on the white keys F3..F4, repeated over the keybed (PLATE_KEYS) */
const plates = (b: B): number => b.add('drummap', 0, 0, { ...Object.fromEntries(PLATE_KEYS[1].map((n, r) => [`n${r + 1}`, n])), repeat: 1 });

// 8 Lire, after the SOMA Laboratory Lyra-8 (#182; the panel as we remember it, not checked against SOMA's manual): eight
// voices, no keyboard. A Drum map turns the keys into eight gates, one per touch plate (F3..F4 as the drum kits' rows,
// repeated over the keybed in blocks of eight white keys, a black key playing the white key's below: PLATE_KEYS); each
// voice keeps its own tuning and plays a triangle through a VCA on its own envelope (attack / release for the FAST / SLOW
// switch). Voices come in pairs (1-2, 3-4, 5-6, 7-8): a pair shares a waveshaper (SHARP) and a
// modulation depth (MOD, into both voices' pitch); pairs come in quads (1-4, 5-8): a quad shares HOLD (an offset into its
// voices' VCAs, so they drone with nothing held) and its modulation bus, a mix of the other quad, the Hyper LFO and the
// total feedback (the delay's output). The Hyper LFO: two square LFOs combined, AND crossfaded into OR, into the bus and
// the delay time. The drive, then the delay (the FM-1 holds one Delay: the Lyra's two lines are its ping-pong taps, the
// engine's l / r). Cross-quad and feedback modulation run one block late (the cables close loops).
asm('8 Lire', 'Voices', (b) => {
  const map = plates(b);
  b.module(map).names = Array.from({ length: 8 }, (_, r) => `VOICE ${r + 1}`);   // (the rows are the voices, not drums)
  const lfoA = b.add('lfo', 0, 1, { wave: 3, rate: 0.7, depth: 1 });
  const lfoB = b.add('lfo', 0, 2, { wave: 3, rate: 1.9, depth: 1 });
  const logic = b.add('logic', 0, 3, {});
  const hyper = b.add('xfade', 0, 4, { mix: 0 });
  const toDelay = b.add('scale', 0, 5, { gain: 0, offset: 0 });
  //               coarse  fine attack release
  const tunes: [number, number, number, number][] = [
    [-22, 0, 0.02, 1.2], [-22, 7, 0.02, 1.2], [-15, 0, 0.6, 2.5], [-15, -6, 0.6, 2.5],
    [-10, 0, 0.01, 0.6], [-3, 4, 0.01, 0.6], [0, 0, 0.9, 3], [4, -3, 0.9, 3],
  ];
  const voices = tunes.map(([coarse, fine, a, r], i) => {
    const osc = b.add('osc', 1 + i, 0, { wave: 1, coarse, fine, level: 0.5 });
    const env = b.add('adsr', 1 + i, 1, { a, d: 0.2, s: 1, r });
    const vca = b.add('vca', 1 + i, 2, { gain: 1 });
    b.wire(osc, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    b.wire(map, `g${i + 1}`, env, 'gate');
    return { osc, env, vca };
  });
  const sharp = [0, 1, 2, 3].map((p) => b.add('shape', 1 + 2 * p, 3, { drive: 2, mode: 0, level: 0.7 }));
  const mod = [0, 1, 2, 3].map((p) => b.add('scale', 2 + 2 * p, 3, { gain: 0, offset: 0 }));
  const bus = [0, 1].map((q) => b.add('mixer', 1 + 4 * q, 4, { l1: 1, l2: 0, l3: 0, l4: 0 }));
  const hold = [0, 1].map((q) => b.add('const', 2 + 4 * q, 4, { value: 0 }));
  const mix = b.add('mixer', 9, 0, { l1: 0.7, l2: 0.7, l3: 0.7, l4: 0.7 });
  const drive = b.add('shape', 9, 1, { drive: 1.5, mode: 0, level: 0.7 });
  const dly = b.add('delay', 10, 0, { time: 330, fb: 0.45, mix: 0.35, pingpong: 1 }, { p1: 'time' });
  const scope = b.add('scope', 10, 1, { time: 16 });
  voices.forEach((v, i) => {
    const p = Math.floor(i / 2);
    b.wire(v.vca, 'out', sharp[p], 'in');
    b.wire(mod[p], 'out', v.osc, 'pitch');
    b.wire(hold[Math.floor(i / 4)], 'out', v.vca, 'cv');
  });
  sharp.forEach((s, p) => {
    b.wire(s, 'out', mix, `in${p + 1}`);
    b.wire(s, 'out', bus[p < 2 ? 1 : 0], 'in1'); // the other quad
    b.wire(bus[Math.floor(p / 2)], 'out', mod[p], 'in');
  });
  b.wire(lfoA, 'out', logic, 'a');
  b.wire(lfoB, 'out', logic, 'b');
  b.wire(logic, 'and', hyper, 'a');
  b.wire(logic, 'or', hyper, 'b');
  b.wire(hyper, 'out', toDelay, 'in');
  b.wire(toDelay, 'out', dly, 'p1');
  for (const q of bus) {
    b.wire(hyper, 'out', q, 'in2');
    b.wire(dly, 'out', q, 'in3');
  }
  b.wire(mix, 'out', drive, 'in');
  b.wire(drive, 'out', dly, 'in');
  b.wire(dly, 'out', scope, 'a');
  b.wire(dly, 'r', scope, 'b');
  voices.forEach((v, i) => b.nest(`voice ${i + 1}`, 1 + i, 0, [v.osc, v.env, v.vca]));
  voices.forEach((v) => {
    b.nestInput('gate', v.env, 'gate');
    b.nestInput('mod', v.osc, 'pitch');
    b.nestInput('hold', v.vca, 'cv');
    b.nestOutput('out', v.vca, 'out');
  });
  b.input('keys', map, 'keys');
  b.output('l', dly, 'out');
  b.output('r', dly, 'r');
  for (const [q, name, other] of [[0, '1-4', '5-8'], [1, '5-8', '1-4']] as const) {
    b.param('hold', hold[q], 'value', { col: q === 0 ? undefined : true, head: name });
    b.param(`from ${other}`, bus[q], 'l1');
    b.param('from lfo', bus[q], 'l2');
    b.param('from fb', bus[q], 'l3');
    for (const p of [2 * q, 2 * q + 1]) b.param(`mod ${2 * p + 1}-${2 * p + 2}`, mod[p], 'gain', p === 2 * q ? { group: true } : {});
    for (const p of [2 * q, 2 * q + 1]) b.param(`sharp ${2 * p + 1}-${2 * p + 2}`, sharp[p], 'drive');
  }
  b.param('rate a', lfoA, 'rate', { col: true, head: 'hyper lfo' });
  b.param('rate b', lfoB, 'rate');
  b.param('and / or', hyper, 'mix');
  b.param('lfo → delay', toDelay, 'gain');
  b.param('time', dly, 'time', { head: 'delay' });
  b.param('feedback', dly, 'fb');
  b.param('mix', dly, 'mix');
  b.param('ping-pong', dly, 'pingpong');
  b.param('drive', drive, 'drive', { head: 'out' });
  b.param('vol', drive, 'level');
  voices.forEach((v, i) => {
    b.param('tune', v.osc, 'coarse', { head: `voice ${i + 1}`, ...(i % 4 === 0 ? { col: true } : {}) });
    b.param('fine', v.osc, 'fine');
    b.param('attack', v.env, 'a');
    b.param('release', v.env, 'r');
  });
  b.param('out', scope, 'view', { col: true });
});

// Elvira 2, after the neutral labs Elmyra 2 (its manual v2.4): four voices, each a wavetable oscillator (PG's four pages
// = `bank`, WAVE = `pos`, TUNE) through its MOD program (here the SRR one, a Bitcrusher's rate: clean at the left) into a
// VCA on its own envelope (the ENV knob's attack and release as two rows) plus DRONE (an offset into the VCA: the
// envelope held at the top). The keys play the voices as touchpads: the Drum map's rows 1-4 and 5-8 are voices 1-4 (the
// white keys from F3, repeated over the keybed as 8 Lire's). The mix is saturated, then the ladder low pass (CUTOFF,
// RESO), the delay (TIME, FDBK, MIX; ours reaches 520 ms, the original 1.6 s) and OUCH: BITE (a folding Waveshaper) into CHOKE (a low pass, open
// at the right), without the original's analog feedback loop or modifier ports; VOL. LFO 1 (sine) into the cutoff, LFO 2
// (a wave choice) into the bite, each by an amount (on the original they are patched by hand). No sequencer, no CHRM:
// TUNE is in semitones.
asm('Elvira 2', 'Voices', (b) => {
  const map = plates(b);
  b.module(map).names = [1, 2, 3, 4, 1, 2, 3, 4].map((v, r) => `VOICE ${v}${r < 4 ? '' : 'B'}`);   // (rows 5-8 play voices 1-4 again)
  const lfo1 = b.add('lfo', 0, 1, { wave: 0, rate: 0.2, depth: 1 });
  const lfo2 = b.add('lfo', 0, 2, { wave: 2, rate: 3, depth: 1 });
  const toCutoff = b.add('scale', 0, 3, { gain: 0, offset: 0 });
  const toBite = b.add('scale', 0, 4, { gain: 0, offset: 0 });
  //               bank pos  coarse attack release
  const set: [number, number, number, number, number][] = [
    [0, 0.2, -15, 0.05, 0.8], [1, 0.4, -8, 0.05, 0.8], [2, 0.3, -3, 0.3, 1.5], [3, 0.6, 0, 0.3, 1.5],
  ];
  const voices = set.map(([bank, pos, coarse, a, r], i) => {
    const wt = b.add('wavetable', 1 + i, 0, { bank, pos, coarse, level: 0.8 });
    const srr = b.add('crush', 1 + i, 1, { bits: 16, rate: 1 });
    const env = b.add('adsr', 1 + i, 2, { a, d: 0.2, s: 1, r });
    const drone = b.add('const', 1 + i, 3, { value: 0 });
    const vca = b.add('vca', 1 + i, 4, { gain: 1 });
    b.wire(wt, 'out', srr, 'in');
    b.wire(srr, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    b.wire(drone, 'out', vca, 'cv');
    for (const row of [i + 1, i + 5]) b.wire(map, `g${row}`, env, 'gate'); // (either row of the voice holds the gate up)
    return { wt, srr, env, drone, vca };
  });
  const mix = b.add('mixer', 5, 0, { l1: 0.7, l2: 0.7, l3: 0.7, l4: 0.7 });
  const sat = b.add('shape', 5, 1, { drive: 2, mode: 0, level: 0.8 });
  const lpf = b.add('ladder', 6, 0, { cutoff: 2500, res: 0.25, cvamt: 3 });
  const dly = b.add('delay', 6, 1, { time: 400, fb: 0.4, mix: 0.3 });
  const bite = b.add('shape', 7, 0, { drive: 1, mode: 2, level: 0.8 }, { p1: 'drive' });
  const choke = b.add('filter', 7, 1, { cutoff: 16000, res: 0 });
  const scope = b.add('scope', 8, 0, { time: 16 });
  voices.forEach((v, i) => b.wire(v.vca, 'out', mix, `in${i + 1}`));
  b.wire(mix, 'out', sat, 'in');
  b.wire(sat, 'out', lpf, 'in');
  b.wire(lpf, 'lp24', dly, 'in');
  b.wire(dly, 'out', bite, 'in');
  b.wire(bite, 'out', choke, 'in');
  b.wire(choke, 'lp12', scope, 'a');
  b.wire(lfo1, 'out', toCutoff, 'in');
  b.wire(toCutoff, 'out', lpf, 'cv');
  b.wire(lfo2, 'out', toBite, 'in');
  b.wire(toBite, 'out', bite, 'p1');
  voices.forEach((v, i) => b.nest(`voice ${i + 1}`, 1 + i, 0, [v.wt, v.srr, v.env, v.drone, v.vca]));
  voices.forEach((v) => {
    b.nestInput('gate', v.env, 'gate');
    b.nestOutput('out', v.vca, 'out');
  });
  b.input('keys', map, 'keys');
  b.output('out', choke, 'lp12');
  voices.forEach((v, i) => {
    b.param('tune', v.wt, 'coarse', { head: `voice ${i + 1}`, ...(i % 2 === 0 ? { col: true } : {}) });
    b.param('fine', v.wt, 'fine');
    b.param('wave', v.wt, 'pos');
    b.param('page', v.wt, 'bank');
    b.param('mod', v.srr, 'rate', { group: true });
    b.param('attack', v.env, 'a');
    b.param('release', v.env, 'r');
    b.param('drone', v.drone, 'value');
  });
  b.param('cutoff', lpf, 'cutoff', { col: true, head: 'lpf' });
  b.param('reso', lpf, 'res');
  b.param('time', dly, 'time', { head: 'delay' });
  b.param('fdbk', dly, 'fb');
  b.param('mix', dly, 'mix');
  b.param('bite', bite, 'drive', { head: 'ouch' });
  b.param('choke', choke, 'cutoff');
  b.param('vol', bite, 'level');
  b.param('lfo 1 freq', lfo1, 'rate', { col: true, head: 'lfos' });
  b.param('lfo 1 → cutoff', toCutoff, 'gain');
  b.param('lfo 2 freq', lfo2, 'rate', { group: true });
  b.param('lfo 2 wav', lfo2, 'wave');
  b.param('lfo 2 → bite', toBite, 'gain');
  b.param('out', scope, 'view', { col: true });
});

// Scrounge, after the neutral labs Scrooge (its manual v1.1): five voices that live on their control voltage. On the
// original each sequencer step is a voltage curve (POKE its height, TILT its slope, GATE its length) that both powers a
// voice's starved CMOS circuit and sets its pitch and timbre; here a Drum map row plays a one-shot curve (an Env L/R:
// tilt = the rise, gate = the fall) whose height is the row's velocity (a pin on l1: the step's accent is its POKE), and
// the curve, summed with the two modulation tracks, drives the voice's level, pitch and tone all at once. Voices: 1 a
// boomy sine with a pitch drop (kick), 2 a high square through a Bitcrusher (hats to drones), 3 noise through a band pass
// (snare), 4 a triangle bent by a square (growls, chirps), 5 a saw into a ladder (squelchy bass); each with the two
// unlabelled knobs of the original, its volume slider and the A-B switch (a pan: left = A, right = B). Rows 6 and 7 are
// MOD X and MOD Y: their own curves through a slew limiter (SLEW), into every voice by its X / Y amount (the X-Y switch).
// The mix saturates; CHOP (a square LFO opening and closing both outputs, the CTL ALL gesture on all five voices) and MELT
// (both outputs' sample rate, by a pin) after it. Mod wheel = the MOD X input. Row 8 (EXT) stays free. The sequencer is the
// patch's Steps track, not part of the engine.
asm('Scrounge', 'Drums', (b) => {
  const map = b.add('drummap', 0, 0, Object.fromEntries(PLATE_KEYS[1].map((n, r) => [`n${r + 1}`, n])));
  b.module(map).names = ['VOICE 1', 'VOICE 2', 'VOICE 3', 'VOICE 4', 'VOICE 5', 'MOD X', 'MOD Y', 'EXT'];
  const curveOf = (col: number, row: number, gate: number) =>
    b.add('env', col, row, { l1: 0, r1: 0.001, l2: 0, r2: gate, l3: 0, r3: 0.001, l4: 0, r4: 0.001 }, { p1: 'l1' });
  const modX = curveOf(0, 1, 0.4);
  const modY = curveOf(0, 2, 0.2);
  const slewX = b.add('glide', 0, 3, { time: 0.05 });
  const slewY = b.add('glide', 0, 4, { time: 0.2 });
  for (const [r, env, slew] of [[6, modX, slewX], [7, modY, slewY]] as const) {
    b.wire(map, `g${r}`, env, 'gate');
    b.wire(map, `v${r}`, env, 'p1');
    b.wire(env, 'env', slew, 'in');
  }
  const L = b.add('shape', 7, 0, { drive: 1.5, mode: 0, level: 0.8 });
  const R = b.add('shape', 7, 1, { drive: 1.5, mode: 0, level: 0.8 });
  type V = { env: number; curve: number; vca: number; pan: number; members: number[]; k1: [number, string, string]; k2: [number, string, string] };
  const voice = (i: number, gate: number, xy: [number, number], build: (col: number, curve: number, vca: number) => Omit<V, 'env' | 'curve' | 'vca' | 'pan'>): V => {
    const col = 1 + i;
    const env = curveOf(col, 0, gate);
    const curve = b.add('mixer', col, 1, { l1: 1, l2: xy[0], l3: xy[1], l4: 0 });
    const vca = b.add('vca', col, 5, { gain: 0.8 });
    const pan = b.add('pan', col, 6, { pan: 0 });
    b.wire(map, `g${i + 1}`, env, 'gate');
    b.wire(map, `v${i + 1}`, env, 'p1');
    b.wire(env, 'env', curve, 'in1');
    b.wire(slewX, 'out', curve, 'in2');
    b.wire(slewY, 'out', curve, 'in3');
    b.wire(curve, 'out', vca, 'cv');
    b.wire(vca, 'out', pan, 'in');
    b.wire(pan, 'l', L, 'in');
    b.wire(pan, 'r', R, 'in');
    const v = build(col, curve, vca);
    return { env, curve, vca, pan, ...v, members: [env, curve, ...v.members, vca, pan] };
  };
  const voices: V[] = [
    // 1: boom (a sine whose pitch rides the curve: the voltage drops, so does the pitch)
    voice(0, 0.35, [0, 0], (col, curve, vca) => {
      const osc = b.add('osc', col, 2, { wave: 0, coarse: -31, level: 1 });
      const boom = b.add('scale', col, 3, { gain: 1.5, offset: 0 });
      b.wire(curve, 'out', boom, 'in');
      b.wire(boom, 'out', osc, 'pitch');
      b.wire(osc, 'out', vca, 'in');
      return { members: [osc, boom], k1: [osc, 'coarse', 'pitch'], k2: [boom, 'gain', 'boom'] };
    }),
    // 2: a high square, starved: the curve bends it and the Bitcrusher folds it into metal (a drone at low pitch)
    voice(1, 0.06, [0, 0.15], (col, curve, vca) => {
      const osc = b.add('osc', col, 2, { wave: 3, coarse: 30, pw: 0.3, level: 0.7 });
      const bend = b.add('scale', col, 3, { gain: 1, offset: 0 });
      const crush = b.add('crush', col, 4, { bits: 16, rate: 6 });
      b.wire(curve, 'out', bend, 'in');
      b.wire(bend, 'out', osc, 'pitch');
      b.wire(osc, 'out', crush, 'in');
      b.wire(crush, 'out', vca, 'in');
      return { members: [osc, bend, crush], k1: [osc, 'coarse', 'pitch'], k2: [crush, 'rate', 'grit'] };
    }),
    // 3: noise through a band pass the curve opens (a snare's crack, a hiss)
    voice(2, 0.15, [0, 0], (col, curve, vca) => {
      const nz = b.add('noise', col, 2, { level: 1 });
      const bp = b.add('filter', col, 3, { cutoff: 1800, res: 0.5, cvamt: 2 });
      b.wire(nz, 'out', bp, 'in');
      b.wire(curve, 'out', bp, 'cv');
      b.wire(bp, 'bp', vca, 'in');
      return { members: [nz, bp], k1: [bp, 'cutoff', 'tone'], k2: [bp, 'res', 'ring'] };
    }),
    // 4: a triangle whose phase a square bends (growl), both pitched up hard by the curve (chirp)
    voice(3, 0.12, [0, 0.4], (col, curve, vca) => {
      const sq = b.add('osc', col, 2, { wave: 3, coarse: -5, level: 1 });
      const tri = b.add('osc', col, 3, { wave: 1, coarse: 7, pm: 2, level: 0.9 });
      const chirp = b.add('scale', col, 4, { gain: 2.5, offset: 0 });
      b.wire(curve, 'out', chirp, 'in');
      b.wire(chirp, 'out', tri, 'pitch');
      b.wire(chirp, 'out', sq, 'pitch');
      b.wire(sq, 'out', tri, 'pm');
      b.wire(tri, 'out', vca, 'in');
      return { members: [sq, tri, chirp], k1: [tri, 'coarse', 'pitch'], k2: [tri, 'pm', 'growl'] };
    }),
    // 5: a saw into a ladder whose cutoff follows the curve (squelch)
    voice(4, 0.25, [0.35, 0], (col, curve, vca) => {
      const osc = b.add('osc', col, 2, { wave: 2, coarse: -24, level: 0.9 });
      const lad = b.add('ladder', col, 3, { cutoff: 180, res: 0.7, cvamt: 4, drive: 2 });
      b.wire(osc, 'out', lad, 'in');
      b.wire(curve, 'out', lad, 'cv');
      b.wire(lad, 'lp24', vca, 'in');
      return { members: [osc, lad], k1: [osc, 'coarse', 'pitch'], k2: [lad, 'res', 'squelch'] };
    }),
  ];
  // CHOP: a square LFO (rate, depth) made unipolar (max(0, lfo)) and turned into a gain of 1 or 1 - depth, on both outputs
  const chop = b.add('lfo', 8, 0, { wave: 3, rate: 8, depth: 0 });
  const half = b.add('math', 8, 1, { ka: 0, kb: 1, off: 0 });
  const gain = b.add('math', 8, 2, { ka: 0, kb: 1, off: 1 });
  const vcaL = b.add('vca', 9, 0, { gain: 1 });
  const vcaR = b.add('vca', 9, 1, { gain: 1 });
  const melt = b.add('macro', 8, 3, { value: 0 });
  const meltL = b.add('crush', 10, 0, { bits: 16, rate: 1 }, { p1: 'rate' });
  const meltR = b.add('crush', 10, 1, { bits: 16, rate: 1 }, { p1: 'rate' });
  const scope = b.add('scope', 11, 0, { time: 16 });
  b.wire(chop, 'out', half, 'b');
  b.wire(half, 'max', gain, 'b');
  b.wire(gain, 'sub', vcaL, 'cv');
  b.wire(gain, 'sub', vcaR, 'cv');
  b.wire(L, 'out', vcaL, 'in');
  b.wire(R, 'out', vcaR, 'in');
  b.wire(vcaL, 'out', meltL, 'in');
  b.wire(vcaR, 'out', meltR, 'in');
  b.wire(melt, 'out', meltL, 'p1');
  b.wire(melt, 'out', meltR, 'p1');
  b.wire(meltL, 'out', scope, 'a');
  b.wire(meltR, 'out', scope, 'b');
  voices.forEach((v, i) => b.nest(`voice ${i + 1}`, 1 + i, 0, v.members));
  voices.forEach((v) => {
    b.nestInput('gate', v.env, 'gate');
    b.nestInput('poke', v.env, 'p1');
    b.nestInput('mod', v.curve, 'in2', [v.curve, 'in3']);
    b.nestOutput('a', v.pan, 'l');
    b.nestOutput('b', v.pan, 'r');
  });
  b.input('keys', map, 'keys');
  b.input('wheel', slewX, 'in');
  b.output('l', meltL, 'out');
  b.output('r', meltR, 'out');
  voices.forEach((v, i) => {
    b.param(v.k1[2], v.k1[0], v.k1[1], { head: `voice ${i + 1}`, ...(i === 0 || i === 3 ? { col: true } : {}) });
    b.param(v.k2[2], v.k2[0], v.k2[1]);
    b.param('tilt', v.env, 'r1');
    b.param('gate', v.env, 'r2');
    b.param('vol', v.vca, 'gain');
    b.param('a-b', v.pan, 'pan');
    b.param('x', v.curve, 'l2');
    b.param('y', v.curve, 'l3');
  });
  b.param('x gate', modX, 'r2', { col: true, head: 'mod' });
  b.param('x slew', slewX, 'time');
  b.param('y gate', modY, 'r2');
  b.param('y slew', slewY, 'time');
  b.param('chop', chop, 'rate', { head: 'ctl all' });
  b.param('chop depth', chop, 'depth');
  b.param('melt', melt, 'value');
  b.param('vol a', L, 'level', { head: 'out' });
  b.param('vol b', R, 'level');
  b.param('out', scope, 'view', { col: true });
});

// Meridian 8, after the Landscape NOON (the instrument's page, landscape.fm/noon): eight passive circuits powered by their
// gates, no supply of their own. A Drum map row is a channel's gate; its "power" (an ADSR: up while the gate is held,
// sagging after it) is the VCA's cv and also pushes the circuit's pitch or filter, so a hit swoops and a dying gate
// starves the sound. Channels: 1 DOT (a saw through a ladder low pass), 2 DUAL (a sine ping), 3 SYS (a resonator struck
// at the gate, the power sweeps its pitch), 4 PLAST (noise through a comb filter the power stretches), 5 CYMPATH (a narrow
// square crumbled by a Bitcrusher), 6 CYRINX (a chirping triangle), 7 LARYNX (a saw through a formant filter the power
// moves), 8 BACID (a saw into an acid ladder); each with its two tone sliders and its volume (the cheaper modules where the
// first try, two Multimodes on cv and a three-voice cluster, read 85 %). LINK: channel n's power into channel n + 1 (8
// into 1), by an amount: a powered channel half-powers its neighbour. ODD / EVEN CV: an offset into the odd / even
// channels (they drone, and the voltage detunes them). The odd channels sum to the left output, the even ones to the
// right (the original's two main outputs), each through a saturator for the passive mix's squash; one main volume.
asm('Meridian 8', 'Drums', (b) => {
  const map = b.add('drummap', 0, 0, Object.fromEntries(PLATE_KEYS[1].map((n, r) => [`n${r + 1}`, n])));
  b.module(map).names = ['DOT', 'DUAL', 'SYS', 'PLAST', 'CYMPATH', 'CYRINX', 'LARYNX', 'BACID'];
  const odd = b.add('macro', 0, 1, { value: 0 });
  const even = b.add('macro', 0, 2, { value: 0 });
  const L = b.add('shape', 9, 0, { drive: 1.5, mode: 0, level: 0 }, { p1: 'level' });
  const R = b.add('shape', 9, 1, { drive: 1.5, mode: 0, level: 0 }, { p1: 'level' });
  const main = b.add('macro', 9, 2, { value: 0.8 });
  const scope = b.add('scope', 10, 0, { time: 16 });
  type Ch = { name: string; env: number; vca: number; members: number[]; power: [number, string][]; s1: [number, string, string]; s2: [number, string, string] };
  const channel = (i: number, name: string, adsr: Record<string, number>, build: (col: number, env: number, vca: number) => Omit<Ch, 'name' | 'env' | 'vca'>): Ch => {
    const col = 1 + i;
    const env = b.add('adsr', col, 0, adsr);
    const vca = b.add('vca', col, 4, { gain: 0.8 });
    b.wire(map, `g${i + 1}`, env, 'gate');
    const c = build(col, env, vca);
    for (const [m, port] of [[vca, 'cv'] as [number, string], ...c.power]) b.wire(env, 'env', m, port);
    b.wire(vca, 'out', i % 2 === 0 ? L : R, 'in');
    return { name, env, vca, ...c, power: [[vca, 'cv'], ...c.power], members: [env, ...c.members, vca] };
  };
  const chs: Ch[] = [
    channel(0, 'dot', { a: 0.002, d: 0.08, s: 0.6, r: 0.15 }, (col, env, vca) => {
      const osc = b.add('osc', col, 1, { wave: 2, coarse: -17, level: 0.8 });
      const lp = b.add('ladder', col, 2, { cutoff: 600, res: 0.4, cvamt: 3 });
      b.wire(osc, 'out', lp, 'in');
      b.wire(lp, 'lp12', vca, 'in');
      return { members: [osc, lp], power: [[osc, 'pitch'], [lp, 'cv']], s1: [osc, 'coarse', 'pitch'], s2: [lp, 'cutoff', 'filter'] };
    }),
    channel(1, 'dual', { a: 0.001, d: 0.25, s: 0.3, r: 0.3 }, (col, env, vca) => {
      const osc = b.add('osc', col, 1, { wave: 0, coarse: -24, level: 1 });
      const ping = b.add('scale', col, 2, { gain: 1.5, offset: 0 });
      b.wire(env, 'env', ping, 'in');
      b.wire(ping, 'out', osc, 'pitch');
      b.wire(osc, 'out', vca, 'in');
      return { members: [osc, ping], power: [], s1: [osc, 'coarse', 'pitch'], s2: [ping, 'gain', 'ping'] };
    }),
    channel(2, 'sys', { a: 0.001, d: 0.1, s: 0.5, r: 0.2 }, (col, env, vca) => {
      const strike = b.add('pulse', col, 1, { time: 0.002 });
      const hit = b.add('scale', col, 2, { gain: 0.03, offset: 0 });
      const res = b.add('modal', col, 3, { coarse: -10, decay: 0.4, struct: 0.3, bright: 0.6, damp: 0.4 });
      b.wire(map, 'g3', strike, 'trig');
      b.wire(strike, 'out', hit, 'in');
      b.wire(hit, 'out', res, 'in');
      b.wire(res, 'out', vca, 'in');
      return { members: [strike, hit, res], power: [[res, 'pitch']], s1: [res, 'coarse', 'pitch'], s2: [res, 'struct', 'hollow'] };
    }),
    channel(3, 'plast', { a: 0.003, d: 0.12, s: 0.4, r: 0.25 }, (col, env, vca) => {
      const nz = b.add('noise', col, 1, { level: 0.6, color: 0.3 });
      const cb = b.add('comb', col, 2, { coarse: 5, fb: 0.85, damp: 0.3, mix: 1 });
      b.wire(nz, 'out', cb, 'in');
      b.wire(cb, 'out', vca, 'in');
      return { members: [nz, cb], power: [[cb, 'pitch']], s1: [cb, 'coarse', 'tone'], s2: [cb, 'fb', 'squish'] };
    }),
    channel(4, 'cympath', { a: 0.001, d: 0.15, s: 0.2, r: 0.35 }, (col, env, vca) => {
      const osc = b.add('osc', col, 1, { wave: 3, coarse: 26, pw: 0.35, level: 0.6 });
      const crush = b.add('crush', col, 2, { bits: 16, rate: 3 });
      b.wire(osc, 'out', crush, 'in');
      b.wire(crush, 'out', vca, 'in');
      return { members: [osc, crush], power: [[osc, 'pitch']], s1: [osc, 'coarse', 'pitch'], s2: [crush, 'rate', 'crumble'] };
    }),
    channel(5, 'cyrinx', { a: 0.005, d: 0.06, s: 0.5, r: 0.12 }, (col, env, vca) => {
      const osc = b.add('osc', col, 1, { wave: 1, coarse: 12, level: 0.9 });
      const chirp = b.add('scale', col, 2, { gain: 2, offset: 0 });
      b.wire(env, 'env', chirp, 'in');
      b.wire(chirp, 'out', osc, 'pitch');
      b.wire(osc, 'out', vca, 'in');
      return { members: [osc, chirp], power: [], s1: [osc, 'coarse', 'pitch'], s2: [chirp, 'gain', 'chirp'] };
    }),
    channel(6, 'larynx', { a: 0.01, d: 0.2, s: 0.6, r: 0.3 }, (col, env, vca) => {
      const osc = b.add('osc', col, 1, { wave: 2, coarse: -12, level: 0.8 });
      const vow = b.add('vowel', col, 2, { vowel: 0.5, res: 0.7, level: 1 });
      b.wire(osc, 'out', vow, 'in');
      b.wire(vow, 'out', vca, 'in');
      return { members: [osc, vow], power: [[osc, 'pitch'], [vow, 'vowel']], s1: [osc, 'coarse', 'pitch'], s2: [vow, 'vowel', 'vowel'] };
    }),
    channel(7, 'bacid', { a: 0.001, d: 0.18, s: 0.4, r: 0.2 }, (col, env, vca) => {
      const osc = b.add('osc', col, 1, { wave: 2, coarse: -29, level: 0.9 });
      const lad = b.add('ladder', col, 2, { cutoff: 150, res: 0.75, cvamt: 4, drive: 2 });
      b.wire(osc, 'out', lad, 'in');
      b.wire(lad, 'lp24', vca, 'in');
      return { members: [osc, lad], power: [[lad, 'cv']], s1: [osc, 'coarse', 'pitch'], s2: [lad, 'res', 'acid'] };
    }),
  ];
  // the links: channel n's power (its own ADSR, not what it receives) into the next channel's power inputs
  const links = chs.map((c, i) => {
    const to = chs[(i + 1) % chs.length];
    const link = b.add('scale', 1 + i, 5, { gain: 0, offset: 0 });
    b.wire(c.env, 'env', link, 'in');
    for (const [m, port] of to.power) b.wire(link, 'out', m, port);
    return link;
  });
  chs.forEach((c, i) => {
    for (const [m, port] of c.power) b.wire(i % 2 === 0 ? odd : even, 'out', m, port);
  });
  b.wire(main, 'out', L, 'p1');
  b.wire(main, 'out', R, 'p1');
  b.wire(L, 'out', scope, 'a');
  b.wire(R, 'out', scope, 'b');
  chs.forEach((c, i) => b.nest(`${i + 1} ${c.name}`, 1 + i, 0, c.members));
  chs.forEach((c) => {
    b.nestInput('gate', c.env, 'gate');
    b.nestInput('power', c.vca, 'cv', ...c.power.slice(1));
    b.nestOutput('out', c.vca, 'out');
  });
  b.input('keys', map, 'keys');
  b.output('l', L, 'out');
  b.output('r', R, 'out');
  chs.forEach((c, i) => {
    b.param(c.s1[2], c.s1[0], c.s1[1], { head: `${i + 1} ${c.name}`, ...(i % 4 === 0 ? { col: true } : {}) });
    b.param(c.s2[2], c.s2[0], c.s2[1]);
    b.param('vol', c.vca, 'gain');
  });
  links.forEach((l, i) => b.param(`${i + 1}-${((i + 1) % 8) + 1}`, l, 'gain', i === 0 ? { col: true, head: 'link' } : {}));
  b.param('odd cv', odd, 'value', { col: true, head: 'cv' });
  b.param('even cv', even, 'value');
  b.param('main', main, 'value', { head: 'out' });
  b.param('out', scope, 'view', { col: true });
});

// Perun 4, after the Erica Synths PERKONS HD-01 (the manual's voice tables and Sound On Sound's review): four drum voices
// with the same eight controls each: TUNE, DECAY, PARAM 1 / 2 (one algorithm per voice here: 1 the FOLD DRUM, a sine with
// a pitch drop (param 1) through a wavefolder (param 2); 2 the WAVETABLE DRUM (wave, table); 3 the RESONANT SNARE, a sine
// body crossfaded with noise (noise, tone = the noise's color); 4 the NOISE HAT, noise crossfaded with a pulse stack of
// two squares (the mix, the second square's pitch); phase modulation, tried for 2 and 4, cost 8 points), then the filter without
// resonance (CUTOFF, MODE from low pass to high pass), the overdrive (DRIVE), the FX send and the LEVEL. A Drum map row per
// voice (the white keys from F3); its velocity is the hit's height (a pin on the envelope's l1): the sequencer's accent.
// The sends feed the BBD-style delay (TIME, FEEDBACK; its LFO bends the time), the delay returns into the mix, the mix into
// the master compressor (COMP = threshold, MASTER = make-up gain). The global LFO reaches only the delay time (into the
// four tunings it read 8 points more: an oscillator with a moving pitch costs more).
asm('Perun 4', 'Drums', (b) => {
  const map = b.add('drummap', 0, 0, Object.fromEntries(PLATE_KEYS[1].map((n, r) => [`n${r + 1}`, n])));
  b.module(map).names = ['VOICE 1', 'VOICE 2', 'VOICE 3', 'VOICE 4', 'ROW 5', 'ROW 6', 'ROW 7', 'ROW 8'];
  const lfo = b.add('lfo', 0, 1, { wave: 0, rate: 0.3, depth: 1 });
  const toTime = b.add('scale', 0, 2, { gain: 0.02, offset: 0 });
  const mix = b.add('mixer', 5, 0, { l1: 0.9, l2: 0.7, l3: 0.7, l4: 0.5 });
  const send = b.add('mixer', 5, 1, { l1: 0, l2: 0.2, l3: 0.3, l4: 0.15 });
  const dly = b.add('delay', 6, 1, { time: 300, fb: 0.35, mix: 1 }, { p1: 'time' });
  const comp = b.add('dyn', 6, 0, { thresh: -14, ratio: 3, attack: 0.005, release: 0.15, gain: 3 });
  const scope = b.add('scope', 7, 0, { time: 16 });
  b.wire(lfo, 'out', toTime, 'in');
  b.wire(toTime, 'out', dly, 'p1');
  b.wire(send, 'out', dly, 'in');
  b.wire(mix, 'out', comp, 'in');
  b.wire(dly, 'out', comp, 'in');
  b.wire(comp, 'out', scope, 'a');
  type V = { env: number; vca: number; flt: number; drive: number; tune: [number, string]; p1: [number, string]; p2: [number, string]; members: number[] };
  const voice = (i: number, decay: number, cutoff: number, morph: number, build: (col: number, env: number, vca: number) => Omit<V, 'env' | 'vca' | 'flt' | 'drive' | 'members'> & { members: number[] }): V => {
    const col = 1 + i;
    const env = b.add('env', col, 0, { l1: 0, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001 }, { p1: 'l1' });
    const vca = b.add('vca', col, 4, { gain: 1 });
    const flt = b.add('filter', col, 5, { cutoff, res: 0, morph });
    const drive = b.add('shape', col, 6, { drive: 1.5, mode: 0, level: 0.8 });
    b.wire(map, `g${i + 1}`, env, 'gate');
    b.wire(map, `v${i + 1}`, env, 'p1');
    b.wire(env, 'env', vca, 'cv');
    b.wire(vca, 'out', flt, 'in');
    b.wire(flt, 'mix', drive, 'in');
    b.wire(drive, 'out', mix, `in${i + 1}`);
    b.wire(drive, 'out', send, `in${i + 1}`);
    const v = build(col, env, vca);
    return { env, vca, flt, drive, ...v, members: [env, ...v.members, vca, flt, drive] };
  };
  const voices: V[] = [
    // 1 FOLD DRUM: a sine, its own fast pitch envelope (param 1 = the drop), a wavefolder (param 2)
    voice(0, 0.45, 9000, 0, (col, env, vca) => {
      const osc = b.add('osc', col, 1, { wave: 0, coarse: -27, level: 1 });
      const penv = b.add('env', col, 2, { l1: 1, r1: 0.001, l2: 0, r2: 0.05, l3: 0, r3: 0.001, l4: 0, r4: 0.001 });
      const drop = b.add('scale', col, 3, { gain: 2, offset: 0 });
      const fold = b.add('shape', col, 3.5, { drive: 1.2, mode: 2, level: 0.9 });
      b.wire(map, 'g1', penv, 'gate');
      b.wire(penv, 'env', drop, 'in');
      b.wire(drop, 'out', osc, 'pitch');
      b.wire(osc, 'out', fold, 'in');
      b.wire(fold, 'out', vca, 'in');
      return { members: [osc, penv, drop, fold], tune: [osc, 'coarse'], p1: [drop, 'gain'], p2: [fold, 'drive'] };
    }),
    // 2 WAVETABLE DRUM: a wavetable oscillator with a little pitch drop (param 1 = the wave, param 2 = the table)
    voice(1, 0.3, 7000, 0, (col, env, vca) => {
      const wt = b.add('wavetable', col, 1, { bank: 1, pos: 0.3, coarse: -12, level: 1 });
      const drop = b.add('scale', col, 3, { gain: 0.4, offset: 0 });
      b.wire(env, 'env', drop, 'in');
      b.wire(drop, 'out', wt, 'pitch');
      b.wire(wt, 'out', vca, 'in');
      return { members: [wt, drop], tune: [wt, 'coarse'], p1: [wt, 'pos'], p2: [wt, 'bank'] };
    }),
    // 3 RESONANT SNARE: a sine body and noise, crossfaded (param 1), the noise's color (param 2)
    voice(2, 0.18, 250, 1, (col, env, vca) => {
      const body = b.add('osc', col, 1, { wave: 0, coarse: -8, level: 0.9 });
      const nz = b.add('noise', col, 2, { level: 1, color: 0 });
      const xf = b.add('xfade', col, 3, { mix: 0.6 });
      b.wire(body, 'out', xf, 'a');
      b.wire(nz, 'out', xf, 'b');
      b.wire(xf, 'out', vca, 'in');
      return { members: [body, nz, xf], tune: [body, 'coarse'], p1: [xf, 'mix'], p2: [nz, 'color'] };
    }),
    // 4 NOISE HAT: noise crossfaded with a pulse stack, two squares (param 1 = the mix, param 2 = the second square's pitch)
    voice(3, 0.06, 6000, 1, (col, env, vca) => {
      const sq = b.add('osc', col, 1, { wave: 3, coarse: 31, pw: 0.3, level: 0.6 });
      const sq2 = b.add('osc', col, 2, { wave: 3, coarse: 37, fine: 40, pw: 0.4, level: 0.6 });
      const nz = b.add('noise', col, 2.5, { level: 1, color: 0 });
      const xf = b.add('xfade', col, 3, { mix: 0.5 });
      b.wire(sq, 'out', xf, 'a');
      b.wire(sq2, 'out', xf, 'a');
      b.wire(nz, 'out', xf, 'b');
      b.wire(xf, 'out', vca, 'in');
      return { members: [sq, sq2, nz, xf], tune: [sq, 'coarse'], p1: [xf, 'mix'], p2: [sq2, 'coarse'] };
    }),
  ];
  voices.forEach((v, i) => b.nest(`voice ${i + 1}`, 1 + i, 0, v.members));
  voices.forEach((v) => {
    b.nestInput('gate', v.env, 'gate');
    b.nestInput('accent', v.env, 'p1');
    b.nestOutput('out', v.drive, 'out');
  });
  b.input('keys', map, 'keys');
  b.output('out', comp, 'out');
  voices.forEach((v, i) => {
    b.param('tune', v.tune[0], v.tune[1], { head: `voice ${i + 1}`, col: true });
    b.param('decay', v.env, 'r2');
    b.param('param 1', v.p1[0], v.p1[1]);
    b.param('param 2', v.p2[0], v.p2[1]);
    b.param('cutoff', v.flt, 'cutoff');
    b.param('mode', v.flt, 'morph');
    b.param('drive', v.drive, 'drive');
    b.param('send', send, `l${i + 1}`);
    b.param('level', mix, `l${i + 1}`);
  });
  b.param('time', dly, 'time', { col: true, head: 'delay' });
  b.param('feedback', dly, 'fb');
  b.param('lfo → time', toTime, 'gain');
  b.param('lfo rate', lfo, 'rate', { head: 'lfo' });
  b.param('lfo wave', lfo, 'wave');
  b.param('comp', comp, 'thresh', { head: 'master' });
  b.param('master', comp, 'gain');
  b.param('out', scope, 'view', { col: true });
});

// Spokes 6, after the Elektron Model:Cycles (its user manual's track parameters, the reviews' account of the machines):
// six tracks of FM voices, one machine each, with the original's six synthesis controls on every track: PITCH (an
// offset in octaves on every oscillator of the voice), DECAY (the amp envelope), COLOR, SHAPE, SWEEP and CONTOUR, which
// do a different thing per machine (Elektron does not publish the engines; these follow what the manual and the reviews
// say each one does), then VOLUME and the DELAY and REVERB sends. 1 KICK: a sine carrier phase-modulated by a sine
// (color = the index, shape = the modulator's interval), a pitch envelope (sweep = its depth, contour = its time).
// 2 SNARE: a phase-modulated body (color = the inharmonic index) and a noise burst (shape = the noise level, contour =
// its decay), the amp envelope sweeping the pitch (sweep). 3 METAL: a square phase-modulated by a sine at an inharmonic
// interval (color = the interval, contour = the index) through a high pass (shape = the cutoff) the envelope opens
// (sweep). 4 PERC: an FM pair whose index has its own envelope (color = the index, shape = the ratio, contour = the
// index's decay: ringing to damped), sweep = the pitch drop. A Drum map row each (the white keys from F3); the velocity
// is the hit's height (a pin on the amp envelope's l1): a Steps accent is the original's PUNCH. 5 TONE: a two-operator
// FM voice on its own keys (color = the ratio, shape = the index, sweep = noise into the carrier's phase for grit,
// contour = the index's decay). 6 CHORD: three saws on its own keys (shape = the chord's middle note in semitones, 3
// minor, 4 major, 5 sus4; color = the top note, 7 a fifth, 10 a minor seventh), a low pass (sweep), the attack
// (contour). The sends feed one delay (time, feedback) and one reverb (size, tone); both return into the mix, which
// goes through the master saturator (dist, the original's VOLUME + DIST past 60) to the output.
asm('Spokes 6', 'Drums', (b) => {
  const map = b.add('drummap', 0, 0, Object.fromEntries(PLATE_KEYS[1].map((n, r) => [`n${r + 1}`, n])));
  b.module(map).names = ['KICK', 'SNARE', 'METAL', 'PERC', 'ROW 5', 'ROW 6', 'ROW 7', 'ROW 8'];
  const mixA = b.add('mixer', 7, 0, { l1: 0.9, l2: 0.85, l3: 0.9, l4: 0.6 });
  const mixB = b.add('mixer', 7, 1, { l1: 0.35, l2: 0.7, l3: 1, l4: 1 });
  const dsA = b.add('mixer', 7, 2, { l1: 0, l2: 0.15, l3: 0.1, l4: 0.3 });
  const dsB = b.add('mixer', 7, 3, { l1: 0.25, l2: 0.2, l3: 1, l4: 0 });
  const dly = b.add('delay', 8, 2, { time: 375, fb: 0.4, mix: 1 });
  const master = b.add('shape', 8, 0, { drive: 1, mode: 0, level: 0.8 });
  const scope = b.add('scope', 9, 0, { time: 16 });
  b.wire(mixA, 'out', mixB, 'in3');
  b.wire(dsA, 'out', dsB, 'in3');
  b.wire(dsB, 'out', dly, 'in');
  b.wire(dly, 'out', mixB, 'in4');
  b.wire(mixB, 'out', master, 'in');
  b.wire(master, 'out', scope, 'a');
  type Row = [number, string];
  type T = { name: string; members: number[]; pitchIn?: number; out: number[]; gate: [number, string][]; rows: Record<'pitch' | 'decay' | 'color' | 'shape' | 'sweep' | 'contour', Row>; mix: [number, string]; ds: [number, string] };
  const tracks: T[] = [];
  /** a track's voice into its mixer, delay send and reverb send inputs (tracks 1..4 on the A mixers, 5 and 6 on the B) */
  const track = (i: number, name: string, make: (col: number) => Omit<T, 'name' | 'mix' | 'ds'>): void => {
    const t = make(1 + i);
    const [mix, ds] = i < 4 ? [mixA, dsA] : [mixB, dsB];
    const n = i < 4 ? i + 1 : i - 3;
    for (const o of t.out) for (const m of [mix, ds]) b.wire(o, 'out', m, `in${n}`);
    tracks.push({ name, ...t, mix: [mix, `l${n}`], ds: [ds, `l${n}`] });
  };
  /** a drum track's amp envelope: a Drum map row's gate, its velocity the height (pin p1 on l1) */
  const ampEnv = (col: number, r: number, decay: number): number => {
    const env = b.add('env', col, 0, { l1: 0, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001 }, { p1: 'l1' });
    b.wire(map, `g${r}`, env, 'gate');
    b.wire(map, `v${r}`, env, 'p1');
    return env;
  };
  // 1 KICK
  track(0, 'kick', (col) => {
    const env = ampEnv(col, 1, 0.45);
    const penv = b.add('adsr', col, 1, { a: 0.001, d: 0.05, s: 0, r: 0.08 });
    const sweep = b.add('scale', col, 2, { gain: 2.5, offset: -2.25 });
    const car = b.add('osc', col, 3, { wave: 0, coarse: 0, pm: 0.4, level: 1 });
    const op = b.add('osc', col, 3.5, { wave: 0, coarse: 12, level: 1 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    b.wire(map, 'g1', penv, 'gate');
    b.wire(penv, 'env', sweep, 'in');
    b.wire(sweep, 'out', car, 'pitch');
    b.wire(sweep, 'out', op, 'pitch');
    b.wire(op, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { members: [env, penv, sweep, car, op, vca], out: [vca], gate: [[env, 'gate'], [penv, 'gate']], rows: { pitch: [sweep, 'offset'], decay: [env, 'r2'], color: [car, 'pm'], shape: [op, 'coarse'], sweep: [sweep, 'gain'], contour: [penv, 'd'] } };
  });
  // 2 SNARE
  track(1, 'snare', (col) => {
    const env = ampEnv(col, 2, 0.16);
    const sweep = b.add('scale', col, 1, { gain: 0.5, offset: -0.75 });
    const body = b.add('osc', col, 2, { wave: 0, coarse: 0, level: 0.8 });
    const vca = b.add('vca', col, 3, { gain: 1 });
    const nz = b.add('noise', col, 3.5, { level: 0.8, color: 0.3 });
    const nenv = b.add('adsr', col, 4, { a: 0.001, d: 0.12, s: 0, r: 0.15 });
    const nvca = b.add('vca', col, 4.5, { gain: 1 });
    b.wire(env, 'env', sweep, 'in');
    b.wire(sweep, 'out', body, 'pitch');
    b.wire(body, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    b.wire(map, 'g2', nenv, 'gate');
    b.wire(nz, 'out', nvca, 'in');
    b.wire(nenv, 'env', nvca, 'cv');
    return { members: [env, sweep, body, vca, nz, nenv, nvca], out: [vca, nvca], gate: [[env, 'gate'], [nenv, 'gate']], rows: { pitch: [sweep, 'offset'], decay: [env, 'r2'], color: [nz, 'color'], shape: [nz, 'level'], sweep: [sweep, 'gain'], contour: [nenv, 'd'] } };
  });
  // 3 METAL
  track(2, 'metal', (col) => {
    const env = ampEnv(col, 3, 0.12);
    const sq1 = b.add('osc', col, 2, { wave: 3, coarse: 30, pw: 0.5, level: 0.8 });
    const sq2 = b.add('osc', col, 2.5, { wave: 3, coarse: 37, fine: 35, pw: 0.4, level: 0.8 });
    const open = b.add('scale', col, 3, { gain: 1, offset: 0 });
    const hp = b.add('filter', col, 3.5, { cutoff: 2500, res: 0.1, cvamt: 2 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    b.wire(env, 'env', open, 'in');
    b.wire(open, 'out', hp, 'cv');
    b.wire(sq1, 'out', hp, 'in');
    b.wire(sq2, 'out', hp, 'in');
    b.wire(hp, 'hp', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { members: [env, sq1, sq2, open, hp, vca], out: [vca], gate: [[env, 'gate']], rows: { pitch: [sq1, 'coarse'], decay: [env, 'r2'], color: [sq2, 'coarse'], shape: [hp, 'cutoff'], sweep: [open, 'gain'], contour: [hp, 'res'] } };
  });
  // 4 PERC
  track(3, 'perc', (col) => {
    const env = ampEnv(col, 4, 0.25);
    const sweep = b.add('scale', col, 1, { gain: 0.3, offset: -0.5 });
    const ienv = b.add('adsr', col, 1.5, { a: 0.001, d: 0.08, s: 0, r: 0.1 });
    const car = b.add('osc', col, 2, { wave: 0, coarse: 0, pm: 2.5, level: 1 });
    const op = b.add('osc', col, 2.5, { wave: 0, coarse: 19, level: 1 });
    const ivca = b.add('vca', col, 3, { gain: 1 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    b.wire(map, 'g4', ienv, 'gate');
    b.wire(env, 'env', sweep, 'in');
    b.wire(sweep, 'out', car, 'pitch');
    b.wire(sweep, 'out', op, 'pitch');
    b.wire(op, 'out', ivca, 'in');
    b.wire(ienv, 'env', ivca, 'cv');
    b.wire(ivca, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { members: [env, sweep, ienv, car, op, ivca, vca], out: [vca], gate: [[env, 'gate'], [ienv, 'gate']], rows: { pitch: [sweep, 'offset'], decay: [env, 'r2'], color: [car, 'pm'], shape: [op, 'coarse'], sweep: [sweep, 'gain'], contour: [ienv, 'd'] } };
  });
  // 5 TONE: its own pitch and gate (a Steps track's)
  track(4, 'tone', (col) => {
    const pitch = b.add('scale', col, 0, { gain: 1, offset: 0 });
    const env = b.add('adsr', col, 1, { a: 0.002, d: 0.5, s: 0, r: 0.3 });
    const ienv = b.add('adsr', col, 1.5, { a: 0.001, d: 0.3, s: 0, r: 0.3 });
    const op = b.add('osc', col, 2, { wave: 0, coarse: 12, level: 1 });
    const nz = b.add('noise', col, 2.5, { level: 0, color: 0 });
    const ivca = b.add('vca', col, 3, { gain: 1 });
    const car = b.add('osc', col, 3.5, { wave: 0, coarse: 0, pm: 1.5, level: 1 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    b.wire(pitch, 'out', op, 'pitch');
    b.wire(pitch, 'out', car, 'pitch');
    b.wire(op, 'out', ivca, 'in');
    b.wire(nz, 'out', ivca, 'in');
    b.wire(ienv, 'env', ivca, 'cv');
    b.wire(ivca, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { pitchIn: pitch, members: [pitch, env, ienv, op, nz, ivca, car, vca], out: [vca], gate: [[env, 'gate'], [ienv, 'gate']], rows: { pitch: [pitch, 'offset'], decay: [env, 'd'], color: [op, 'coarse'], shape: [car, 'pm'], sweep: [nz, 'level'], contour: [ienv, 'd'] } };
  });
  // 6 CHORD: its own pitch and gate (a Steps track's), a stacked saw and the chord's middle note
  track(5, 'chord', (col) => {
    const pitch = b.add('scale', col, 0, { gain: 1, offset: 0 });
    const env = b.add('adsr', col, 1, { a: 0.005, d: 0.8, s: 0, r: 0.4 });
    const o1 = b.add('osc', col, 2, { wave: 2, coarse: 0, stack: 2, level: 0.5 });
    const o2 = b.add('osc', col, 2.5, { wave: 2, coarse: 3, fine: 4, level: 0.3 });
    const lp = b.add('filter', col, 3, { cutoff: 2000, res: 0.2 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    for (const o of [o1, o2]) {
      b.wire(pitch, 'out', o, 'pitch');
      b.wire(o, 'out', lp, 'in');
    }
    b.wire(lp, 'lp24', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { pitchIn: pitch, members: [pitch, env, o1, o2, lp, vca], out: [vca], gate: [[env, 'gate']], rows: { pitch: [pitch, 'offset'], decay: [env, 'd'], color: [o1, 'stack'], shape: [o2, 'coarse'], sweep: [lp, 'cutoff'], contour: [env, 'a'] } };
  });
  tracks.forEach((t, i) => b.nest(`${i + 1} ${t.name}`, 1 + i, 0, t.members));
  tracks.forEach((t, i) => {
    // (the tone and chord tracks' pitch and gate are the engine's own inputs: they show on their cards as those)
    if (i < 4) {
      b.nestInput('gate', ...t.gate[0], ...t.gate.slice(1));
      b.nestInput('accent', t.gate[0][0], 'p1');
    }
    b.nestOutput('out', t.out[0], 'out');
  });
  b.input('keys', map, 'keys');
  b.input('tone pitch', tracks[4].pitchIn!, 'in');
  b.input('tone gate', ...tracks[4].gate[0], ...tracks[4].gate.slice(1));
  b.input('chord pitch', tracks[5].pitchIn!, 'in');
  b.input('chord gate', ...tracks[5].gate[0], ...tracks[5].gate.slice(1));
  b.output('out', master, 'out');
  tracks.forEach((t, i) => {
    const r = t.rows;
    b.param('pitch', ...r.pitch, { head: `${i + 1} ${t.name}`, ...(i % 2 === 0 ? { col: true } : {}) });
    b.param('decay', ...r.decay);
    b.param('color', ...r.color);
    b.param('shape', ...r.shape);
    b.param('sweep', ...r.sweep);
    b.param('contour', ...r.contour);
    b.param('volume', ...t.mix);
    b.param('delay', ...t.ds);
  });
  b.param('time', dly, 'time', { col: true, head: 'delay' });
  b.param('feedback', dly, 'fb');
  b.param('dist', master, 'drive', { head: 'master' });
  b.param('master', master, 'level');
  b.param('out', scope, 'view', { col: true });
});

// an LFO through a Scale: vibrato (into a pitch input), tremolo (into a VCA's cv with an offset), a filter sweep
asm('vibrato', 'Utilities', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 0, rate: 5, depth: 1 });
  const sc = b.add('scale', 1, 0, { gain: 0.03, offset: 0 });
  b.wire(lfo, 'out', sc, 'in');
  b.input('reset', lfo, 'reset');
  b.output('out', sc, 'out');
  b.param('rate', lfo, 'rate');
  b.param('depth', sc, 'gain');
  b.param('offset', sc, 'offset');
  b.param('wave', lfo, 'wave');
});

// a step sequencer with its own clock: pitch (quantized) and gate out; add its pitch to Main's into an oscillator
asm('step sequencer', 'Utilities', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const sq = b.add('seq', 1, 0, { s1: 0, s2: 0.25, s3: 0.58, s4: 0.33, s5: 0, s6: 0.75, s7: 0.58, s8: 1, len: 8, dir: 0 });
  const qn = b.add('quant', 2, 0, { scale: 1, root: 0 });
  b.wire(clk, 'out', sq, 'clock');
  b.wire(sq, 'out', qn, 'in');
  b.input('reset', sq, 'reset', [clk, 'reset']);
  b.output('pitch', qn, 'out');
  b.output('gate', sq, 'gate');
  b.param('tempo', clk, 'rate', { head: 'sequence' });
  b.param('length', sq, 'len');
  b.param('direction', sq, 'dir');
  b.param('scale', qn, 'scale');
  b.param('root', qn, 'root');
  for (const q of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) b.param(q, sq, q, q === 's1' ? { head: 'steps' } : {});
});

// a random melody: clocked sample & hold on noise, quantized; a pulse makes the gate
asm('random melody', 'Utilities', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 6, depth: 1 });
  const nz = b.add('noise', 1, 0, { level: 0.6 });
  const sh = b.add('sh', 2, 0, { mode: 0 });
  const qn = b.add('quant', 3, 0, { scale: 4, root: 0 });
  const pl = b.add('pulse', 1, 1, { time: 0.08 });
  b.wire(nz, 'out', sh, 'in');
  b.wire(clk, 'out', sh, 'clock');
  b.wire(sh, 'out', qn, 'in');
  b.wire(clk, 'out', pl, 'trig');
  b.input('reset', clk, 'reset');
  b.output('pitch', qn, 'out');
  b.output('gate', pl, 'out');
  b.param('tempo', clk, 'rate');
  b.param('range', nz, 'level');
  b.param('scale', qn, 'scale');
  b.param('root', qn, 'root');
  b.param('gate length', pl, 'time');
});

// a clock with divisions
asm('clock', 'Utilities', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 4, depth: 1 });
  const dv = b.add('clkdiv', 1, 0, { div: 3 });
  b.wire(clk, 'out', dv, 'clock');
  b.input('reset', clk, 'reset', [dv, 'reset']);
  b.output('clock', clk, 'out');
  b.output('/2', dv, 'd2');
  b.output('/4', dv, 'd4');
  b.output('/8', dv, 'd8');
  b.output('/div', dv, 'out');
  b.param('rate', clk, 'rate');
  b.param('div', dv, 'div');
});

// ---- granular

// a cloud: whatever comes in, scattered into a dense pitch-true cloud; `freeze` is the instrument: play a chord, freeze it,
// play over the cloud (put a Reverb after it)
asm('cloud', 'Textures', (b) => {
  const gr = b.add('grain', 0, 0, { position: 0.3, size: 0.15, density: 25, pitch: 0, spray: 0.6, freeze: 0, mix: 1 });
  b.input('in', gr, 'in');
  b.input('trig', gr, 'trig');
  b.output('out', gr, 'out');
  b.param('freeze', gr, 'freeze');
  b.param('position', gr, 'position');
  b.param('pitch', gr, 'pitch');
  b.param('spray', gr, 'spray');
  b.param('size', gr, 'size');
  b.param('density', gr, 'density');
  b.param('mix', gr, 'mix');
});

// shimmer: the reverb's tail is fed back through a granular pitch shift an octave up (one Reverb and one Granular: the
// patch cannot hold another of either)
asm('shimmer', 'Textures', (b) => {
  const mix = b.add('mixer', 0, 0, { l1: 1, l2: 0.4, l3: 0, l4: 0 });
  const rv = b.add('reverb', 1, 0, { size: 0.8, damp: 0.3, mix: 0.5, pre: 10, mod: 0.4 });
  const gr = b.add('grain', 2, 0, { position: 0.05, size: 0.25, density: 12, pitch: 12, spray: 0, freeze: 0, mix: 1 });
  b.wire(mix, 'out', rv, 'in');
  b.wire(rv, 'out', gr, 'in');
  b.wire(gr, 'out', mix, 'in2');
  b.input('in', mix, 'in1');
  b.output('out', rv, 'out');
  b.param('shimmer', mix, 'l2');
  b.param('decay', rv, 'size');
  b.param('interval', gr, 'pitch');
  b.param('damp', rv, 'damp');
  b.param('mix', rv, 'mix');
});

// stutter: grains fired by an internal clock (divided), the read position jumping with a slow square; density 0 = only the
// clock fires grains
asm('stutter', 'Effects', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const dv = b.add('clkdiv', 1, 0, { div: 2 });
  const pos = b.add('lfo', 0, 1, { wave: 3, rate: 0.7, depth: 1 });
  const sc = b.add('scale', 1, 1, { gain: 0.2, offset: 0 });
  const gr = b.add('grain', 2, 0, { position: 0.3, size: 0.12, density: 0, pitch: 0, spray: 0, freeze: 0, mix: 1 }, { p1: 'position', att: [1, 1] });
  b.wire(clk, 'out', dv, 'clock');
  b.wire(dv, 'out', gr, 'trig');
  b.wire(pos, 'out', sc, 'in');
  b.wire(sc, 'out', gr, 'p1');
  b.input('in', gr, 'in');
  b.input('reset', clk, 'reset', [dv, 'reset']);
  b.output('out', gr, 'out');
  b.param('rate', clk, 'rate');
  b.param('div', dv, 'div');
  b.param('size', gr, 'size');
  b.param('pitch', gr, 'pitch');
  b.param('jump', sc, 'gain');
  b.param('freeze', gr, 'freeze');
});

// time smear: a feedback delay into grains an octave down whose read position drifts with a slow triangle, crossfaded with
// the dry signal (holds the patch's Delay and Granular)
asm('time smear', 'Textures', (b) => {
  const dly = b.add('delay', 0, 0, { time: 400, fb: 0.5, mix: 1 });
  const lfo = b.add('lfo', 0, 1, { wave: 1, rate: 0.1, depth: 1 });
  const sc = b.add('scale', 1, 1, { gain: 0.3, offset: 0 });
  const gr = b.add('grain', 1, 0, { position: 0.5, size: 0.3, density: 8, pitch: -12, spray: 0.2, freeze: 0, mix: 1 }, { p1: 'position', att: [1, 1] });
  const xf = b.add('xfade', 2, 0, { mix: 0.5 });
  b.wire(dly, 'out', gr, 'in');
  b.wire(lfo, 'out', sc, 'in');
  b.wire(sc, 'out', gr, 'p1');
  b.wire(gr, 'out', xf, 'b');
  b.input('in', dly, 'in', [xf, 'a']);
  b.output('out', xf, 'out');
  b.param('smear', xf, 'mix');
  b.param('time', dly, 'time');
  b.param('feedback', dly, 'fb');
  b.param('pitch', gr, 'pitch');
  b.param('drift', lfo, 'rate');
});

// a slicer: a step sequencer picks the read position of the last second of audio, its gate fires the grain: a sample
// slicer on whatever was played into it
asm('slicer', 'Effects', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const sq = b.add('seq', 1, 0, { s1: -0.8, s2: 0.2, s3: -0.4, s4: 0.8, s5: 0, s6: -0.6, s7: 0.5, s8: -0.2, len: 8, dir: 0 });
  const gr = b.add('grain', 2, 0, { position: 0.5, size: 0.2, density: 0, pitch: 0, spray: 0, freeze: 0, mix: 1 }, { p1: 'position', att: [0.5, 1] });
  b.wire(clk, 'out', sq, 'clock');
  b.wire(sq, 'out', gr, 'p1');
  b.wire(sq, 'gate', gr, 'trig');
  b.input('in', gr, 'in');
  b.input('reset', sq, 'reset', [clk, 'reset']);
  b.output('out', gr, 'out');
  b.param('tempo', clk, 'rate');
  b.param('length', sq, 'len');
  b.param('direction', sq, 'dir');
  b.param('size', gr, 'size');
  b.param('pitch', gr, 'pitch');
  b.param('freeze', gr, 'freeze');
  for (const q of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) b.param(q, sq, q);
});

// a reverse pad: long grains read from `age` seconds back, under a slow attack: a "played from the past" smear (turn age up for the oldest audio)
asm('reverse pad', 'Textures', (b) => {
  const gr = b.add('grain', 0, 0, { position: 0.2, size: 0.15, density: 12, pitch: 0, spray: 0, freeze: 0, mix: 1 });
  const env = b.add('adsr', 0, 1, { a: 0.5, d: 0.5, s: 1, r: 1.5 });
  const vca = b.add('vca', 1, 0);
  b.wire(gr, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('in', gr, 'in');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('attack', env, 'a');
  b.param('release', env, 'r');
  b.param('age', gr, 'position');
  b.param('size', gr, 'size');
  b.param('pitch', gr, 'pitch');
});

// ---- modal

// a glass bell: a 3 ms strike into a bar-like modal body, a little frequency shift for the shimmer; velocity opens `bright`
asm('glass bell', 'Voices', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.003 });
  const hit = b.add('scale', 0, 1, { gain: 0.04, offset: 0 });
  const md = b.add('modal', 1, 0, { coarse: 0, decay: 4, struct: 1, bright: 0.7, damp: 0.2 }, { p1: 'bright', att: [0.4, 1] });
  const fs = b.add('shift', 2, 0, { shift: 3, cvamt: 100, mix: 0.3 });
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.wire(md, 'out', fs, 'in');
  b.input('gate', pl, 'trig');
  b.input('pitch', md, 'pitch');
  b.input('vel', md, 'p1');
  b.output('out', fs, 'up');
  b.param('decay', md, 'decay');
  b.param('bright', md, 'bright');
  b.param('shimmer', fs, 'shift');
  b.param('shimmer mix', fs, 'mix');
  b.param('hit', hit, 'gain');
});

// gamelan: two bar-like modal bodies a fifth apart, the second a little sharp (beating), both hit by one noise burst
asm('gamelan', 'Voices', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const env = b.add('env', 1, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.015, l3: 0, r3: 0.01, l4: 0, r4: 0.01 });
  const vca = b.add('vca', 2, 0, { gain: 0.05 });
  const m1 = b.add('modal', 0, 1, { coarse: 0, decay: 2.5, struct: 1, bright: 0.5, damp: 0.3 });
  const det = b.add('scale', 1, 1, { gain: 1, offset: 0.015 });
  const m2 = b.add('modal', 2, 1, { coarse: 7, decay: 2, struct: 1, bright: 0.4, damp: 0.3 });
  const mix = b.add('mixer', 3, 0, { l1: 0.7, l2: 0.5, l3: 0, l4: 0 });
  b.wire(nz, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', m1, 'in');
  b.wire(vca, 'out', m2, 'in');
  b.wire(det, 'out', m2, 'pitch');
  b.wire(m1, 'out', mix, 'in1');
  b.wire(m2, 'out', mix, 'in2');
  b.input('gate', env, 'gate');
  b.input('pitch', m1, 'pitch', [det, 'in']);
  b.output('out', mix, 'out');
  b.param('decay', m1, 'decay');
  b.param('detune', det, 'offset');
  b.param('interval', m2, 'coarse');
  b.param('balance', mix, 'l2');
  b.param('hit', vca, 'gain');
});

// a kalimba: a plucked modal tine with a tuned comb for the body
asm('kalimba', 'Voices', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.002 });
  const hit = b.add('scale', 0, 1, { gain: 0.015, offset: 0 });
  const md = b.add('modal', 1, 0, { coarse: 0, decay: 0.8, struct: 0.3, bright: 0.5, damp: 0.7 });
  const cb = b.add('comb', 2, 0, { coarse: -12, fb: 0.4, damp: 0.6, mix: 0.4 });
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.wire(md, 'out', cb, 'in');
  b.input('gate', pl, 'trig');
  b.input('pitch', md, 'pitch', [cb, 'pitch']);
  b.output('out', cb, 'out');
  b.param('decay', md, 'decay');
  b.param('body', cb, 'mix');
  b.param('bright', md, 'bright');
  b.param('hit', hit, 'gain');
});

// marimba / vibes: a harmonic modal bar with a resonator tube (a darker modal an octave below) by `tube`, and a tremolo
// `motor` for the vibes
asm('marimba', 'Voices', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.002 });
  const hit = b.add('scale', 0, 1, { gain: 0.02, offset: 0 });
  const bar = b.add('modal', 1, 0, { coarse: 0, decay: 0.4, struct: 0, bright: 0.6, damp: 0.4 });
  const tube = b.add('modal', 1, 1, { coarse: -12, decay: 0.7, struct: 0, bright: 0.2, damp: 0.9 });
  const xf = b.add('xfade', 2, 0, { mix: 0.3 });
  const lfo = b.add('lfo', 2, 1, { wave: 0, rate: 5, depth: 1 });
  const sc = b.add('scale', 3, 1, { gain: 0, offset: 1 });
  const vca = b.add('vca', 3, 0);
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', bar, 'in');
  b.wire(hit, 'out', tube, 'in');
  b.wire(bar, 'out', xf, 'a');
  b.wire(tube, 'out', xf, 'b');
  b.wire(xf, 'out', vca, 'in');
  b.wire(lfo, 'out', sc, 'in');
  b.wire(sc, 'out', vca, 'cv');
  b.input('gate', pl, 'trig');
  b.input('pitch', bar, 'pitch', [tube, 'pitch']);
  b.output('out', vca, 'out');
  b.param('decay', bar, 'decay');
  b.param('tube', xf, 'mix');
  b.param('motor', sc, 'gain');
  b.param('motor rate', lfo, 'rate');
  b.param('bright', bar, 'bright');
  b.param('hit', hit, 'gain');
});

// bowed glass: noise through a tracking ladder into a modal body, the noise under a slow envelope (the bow pressure), a
// compressor keeps the sustain even
asm('bowed glass', 'Voices', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const env = b.add('adsr', 0, 1, { a: 0.4, d: 0.3, s: 0.8, r: 0.6 });
  const vca = b.add('vca', 1, 0, { gain: 0.5 });
  const ld = b.add('ladder', 2, 0, { cutoff: 1500, res: 0.6, drive: 1, track: 1 });
  const md = b.add('modal', 1, 1, { coarse: 0, decay: 1, struct: 0.5, bright: 0.5, damp: 0.3 });
  const dyn = b.add('dyn', 2, 1, { thresh: -24, ratio: 6, attack: 0.01, release: 0.2, gain: 6 });
  b.wire(nz, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', ld, 'in');
  b.wire(ld, 'lp24', md, 'in');
  b.wire(md, 'out', dyn, 'in');
  b.input('gate', env, 'gate');
  b.input('pitch', md, 'pitch');
  b.output('out', dyn, 'out');
  b.param('pressure', vca, 'gain');
  b.param('attack', env, 'a');
  b.param('brightness', ld, 'cutoff');
  b.param('decay', md, 'decay');
  b.param('release', env, 'r');
});

// rain: a fast random clock samples noise into a pentatonic pitch and strikes a modal body with a 2 ms burst
asm('rain', 'Textures', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 9, depth: 1 });
  const nz = b.add('noise', 1, 0, { level: 0.8 });
  const sh = b.add('sh', 2, 0, { mode: 0 });
  const qn = b.add('quant', 3, 0, { scale: 3, root: 0 });
  const pl = b.add('pulse', 0, 1, { time: 0.002 });
  const hit = b.add('scale', 2, 1, { gain: 0.03, offset: 0 });
  const md = b.add('modal', 1, 1, { coarse: 12, decay: 0.6, struct: 0.8, bright: 0.6, damp: 0.3 });
  b.wire(nz, 'out', sh, 'in');
  b.wire(clk, 'out', sh, 'clock');
  b.wire(sh, 'out', qn, 'in');
  b.wire(qn, 'out', md, 'pitch');
  b.wire(clk, 'out', pl, 'trig');
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.input('reset', clk, 'reset');
  b.output('out', md, 'out');
  b.param('density', clk, 'rate');
  b.param('range', nz, 'level');
  b.param('scale', qn, 'scale');
  b.param('decay', md, 'decay');
  b.param('tune', md, 'coarse');
  b.param('hit', hit, 'gain');
});

// a resonator bank (effect): three modal bodies on the root, the fifth and the octave in parallel
asm('resonator bank', 'Textures', (b) => {
  const m1 = b.add('modal', 0, 0, { coarse: 0, decay: 1.5, struct: 0, bright: 0.5, damp: 0.4 });
  const m2 = b.add('modal', 0, 1, { coarse: 7, decay: 1.5, struct: 0, bright: 0.5, damp: 0.4 });
  const m3 = b.add('modal', 0, 2, { coarse: 12, decay: 1.5, struct: 0, bright: 0.5, damp: 0.4 });
  const mix = b.add('mixer', 1, 0, { l1: 0.05, l2: 0.04, l3: 0.03, l4: 0 });
  b.wire(m1, 'out', mix, 'in1');
  b.wire(m2, 'out', mix, 'in2');
  b.wire(m3, 'out', mix, 'in3');
  b.input('in', m1, 'in', [m2, 'in'], [m3, 'in']);
  b.input('pitch', m1, 'pitch', [m2, 'pitch'], [m3, 'pitch']);
  b.output('out', mix, 'out');
  b.param('decay', m1, 'decay');
  b.param('decay 5th', m2, 'decay');
  b.param('decay oct', m3, 'decay');
  b.param('struct', m1, 'struct');
  b.param('bright', m1, 'bright');
  b.param('level', mix, 'l1');
});

// ---- comb, shifter, compressor

// a bowed string: noise through a ladder into a high-feedback comb at the pitch; an ADSR on the noise, a glide on the pitch
asm('bowed string', 'Voices', (b) => {
  const gl = b.add('glide', 0, 0, { time: 0.08 });
  const nz = b.add('noise', 1, 0, { level: 1 });
  const env = b.add('adsr', 2, 0, { a: 0.15, d: 0.3, s: 0.8, r: 0.3 });
  const vca = b.add('vca', 0, 1, { gain: 0.4 });
  const ld = b.add('ladder', 1, 1, { cutoff: 2500, res: 0.3, drive: 1 });
  const cb = b.add('comb', 2, 1, { coarse: 0, fb: 0.95, damp: 0.3, mix: 1 });
  b.wire(gl, 'out', cb, 'pitch');
  b.wire(nz, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', ld, 'in');
  b.wire(ld, 'lp24', cb, 'in');
  b.input('pitch', gl, 'in');
  b.input('gate', env, 'gate');
  b.output('out', cb, 'out');
  b.param('pressure', vca, 'gain');
  b.param('brightness', ld, 'cutoff');
  b.param('damp', cb, 'damp');
  b.param('glide', gl, 'time');
  b.param('attack', env, 'a');
});

// barber pole: a slow frequency shift up and down, crossfaded by a slow LFO: an endless rise (or fall)
asm('barber pole', 'Effects', (b) => {
  const fs = b.add('shift', 0, 0, { shift: 0.3, cvamt: 100, mix: 1 });
  const lfo = b.add('lfo', 0, 1, { wave: 1, rate: 0.08, depth: 1 });
  const sc = b.add('scale', 1, 1, { gain: 0.5, offset: 0.5 });
  const xf = b.add('xfade', 1, 0, { mix: 0.5 });
  b.wire(fs, 'up', xf, 'a');
  b.wire(fs, 'down', xf, 'b');
  b.wire(lfo, 'out', sc, 'in');
  b.wire(sc, 'out', xf, 'pos');
  b.input('in', fs, 'in');
  b.output('out', xf, 'out');
  b.param('speed', fs, 'shift');
  b.param('sweep', lfo, 'rate');
  b.param('depth', sc, 'gain');
});

// sidechain pump: a compressor ducked by an internal clock's pulse
asm('sidechain pump', 'Effects', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 2, depth: 1 });
  const pl = b.add('pulse', 1, 0, { time: 0.03 });
  const dyn = b.add('dyn', 2, 0, { thresh: -30, ratio: 12, attack: 0.002, release: 0.18, gain: 0 });
  b.wire(clk, 'out', pl, 'trig');
  b.wire(pl, 'out', dyn, 'side');
  b.input('in', dyn, 'in');
  b.input('reset', clk, 'reset');
  b.output('out', dyn, 'out');
  b.output('env', dyn, 'env');
  b.param('amount', dyn, 'thresh');
  b.param('release', dyn, 'release');
  b.param('rate', clk, 'rate');
});

// a talking filter: the input's envelope opens the vowel (the louder, the more open)
asm('talking filter', 'Effects', (b) => {
  const dyn = b.add('dyn', 0, 0, { thresh: 0, ratio: 1, attack: 0.005, release: 0.08, gain: 0 });
  const sc = b.add('scale', 1, 0, { gain: 4, offset: 0 });
  const vow = b.add('vowel', 2, 0, { vowel: 0, res: 0.6, level: 0.8 });
  b.wire(dyn, 'env', sc, 'in');
  b.wire(sc, 'out', vow, 'vowel');
  b.input('in', dyn, 'in', [vow, 'in']);
  b.output('out', vow, 'out');
  b.param('depth', sc, 'gain');
  b.param('res', vow, 'res');
  b.param('release', dyn, 'release');
  b.param('start', vow, 'vowel');
});

// an auto pan
asm('auto pan', 'Effects', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 0.5, depth: 1 });
  const pan = b.add('pan', 1, 0, { pan: 0 });
  b.wire(lfo, 'out', pan, 'pos');
  b.input('in', pan, 'in');
  b.output('l', pan, 'l');
  b.output('r', pan, 'r');
  b.param('rate', lfo, 'rate');
  b.param('width', lfo, 'depth');
  b.param('centre', pan, 'pan');
});

// an exposed pin is offered as the sliders it routes to (the editor has no p1 / p2 jacks): the same migration as on load
for (const d of defs) {
  const moduleOf = (id: number): ModuleInst | undefined => d.modules.find((m) => m.id === id);
  d.inputs = pinsToParams(d.inputs, d.params, moduleOf);
  for (const n of d.assemblies ?? []) n.inputs = pinsToParams(n.inputs, n.params, moduleOf);
}
// the one-line description of each engine (the Engines shelf, engines.ts) on the "Start with an engine" tiles, the
// assembly browser, the palette and the patch card. The owner's wording (2026-10-21): an engine that emulates an
// instrument is "<that instrument> type shit", verbatim; the others say plainly what they are.
const BLURBS: Record<string, string> = {
  'Oracle V': 'Prophet-5 type shit',
  'Monolith D': 'Minimoog Model D type shit',
  'Silver Box': 'TB-303 type shit',
  'Hera 6': 'Juno-106 type shit',
  'Sallen 20': 'MS-20 type shit',
  'Expander S': 'Oberheim SEM type shit',
  'Algo Four': 'DX100 type shit',
  Canvas: 'Music Easel type shit',
  Wanderer: 'ARP Odyssey type shit',
  'Briefcase 3': 'EMS VCS3 type shit',
  'Io 4': 'Jupiter-4 type shit',
  'Vernon 100': 'ElectroComp 100 type shit',
  '8 Lire': 'Lyra-8 type shit',
  'Elvira 2': 'Elmyra 2 type shit',
  Scrounge: 'Scrooge type shit',
  'Meridian 8': 'NOON type shit',
  'Perun 4': 'Perkons HD-01 type shit',
  'Spokes 6': 'Model:Cycles type shit',
  'Cassia 1': 'CZ-1 type shit',
  'drift poly': 'Two oscillators per voice, four voices that drift a little out of tune',
  'basic poly': 'The plainest polysynth: a saw, a low pass and an envelope per voice',
  'mono lead': 'One voice through a ladder filter, gliding between legato notes',
  'supersaw stack': 'Detuned saws stacked and spread across the stereo field, for pads and leads',
  'drum kit': 'One drum per key: kick, snare, clap, hats, tom, rim and cowbell',
};
for (const [name] of Object.entries(BLURBS)) if (!defs.some((d) => d.name === name)) throw new Error(`a blurb for ${name}, which is not a factory assembly`);
for (const [i, d] of defs.entries()) {
  if (defIsEngine(d) && !BLURBS[d.name]) throw new Error(`the engine ${d.name} has no blurb`);
  const { format, version, name, category, ...rest } = d;
  if (BLURBS[d.name]) defs[i] = { format, version, name, category, blurb: BLURBS[d.name], ...rest };
}
for (const d of defs) writeFileSync(new URL(`${d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`, OUT), JSON.stringify(d, null, 2) + '\n');
console.log(`wrote ${defs.length} assemblies: ${defs.map((d) => d.name).join(', ')}`);
