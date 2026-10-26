// SPDX-License-Identifier: GPL-3.0-only
// Writes the factory assemblies (src/assemblies/*.json) that are defined here as small patches: module grid positions,
// cables, the exposed ports (an input with `also` fans out to several inner inputs) and the promoted parameters.
// `voice` and `echo` are kept as files. Run from web/:  npx vite-node scripts/gen-assemblies.ts
import { writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { defaultMap, defaultParams, rowDef, STEP_VEL, type ModuleInst, type PolyCards, type Source } from '../src/patch';
import { defIsEngine } from '../src/engines';
import { pinsToParams, type AssemblyDef, type NestedDef, type PortRef, type ParamRef } from '../src/assembly';

const OUT = new URL('../src/assemblies/', import.meta.url);
/** the touch plates of 8 Lire and Elvira 2: the white keys from F3 (the drum kits' rows, gen-presets.ts KIT_NOTES),
 * repeated over the keybed in blocks of eight white keys (E2..E3, F3..F4, G4..G5, A5..A6), one Drum map per block, so
 * every white key plays a plate (a stopgap until the Drum map repeats its rows itself, #184) */
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

// Monolith D, a classic three-oscillator monosynth (after the Minimoog Model D): one voice (the allocator plays the
// lowest key held, as the original's keyboard does), glide, three oscillators whose levels are the mixer (summed at
// the filter input with the noise), the 24 dB ladder with its contour (an ADSR; cvamt is the amount of contour) and
// keyboard tracking, the loudness contour. Modulation as on the original's left panel: oscillator 3 or the noise
// (`mod mix` crossfades them) through the `wheel` VCA (plug Main's mod into it) into the oscillators' pitch
// (`osc mod`) and the filter (`filter mod`). Turn oscillator 3 down to -36 for a slow modulation source.
asm('Monolith D', 'Voices', (b) => {
  const part = b.add('alloc', 0, 2, { voices: 1, priority: 1 });
  const gl = b.add('glide', 0, 0, { time: 0.001 });
  const o1 = b.add('osc', 1, 0, { wave: 2, level: 0.45 });
  const o2 = b.add('osc', 1, 1, { wave: 2, level: 0.4, fine: 6 });
  const o3 = b.add('osc', 1, 2, { wave: 3, coarse: -12, level: 0.3, fine: -4 });
  const nz = b.add('noise', 2, 2, { level: 0 });
  const src = b.add('xfade', 3, 2, { mix: 0 });
  const wheel = b.add('vca', 4, 2);
  const oscMod = b.add('scale', 5, 2, { gain: 0, offset: 0 });
  const fltMod = b.add('scale', 6, 2, { gain: 0.6, offset: 0 });
  const fenv = b.add('adsr', 2, 1, { a: 0.005, d: 0.45, s: 0.35, r: 0.25 });
  const flt = b.add('ladder', 3, 0, { cutoff: 700, res: 0.3, cvamt: 3, track: 1, drive: 1.4 });
  const aenv = b.add('adsr', 3, 1, { a: 0.004, d: 0.3, s: 0.85, r: 0.2 });
  const vca = b.add('vca', 4, 0, { gain: 0.7 });
  const scope = b.add('scope', 5, 0, { time: 16 });
  b.wire(part, 'pitch', gl, 'in');
  for (const o of [o1, o2, o3]) b.wire(gl, 'out', o, 'pitch');
  b.wire(part, 'gate', fenv, 'gate');
  b.wire(part, 'gate', aenv, 'gate');
  for (const o of [o1, o2, o3, nz]) b.wire(o, 'out', flt, 'in');
  b.wire(fenv, 'env', flt, 'cv');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(aenv, 'env', vca, 'cv');
  b.wire(o3, 'out', src, 'a');
  b.wire(nz, 'out', src, 'b');
  b.wire(src, 'out', wheel, 'in');
  b.wire(wheel, 'out', oscMod, 'in');
  b.wire(wheel, 'out', fltMod, 'in');
  b.wire(oscMod, 'out', o1, 'pitch');
  b.wire(oscMod, 'out', o2, 'pitch');
  b.wire(fltMod, 'out', flt, 'cv');
  b.wire(vca, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.input('wheel', wheel, 'cv');
  b.output('out', vca, 'out');
  b.param('glide', gl, 'time', { head: 'controllers' });
  b.param('mod mix', src, 'mix');
  b.param('osc mod', oscMod, 'gain');
  b.param('filter mod', fltMod, 'gain');
  b.param('osc 1 range', o1, 'coarse', { head: 'oscillators' });
  b.param('osc 1 wave', o1, 'wave');
  b.param('osc 2 range', o2, 'coarse', { group: true });
  b.param('osc 2 fine', o2, 'fine');
  b.param('osc 2 wave', o2, 'wave');
  b.param('osc 3 range', o3, 'coarse', { group: true });
  b.param('osc 3 fine', o3, 'fine');
  b.param('osc 3 wave', o3, 'wave');
  b.param('osc 1', o1, 'level', { col: true, head: 'mixer' });
  b.param('osc 2', o2, 'level');
  b.param('osc 3', o3, 'level');
  b.param('noise', nz, 'level');
  b.param('cutoff', flt, 'cutoff', { head: 'filter' });
  b.param('emphasis', flt, 'res');
  b.param('contour', flt, 'cvamt');
  b.param('kbd track', flt, 'track');
  b.param('drive', flt, 'drive');
  b.param('filter contour', fenv, 'view', { col: true, head: 'contours' });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, fenv, q);
  b.param('loudness contour', aenv, 'view');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, aenv, q);
  b.param('out', scope, 'view');
});

