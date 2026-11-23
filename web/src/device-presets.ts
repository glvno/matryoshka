// SPDX-License-Identifier: GPL-3.0-only
// Presets (#192, docs/ledger/vocabulary.md "Preset"): stored card values for one structure. An instrument with an FX drawer
// stores its drawer with it, always (FXD1, fx-preset.ts): the effects in order, their on/off and card values; loading one
// in the editor rebuilds the drawer to match. Older instrument-only presets ("no FX") load the instrument and leave its
// drawer as it is. An effect has presets of its own (its card values), loadable onto any copy. A plain module never has
// any. User presets live in localStorage `matryoshka.presets`; factory ones (#193) come with the app, read-only (storing
// over one makes a new one). A patch remembers which preset each assembly was set to (AssemblyInst.preset), for display
// only: the patch plays its own values. Not the A/B snapshot, not a patch (a patch is the whole stored thing).
import { type AssemblyDef, type AssemblyInst } from './assembly';
import { DEFS } from './modules';
import { topOf, type Patch } from './patch';
import { applyPresetPattern, clearPresetPattern } from './preset-patterns';
import { migrationRank, movePreset } from './preset-migrate';
import { rowOrder, structureOf } from './structure';
import { applyDrawerValues, checkDrawerPreset, currentDrawerValues, drawerChange, drawerScope, fxp1ToFxd1, presetEffects, rebuildDrawer, resolveEffects, setRows, type DrawerScope } from './fx-preset';
import { drawerPresetInfo, fxPresetInfo, splitDrawerValues } from './fx-preset-format';
import { PRESET_VALUES_MAX } from './protocol';

/** an effect of an FX drawer preset, kept with it in the editor so loading can add a copy back */
export interface PresetEffect {
  name: string;
  /** its structure (structure.ts structureOf) */
  structure: string;
  def: AssemblyDef;
}

export interface Preset {
  /** the structure fingerprint it belongs to */
  structure: string;
  name: string;
  /** Canonical card rows (structure.ts rowOrder); an FX drawer preset's then hold its effects and a footer (FXD1). */
  values: number[];
  /** an FX drawer preset's effects, in chain order (editor only: one from the FM-1 has none, its effects are found by
   *  structure) */
  fx?: PresetEffect[];
  /** shipped with the app: read-only */
  factory?: true;
}

/** the file format of an exported library */
export const PRESETS_FORMAT = 'matryoshka-presets';
const STORE = 'matryoshka.presets';
/** a preset name's length at most (the FM-1 shows 8 characters of it) */
export const PRESET_NAME_MAX = 24;

/** the factory presets: set by factory-presets.ts (#193), as a list or as a function that gives a structure's (called when a
 * structure's factory presets are first asked for, so the page does not work them all out as it loads); `drawers` gives
 * the FX drawer presets of an instrument structure (by the footer's, fx-preset-format.ts) */
let factorySource: Preset[] | ((structure: string) => Preset[]) = [];
let drawerSource: (base: string) => Preset[] = () => [];
const recalledStructures = new WeakMap<AssemblyInst, string>();
let factoryMade = new Map<string, Preset[]>();
let drawersMade = new Map<string, Preset[]>();
export function setFactoryPresets(list: Preset[] | ((structure: string) => Preset[]), drawers?: (base: string) => Preset[]): void {
  factorySource = list;
  drawerSource = drawers ?? (typeof list === 'function' ? () => [] : (base) => list.filter((p) => drawerPresetInfo(p)?.baseStructure === base));
  factoryMade = new Map();
  drawersMade = new Map();
}
const asFactory = (list: Preset[]): Preset[] => list.map((p) => ({ ...p, factory: true as const }));
/** a structure's factory presets, in their own order (Init first) */
function factoryFor(structure: string): Preset[] {
  let out = factoryMade.get(structure);
  if (!out) {
    const src = factorySource;
    out = asFactory(typeof src === 'function' ? src(structure) : src.filter((p) => p.structure === structure));
    factoryMade.set(structure, out);
  }
  return out;
}
/** an instrument structure's factory FX drawer presets, in their own order */
export function factoryDrawerPresets(base: string): Preset[] {
  let out = drawersMade.get(base);
  if (!out) drawersMade.set(base, (out = asFactory(drawerSource(base))));
  return out;
}

