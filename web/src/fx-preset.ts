// SPDX-License-Identifier: GPL-3.0-only
// Presets of an instrument with its FX drawer (FXD1, fx-preset-format.ts; docs/ledger/patches-and-presets.md). The drawer
// is part of the instrument's sound, so its presets always hold it: the effects in chain order, each one's on/off and
// card values. Loading one in the editor rebuilds the drawer to match (adds, removes and reorders effects, fx-drawer.ts),
// with each effect found by its structure: the preset's own copy (Preset.fx), an effect in the patch, or one from the
// Library (EFFECT_CATALOG). The old "+ FX" presets of the master FX bus (FXP1) are converted to FXD1 where they are read.
import { bypassAssembly, parentOf, rowTargets, tiedTo, toDef, type AssemblyDef, type AssemblyInst } from './assembly';
import type { Preset, PresetEffect } from './device-presets';
import { catalogEffectDef, drawerOf, EFFECT_CATALOG, effectsOf, insertEffect, legacyEffectDef, moveEffect, removeEffect } from './fx-drawer';
import { drawerPresetInfo, drawerPresetValues, FX_PRESET_CONTROLS, FX_PRESET_KINDS, fxPresetInfo, splitDrawerValues, type DrawerValues, type FxPresetKind } from './fx-preset-format';
import { DEFS } from './modules';
import { topOf, type Patch } from './patch';
import { defStructureAndOrder, drawerPresetStructure, rowOrder, structureOf } from './structure';

/** an instrument with its drawer, as its presets see it */
export interface DrawerScope {
  drawer: AssemblyInst;
  /** its effects, in chain order */
  effects: AssemblyInst[];
  /** the instrument's own structure (drawer left out) */
  base: string;
  effectStructures: string[];
  /** the FXD1 structure of the instrument with this chain */
  structure: string;
}

/** a top-level instrument's drawer scope; null when it has no drawer (its presets are instrument-only, as before) */
export function drawerScope(p: Patch, a: AssemblyInst): DrawerScope | null {
  if (parentOf(p, a.id) || a.chain || a.drawer) return null;
  const drawer = drawerOf(p, a.id);
  if (!drawer) return null;
  const effects = effectsOf(p, drawer);
  const base = structureOf(p, a), effectStructures = effects.map(e => structureOf(p, e));
  return { drawer, effects, base, effectStructures, structure: drawerPresetStructure(base, effectStructures) };
}

/** an effect a preset can name: its structure, its card rows' count, its name and a definition to add a copy from */
export interface KnownEffect { structure: string; rows: number; name: string; def: AssemblyDef }

const known = (name: string, def: AssemblyDef): KnownEffect => ({ structure: defStructureAndOrder(def).structure, rows: def.params.length, name, def });

let libraryEffects: KnownEffect[] | undefined;
/** every effect the Library can add (the old bus stages are among them: catalogEffectDef gives the same wrappers) */
function libraryKnown(): KnownEffect[] {
  libraryEffects ??= [
    ...FX_PRESET_KINDS.map(kind => known(legacyName(kind), legacyEffectDef(kind))),
    ...EFFECT_CATALOG.map(entry => known(entry.name, catalogEffectDef(entry))),
  ];
  return libraryEffects;
}

const legacyName = (kind: FxPresetKind): string => kind[0].toUpperCase() + kind.slice(1);

/** the effects a preset of this patch may name, by structure: the patch's own first (its copies keep their settings
 *  outside the card), then the Library's */
function knownEffects(p: Patch): Map<string, KnownEffect> {
  const out = new Map<string, KnownEffect>();
  for (const a of p.assemblies ?? []) if (a.chain) {
    const e = known(a.label || a.name, toDef(p, a));
    if (!out.has(e.structure)) out.set(e.structure, e);
  }
  for (const e of libraryKnown()) if (!out.has(e.structure)) out.set(e.structure, e);
  return out;
}

/** a preset's effects, found by structure; a string says why they cannot be */
export type Resolved = KnownEffect[] | string;

/** what the menu says about a preset whose effects cannot be found */
export const UNKNOWN_EFFECTS = 'Uses an effect that is neither in this patch nor in the Library, so it cannot be loaded here';

const found = new Map<string, string[]>();
/** the most effect lists tried for one preset before giving up (a preset of many effects from another editor) */
const SEARCH_MAX = 400_000;

/** The effects of an FXD1 preset of the instrument `a`: its own copies (Preset.fx), else the drawer's chain when it
 *  matches, else a search of the effects this patch and the Library have, by structure and value count. */