// Silver Box, an acid bass line machine built after the TB-303: one voice, a saw or square into a resonant 24 dB
// ladder that the decay envelope sweeps (`env mod` = its cvamt), an amp envelope that decays slowly while the key is
// held, a soft drive after the filter. Slide as on the original: a note played while the last is still held glides to
// it (the allocator's legato gate opens the glide by `slide`). Accent: the key's velocity adds to the filter sweep and
// the level (`accent`).
asm('Silver Box', 'Voices', (b) => {
  const part = b.add('alloc', 0, 1, { voices: 1, legato: 0 });
  const slide = b.add('scale', 0, 2, { gain: 0.45, offset: 0 });
  const gl = b.add('glide', 1, 1, { time: 0.001 }, { p1: 'time' });
  const osc = b.add('osc', 1, 0, { wave: 2, level: 0.8, coarse: -12 });
  const fenv = b.add('adsr', 2, 1, { a: 0.001, d: 0.3, s: 0, r: 0.05 });
  const acc = b.add('scale', 1, 2, { gain: 0.25, offset: 0 });
  const flt = b.add('ladder', 2, 0, { cutoff: 260, res: 0.75, cvamt: 2.6, drive: 1.6 });
  const aenv = b.add('adsr', 3, 1, { a: 0.002, d: 2.5, s: 0, r: 0.02 });
  const vca = b.add('vca', 3, 0, { gain: 0.8 }, { p1: 'gain', att: [0.5, 1] });
  const drive = b.add('shape', 4, 0, { drive: 1.6, mode: 0, level: 0.75 });
  const scope = b.add('scope', 5, 0, { time: 16 });
  b.wire(part, 'pitch', gl, 'in');
  b.wire(part, 'legato', slide, 'in');
  b.wire(slide, 'out', gl, 'p1');
  b.wire(gl, 'out', osc, 'pitch');
  b.wire(part, 'gate', fenv, 'gate');
  b.wire(part, 'gate', aenv, 'gate');
  b.wire(part, 'vel', acc, 'in');
  b.wire(osc, 'out', flt, 'in');
  b.wire(fenv, 'env', flt, 'cv');
  b.wire(acc, 'out', flt, 'cv');
  b.wire(acc, 'out', vca, 'p1');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(aenv, 'env', vca, 'cv');
  b.wire(vca, 'out', drive, 'in');
  b.wire(drive, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.output('out', drive, 'out');
  b.param('tuning', osc, 'coarse', { head: 'voice' });
  b.param('waveform', osc, 'wave');
  b.param('cutoff', flt, 'cutoff', { group: true });
  b.param('resonance', flt, 'res');
  b.param('env mod', flt, 'cvamt');
  b.param('decay', fenv, 'd');
  b.param('accent', acc, 'gain', { group: true });
  b.param('slide', slide, 'gain');
  b.param('drive', drive, 'drive');
  b.param('sweep', fenv, 'view', { col: true, head: 'envelopes' });
  b.param('amp', aenv, 'view');
  b.param('amp decay', aenv, 'd');
  b.param('out', scope, 'view');
});

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

// Cassia 1, a phase distortion polysynth after the Casio CZ-1 (its operation manual: DCO, DCW and DCA, the waveforms,
// line select, key follow, vibrato). A voice card has the CZ's two lines. Line 1 is phase distortion: a sine whose
// phase a phase-locked saw bends (a Math module multiplies the saw by the DCW envelope; the sine's pm, pi / 2, is full
// bend), which is the CZ's own method written as phase modulation: from a sine (DCW at 0) to the CZ saw (at the
// top), or with the saw an octave up (`wave` 12) to the CZ square. Line 2 is the CZ's resonance waveform I: a sine
// restarted every cycle (hard sync on a falling ramp of the note's period) and faded out by that same ramp, its pitch
// raised by the DCW envelope (up to `res range` octaves): a resonant peak that sweeps. Each line has its DCW envelope
// (an Env L/R: three rate / level steps, the third held, and a release; the CZ has eight steps); one DCA envelope shapes
// both, `line` crossfades them (0 = line 1, 0.5 = 1 + 2, 1 = line 2), line 2 has its octave and detune. Key follow
// lowers both DCWs on higher keys (from C4), the velocity opens the DCA, one LFO adds vibrato. The FM-1 version has no
// pitch (DCO) envelope, no ring or noise modulation and three waveforms of the eight: Cassia 1 XL has the rest.
asm('Cassia 1', 'Voices', (b) => {
  const part = b.add('alloc', 0, 3, { voices: 4 });
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 5.5, depth: 1 });
  const vib = b.add('scale', 0, 1, { gain: 0, offset: 0 });
  const scope = b.add('scope', 6, 0, { time: 16 });
  // line 1: phase distortion
  const car = b.add('osc', 1, 0, { wave: 0, pm: Math.PI / 2, level: 1 });
  const mod = b.add('osc', 1, 1, { wave: 2, coarse: 0, level: 1 });
  const bend = b.add('math', 1, 2, { ka: -1, kb: 1, off: 0 });
  const dcw1 = b.add('env', 1, 3, { l1: 0.9, r1: 0.05, l2: 0.6, r2: 0.6, l3: 0.4, r3: 1.5, l4: 0, r4: 0.3 });
  // line 2: resonance (a sine synced and windowed by a falling ramp of the note's period)
  const ramp = b.add('osc', 2, 0, { wave: 2, coarse: 0, fine: 0, level: 1 });
  const win = b.add('math', 2, 1, { ka: -0.5, kb: 1, off: 0.5 });
  const rs = b.add('osc', 2, 2, { wave: 0, level: 1 });
  const rise = b.add('scale', 2, 3, { gain: 3, offset: 0 });
  const dcw2 = b.add('env', 2, 4, { l1: 0.7, r1: 0.1, l2: 0.4, r2: 0.8, l3: 0.25, r3: 2, l4: 0, r4: 0.3 });
  const wvca = b.add('vca', 2, 5, { gain: 1 });
  // both: key follow, the line mix, the DCA (velocity on its gain)
  const kf = b.add('scale', 3, 0, { gain: -0.15, offset: 0 });
  const line = b.add('xfade', 3, 1, { mix: 0 });
  const dca = b.add('env', 3, 2, { l1: 1, r1: 0.01, l2: 0.8, r2: 0.4, l3: 0.6, r3: 2, l4: 0, r4: 0.4 });
  const vca = b.add('vca', 3, 3, { gain: 0.15 }, { p1: 'gain', att: [0.45, 1] }); // velocity 1 reaches 0.6
  b.nest('voice', 1, 4, [car, mod, bend, dcw1, ramp, win, rs, rise, dcw2, wvca, kf, line, dca, vca], {});
  for (const o of [car, mod, ramp, rs]) {
    b.wire(part, 'pitch', o, 'pitch');
    b.wire(vib, 'out', o, 'pitch');
  }
  b.wire(lfo, 'out', vib, 'in');
  b.wire(part, 'gate', dcw1, 'gate');
  b.wire(part, 'gate', dcw2, 'gate');
  b.wire(part, 'gate', dca, 'gate');
  b.wire(part, 'vel', vca, 'p1');
  b.wire(part, 'pitch', kf, 'in');
  b.wire(dcw1, 'env', bend, 'a');
  b.wire(kf, 'out', bend, 'a');
  b.wire(mod, 'out', bend, 'b');
  b.wire(bend, 'mul', car, 'pm');
  b.wire(ramp, 'out', win, 'a');
  b.wire(win, 'add', rs, 'sync');
  b.wire(win, 'add', wvca, 'cv');
  b.wire(dcw2, 'env', rise, 'in');
  b.wire(kf, 'out', rise, 'in');
  b.wire(rise, 'out', rs, 'pitch');
  b.wire(rs, 'out', wvca, 'in');
  b.wire(car, 'out', line, 'a');
  b.wire(wvca, 'out', line, 'b');
  b.wire(line, 'out', vca, 'in');
  b.wire(dca, 'env', vca, 'cv');
  b.wire(vca, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.nestInput('pitch', car, 'pitch', [mod, 'pitch'], [ramp, 'pitch'], [rs, 'pitch'], [kf, 'in']);
  b.nestInput('gate', dcw1, 'gate', [dcw2, 'gate'], [dca, 'gate']);
  b.nestInput('vel', vca, 'p1');
  b.nestOutput('out', vca, 'out');
  b.output('out', vca, 'out');
  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('line', line, 'mix');
  b.param('vibrato', vib, 'gain');
  b.param('vib rate', lfo, 'rate');
  b.param('wave', mod, 'coarse', { head: 'line 1' });
  b.param('dcw', car, 'pm');
  b.param('key follow', kf, 'gain');
  b.param('octave', ramp, 'coarse', { head: 'line 2' });
  b.param('detune', ramp, 'fine');
  b.param('res range', rise, 'gain');
  const envRows = (e: number, head: string, col = false): void => {
    b.param(head, e, 'view', { head, ...(col ? { col: true } : {}) });
    b.param('rate 1', e, 'r1');
    b.param('level 1', e, 'l1');
    b.param('rate 2', e, 'r2');
    b.param('level 2', e, 'l2');
    b.param('rate 3', e, 'r3');
    b.param('sustain', e, 'l3');
    b.param('release', e, 'r4');
  };
  envRows(dcw1, 'dcw 1', true);
  envRows(dcw2, 'dcw 2', true);
  envRows(dca, 'dca', true);
  b.param('out', scope, 'view', { col: true });
});

