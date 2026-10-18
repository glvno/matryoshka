// SPDX-License-Identifier: GPL-3.0-only
// Copy / paste of a selection (glvno/matryoshka#92), no DOM. A clip is the selection written as an assembly definition
// (toDef on a scratch copy of the patch, the selected modules and assemblies as the members of a stand-in assembly), so it
// carries nested assemblies, the cables among the copied items and Steps data the way saved assemblies do; cables to
// anything not copied are left behind. A paste inserts that definition and ungroups the stand-in: the items land loose,
// with fresh ids. As text it is JSON, which is what goes through the system clipboard.
import { assembliesOf, EXCLUDED_TYPES, insertAssembly, toDef, ungroup, validateAssemblyDef, type AssemblyDef, type AssemblyInst } from './assembly';
import type { ModuleDef, Patch } from './patch';

export const CLIP_FORMAT = 'matryoshka-clip';

export interface Clip {
  format: typeof CLIP_FORMAT;
  version: 1;
  /** where the copied items' top left was in their patch (a paste lands offset from it) */
  x: number;
  y: number;
  def: AssemblyDef;
}

/** the clip of these modules and assemblies (top-level items of a selection: nested ones come with their assembly). Main
 *  and the Output are left out, as from any assembly; null when nothing else is left. */
export function copyItems(p: Patch, moduleIds: number[], asmIds: number[]): Clip | null {
  const scratch = structuredClone(p);
  const mods = moduleIds.filter((id) => {
    const m = scratch.modules.find((x) => x.id === id);
    return m && !EXCLUDED_TYPES.has(m.type);
  });
  const asms = asmIds.filter((id) => assembliesOf(scratch).some((a) => a.id === id));
  if (!mods.length && !asms.length) return null;
  const all = assembliesOf(scratch);
  const holder: AssemblyInst = { v: 1, id: Math.max(0, ...all.map((a) => a.id)) + 1, name: 'clip', label: 'clip', x: 0, y: 0, open: false, modules: mods, children: asms, inputs: [], outputs: [], params: [] };
  scratch.assemblies = [...all, holder];
  const def = toDef(scratch, holder);
  // toDef measures from the members' modules; an assembly's own position may sit further up / left
  const xs = [...def.modules.map((m) => m.x), ...(def.assemblies ?? []).map((a) => a.x)];
  const ys = [...def.modules.map((m) => m.y), ...(def.assemblies ?? []).map((a) => a.y)];
  const dx = Math.min(0, ...xs), dy = Math.min(0, ...ys);
  for (const m of def.modules) (m.x -= dx), (m.y -= dy);
  for (const a of def.assemblies ?? []) (a.x -= dx), (a.y -= dy);
  const origin = scratch.modules.filter((m) => holderModules(scratch, holder).has(m.id));
  return {
    format: CLIP_FORMAT,
    version: 1,
    x: Math.min(...origin.map((m) => m.x)) + dx,
    y: Math.min(...origin.map((m) => m.y)) + dy,
    def,
  };
}

/** the scratch ids of every module the clip holds (the stand-in's members and its nested assemblies' members) */
function holderModules(p: Patch, holder: AssemblyInst): Set<number> {
  const out = new Set(holder.modules);
  const walk = (ids: number[]): void => {
    for (const id of ids) {
      const a = assembliesOf(p).find((x) => x.id === id);
      if (!a) continue;
      for (const m of a.modules) out.add(m);
      walk(a.children ?? []);
    }
  };
  walk(holder.children ?? []);
  return out;
}

export const clipText = (c: Clip): string => JSON.stringify(c);

/** a clip from text (the system clipboard): null when the text is not one; the definition is checked like a library file */
export function parseClip(text: string, defs: Record<string, ModuleDef>): Clip | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as Partial<Clip> | null;
  if (!r || r.format !== CLIP_FORMAT || r.version !== 1 || typeof r.x !== 'number' || typeof r.y !== 'number') return null;
  try {
    return { format: CLIP_FORMAT, version: 1, x: r.x, y: r.y, def: validateAssemblyDef(r.def, defs) };
  } catch {
    return null;
  }
}

/** put the clip's items into `p` with their top left at (x, y); returns the new top-level module and assembly ids */
export function pasteClip(p: Patch, defs: Record<string, ModuleDef>, clip: Clip, x: number, y: number): { modules: number[]; assemblies: number[] } {
  const holder = insertAssembly(p, defs, structuredClone(clip.def), x, y);
  const out = { modules: [...holder.modules], assemblies: [...(holder.children ?? [])] };
  ungroup(p, holder.id);
  return out;
}
