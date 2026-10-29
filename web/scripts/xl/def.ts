// SPDX-License-Identifier: GPL-3.0-only
// A small builder for an XL's own assembly (a definition that lives only in its XL, never on the assembly shelves): the
// subset of gen-assemblies.ts's builder an XL needs (that one writes files when imported), plus pins with macro ranges
// (one Macro turning several parameters, as one switch of the original does). `place` puts the assembly into a patch and
// sets those ranges, which insertAssembly does not copy.
import { DEFS } from '../../src/modules';
import { addModule, connect, defaultMap, defaultParams, emptyPatch, rowDef, type ModuleInst, type Patch, type PolyCards, type Source } from '../../src/patch';
import { Engine } from '../../src/engine';
import { insertAssembly, type AssemblyDef, type AssemblyInst, type NestedDef, type ParamRef, type PortRef } from '../../src/assembly';

const GX = 320;
const GY = 560;

type In = PortRef & { also?: { module: number; port: string }[] };

export interface Def {
  /** a module at grid column / row; returns its local id */
  add(type: string, col: number, row: number, params?: Record<string, number>): number;
  wire(a: number, ap: string, b: number, bp: string): void;
  /** pin p1 / p2 of `module` turns `param`; with `range` (two unit positions, paramUnit) a Macro's 0..1 lands between them */
  pin(module: number, pin: 'p1' | 'p2', param: string, range?: [number, number]): void;
  input(label: string, module: number, port: string, ...also: [number, string][]): void;
  output(label: string, module: number, port: string): void;
  param(label: string, module: number, param: string, o?: { col?: boolean; head?: string; group?: boolean }): void;
  /** a nested assembly (collapsed) of these modules, with these of their ports and rows; `poly`: a rack of voice cards (its
   * members run once per voice of the Voicing that feeds them), with their flaws */
  nest(label: string, col: number, row: number, members: number[], o?: { inputs?: [string, number, string][]; outputs?: [string, number, string][]; params?: [string, number, string][]; poly?: PolyCards }): void;
  module(id: number): ModuleInst;
}

export interface Built {
  def: AssemblyDef;
  /** the macro ranges by local module id, set by `place` */
  ranges: Map<number, NonNullable<ModuleInst['range']>>;
}