// Sallen 20, a semi-modular monosynth after the MS-20: one voice, two oscillators and their ring modulation (a VCA
// with oscillator 2 as its cv) into a resonant high pass and a resonant 12 dB low pass in series, then a soft drive
// (the screaming peak). Envelope 2 (an ADSR) sweeps both filters and opens the VCA; envelope 1 (attack / release)
// and the modulation generator (an LFO) reach the pitch and the cutoffs by their own amounts.
asm('Sallen 20', 'Voices', (b) => {
  const part = b.add('alloc', 0, 2, { voices: 1 });
  const gl = b.add('glide', 0, 0, { time: 0.001 });
  const o1 = b.add('osc', 1, 0, { wave: 2, level: 0.5 }, { p1: 'fine' });
  const o2 = b.add('osc', 1, 1, { wave: 3, level: 0, coarse: 7 }, { p1: 'fine' });
  const ring = b.add('vca', 2, 1, { gain: 0 });
  const hpf = b.add('filter', 2, 0, { cutoff: 60, res: 0.2, cvamt: 0 });
  const lpf = b.add('filter', 3, 0, { cutoff: 1600, res: 0.45, cvamt: 2.5 });
  const drive = b.add('shape', 4, 0, { drive: 1.5, mode: 0, level: 0.75 });
  const eg1 = b.add('adsr', 1, 2, { a: 0.001, d: 0.3, s: 1, r: 0.3 });
  const eg2 = b.add('adsr', 3, 1, { a: 0.005, d: 0.4, s: 0.45, r: 0.3 });
  const vca = b.add('vca', 4, 1, { gain: 0.75 });
  const mg = b.add('lfo', 2, 2, { wave: 1, rate: 5, depth: 1 });
  const mgPitch = b.add('scale', 3, 2, { gain: 0, offset: 0 });
  const mgCut = b.add('scale', 4, 2, { gain: 0, offset: 0 });
  const egPitch = b.add('scale', 5, 2, { gain: 0, offset: 0 });
  const scope = b.add('scope', 5, 0, { time: 16 });
  b.wire(part, 'pitch', gl, 'in');
  b.wire(gl, 'out', o1, 'pitch');
  b.wire(gl, 'out', o2, 'pitch');
  b.wire(part, 'gate', eg1, 'gate');
  b.wire(part, 'gate', eg2, 'gate');
  b.wire(o1, 'out', ring, 'in');
  b.wire(o2, 'out', ring, 'cv');
  for (const s of [o1, o2, ring]) b.wire(s, 'out', hpf, 'in');
  b.wire(hpf, 'hp', lpf, 'in');
  b.wire(lpf, 'lp12', drive, 'in');
  b.wire(drive, 'out', vca, 'in');
  b.wire(eg2, 'env', vca, 'cv');
  b.wire(eg2, 'env', lpf, 'cv');
  b.wire(eg2, 'env', hpf, 'cv');
  b.wire(mg, 'out', mgPitch, 'in');
  b.wire(mg, 'out', mgCut, 'in');
  b.wire(mgPitch, 'out', o1, 'p1');
  b.wire(mgPitch, 'out', o2, 'p1');
  b.wire(mgCut, 'out', lpf, 'cv');
  b.wire(eg1, 'env', egPitch, 'in');
  b.wire(egPitch, 'out', o1, 'pitch');
  b.wire(egPitch, 'out', o2, 'pitch');
  b.wire(vca, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.output('out', vca, 'out');
  b.param('portamento', gl, 'time', { head: 'vco 1' });
  b.param('vco 1 wave', o1, 'wave');
  b.param('vco 1 scale', o1, 'coarse');
  b.param('vco 1 pw', o1, 'pw');
  b.param('vco 2 wave', o2, 'wave', { head: 'vco 2' });
  b.param('vco 2 pitch', o2, 'coarse');
  b.param('vco 2 fine', o2, 'fine');
  b.param('vco 1', o1, 'level', { col: true, head: 'mixer' });
  b.param('vco 2', o2, 'level');
  b.param('ring', ring, 'gain');
  b.param('hp cutoff', hpf, 'cutoff', { head: 'filters' });
  b.param('hp peak', hpf, 'res');
  b.param('lp cutoff', lpf, 'cutoff');
  b.param('lp peak', lpf, 'res');
  b.param('eg2 → lp', lpf, 'cvamt');
  b.param('eg2 → hp', hpf, 'cvamt');
  b.param('drive', drive, 'drive');
  b.param('eg 2', eg2, 'view', { col: true, head: 'envelopes' });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, eg2, q);
  b.param('eg 1 attack', eg1, 'a');
  b.param('eg 1 release', eg1, 'r');
  b.param('eg1 → pitch', egPitch, 'gain');
  b.param('mg rate', mg, 'rate', { head: 'modulation' });
  b.param('mg wave', mg, 'wave');
  b.param('mg → pitch', mgPitch, 'gain');
  b.param('mg → cutoff', mgCut, 'gain');
  b.param('out', scope, 'view');
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

// Canvas, a west-coast voice after Buchla's Music Easel: one voice. The complex oscillator: the principal
// oscillator (sine) phase-modulated by the modulation oscillator (`fm index`), then folded (`timbre` is the folder's
// drive, `symmetry` its offset, `folds` its stages). The function generator (attack / sustain / decay) opens the
// low pass gate: a filter and a VCA driven together through a slow slew (`vactrol`), so the sound gets darker as it
// gets quieter. A random voltage (noise sampled by the pulser, an LFO) moves the timbre by `random`.
asm('Canvas', 'Voices', (b) => {
  const part = b.add('alloc', 0, 2, { voices: 1 });
  const mosc = b.add('osc', 1, 1, { wave: 0, level: 1, coarse: 7 });
  const posc = b.add('osc', 1, 0, { wave: 0, level: 0.9, pm: 1.2 });
  const fold = b.add('shape', 2, 0, { drive: 2.2, mode: 2, level: 0.7, stages: 2, sym: 0.1 }, { p1: 'drive' });
  const fenv = b.add('adsr', 2, 1, { a: 0.003, d: 0.6, s: 0, r: 0.6 });
  const vac = b.add('glide', 3, 1, { time: 0.04, curve: 0 });
  const lpg = b.add('filter', 3, 0, { cutoff: 100, res: 0.1, cvamt: 4 });
  const vca = b.add('vca', 4, 0, { gain: 0.9 });
  const pulser = b.add('lfo', 1, 2, { wave: 3, rate: 3, depth: 1 });
  const nz = b.add('noise', 2, 2, { level: 1 });
  const rnd = b.add('sh', 3, 2, { mode: 0 });
  const amt = b.add('scale', 4, 2, { gain: 0, offset: 0 });
  const scope = b.add('scope', 5, 0, { time: 16 });
  b.wire(part, 'pitch', posc, 'pitch');
  b.wire(part, 'pitch', mosc, 'pitch');
  b.wire(part, 'gate', fenv, 'gate');
  b.wire(mosc, 'out', posc, 'pm');
  b.wire(posc, 'out', fold, 'in');
  b.wire(fold, 'out', lpg, 'in');
  b.wire(fenv, 'env', vac, 'in');
  b.wire(vac, 'out', lpg, 'cv');
  b.wire(lpg, 'lp12', vca, 'in');
  b.wire(vac, 'out', vca, 'cv');
  b.wire(nz, 'out', rnd, 'in');
  b.wire(pulser, 'out', rnd, 'clock');
  b.wire(rnd, 'out', amt, 'in');
  b.wire(amt, 'out', fold, 'p1');
  b.wire(vca, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.output('out', vca, 'out');
  b.param('pitch', posc, 'coarse', { head: 'complex oscillator' });
  b.param('mod ratio', mosc, 'coarse');
  b.param('mod fine', mosc, 'fine');
  b.param('fm index', posc, 'pm');
  b.param('timbre', fold, 'drive');
  b.param('symmetry', fold, 'sym');
  b.param('folds', fold, 'stages');
  b.param('function', fenv, 'view', { col: true, head: 'function / gate' });
  b.param('attack', fenv, 'a');
  b.param('sustain', fenv, 's');
  b.param('decay', fenv, 'r');
  b.param('vactrol', vac, 'time');
  b.param('gate color', lpg, 'cutoff');
  b.param('pulser rate', pulser, 'rate', { head: 'random' });
  b.param('random', amt, 'gain');
  b.param('out', scope, 'view');
});

// Wanderer, a duophonic synth after the ARP Odyssey: the keys go into the Voice allocator, which plays two voice
// cards. A card: two oscillators (saw or pulse) and their ring modulation, the 24 dB low pass (a ladder) swept by the
// ADSR, the level shaped by the AR envelope. Once: the noise (into both cards), the sample & hold (noise sampled at
// the LFO's rate, into the cutoffs by `s&h → filter`) and the static high pass after the voices.
asm('Wanderer', 'Voices', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 3, rate: 6, depth: 1 });
  const nz = b.add('noise', 0, 1, { level: 0 });
  const sh = b.add('sh', 1, 0, { mode: 0 });
  const shAmt = b.add('scale', 1, 1, { gain: 0, offset: 0 });
  const part = b.add('alloc', 0, 2, { voices: 2, assign: 1 });
  const o1 = b.add('osc', 2, 0, { wave: 2, level: 0.45 });
  const o2 = b.add('osc', 2, 1, { wave: 3, level: 0.35, pw: 0.35, coarse: 12, fine: 4 });
  const ring = b.add('vca', 3, 1, { gain: 0 });
  const flt = b.add('ladder', 3, 0, { cutoff: 900, res: 0.4, cvamt: 2.4, track: 1 });
  const adsr = b.add('adsr', 4, 1, { a: 0.005, d: 0.4, s: 0.4, r: 0.3 });
  const ar = b.add('adsr', 5, 1, { a: 0.004, d: 0.1, s: 1, r: 0.25 });
  const vca = b.add('vca', 4, 0, { gain: 1.3 });
  const hpf = b.add('filter', 5, 0, { cutoff: 40, res: 0 });
  const scope = b.add('scope', 6, 0, { time: 16 });
  b.nest('voice', 2, 2, [o1, o2, ring, flt, adsr, ar, vca], { flaws: [{ detune: 4, drift: 30, bright: 1, env: 3, level: 100 }, { detune: -5, drift: 35, bright: -1, env: -4, level: 97 }] });
  b.wire(part, 'pitch', o1, 'pitch');
  b.wire(part, 'pitch', o2, 'pitch');
  b.wire(part, 'gate', adsr, 'gate');
  b.wire(part, 'gate', ar, 'gate');
  b.wire(o1, 'out', ring, 'in');
  b.wire(o2, 'out', ring, 'cv');
  for (const s of [o1, o2, ring, nz]) b.wire(s, 'out', flt, 'in');
  b.wire(adsr, 'env', flt, 'cv');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(ar, 'env', vca, 'cv');
  b.wire(nz, 'out', sh, 'in');
  b.wire(lfo, 'out', sh, 'clock');
  b.wire(sh, 'out', shAmt, 'in');
  b.wire(shAmt, 'out', flt, 'cv');
  b.wire(vca, 'out', hpf, 'in');
  b.wire(hpf, 'hp', scope, 'a');
  b.input('keys', part, 'keys');
  b.nestInput('pitch', o1, 'pitch', [o2, 'pitch']);
  b.nestInput('gate', adsr, 'gate', [ar, 'gate']);
  b.nestInput('noise', flt, 'in');
  b.output('out', hpf, 'hp');
  b.nestOutput('out', vca, 'out');
  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('vco 1 wave', o1, 'wave', { head: 'oscillators' });
  b.param('vco 1 pw', o1, 'pw');
  b.param('vco 2 wave', o2, 'wave', { group: true });
  b.param('vco 2 freq', o2, 'coarse');
  b.param('vco 2 fine', o2, 'fine');
  b.param('vco 1', o1, 'level', { col: true, head: 'mixer' });
  b.param('vco 2', o2, 'level');
  b.param('ring mod', ring, 'gain');
  b.param('noise', nz, 'level');
  b.param('hpf', hpf, 'cutoff', { head: 'filters' });
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  b.param('adsr → filter', flt, 'cvamt');
  b.param('kbd track', flt, 'track');
  b.param('s&h → filter', shAmt, 'gain');
  b.param('lfo rate', lfo, 'rate');
  b.param('adsr', adsr, 'view', { col: true, head: 'envelopes' });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, adsr, q);
  b.param('ar', ar, 'view');
  b.param('ar attack', ar, 'a');
  b.param('ar release', ar, 'r');
  b.param('out', scope, 'view');
});