/** preset names are one name whatever their case (the FM-1 shows and stores capitals: BRIGHT 2 is Bright 2) */
export const sameName = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const fixName = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX);

const isEffect = (x: unknown): x is PresetEffect => {
  const o = x as Partial<PresetEffect> | null;
  return !!o && typeof o.name === 'string' && typeof o.structure === 'string' && /^[0-9a-f]{8}$/.test(o.structure) &&
    !!o.def && Array.isArray(o.def.modules) && Array.isArray(o.def.params) && Array.isArray(o.def.cables);
};

/** a preset from anything, or null; an old "+ FX" one (FXP1) comes back as an FX drawer preset (fx-preset.ts fxp1ToFxd1) */
export function fixPreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = fixName(o.name);
  if (typeof o.structure !== 'string' || !/^[0-9a-f]{8}$/.test(o.structure) || !name || !Array.isArray(o.values)) return null;
  const values = o.values.map(Number);
  if (values.some((v) => !Number.isFinite(v))) return null;
  const fx = Array.isArray(o.fx) && o.fx.every(isEffect) ? (o.fx as PresetEffect[]) : undefined;
  return fxp1ToFxd1(fx ? { structure: o.structure, name, values, fx } : { structure: o.structure, name, values });
}

/** a factory engine's Init values for a structure, if it has them */
const initOf = (structure: string): number[] | undefined => factoryFor(structure).find((p) => p.name === 'Init')?.values;

/** a user preset stored for an earlier structure of a factory engine, moved to today's structure (D-865,
 * preset-migrate.ts): rows still there keep their values, new ones take the engine's Init values. Null when its structure
 * does not move, or a factory preset of today's structure has its name (it then stays as it is). */
export function movedPreset(structure: string, name: string, values: number[]): { structure: string; values: number[] } | null {
  const m = movePreset(structure, values, initOf);
  return m && !factoryFor(m.structure).some((f) => sameName(f.name, name)) ? m : null;
}

/** move the user's presets of earlier structures to today's (once as the app starts, D-865): each replaces its old copy,
 * and a preset of today's structure of the same name (the older structure's moved first, so the newer one's wins). Old
 * "+ FX" presets (FXP1) are stored again as FX drawer presets (userPresets reads them so). How many moved. */