export function define(name: string, f: (b: Def) => void): Built {
  const modules: ModuleInst[] = [];
  const cables: AssemblyDef['cables'] = [];
  const inputs: In[] = [];
  const outputs: PortRef[] = [];
  const params: ParamRef[] = [];
  const nested: NestedDef[] = [];
  const ranges: Built['ranges'] = new Map();
  const at = (id: number): ModuleInst => {
    const m = modules[id - 1];
    if (!m) throw new Error(`${name}: no module ${id}`);
    return m;
  };
  const check = (id: number, port: string, dir: 'inputs' | 'outputs'): void => {
    if (!DEFS[at(id).type][dir].some((p) => p.name === port)) throw new Error(`${name}: no ${dir} ${port} on ${at(id).type} ${id}`);
  };
  const checkParam = (id: number, param: string): void => {
    if (!rowDef(DEFS[at(id).type], param)) throw new Error(`${name}: no parameter ${param} on ${at(id).type} ${id}`);
  };
  const b: Def = {
    add(type, col, row, p = {}) {
      const def = DEFS[type];
      if (!def) throw new Error(`${name}: no module type ${type}`);
      for (const k of Object.keys(p)) if (!def.params.some((q) => q.name === k)) throw new Error(`${name}: ${type} has no parameter ${k}`);
      const m: ModuleInst = { id: modules.length + 1, type, x: col * GX, y: row * GY, params: { ...defaultParams(def), ...p } };
      if (def.paramInputs) {
        const map = defaultMap(def) as Record<Source, string[]>;
        map.k1 = map.k2 = map.k3 = map.k4 = [];
        m.att = [1, 1];
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
    pin(id, pin, param, range) {
      const m = at(id);
      checkParam(id, param);
      if (!m.map) throw new Error(`${name}: ${m.type} has no pins`);
      m.map[pin] = [param];
      if (range) {
        const r = ranges.get(id) ?? {};
        r[pin] = { ...r[pin], [param]: range };
        ranges.set(id, r);
      }
    },
    input(label, module, port, ...also) {
      check(module, port, 'inputs');
      for (const [m, p] of also) check(m, p, 'inputs');
      inputs.push({ module, port, label, ...(also.length ? { also: also.map(([m, p]) => ({ module: m, port: p })) } : {}) });
    },
    output(label, module, port) {
      check(module, port, 'outputs');
      outputs.push({ module, port, label });
    },
    param(label, module, param, o = {}) {
      checkParam(module, param);
      params.push({ module, param, label, ...(o.col && params.length ? { col: true as const } : {}), ...(o.head ? { head: o.head } : {}), ...(o.group && params.length ? { group: true as const } : {}) });
    },
    nest(label, col, row, members, o = {}) {
      for (const m of members) if (!modules[m - 1] || nested.some((n) => n.modules.includes(m))) throw new Error(`${name}: module ${m} cannot join ${label}`);
      const n: NestedDef = { id: nested.length + 1, name: label, label, x: col * GX, y: row * GY, open: false, modules: members, inputs: [], outputs: [], params: [], ...(o.poly ? { poly: structuredClone(o.poly) } : {}) };
      for (const [l, m, p] of o.inputs ?? []) (check(m, p, 'inputs'), n.inputs.push({ module: m, port: p, label: l }));
      for (const [l, m, p] of o.outputs ?? []) (check(m, p, 'outputs'), n.outputs.push({ module: m, port: p, label: l }));
      for (const [l, m, p] of o.params ?? []) (checkParam(m, p), n.params.push({ module: m, param: p, label: l }));
      nested.push(n);
    },
    module: at,
  };
  f(b);
  // a row or port of a nested module shows on its nested card too (a parent shows only what its children show)
  for (const n of nested) {
    for (const r of params) if (n.modules.includes(r.module) && !n.params.some((q) => q.module === r.module && q.param === r.param)) n.params.push({ module: r.module, param: r.param, label: r.label });
    for (const r of inputs) if (n.modules.includes(r.module) && !n.inputs.includes(r)) n.inputs.push(r);
    for (const r of outputs) if (n.modules.includes(r.module) && !n.outputs.some((q) => q.module === r.module && q.port === r.port)) n.outputs.push(r);
  }
  const def: AssemblyDef = {
    format: 'matryoshka-assembly', version: 1, name, modules, cables, inputs, outputs, params,
    ...(nested.length ? { children: nested.map((n) => n.id), assemblies: nested } : {}),
  };
  return { def, ranges };
}

/** insert the assembly at x / y and set its macro ranges; returns it and its modules' patch ids by local id */
export function place(p: Patch, built: Built, x: number, y: number): { a: AssemblyInst; ids: (local: number) => number } {
  const before = p.modules.length;
  const a = insertAssembly(p, DEFS, built.def, x, y);
  const fresh = p.modules.slice(before); // (insertAssembly adds them in the definition's order)
  if (fresh.length !== built.def.modules.length) throw new Error(`${built.def.name}: inserted ${fresh.length} of ${built.def.modules.length} modules`);
  const ids = (local: number): number => fresh[local - 1].id;
  for (const [local, r] of built.ranges) fresh[local - 1].range = structuredClone(r);
  return { a, ids };
}

/** a patch around one such assembly, as factory-build.ts `around` does for a factory one: Main's keys into its `keys`, its
 * `out` (or `l` / `r`) into the Output */
export function around(name: string, built: Built): { p: Patch; main: ModuleInst; out: ModuleInst; a: AssemblyInst; ids: (local: number) => number } {
  const p = emptyPatch(name);
  const main = addModule(p, DEFS.fm1, 20, 20);
  const { a, ids } = place(p, built, 20, 60);
  const out = addModule(p, DEFS.output, Math.max(...p.modules.map((m) => m.x)) + 380, 20);
  const port = (dir: 'inputs' | 'outputs', label: string): PortRef => {
    const r = a[dir].find((x) => x.label === label);
    if (!r) throw new Error(`${name}: no ${dir} ${label}`);
    return r;
  };
  const keys = port('inputs', 'keys') as In;
  for (const t of [keys, ...(keys.also ?? [])]) connectOrThrow(p, main.id, 'keys', t.module, t.port);
  const l = port('outputs', a.outputs.some((x) => x.label === 'l') ? 'l' : 'out');
  const r = port('outputs', a.outputs.some((x) => x.label === 'r') ? 'r' : 'out');
  connectOrThrow(p, l.module, l.port, out.id, 'l');
  connectOrThrow(p, r.module, r.port, out.id, 'r');
  return { p, main, out, a, ids };
}

function connectOrThrow(p: Patch, a: number, ap: string, b: number, bp: string): void {
  if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`${p.name}: bad cable ${a}.${ap} -> ${b}.${bp}`);
}

/** the white keys from F3 the Drum maps' rows sit on (the drum kits' rows, gen-presets.ts KIT_NOTES): the level is set
 * with all of them held */
export const KIT_NOTES = [53, 55, 57, 59, 60, 62, 64, 65];

/** peak and RMS of both channels over `secs` with `notes` held */
export function loudness(p: Patch, notes: number[], secs = 3): { peak: number; rms: number; nan: boolean } {
  const e = new Engine(SR);
  e.load(p);
  for (const n of notes) e.noteOn(n);
  const l = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(l.length);
  e.render(l, r);
  let peak = 0, sum = 0, nan = false;
  for (let i = 0; i < l.length; i++) {
    if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) nan = true;
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    sum += l[i] * l[i] + r[i] * r[i];
  }
  return { peak, rms: Math.sqrt(sum / (2 * l.length)), nan };
}
const SR = 44118;

/** the Output's level so the XL's RMS (`notes` held) matches its FM-1 version's, kept under a peak of 0.95 */
export function matchLevel(p: Patch, fm1: Patch, notes: number[]): void {
  const out = p.modules.find((m) => m.type === 'output')!;
  const want = loudness(fm1, notes).rms;
  out.params.level = 0.1;
  const got = loudness(p, notes);
  const lv = Math.min((0.1 * want) / Math.max(got.rms, 1e-9), (0.1 * 0.95) / Math.max(got.peak, 1e-9));
  out.params.level = Math.round(Math.max(0.01, Math.min(1, lv)) * 100) / 100;
}