// Briefcase 3, a monosynth after the EMS VCS3 / Synthi AKS: three oscillators (oscillator 1's sine and saw as two
// modules on one pitch, oscillator 2's pulse, oscillator 3 an LFO: its slow range), noise and the ring modulator
// (oscillator 1's saw times oscillator 2) into a resonant 24 dB low pass that self-oscillates near the top of `res`
// (a ladder). The trapezoid envelope is an Env L/R: rise for `attack`, stay up for `on`, fall to silence for `decay`
// even while the key is held (its sustain level is 0), as the original's attack / on / decay; it shapes the level
// and, by `env → filter`, the cutoff. What the pin matrix was is the cables here, set to the classic patch:
// oscillator 3 into oscillator 1's pitch (`osc 3 → osc 1`, the joystick's Y with the cutoff as X on K1 / K2) and into
// the cutoff, then the tone control (a 12 dB filter swept from low to high pass by `tone`) and the spring (our reverb).
asm('Briefcase 3', 'Voices', (b) => {
  const part = b.add('alloc', 0, 3, { voices: 1 });
  const o1s = b.add('osc', 1, 0, { wave: 0, level: 0.6 });
  const o1w = b.add('osc', 1, 1, { wave: 2, level: 0.5 });
  const o2 = b.add('osc', 1, 2, { wave: 3, level: 0.35, pw: 0.3, coarse: 7, fine: 6 });
  const o3 = b.add('lfo', 0, 0, { wave: 1, rate: 0.7, depth: 1 });
  const o3p = b.add('scale', 0, 1, { gain: 0.12, offset: 0 });
  const o3f = b.add('scale', 0, 2, { gain: 0.2, offset: 0 });
  const nz = b.add('noise', 2, 2, { level: 0 });
  const ring = b.add('vca', 2, 1, { gain: 0.3 });
  const flt = b.add('ladder', 2, 0, { cutoff: 900, res: 0.55, cvamt: 2.5, track: 1 });
  const env = b.add('env', 3, 1, { l1: 1, r1: 0.02, l2: 1, r2: 0.6, l3: 0, r3: 1.4, l4: 0, r4: 0.5 });
  const vca = b.add('vca', 3, 0, { gain: 1.8 });
  const tone = b.add('filter', 4, 0, { cutoff: 1500, res: 0, morph: 0.15 });
  const rev = b.add('reverb', 5, 0, { size: 0.45, damp: 0.25, mix: 0.25, pre: 0, mod: 0.6 });
  const scope = b.add('scope', 6, 0, { time: 16 });
  b.wire(part, 'pitch', o1s, 'pitch');
  b.wire(part, 'pitch', o1w, 'pitch');
  b.wire(part, 'pitch', o2, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(o3, 'out', o3p, 'in');
  b.wire(o3, 'out', o3f, 'in');
  b.wire(o3p, 'out', o1s, 'pitch');
  b.wire(o3p, 'out', o1w, 'pitch');
  b.wire(o1w, 'out', ring, 'in');
  b.wire(o2, 'out', ring, 'cv');
  for (const s of [o1s, o1w, o2, ring, nz]) b.wire(s, 'out', flt, 'in');
  b.wire(env, 'env', flt, 'cv');
  b.wire(o3f, 'out', flt, 'cv');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', tone, 'in');
  b.wire(tone, 'mix', rev, 'in');
  b.wire(rev, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.output('out', rev, 'out');
  b.param('osc 1 sine', o1s, 'level', { head: 'oscillators' });
  b.param('osc 1 saw', o1w, 'level');
  b.param('osc 2 pulse', o2, 'level', { group: true });
  b.param('osc 2 shape', o2, 'pw');
  b.param('osc 2 freq', o2, 'coarse');
  b.param('osc 2 fine', o2, 'fine');
  b.param('osc 3 rate', o3, 'rate', { group: true });
  b.param('osc 3 wave', o3, 'wave');
  b.param('noise', nz, 'level', { col: true, head: 'matrix' });
  b.param('ring mod', ring, 'gain');
  b.param('osc 3 → osc 1', o3p, 'gain');
  b.param('osc 3 → filter', o3f, 'gain');
  b.param('cutoff', flt, 'cutoff', { head: 'filter' });
  b.param('res', flt, 'res');
  b.param('env → filter', flt, 'cvamt');
  b.param('trapezoid', env, 'view', { col: true, head: 'envelope' });
  b.param('attack', env, 'r1');
  b.param('on', env, 'r2');
  b.param('decay', env, 'r3');
  b.param('tone', tone, 'morph', { head: 'output' });
  b.param('spring', rev, 'mix');
  b.param('out', scope, 'view');
});

// Io 4, a four-voice polysynth after the Roland Jupiter-4: the keys go into the Voice allocator, which plays four
// voice cards. A card: one oscillator (saw, square or pulse; its width follows the LFO by `pwm`), the resonant 24 dB
// low pass (a ladder, key tracked) and the one ADSR that sweeps the filter by `env` and shapes the level, as the
// original's single envelope. Once: the LFO (into the oscillators' fine tune by `lfo → pitch`, the cutoffs by
// `lfo → filter`, the widths by `pwm`), the non-resonant high pass after the voices and the ensemble (our chorus).
asm('Io 4', 'Voices', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 0, rate: 4.5, depth: 1 });
  const vib = b.add('scale', 0, 1, { gain: 0, offset: 0 });
  const pwm = b.add('scale', 0, 2, { gain: 0.25, offset: 0 });
  const lflt = b.add('scale', 0, 3, { gain: 0, offset: 0 });
  const part = b.add('alloc', 1, 3, { voices: 4 });
  const osc = b.add('osc', 2, 0, { wave: 3, level: 0.6, pw: 0.4 }, { p1: 'fine', p2: 'pw' });
  const flt = b.add('ladder', 3, 0, { cutoff: 1800, res: 0.25, cvamt: 2, track: 1 });
  const env = b.add('adsr', 3, 1, { a: 0.02, d: 0.6, s: 0.55, r: 0.6 });
  const vca = b.add('vca', 4, 0, { gain: 1 });
  const hpf = b.add('filter', 5, 0, { cutoff: 30, res: 0 });
  const ch = b.add('chorus', 6, 0, { rate: 0.6, depth: 0.5, mix: 0.45 });
  const scope = b.add('scope', 7, 0, { time: 16 });
  b.nest('voice', 2, 2, [osc, flt, env, vca], {
    flaws: [{ detune: 3, drift: 25, bright: 1, env: 2, level: 100 }, { detune: -4, drift: 30, bright: -1, env: -3, level: 98 }, { detune: 2, drift: 20, bright: 0, env: 4, level: 100 }, { detune: -2, drift: 28, bright: 2, env: -2, level: 97 }],
  });
  b.wire(part, 'pitch', osc, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(osc, 'out', flt, 'in');
  b.wire(env, 'env', flt, 'cv');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(lfo, 'out', vib, 'in');
  b.wire(lfo, 'out', pwm, 'in');
  b.wire(lfo, 'out', lflt, 'in');
  b.wire(vib, 'out', osc, 'p1');
  b.wire(pwm, 'out', osc, 'p2');
  b.wire(lflt, 'out', flt, 'cv');
  b.wire(vca, 'out', hpf, 'in');
  b.wire(hpf, 'hp', ch, 'in');
  b.wire(hpf, 'hp', scope, 'a');
  b.input('keys', part, 'keys');
  b.nestInput('pitch', osc, 'pitch');
  b.nestInput('gate', env, 'gate');
  b.nestInput('lfo', osc, 'p1');
  b.nestInput('pwm', osc, 'p2');
  b.output('l', ch, 'l');
  b.output('r', ch, 'r');
  b.nestOutput('out', vca, 'out');
  b.param('voices', part, 'voices', { head: 'voice' });
  b.param('lfo rate', lfo, 'rate', { head: 'lfo' });
  b.param('lfo wave', lfo, 'wave');
  b.param('lfo → pitch', vib, 'gain');
  b.param('pwm', pwm, 'gain');
  b.param('lfo → filter', lflt, 'gain');
  b.param('wave', osc, 'wave', { head: 'vco' });
  b.param('pw', osc, 'pw');
  b.param('hpf', hpf, 'cutoff', { col: true, head: 'filters' });
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  b.param('env', flt, 'cvamt');
  b.param('kybd', flt, 'track');
  b.param('envelope', env, 'view', { col: true, head: 'env' });
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
  b.param('ensemble rate', ch, 'rate', { head: 'ensemble' });
  b.param('ensemble depth', ch, 'depth');
  b.param('ensemble mix', ch, 'mix');
  b.param('out', scope, 'view');
});

