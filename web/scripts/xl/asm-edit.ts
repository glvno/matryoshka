// SPDX-License-Identifier: GPL-3.0-only
// Editing a factory assembly's definition for an XL (scripts/xl/xl.ts): a copy of the FM-1 version's assembly (`edit`) gets
// modules, cables, retyped modules and card rows the way gen-assemblies.ts builds them (grid columns of GX, rows of GY;
// local ids 1..n, the definition's own), then goes into a patch with `aroundDef` (factory-build.ts `around`, for a
// definition that is not on the shelves). The FM-1 version's assembly is never changed: the XL's definition lives only in
// its patch. An XL that builds its assembly anew uses def.ts.
import { DEFS } from '../../src/modules';
import { addModule, defaultMap, defaultParams, emptyPatch, rowDef, type ModuleInst, type Source } from '../../src/patch';
import { FACTORY } from '../../src/assemblies';
import { insertAssembly, type AssemblyDef, type NestedDef, type ParamRef, type PortRef } from '../../src/assembly';
import { mod, plugIn, plugOut, row, type Inst } from '../factory-build';

export const GX = 320;
export const GY = 560;

type In = PortRef & { also?: { module: number; port: string }[] };
export interface RowOpts { col?: boolean; head?: string; group?: boolean; span?: number; inner?: string }

export class Ed {
  constructor(readonly def: AssemblyDef) {}
  private get nests(): NestedDef[] {
    return this.def.assemblies ?? [];
  }
  m(id: number): ModuleInst {
    const m = this.def.modules[id - 1];
    if (!m || m.id !== id) throw new Error(`${this.def.name}: no module ${id}`);
    return m;
  }
  /** a module at grid column / row (fractions allowed); returns its local id */
  add(type: string, col: number, r: number, p: Record<string, number> = {}, o: { p1?: string; p2?: string } = {}): number {
    const def = DEFS[type];
    if (!def) throw new Error(`no module type ${type}`);
    for (const k of Object.keys(p)) if (!def.params.some((q) => q.name === k)) throw new Error(`${type} has no parameter ${k}`);
    const m: ModuleInst = { id: this.def.modules.length + 1, type, x: Math.round(col * GX), y: Math.round(r * GY), params: { ...defaultParams(def), ...p } };
    if (def.paramInputs) {
      const map = defaultMap(def) as Record<Source, string[]>;
      map.k1 = map.k2 = map.k3 = map.k4 = [];
      if (o.p1) map.p1 = [o.p1];
      if (o.p2) map.p2 = [o.p2];
      m.att = [1, 1];
      m.map = map;
    }
    this.def.modules.push(m);
    return m.id;
  }
  /** a module becomes another type with the same ports in use (a Ladder into a Multimode): its parameters are the new
   * type's defaults, then `p` */
  retype(id: number, type: string, p: Record<string, number>): void {
    const m = this.m(id);
    const def = DEFS[type];
    m.type = type;
    m.params = { ...defaultParams(def), ...p };
    for (const c of this.def.cables) {
      if (c.from.module === id && !def.outputs.some((q) => q.name === c.from.port)) throw new Error(`${type} has no output ${c.from.port}`);
      if (c.to.module === id && !def.inputs.some((q) => q.name === c.to.port)) throw new Error(`${type} has no input ${c.to.port}`);
    }
  }
  wire(a: number, ap: string, b: number, bp: string): void {
    if (!DEFS[this.m(a).type].outputs.some((q) => q.name === ap)) throw new Error(`${this.def.name}: no output ${ap} on ${a}`);
    if (!DEFS[this.m(b).type].inputs.some((q) => q.name === bp)) throw new Error(`${this.def.name}: no input ${bp} on ${b}`);
    this.def.cables.push({ from: { module: a, port: ap }, to: { module: b, port: bp } });
  }
  /** take a cable out (it must exist) */
  unwire(a: number, ap: string, b: number, bp: string): void {
    const i = this.def.cables.findIndex((c) => c.from.module === a && c.from.port === ap && c.to.module === b && c.to.port === bp);
    if (i < 0) throw new Error(`${this.def.name}: no cable ${a}.${ap} -> ${b}.${bp}`);
    this.def.cables.splice(i, 1);
  }
  nest(label: string): NestedDef {
    const n = this.nests.find((x) => x.label === label);
    if (!n) throw new Error(`${this.def.name}: no nested ${label}`);
    return n;
  }
  /** modules join a nested assembly (the voice card of a poly assembly: they then run once per voice) */
  join(label: string, ...ids: number[]): void {
    const n = this.nest(label);
    n.modules.push(...ids);
    // a parent shows only what its children show: the card's rows of a module that joins go on the nested card too
    for (const r of this.def.params) if (ids.includes(r.module) && !n.params.some((q) => q.module === r.module && q.param === r.param)) n.params.push({ module: r.module, param: r.param, label: r.label });
  }
  private nestOf(id: number): NestedDef | undefined {
    return this.nests.find((n) => n.modules.includes(id));
  }
  input(label: string, module: number, port: string, ...also: [number, string][]): void {
    const ref: In = { module, port, label, ...(also.length ? { also: also.map(([m, p]) => ({ module: m, port: p })) } : {}) };
    this.def.inputs.push(ref);
  }
  private ref(label: string, module: number, param: string, o: RowOpts): ParamRef {
    if (!rowDef(DEFS[this.m(module).type], param)) throw new Error(`${this.def.name}: no parameter ${param} on ${module}`);
    const n = this.nestOf(module);
    if (n && !n.params.some((r) => r.module === module && r.param === param)) n.params.push({ module, param, label: o.inner ?? label });
    return { module, param, label, ...(o.col ? { col: true as const } : {}), ...(o.head ? { head: o.head } : {}), ...(o.group ? { group: true as const } : {}), ...(o.span && o.span > 1 ? { span: o.span } : {}) };
  }
  /** a card row at the end */
  param(label: string, module: number, param: string, o: RowOpts = {}): void {
    this.def.params.push(this.ref(label, module, param, o));
  }
  /** the index of the card row of this label (the n-th of that label with `nth`) */
  rowAt(label: string, nth = 0): number {
    const at = this.def.params.map((r, i) => (r.label === label ? i : -1)).filter((i) => i >= 0)[nth];
    if (at === undefined) throw new Error(`${this.def.name}: no row ${label}`);
    return at;
  }
  /** a card row before row `at` */
  insertRow(at: number, label: string, module: number, param: string, o: RowOpts = {}): void {
    this.def.params.splice(at, 0, this.ref(label, module, param, o));
  }
  /** row `at` shows another parameter under another label (its heading and breaks stay) */
  rebind(at: number, label: string, module: number, param: string, inner?: string): void {
    const old = this.def.params[at];
    for (const n of this.nests) n.params = n.params.filter((r) => !(r.module === old.module && r.param === old.param));
    const fresh = this.ref(label, module, param, { inner });
    this.def.params[at] = { ...old, module: fresh.module, param: fresh.param, label };
  }
}