export function migrateUserPresets(): number {
  const list = userPresets();
  const converted = storedRaw().filter((x) => { const o = x as Preset | null; return !!o && Array.isArray(o.values) && typeof o.structure === 'string' && !!fxPresetInfo(o); }).length;
  const due = list.map((p) => ({ p, r: migrationRank(p.structure) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r);
  if (!due.length && !converted) return 0;
  let out = list;
  let n = converted;
  for (const { p } of due) {
    const m = movedPreset(p.structure, p.name, p.values);
    if (!m) continue;
    out = [...out.filter((x) => x !== p && !(x.structure === m.structure && sameName(x.name, p.name))), { structure: m.structure, name: p.name, values: m.values }];
    n++;
  }
  if (n) writeUser(out);
  return n;
}

/** the stored list as it is, unread */
function storedRaw(): unknown[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** the user's presets */
export function userPresets(): Preset[] {
  return storedRaw().map(fixPreset).filter((p): p is Preset => !!p);
}

function writeUser(list: readonly Preset[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list.map(({ structure, name, values, fx }) => (fx ? { structure, name, values, fx } : { structure, name, values }))));
  } catch {
    // storage full or blocked: the library stays as it was
  }
}

const byName = (a: Preset, b: Preset): number => a.name.localeCompare(b.name, undefined, { numeric: true });

/** the presets of a structure: factory first (in their own order, Init first), then the user's by name */
export function presetsFor(structure: string): Preset[] {
  return [...factoryFor(structure), ...userPresets().filter((p) => p.structure === structure).sort(byName)];
}

/** Values as this card can play them. Keep stored factory/user values intact for wider copies. */
function boundedValues(p: Patch, a: AssemblyInst, rows: { module: number; param: string }[], values: number[]): number[] {
  let bounded: number[] | undefined;
  rows.slice(0, values.length).forEach((r, i) => {
    const m = p.modules.find(x => x.id === r.module);
    const pd = m && DEFS[m.type]?.params.find(d => d.name === r.param);
    if (!pd) return;
    const cardTop = a.params.find(x => x.module === r.module && x.param === r.param)?.top;
    const value = Math.min(topOf(pd), cardTop ?? Infinity, Math.max(pd.min, values[i]));
    if (value !== values[i]) {
      bounded ??= [...values];
      bounded[i] = value;
    }
  });
  return bounded ?? values;
}

/** an instrument's FX drawer presets: the factory ones, then the user's by name (any chain: loading rebuilds the drawer) */
function drawerPresetsFor(base: string): Preset[] {
  return [...factoryDrawerPresets(base), ...userPresets().filter((p) => p.structure !== base && drawerPresetInfo(p)?.baseStructure === base).sort(byName)];
}

/** a preset of an instrument with its drawer that cannot be loaded here, and why */
export interface UnloadablePreset { preset: Preset; reason: string }

/** The presets this assembly can load, respecting its exposed row limits, and those it cannot (an FX drawer preset whose
 *  effects are not to be found). An instrument with a drawer lists its FX drawer presets, then its instrument-only ones
 *  ("no FX"); the factory instrument-only ones only when it has no factory FX drawer presets (those are the same sounds
 *  with their effects). Any other assembly (an effect too) lists its own structure's. */
export function presetChoices(p: Patch, a: AssemblyInst): { list: Preset[]; unloadable: UnloadablePreset[] } {
  const rows = rowOrder(p, a), base = structureOf(p, a), scope = drawerScope(p, a);
  const unloadable: UnloadablePreset[] = [];
  let list = presetsFor(base);
  if (scope) {
    const fx = drawerPresetsFor(base).filter((preset) => {
      const r = resolveEffects(p, a, preset, scope);
      if (typeof r === 'string') unloadable.push({ preset, reason: r });
      return typeof r !== 'string';
    });
    const authored = fx.some((preset) => preset.factory);
    list = [...fx.filter((preset) => preset.factory), ...list.filter((preset) => !preset.factory || !authored), ...fx.filter((preset) => !preset.factory)];
  }
  return {
    list: list.map((preset) => {
      const values = boundedValues(p, a, rows, preset.values);
      return values === preset.values ? preset : { ...preset, values };
    }),
    unloadable,
  };
}

/** The presets this assembly can load (presetChoices). */
export const presetsOf = (p: Patch, a: AssemblyInst): Preset[] => presetChoices(p, a).list;

/** how a preset reads in the menu of an instrument with a drawer */
export interface PresetView {
  /** instrument-only: loading leaves the drawer as it is */
  noFx: boolean;
  /** its effects by name, in chain order, and whether each is on */
  chain: string[];
  on: boolean[];
  /** what loading adds to and removes from the drawer, by name */
  adds: string[];
  removes: string[];
}

/** How a preset of an instrument with a drawer reads in its menu; null for an assembly without a drawer (or a preset
 *  whose effects cannot be found). */
export function presetView(p: Patch, a: AssemblyInst, preset: Preset, scope = drawerScope(p, a)): PresetView | null {
  if (!scope) return null;
  if (!drawerPresetInfo(preset)) return { noFx: true, chain: [], on: [], adds: [], removes: [] };
  const r = resolveEffects(p, a, preset, scope);
  if (typeof r === 'string') return null;
  const split = splitDrawerValues(preset.values, rowOrder(p, a).length, r.map((e) => e.rows));
  return { noFx: false, chain: r.map((e) => e.name), on: split?.effects.map((e) => e.on) ?? r.map(() => true), ...drawerChange(scope, r) };
}

/** names in a sentence: "Drive", "Drive and Delay", "Drive, Chorus and Delay" */
const listed = (names: readonly string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** what loading a preset does to the drawer, as its menu row says it ("loading adds Drive, removes Chorus"), or once done
 *  ("added Drive, removed Chorus"); '' nothing */
export function drawerChangeText(adds: readonly string[], removes: readonly string[], done = false): string {
  const parts = [adds.length ? `${done ? 'added' : 'adds'} ${listed(adds)}` : '', removes.length ? `${done ? 'removed' : 'removes'} ${listed(removes)}` : ''].filter(Boolean);
  return !parts.length ? '' : done ? parts.join(', ') : `loading ${parts.join(', ')}`;
}

/** an assembly's card row values, in canonical order */
export function currentValues(p: Patch, a: AssemblyInst): number[] {
  return rowOrder(p, a).map((r) => p.modules.find((m) => m.id === r.module)?.params[r.param] ?? 0);
}

/** Capture an assembly's preset: an instrument with a drawer, the instrument with its whole drawer (FXD1, its effects'
 *  copies with it); any other assembly, its card rows. */
export function capturePreset(p: Patch, a: AssemblyInst, name: string): Preset {
  const values = currentValues(p, a), scope = drawerScope(p, a);
  return scope
    ? { structure: scope.structure, name, values: currentDrawerValues(p, a, scope, values), fx: presetEffects(p, scope) }
    : { structure: structureOf(p, a), name, values };
}

/** Load a preset into an assembly: its card rows take the preset's values (clamped to each parameter's range), every
 * parameter a row sets (#357) too; the assembly remembers its name. A preset of fewer values than the card has rows (a
 * Cassia 1 preset the FM-1 stored before 1.8.2 kept 88 of 118, #485, D-858) sets the rows it has, in order; the rest keep
 * their values (shortBy says how many). An FX drawer preset is checked whole first, then sets the instrument's rows and
 * each effect's rows and on/off; with `rebuild` (the editor's menu) the drawer is first made to hold the preset's
 * effects in its order, else (the FM-1's palette) only a drawer that holds them already takes one. False when it does
 * not fit (another structure, more values than rows, a malformed record or effects not to be found): nothing changed. */
export function applyPreset(p: Patch, a: AssemblyInst, preset: Preset, rebuild = false): boolean {
  const base = structureOf(p, a), rows = rowOrder(p, a);
  if (drawerPresetInfo(preset)) return applyDrawerPreset(p, a, preset, base, rows, rebuild);
  if (preset.structure !== base || preset.values.length > rows.length || preset.values.some(v => !Number.isFinite(v))) return false;
  if (preset.factory) applyPresetPattern(p, a, base, preset.name);
  else clearPresetPattern(p, a);
  setRows(p, rows, boundedValues(p, a, rows, preset.values));
  recalledStructures.set(a, preset.structure);
  a.preset = preset.name;
  return true;
}

function applyDrawerPreset(p: Patch, a: AssemblyInst, preset: Preset, base: string, rows: { module: number; param: string }[], rebuild: boolean): boolean {
  const scope = drawerScope(p, a);
  if (!scope || preset.values.length > PRESET_VALUES_MAX || (!rebuild && preset.structure !== scope.structure)) return false;
  const effects = resolveEffects(p, a, preset, scope);
  if (typeof effects === 'string') return false;
  const split = checkDrawerPreset(p, a, preset, effects);
  if (!split) return false;
  if (preset.factory) applyPresetPattern(p, a, base, preset.name);
  else clearPresetPattern(p, a);
  const chain = preset.structure === scope.structure ? scope.effects : rebuildDrawer(p, scope, effects);
  setRows(p, rows, boundedValues(p, a, rows, split.rows));
  applyDrawerValues(p, scope.drawer, chain, split.effects);
  recalledStructures.set(a, preset.structure);
  a.preset = preset.name;
  return true;
}

/** how many of the assembly's card rows a preset leaves as they are (it has fewer values than rows); 0 a whole one */
export function shortBy(p: Patch, a: AssemblyInst, preset: Preset): number {
  return drawerPresetInfo(preset) ? 0 : Math.max(0, rowOrder(p, a).length - preset.values.length);
}

/** what the editor says about a preset that leaves `missing` of an engine's `rows` rows as they are (D-858) */
export const shortPresetText = (engine: string, missing: number, rows: number): string =>
  `Stored before 1.8.2: ${missing} of ${engine}'s ${rows} rows are missing and keep their current values. To keep it, adjust and store it again, which saves all ${rows} rows. To start over, load a factory ${engine} preset and store it under this name, which replaces this one.`;

/** the assembly's values agree with a preset's (a shorter preset: its rows, the rest are not its; as the FM-1's dp_same,
 * one of no values never) */
const agrees = (now: number[], values: number[]): boolean => values.length > 0 && values.length <= now.length && values.every((v, i) => Math.abs(v - now[i]) < 1e-6);

function agreesWithPreset(p: Patch, a: AssemblyInst, preset: Preset, scope: DrawerScope | null = drawerScope(p, a)): boolean {
  if (drawerPresetInfo(preset)) {
    if (!scope || scope.structure !== preset.structure) return false;
    const now = currentDrawerValues(p, a, scope, currentValues(p, a));
    return now.length === preset.values.length && agrees(now, preset.values);
  }
  return preset.structure === structureOf(p, a) && agrees(currentValues(p, a), preset.values);
}

/** Names may exist both for the instrument alone and with its drawer. A live selection wins; after a patch reload, infer
 * it from the actual values, FX drawer presets first. */
export function rememberedPreset(p: Patch, a: AssemblyInst, list = presetsOf(p, a)): Preset | undefined {
  const named = list.filter(pr => sameName(pr.name, a.preset));
  if (named.length < 2) return named[0];
  const scope = drawerScope(p, a);
  return named.find(pr => pr.structure === recalledStructures.get(a))
    ?? named.find(pr => !!drawerPresetInfo(pr) && agreesWithPreset(p, a, pr, scope))
    ?? named.find(pr => agreesWithPreset(p, a, pr, scope)) ?? named[0];
}

/** whether the assembly's values still match the preset it remembers (false: edited since, or the preset is gone) */
export function matchesPreset(p: Patch, a: AssemblyInst): boolean {
  const pr = rememberedPreset(p, a);
  return !!pr && agreesWithPreset(p, a, pr);
}

/** store the assembly's values as a user preset under `name` (a user preset of that name for the structure is
 * overwritten; a factory one's name gets a new name: "<name> 2"); the assembly remembers it. Returns the name used. */
export function storePreset(p: Patch, a: AssemblyInst, name: string): string {
  const { put } = addPresetOf(p, a, capturePreset(p, a, name));
  a.preset = put.name;
  recalledStructures.set(a, put.structure);
  clearPresetPattern(p, a);
  return put.name;
}

/** store `preset` (values captured from the assembly `a` of `p`, or from a version of `p`: a snapshot, #1031) as a user
 * preset of `a`, named as storePreset names one; `fresh`: a name any of the assembly's presets has takes the next number
 * instead of storing over a user preset. The assembly is left as it is. What it stored, and the user preset it replaced */
export function addPresetOf(p: Patch, a: AssemblyInst, preset: Preset, fresh = false): { put: Preset; was?: Preset } {
  const structure = preset.structure;
  if (drawerPresetInfo(preset) && preset.values.length > PRESET_VALUES_MAX)
    throw new Error(`${a.label} with its FX drawer needs ${preset.values.length} preset values, and a preset holds ${PRESET_VALUES_MAX} at most. Take an effect out of the drawer to store it.`);
  let n = fixName(preset.name) || 'preset';
  const available = presetsOf(p, a);
  const taken = (x: string): boolean => available.some(f => (fresh || f.factory || f.structure !== structure) && sameName(f.name, x));
  for (let k = 2; taken(n); k++) n = `${fixName(preset.name).slice(0, PRESET_NAME_MAX - 3)} ${k}`;
  const users = userPresets();
  const was = users.find((x) => x.structure === structure && sameName(x.name, n));
  const put: Preset = { structure, name: n, values: [...preset.values], ...(preset.fx ? { fx: preset.fx } : {}) };
  writeUser([...users.filter((x) => x !== was), put]);
  return was ? { put, was } : { put };
}

/** take the user presets of these structures and names out of the library, then add `add` (an undo step's presets, #1031) */
export function replaceUserPresets(drop: readonly { structure: string; name: string }[], add: readonly Preset[]): void {
  const gone = (x: Preset): boolean => drop.some((d) => d.structure === x.structure && sameName(d.name, x.name));
  writeUser([...userPresets().filter((x) => !gone(x)), ...add.map((x) => ({ ...x, values: [...x.values] }))]);
}

/** a user preset from elsewhere (the FM-1, #195): stored under its name, over one of the same structure and name in any
 * case (which keeps its own spelling); a name in capitals only, as the FM-1 writes them, otherwise takes the editor's
 * style (INIT 2 -> Init 2). One of an earlier structure of a factory engine moves to today's (D-865); an old "+ FX" one
 * (FXP1) becomes an FX drawer preset. False when a factory one has that name. Returns the name it is stored under */
export function addUserPreset(structure: string, name: string, values: number[]): string | false {
  let n = fixName(name);
  const m = movedPreset(structure, n, values);   // (from an FM-1 that has not moved its presets yet, D-865)
  if (m) ({ structure, values } = m);
  const read = fxp1ToFxd1({ structure, name: n, values });
  if (!n || factoryFor(read.structure).some((f) => sameName(f.name, n))) return false;
  const users = userPresets();
  const had = users.find((x) => x.structure === read.structure && sameName(x.name, n));
  if (had) n = had.name;
  else if (n === n.toUpperCase() && /[A-Z]/.test(n)) n = n.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  writeUser([...users.filter((x) => !(x.structure === read.structure && sameName(x.name, n))), { ...read, name: n, values: [...read.values] }]);
  return n;
}

/** rename a user preset; false when it is a factory one, missing, or the new name is taken */
export function renamePreset(structure: string, from: string, to: string): boolean {
  const n = fixName(to);
  const list = userPresets();
  const pr = list.find((x) => x.structure === structure && sameName(x.name, from));
  if (!pr || !n || presetsFor(structure).some((x) => sameName(x.name, n) && !sameName(x.name, from))) return false;
  pr.name = n;
  writeUser(list);
  return true;
}

/** delete a user preset; false when it is a factory one or missing */
export function deletePreset(structure: string, name: string): boolean {
  const list = userPresets();
  const kept = list.filter((x) => !(x.structure === structure && sameName(x.name, name)));
  if (kept.length === list.length) return false;
  writeUser(kept);
  return true;
}

/** the user's library as a file */
export const exportPresets = (): { format: string; presets: Preset[] } => ({ format: PRESETS_FORMAT, presets: userPresets() });

/** a library file's presets merged into the user's (same structure and name: the file's wins; one of an earlier structure
 * of a factory engine moves to today's, D-865); null when it is not one */
export function importPresets(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== PRESETS_FORMAT) return null;
  const incoming = (Array.isArray((raw as { presets?: unknown }).presets) ? ((raw as { presets: unknown[] }).presets).map(fixPreset).filter((p): p is Preset => !!p) : [])
    .map((p) => ({ ...p, ...movedPreset(p.structure, p.name, p.values) }));   // (an older file: D-865)
  const key = (x: Preset): string => `${x.structure}/${x.name.toLowerCase()}`;
  const have = new Map(userPresets().map((x) => [key(x), x]));
  for (const x of incoming) have.set(key(x), x);
  writeUser([...have.values()]);
  return incoming.length;
}

/** the name a new preset of the assembly gets by default (the FM-1's ENV + SAVE names it the same way, pages_ui.c
 * dp_store): the preset it is based on (the one it remembers; none: the first of its list, a factory engine's Init; none
 * either: "Preset") with the next free number; a number already at its end is replaced ("Bright 2" -> "Bright 3") */
export function nextPresetName(p: Patch, a: AssemblyInst): string {
  const list = presetsOf(p, a);
  const base = (a.preset ?? list[0]?.name ?? 'Preset').replace(/ \d+$/, '').slice(0, PRESET_NAME_MAX - 3) || 'Preset';
  const taken = new Set(list.map((x) => x.name.toLowerCase()));
  let k = 2;
  while (taken.has(`${base} ${k}`.toLowerCase())) k++;
  return `${base} ${k}`;
}

/** step from the assembly's remembered preset to the next (dir 1) or previous (-1) one, round; null when it has none. One
 * that remembers none (a patch just loaded, #432) stands on the first preset whose values it has, as the FM-1 does
 * (pages_ui.c dp_current): a fresh factory engine is on Init, so the next is the first after it */
export function stepPreset(p: Patch, a: AssemblyInst, dir: 1 | -1): Preset | null {
  const list = presetsOf(p, a);
  if (!list.length) return null;
  const remembered = rememberedPreset(p, a, list);
  const i = a.preset ? list.indexOf(remembered!)
    : list.findIndex(pr => agreesWithPreset(p, a, pr));
  return list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
}