export function resolveEffects(p: Patch, a: AssemblyInst, preset: Preset, scope = drawerScope(p, a)): Resolved {
  const info = drawerPresetInfo(preset);
  if (!info || !scope || info.baseStructure !== scope.base) return 'Belongs to another instrument';
  const rows = rowOrder(p, a).length;
  const fits = (list: readonly string[]): boolean => drawerPresetStructure(scope.base, list) === preset.structure;
  if (preset.fx?.length === info.count && fits(preset.fx.map(f => f.structure)))
    return preset.fx.map(f => ({ structure: f.structure, rows: f.def.params.length, name: f.name, def: f.def }));
  const pool = knownEffects(p);
  if (scope.effects.length === info.count && fits(scope.effectStructures))
    return scope.effects.map((e, i) => pool.get(scope.effectStructures[i])!);
  const key = `${preset.structure}/${preset.values.length}`;
  const hit = found.get(key);
  if (hit) return hit.every(s => pool.has(s)) ? hit.map(s => pool.get(s)!) : UNKNOWN_EFFECTS;
  // every effect list of `count` known effects whose rows fill the record exactly, until one hashes to its structure
  const budget = preset.values.length - rows - 4 - info.count;
  const all = [...pool.values()].filter(e => e.rows <= budget);
  const least = Math.min(...all.map(e => e.rows));
  const pick: string[] = [];
  let tries = 0;
  const search = (left: number): boolean => {
    const slots = info.count - pick.length;
    if (!slots) return left === 0 && fits(pick);
    if (left < least * slots || ++tries > SEARCH_MAX) return false;
    for (const e of all) if (e.rows <= left) {
      pick.push(e.structure);
      if (search(left - e.rows)) return true;
      pick.pop();
    }
    return false;
  };
  if (budget < 0 || (info.count && !all.length) || !search(budget)) return UNKNOWN_EFFECTS;
  found.set(key, [...pick]);
  return pick.map(s => pool.get(s)!);
}

/** each effect's card row value ranges from its definition, in canonical row order (the order a preset keeps them in) */
function defRanges(def: AssemblyDef): { min: number; max: number }[] {
  return defStructureAndOrder(def).order.map(i => {
    const r = def.params[i];
    const m = def.modules.find(x => x.id === r.module)!;
    const pd = DEFS[m.type]?.params.find(d => d.name === r.param);
    return pd ? { min: pd.min, max: topOf(pd) } : { min: -Infinity, max: Infinity };
  });
}

/** an FXD1 record of `a` checked whole before anything changes: its values split by the resolved effects, or null */
export function checkDrawerPreset(p: Patch, a: AssemblyInst, preset: Preset, effects: KnownEffect[]): DrawerValues | null {
  const rows = rowOrder(p, a);
  const split = splitDrawerValues(preset.values, rows.length, effects.map(e => e.rows));
  if (!split) return null;
  const outside = (v: number, r: { module: number; param: string }): boolean => {
    const m = p.modules.find(x => x.id === r.module);
    const pd = m && DEFS[m.type]?.params.find(d => d.name === r.param);
    return !!pd && (v < pd.min || v > topOf(pd));
  };
  if (split.rows.some((v, i) => outside(v, rows[i]))) return null;
  if (split.effects.some((e, k) => { const ranges = defRanges(effects[k].def); return e.values.some((v, i) => v < ranges[i].min || v > ranges[i].max); })) return null;
  return split;
}

/** How loading a preset changes the drawer: the effects it adds and removes, by name (empty both: the chain stays). */
export function drawerChange(scope: DrawerScope, effects: readonly KnownEffect[]): { adds: string[]; removes: string[] } {
  const left = [...scope.effectStructures];
  const adds: string[] = [];
  for (const e of effects) {
    const i = left.indexOf(e.structure);
    if (i >= 0) left[i] = '';
    else adds.push(e.name);
  }
  const removes = scope.effects.filter((_, i) => left[i]).map(e => e.label || e.name);
  return { adds, removes };
}

/** Make the drawer's chain the preset's: keep the effects it has (first copy of each structure, in order), take out the
 *  rest, add the missing ones from their definitions, then put them in the preset's order. The effects, in that order. */
export function rebuildDrawer(p: Patch, scope: DrawerScope, effects: readonly KnownEffect[]): AssemblyInst[] {
  const free = scope.effects.map((e, i) => ({ e, s: scope.effectStructures[i], used: false }));
  const chosen: (AssemblyInst | null)[] = effects.map(want => {
    const have = free.find(f => !f.used && f.s === want.structure);
    if (!have) return null;
    have.used = true;
    return have.e;
  });
  for (const f of free) if (!f.used) removeEffect(p, f.e.id);
  const out = effects.map((want, k) => chosen[k] ?? insertEffect(p, scope.drawer, { def: want.def }));
  out.forEach((e, k) => { if (effectsOf(p, scope.drawer)[k]?.id !== e.id) moveEffect(p, scope.drawer, e.id, k); });
  return out;
}

/** set card rows (in canonical order) to values, every parameter a row sets with them, clamped to each one's range */
export function setRows(p: Patch, rows: readonly { module: number; param: string }[], values: readonly number[]): void {
  rows.slice(0, values.length).forEach((r, i) => {
    for (const t of tiedTo(p, r.module, r.param)) {
      const m = p.modules.find(x => x.id === t.module);
      const pd = m && DEFS[m.type]?.params.find(d => d.name === t.param);
      if (m && pd) m.params[t.param] = Math.min(topOf(pd), Math.max(pd.min, values[i]));
    }
  });
}