/** a copy of a factory assembly to edit */
export function edit(name: string, f: (e: Ed) => void): AssemblyDef {
  const src = FACTORY.find((d) => d.name === name);
  if (!src) throw new Error(`no factory assembly ${name}`);
  const def = structuredClone(src);
  f(new Ed(def));
  return def;
}

/** factory-build.ts `around` for a definition of the XL's own: Main's keys (and mod wheel, when it has a `wheel` input)
 * in, its outputs to the Output */
export function aroundDef(name: string, def: AssemblyDef): Inst {
  const p = emptyPatch(name);
  const main = addModule(p, DEFS.fm1, 20, 20);
  const a = insertAssembly(p, DEFS, def, 20, 60);
  const right = Math.max(...p.modules.map((m) => m.x)) + 380;
  const out = addModule(p, DEFS.output, right, 20);
  plugIn(p, main.id, 'keys', a, 'keys');
  if (a.inputs.some((x) => x.label === 'wheel')) plugIn(p, main.id, 'mod', a, 'wheel');
  if (a.outputs.some((x) => x.label === 'l')) {
    plugOut(p, a, 'l', out.id, 'l');
    plugOut(p, a, 'r', out.id, 'r');
  } else {
    plugOut(p, a, 'out', out.id, 'l');
    plugOut(p, a, 'out', out.id, 'r');
  }
  return {
    p, main, out, a,
    set: (label, v, after) => {
      const r = row(a, label, after);
      mod(p, r.module).params[r.param] = v;
    },
  };
}