// Vernon 100, a duophonic synth after the EML ElectroComp 100 (made in Vernon, Connecticut): four oscillators, one
// of them the LFO; the keys go into the Voice allocator, which plays two voice cards (the two notes the keyboard
// sends), a card being one oscillator with a variable pulse width. Once, as on the original: both notes through the
// one 12 dB multimode filter (`mode` sweeps low pass → band → high pass), two ADS envelopes on the shared gate (one
// into the cutoff, one shaping the level; the release a short fixed tail), noise, and the sampler (sample & hold: the
// noise sampled at the LFO's rate, into the cutoff by `s&h → filter`); the LFO also reaches the pitch and the widths.
asm('Vernon 100', 'Voices', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 5, depth: 1 });
  const vib = b.add('scale', 0, 1, { gain: 0, offset: 0 });
  const pwm = b.add('scale', 0, 2, { gain: 0.2, offset: 0 });
  const nz = b.add('noise', 1, 0, { level: 0 });
  const sh = b.add('sh', 1, 1, { mode: 0 });
  const shAmt = b.add('scale', 1, 2, { gain: 0, offset: 0 });
  const part = b.add('alloc', 0, 3, { voices: 2, assign: 1 });
  const osc = b.add('osc', 2, 0, { wave: 3, level: 0.5, pw: 0.45 }, { p1: 'fine', p2: 'pw' });
  const flt = b.add('filter', 3, 0, { cutoff: 1100, res: 0.35, cvamt: 2.2, track: 1, morph: 0.25 });
  const env1 = b.add('adsr', 3, 1, { a: 0.01, d: 0.5, s: 0.35, r: 0.15 });
  const env2 = b.add('adsr', 4, 1, { a: 0.005, d: 0.3, s: 0.8, r: 0.15 });
  const vca = b.add('vca', 4, 0, { gain: 1 });
  const scope = b.add('scope', 5, 0, { time: 16 });
  b.nest('voice', 2, 2, [osc], { flaws: [{ detune: 3, drift: 30, bright: 0, env: 0, level: 100 }, { detune: -4, drift: 35, bright: 0, env: 0, level: 97 }] });
  b.wire(part, 'pitch', osc, 'pitch');
  b.wire(part, 'gate', env1, 'gate');
  b.wire(part, 'gate', env2, 'gate');
  b.wire(osc, 'out', flt, 'in');
  b.wire(nz, 'out', flt, 'in');
  b.wire(env1, 'env', flt, 'cv');
  b.wire(flt, 'mix', vca, 'in');
  b.wire(env2, 'env', vca, 'cv');
  b.wire(lfo, 'out', vib, 'in');
  b.wire(lfo, 'out', pwm, 'in');
  b.wire(vib, 'out', osc, 'p1');
  b.wire(pwm, 'out', osc, 'p2');
  b.wire(nz, 'out', sh, 'in');
  b.wire(lfo, 'out', sh, 'clock');
  b.wire(sh, 'out', shAmt, 'in');
  b.wire(shAmt, 'out', flt, 'cv');
  b.wire(vca, 'out', scope, 'a');
  b.input('keys', part, 'keys');
  b.nestInput('pitch', osc, 'pitch');
  b.nestInput('lfo', osc, 'p1');
  b.nestInput('pwm', osc, 'p2');
  b.output('out', vca, 'out');
  b.nestOutput('out', osc, 'out');
  b.param('voices', part, 'voices', { head: 'oscillators' });
  b.param('wave', osc, 'wave');
  b.param('width', osc, 'pw');
  b.param('noise', nz, 'level');
  b.param('lfo rate', lfo, 'rate', { head: 'lfo / sampler' });
  b.param('lfo → pitch', vib, 'gain');
  b.param('lfo → width', pwm, 'gain');
  b.param('s&h → filter', shAmt, 'gain');
  b.param('cutoff', flt, 'cutoff', { col: true, head: 'filter' });
  b.param('res', flt, 'res');
  b.param('mode', flt, 'morph');
  b.param('env 1 → filter', flt, 'cvamt');
  b.param('kbd track', flt, 'track');
  b.param('env 1', env1, 'view', { col: true, head: 'envelopes' });
  for (const q of ['a', 'd', 's']) b.param(q, env1, q);
  b.param('env 2', env2, 'view', { group: true });
  for (const q of ['a', 'd', 's']) b.param(q, env2, q);
  b.param('out', scope, 'view');
});

