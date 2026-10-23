// SPDX-License-Identifier: GPL-3.0-only
// Presets (#192, CONTEXT.md "Preset"): stored sets of card row values for one structure (structure.ts). Any assembly
// device of that structure can load them, whatever its name or patch; a plain module never has any. The user's own are
// kept in the browser (localStorage `matryoshka.presets`); factory ones (#193) come with the app, read-only (storing over
// one makes a new one). A patch remembers which preset each assembly was set to (AssemblyInst.preset), for display only:
// the patch plays its own values. Not the A/B snapshot, not a patch (a patch is the whole stored thing).
import { type AssemblyInst } from './assembly';
import { DEFS } from './modules';
import type { Patch } from './patch';
import { rowOrder, structureOf } from './structure';

export interface Preset {
  /** the structure fingerprint it belongs to */
  structure: string;
  name: string;
  /** the card rows' values, in canonical row order (structure.ts rowOrder) */
  values: number[];
  /** shipped with the app: read-only */
  factory?: true;
}

/** the file format of an exported library */
export const PRESETS_FORMAT = 'matryoshka-presets';
const STORE = 'matryoshka.presets';
/** a preset name's length at most (the FM-1 shows 8 characters of it) */
export const PRESET_NAME_MAX = 24;

/** the factory presets: set by factory-presets.ts (#193) */
let factory: Preset[] = [];
export const setFactoryPresets = (list: Preset[]): void => void (factory = list.map((p) => ({ ...p, factory: true })));

const fixName = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX);

/** a preset from anything, or null */
export function fixPreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = fixName(o.name);
  if (typeof o.structure !== 'string' || !/^[0-9a-f]{8}$/.test(o.structure) || !name || !Array.isArray(o.values)) return null;
  const values = o.values.map(Number);
  if (values.some((v) => !Number.isFinite(v))) return null;
  return { structure: o.structure, name, values };
}

/** the user's presets */
export function userPresets(): Preset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.map(fixPreset).filter((p): p is Preset => !!p) : [];
  } catch {
    return [];
  }
}

function writeUser(list: Preset[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list.map(({ structure, name, values }) => ({ structure, name, values }))));
  } catch {
    // storage full or blocked: the library stays as it was
  }
}

/** the presets of a structure: factory first, then the user's, each by name */
export function presetsFor(structure: string): Preset[] {
  const by = (a: Preset, b: Preset): number => a.name.localeCompare(b.name, undefined, { numeric: true });
  return [...factory.filter((p) => p.structure === structure).sort(by), ...userPresets().filter((p) => p.structure === structure).sort(by)];
}

/** the presets an assembly can load */
export const presetsOf = (p: Patch, a: AssemblyInst): Preset[] => presetsFor(structureOf(p, a));

/** an assembly's card row values, in canonical order */
export function currentValues(p: Patch, a: AssemblyInst): number[] {
  return rowOrder(p, a).map((r) => p.modules.find((m) => m.id === r.module)?.params[r.param] ?? 0);
}

/** load a preset into an assembly: its card rows take the preset's values (clamped to each parameter's range); the
 * assembly remembers its name. False when it does not fit (another structure). */
export function applyPreset(p: Patch, a: AssemblyInst, preset: Preset): boolean {
  if (preset.structure !== structureOf(p, a)) return false;
  const rows = rowOrder(p, a);
  if (rows.length !== preset.values.length) return false;
  rows.forEach((r, i) => {
    const m = p.modules.find((x) => x.id === r.module);
    const pd = m && DEFS[m.type]?.params.find((d) => d.name === r.param);
    if (m && pd) m.params[r.param] = Math.min(pd.max, Math.max(pd.min, preset.values[i]));
  });
  a.preset = preset.name;
  return true;
}

/** whether the assembly's values still match the preset it remembers (false: edited since, or the preset is gone) */
export function matchesPreset(p: Patch, a: AssemblyInst): boolean {
  if (!a.preset) return false;
  const pr = presetsOf(p, a).find((x) => x.name === a.preset);
  if (!pr) return false;
  const now = currentValues(p, a);
  return now.length === pr.values.length && now.every((v, i) => Math.abs(v - pr.values[i]) < 1e-6);
}

/** store the assembly's values as a user preset under `name` (a user preset of that name for the structure is
 * overwritten; a factory one's name gets a new name: "<name> 2"); the assembly remembers it. Returns the name used. */
export function storePreset(p: Patch, a: AssemblyInst, name: string): string {
  const structure = structureOf(p, a);
  let n = fixName(name) || 'preset';
  const taken = (x: string): boolean => factory.some((f) => f.structure === structure && f.name === x);
  for (let k = 2; taken(n); k++) n = `${fixName(name).slice(0, PRESET_NAME_MAX - 3)} ${k}`;
  const list = userPresets().filter((x) => !(x.structure === structure && x.name === n));
  list.push({ structure, name: n, values: currentValues(p, a) });
  writeUser(list);
  a.preset = n;
  return n;
}

/** rename a user preset; false when it is a factory one, missing, or the new name is taken */
export function renamePreset(structure: string, from: string, to: string): boolean {
  const n = fixName(to);
  const list = userPresets();
  const pr = list.find((x) => x.structure === structure && x.name === from);
  if (!pr || !n || presetsFor(structure).some((x) => x.name === n)) return false;
  pr.name = n;
  writeUser(list);
  return true;
}

/** delete a user preset; false when it is a factory one or missing */
export function deletePreset(structure: string, name: string): boolean {
  const list = userPresets();
  const kept = list.filter((x) => !(x.structure === structure && x.name === name));
  if (kept.length === list.length) return false;
  writeUser(kept);
  return true;
}

/** the user's library as a file */
export const exportPresets = (): { format: string; presets: Preset[] } => ({ format: PRESETS_FORMAT, presets: userPresets() });

/** a library file's presets merged into the user's (same structure and name: the file's wins); null when it is not one */
export function importPresets(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== PRESETS_FORMAT) return null;
  const incoming = Array.isArray((raw as { presets?: unknown }).presets) ? ((raw as { presets: unknown[] }).presets).map(fixPreset).filter((p): p is Preset => !!p) : [];
  const key = (x: Preset): string => `${x.structure}/${x.name}`;
  const have = new Map(userPresets().map((x) => [key(x), x]));
  for (const x of incoming) have.set(key(x), x);
  writeUser([...have.values()]);
  return incoming.length;
}

/** step from the assembly's remembered preset to the next (dir 1) or previous (-1) one, round; null when it has none */
export function stepPreset(p: Patch, a: AssemblyInst, dir: 1 | -1): Preset | null {
  const list = presetsOf(p, a);
  if (!list.length) return null;
  const i = list.findIndex((x) => x.name === a.preset);
  return list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
}
