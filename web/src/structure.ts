// SPDX-License-Identifier: GPL-3.0-only
// An assembly's structure (#192, CONTEXT.md "Structure"): what makes two assemblies the same, so that a preset made on one
// loads on every other: their module types, the cables among them, the nesting and which (module, parameter) pairs are
// card rows. Not values, positions, labels, names or row order. Module ids differ between copies, so the fingerprint
// never reads them: every module gets a label from its type, its card rows and its depth, refined a few rounds by the
// labels of the modules its cables join (port names included); the fingerprint hashes the sorted labels, the cables
// written in labels and the nested assemblies' member labels. Card rows are put in a canonical order the same way (by
// their module's label and parameter, ties in the definition's module order), which is the order a preset keeps its values in.
import { toDef, type AssemblyDef, type AssemblyInst } from './assembly';
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
  for (const r of def.params) rows.set(r.module, [...(rows.get(r.module) ?? []), r.param]);
  let lab = new Map(def.modules.map((m) => [m.id, `${m.type}|${depth.get(m.id) ?? 0}|${[...(rows.get(m.id) ?? [])].sort().join(',')}`]));
  for (let k = 0; k < ROUNDS; k++) {
    const next = new Map<number, string>();
    for (const m of def.modules) {
      const outs = def.cables.filter((c) => c.from.module === m.id).map((c) => `>${c.from.port}:${c.to.port}:${lab.get(c.to.module)}`);
      const ins = def.cables.filter((c) => c.to.module === m.id).map((c) => `<${c.to.port}:${c.from.port}:${lab.get(c.from.module)}`);
      next.set(m.id, fnv([lab.get(m.id), ...outs.sort(), ...ins.sort()].join(';')));
    }
    lab = next;
  }
  return lab;
}

/** a definition's structure fingerprint */
export function defStructure(def: AssemblyDef): string {
  const lab = labels(def);
  const mods = def.modules.map((m) => `${m.type}:${lab.get(m.id)}`).sort();
  const cables = def.cables.map((c) => `${lab.get(c.from.module)}.${c.from.port}>${lab.get(c.to.module)}.${c.to.port}`).sort();
  const nests = (def.assemblies ?? []).map((n) => n.modules.map((id) => lab.get(id)).sort().join(',')).sort();
  const rows = def.params.map((r) => `${lab.get(r.module)}.${r.param}`).sort();
  return fnv([mods.join(' '), cables.join(' '), nests.join(' / '), rows.join(' ')].join('#'));
}

/** an assembly's structure fingerprint, in a patch */
export const structureOf = (p: Patch, a: AssemblyInst): string => defStructure(toDef(p, a));

/** a definition's card rows in their canonical order (the order a preset keeps its values in), as indices into def.params */
export function defRowOrder(def: AssemblyDef): number[] {
  const lab = labels(def);
  const pos = new Map(def.modules.map((m, i) => [m.id, i]));
  return def.params.map((_, i) => i).sort((i, j) => {
    const a = def.params[i], b = def.params[j];
    const la = `${lab.get(a.module)}.${a.param}`, lb = `${lab.get(b.module)}.${b.param}`;
    return la < lb ? -1 : la > lb ? 1 : (pos.get(a.module)! - pos.get(b.module)!);
  });
}

/** an assembly's card rows in canonical order: (module id in the patch, parameter) */
export function rowOrder(p: Patch, a: AssemblyInst): { module: number; param: string }[] {
  const def = toDef(p, a);
  return defRowOrder(def).map((i) => ({ module: a.params[i].module, param: a.params[i].param }));
}