// 8 Lire, after the SOMA Laboratory Lyra-8 (#182; the panel as we remember it, not checked against SOMA's manual): eight
// voices, no keyboard. Drum maps turn the white keys into eight gates, one per touch plate (F3..F4 as the drum kits'
// rows, repeated in blocks of eight white keys: PLATE_KEYS); each voice keeps its own tuning and plays a triangle through a VCA on its own envelope (attack / release
// for the FAST / SLOW switch). Voices come in pairs (1-2, 3-4, 5-6, 7-8): a pair shares a waveshaper (SHARP) and a
// modulation depth (MOD, into both voices' pitch); pairs come in quads (1-4, 5-8): a quad shares HOLD (an offset into its
// voices' VCAs, so they drone with nothing held) and its modulation bus, a mix of the other quad, the Hyper LFO and the
// total feedback (the delay's output). The Hyper LFO: two square LFOs combined, AND crossfaded into OR, into the bus and
// the delay time. The drive, then the delay (the FM-1 holds one Delay: the Lyra's two lines are its ping-pong taps, the
// engine's l / r). Cross-quad and feedback modulation run one block late (the cables close loops).
asm('8 Lire', 'Voices', (b) => {
  const maps = PLATE_KEYS.map((keys, i) => b.add('drummap', 0, [6, 0, 7, 8][i], Object.fromEntries(keys.map((n, r) => [`n${r + 1}`, n]))));
  for (const map of maps) b.module(map).names = Array.from({ length: 8 }, (_, r) => `VOICE ${r + 1}`);   // (the rows are the voices, not drums)
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
    for (const map of maps) b.wire(map, `g${i + 1}`, env, 'gate'); // (any copy of the plate holds the gate up)
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
  b.input('keys', maps[1], 'keys', ...maps.filter((_, i) => i !== 1).map((m) => [m, 'keys'] as [number, string]));
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
// envelope held at the top). The keys play the voices as touchpads: the Drum maps' rows 1-4 and 5-8 are voices 1-4 (the
// white keys from E2 to A6, as 8 Lire). The mix is saturated, then the ladder low pass (CUTOFF, RESO), the delay (TIME,
// FDBK, MIX; ours reaches 520 ms, the original 1.6 s) and OUCH: BITE (a folding Waveshaper) into CHOKE (a low pass, open
// at the right), without the original's analog feedback loop or modifier ports; VOL. LFO 1 (sine) into the cutoff, LFO 2
// (a wave choice) into the bite, each by an amount (on the original they are patched by hand). No sequencer, no CHRM:
// TUNE is in semitones.
asm('Elvira 2', 'Voices', (b) => {
  const maps = PLATE_KEYS.map((keys, i) => b.add('drummap', 0, [6, 0, 7, 8][i], Object.fromEntries(keys.map((n, r) => [`n${r + 1}`, n]))));
  for (const map of maps) b.module(map).names = [1, 2, 3, 4, 1, 2, 3, 4].map((v, r) => `VOICE ${v}${r < 4 ? '' : 'B'}`);   // (rows 5-8 play voices 1-4 again)
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
    for (const map of maps) for (const row of [i + 1, i + 5]) b.wire(map, `g${row}`, env, 'gate'); // (any key of the voice holds the gate up)
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
  b.input('keys', maps[1], 'keys', ...maps.filter((_, i) => i !== 1).map((m) => [m, 'keys'] as [number, string]));
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
