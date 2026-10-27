// SPDX-License-Identifier: GPL-3.0-only
// An assembly's structure (#192, docs/ledger/vocabulary.md "Structure"): what makes two assemblies the same, so that a preset made on one
// loads on every other: their module types, the cables among them, the nesting and which (module, parameter) pairs are
// card rows (with the further parameters a row sets, #357). Not values, positions, labels, names or row order. Module ids differ between copies, so the fingerprint
// never reads them: every module gets a label from its type, its card rows and its depth, refined a few rounds by the
// labels of the modules its cables join (port names included); the fingerprint hashes the sorted labels, the cables
// written in labels and the nested assemblies' member labels. Card rows are put in a canonical order the same way (by
// their module's label and parameter, ties in the definition's module order), which is the order a preset keeps its values in.
import { rowTargets, toDef, type AssemblyDef, type AssemblyInst } from './assembly';
import type { Patch } from './patch';

/** FNV-1a, 32 bits, as 8 hex digits */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** rounds of label refinement: enough for any assembly's cable paths to tell its modules apart in practice */
const ROUNDS = 4;

/** each module's final label, by local id */
function labels(def: AssemblyDef): Map<number, string> {
  const depth = new Map<number, number>();
  const nested = def.assemblies ?? [];
  const parent = new Map<number, number>();
  for (const n of nested) for (const c of n.children ?? []) parent.set(c, n.id);
  const levels = (id: number): number => { let k = 1; for (let x = parent.get(id); x !== undefined; x = parent.get(x)) k++; return k; };
  for (const n of nested) for (const m of n.modules) depth.set(m, levels(n.id));
  const rows = new Map<number, string[]>();
  for (const r of def.params) for (const t of rowTargets(r)) rows.set(t.module, [...(rows.get(t.module) ?? []), t.param]);
  let lab = new Map(def.modules.map((m) => [m.id, `${m.type}|${depth.get(m.id) ?? 0}|${[...(rows.get(m.id) ?? [])].sort().join(',')}`]));
  // each module's cables, found once (not by scanning every cable for every module in every round)
  const outOf = new Map<number, AssemblyDef['cables']>();
  const inOf = new Map<number, AssemblyDef['cables']>();
  for (const c of def.cables) {
    let o = outOf.get(c.from.module);
    if (!o) outOf.set(c.from.module, (o = []));
    o.push(c);
    let i = inOf.get(c.to.module);
    if (!i) inOf.set(c.to.module, (i = []));
    i.push(c);
  }
  for (let k = 0; k < ROUNDS; k++) {
    const next = new Map<number, string>();
    for (const m of def.modules) {
      const outs = (outOf.get(m.id) ?? []).map((c) => `>${c.from.port}:${c.to.port}:${lab.get(c.to.module)}`);
      const ins = (inOf.get(m.id) ?? []).map((c) => `<${c.to.port}:${c.from.port}:${lab.get(c.from.module)}`);
      next.set(m.id, fnv([lab.get(m.id), ...outs.sort(), ...ins.sort()].join(';')));
    }
    lab = next;
  }
  return lab;
}

/** the fingerprint from the labels */
function structureFrom(def: AssemblyDef, lab: Map<number, string>): string {
  const mods = def.modules.map((m) => `${m.type}:${lab.get(m.id)}`).sort();
  const cables = def.cables.map((c) => `${lab.get(c.from.module)}.${c.from.port}>${lab.get(c.to.module)}.${c.to.port}`).sort();
  const nests = (def.assemblies ?? []).map((n) => n.modules.map((id) => lab.get(id)).sort().join(',')).sort();
  // a row that sets several parameters (#357) is all of them joined by +, so the same parameters as separate rows differ
  const rows = def.params.map((r) => rowTargets(r).map((t) => `${lab.get(t.module)}.${t.param}`).join('+')).sort();
  return fnv([mods.join(' '), cables.join(' '), nests.join(' / '), rows.join(' ')].join('#'));
}

/** the canonical row order from the labels */
function rowOrderFrom(def: AssemblyDef, lab: Map<number, string>): number[] {
  const pos = new Map(def.modules.map((m, i) => [m.id, i]));
  return def.params.map((_, i) => i).sort((i, j) => {
    const a = def.params[i], b = def.params[j];
    const la = `${lab.get(a.module)}.${a.param}`, lb = `${lab.get(b.module)}.${b.param}`;
    return la < lb ? -1 : la > lb ? 1 : (pos.get(a.module)! - pos.get(b.module)!);
  });
}

/** a definition's structure fingerprint */
export const defStructure = (def: AssemblyDef): string => structureFrom(def, labels(def));

/** an assembly's structure fingerprint, in a patch */
export const structureOf = (p: Patch, a: AssemblyInst): string => defStructure(toDef(p, a));

/** a definition's card rows in their canonical order (the order a preset keeps its values in), as indices into def.params */
export const defRowOrder = (def: AssemblyDef): number[] => rowOrderFrom(def, labels(def));

/** defStructure and defRowOrder together, the labels worked out once */
export function defStructureAndOrder(def: AssemblyDef): { structure: string; order: number[] } {
  const lab = labels(def);
  return { structure: structureFrom(def, lab), order: rowOrderFrom(def, lab) };
}

/** an assembly's card rows in canonical order: (module id in the patch, parameter) */
export function rowOrder(p: Patch, a: AssemblyInst): { module: number; param: string }[] {
  return rowsOf(a, defRowOrder(toDef(p, a)));
}

const rowsOf = (a: AssemblyInst, order: number[]): { module: number; param: string }[] => order.map((i) => ({ module: a.params[i].module, param: a.params[i].param }));

/** structureOf and rowOrder together (one copy of the definition, the labels worked out once) */
export function structureAndRows(p: Patch, a: AssemblyInst): { structure: string; rows: { module: number; param: string }[] } {
  const { structure, order } = defStructureAndOrder(toDef(p, a));
  return { structure, rows: rowsOf(a, order) };
}