/** an effect on or off as its own ⏻ switches it (the whole effect, never the group switch's kept list); inside a drawer
 *  that is off, the drawer's ⏻ brings it back in that state */
export function setEffectEnabled(p: Patch, effect: AssemblyInst, on: boolean): number[] {
  delete effect.kept;
  const changed = bypassAssembly(p, effect, false);
  return on ? changed : bypassAssembly(p, effect, true);
}

/** Load the drawer part of a checked FXD1 record: each effect's rows, then its on/off. A drawer that is off stays off and
 *  brings each effect back as the preset has it. */
export function applyDrawerValues(p: Patch, drawer: AssemblyInst, effects: readonly AssemblyInst[], values: readonly { on: boolean; values: readonly number[] }[]): void {
  const off = !!drawer.bypass;
  if (off) bypassAssembly(p, drawer, false);
  effects.forEach((e, k) => {
    setRows(p, rowOrder(p, e), values[k].values);
    setEffectEnabled(p, e, values[k].on);
  });
  if (off) bypassAssembly(p, drawer, true);
}

/** the instrument's FXD1 record now: its rows, each effect's on/off and rows, the footer */
export function currentDrawerValues(p: Patch, a: AssemblyInst, scope: DrawerScope, rows: readonly number[]): number[] {
  return drawerPresetValues(scope.base, rows, scope.effects.map(e => ({ on: !e.bypass, values: rowOrder(p, e).map(r => p.modules.find(m => m.id === r.module)?.params[r.param] ?? 0) })));
}

/** the effects' own copies a captured preset carries, so loading it can add them back */
export const presetEffects = (p: Patch, scope: DrawerScope): PresetEffect[] =>
  scope.effects.map((e, i) => ({ name: e.label || e.name, structure: scope.effectStructures[i], def: toDef(p, e) }));

/** each old bus stage's controls (FX_PRESET_CONTROLS order) as its converted effect's canonical rows */
const legacyLayouts = new Map<FxPresetKind, { structure: string; def: AssemblyDef; fromControl: number[]; defaults: number[] }>();
function legacyLayout(kind: FxPresetKind) {
  let out = legacyLayouts.get(kind);
  if (out) return out;
  const def = legacyEffectDef(kind);
  const { structure, order } = defStructureAndOrder(def);
  const type = kind === 'drive' ? 'shape' : kind;
  const fromControl = order.map(i => {
    const targets = rowTargets(def.params[i]).map(t => ({ t, m: def.modules.find(x => x.id === t.module)! }));
    return FX_PRESET_CONTROLS[kind].findIndex(c => targets.some(({ t, m }) => kind === 'reverb' && c === 'mix' ? m.type === 'macro' && t.param === 'value' : m.type === type && t.param === c));
  });
  const defaults = order.map(i => def.modules.find(x => x.id === def.params[i].module)!.params[def.params[i].param] ?? 0);
  out = { structure, def, fromControl, defaults };
  legacyLayouts.set(kind, out);
  return out;
}

/** An old "+ FX" preset (FXP1) as an FXD1 one of the same instrument with its converted drawer (convertLegacyBus): each
 *  stage's on/off and controls go to its effect's card rows. Anything else comes back as it is. */
export function fxp1ToFxd1(preset: Preset): Preset {
  const info = fxPresetInfo(preset);
  if (!info) return preset;
  const kinds = FX_PRESET_KINDS.filter((_, i) => info.mask & (1 << i));
  let at = info.rows;
  const effects = kinds.map(kind => {
    const on = preset.values[at] === 1;
    const controls = preset.values.slice(at + 1, at + 1 + FX_PRESET_CONTROLS[kind].length);
    at += 1 + controls.length;
    return { on, values: legacyRows(kind, controls) };
  });
  const fx = legacyEffects(kinds);
  return {
    ...preset,
    structure: drawerPresetStructure(info.baseStructure, fx.map(f => f.structure)),
    values: drawerPresetValues(info.baseStructure, preset.values.slice(0, info.rows), effects),
    fx,
  };
}

/** the converted drawer's effects of an old bus with these stages: what factory presets of a converted factory drawer
 *  hold (factory-fx-presets.ts) */
export function legacyEffects(kinds: readonly FxPresetKind[]): PresetEffect[] {
  return kinds.map(kind => ({ name: legacyName(kind), structure: legacyLayout(kind).structure, def: legacyLayout(kind).def }));
}

/** a stage's controls in its converted effect's canonical row order (factory-fx-presets.ts) */
export function legacyRows(kind: FxPresetKind, controls: readonly number[]): number[] {
  const lay = legacyLayout(kind);
  return lay.fromControl.map((c, i) => (c >= 0 ? controls[c] : lay.defaults[i]));
}
