// SPDX-License-Identifier: GPL-3.0-only
// Whether a sound is a version of a patch that device presets reach (D-1240, D-1319): the same patch (its name, modules,
// cables and drawers) with other card values, tempo or patterns, each differing device then taking a preset of its values
// (one this browser or the FM-1 has, else a new one). Add to palette (palette.ts) points a palette entry at an FM-1 slot
// with it; a candidate's Save… (candidate-save.ts) stores those presets instead of a new patch.
import { assemblyById, bypassAssembly, drawers, effectsOf, moveAssembly, parentOf, type AssemblyInst } from './assembly';
import { parseBinary, type BinPatch } from './bin-parse';
import { deviceName } from './bank';
import { KIND_LABEL, type ButtonKind } from './buttons';
import type { DeviceLink } from './device';
import { applyPreset, capturePreset, currentValues, matchesPreset, presetsOf, rememberedPreset, sameName, type Preset } from './device-presets';
import { drawerScope, setEffectEnabled } from './fx-preset';
import { DEFS } from './modules';
import type { Patch } from './patch';
import { placeOf } from './pages';
import { layout } from './patchbin';
import { devicePresetName, PALETTE_DEVS, PRESET_NAME_BYTES, PRESET_VALUES_MAX, type PaletteDevice, type PaletteEntry } from './protocol';
import { structureAndRows, structureOf } from './structure';
import { fixSeq } from './track';

/** the characters of a preset name the patch binary keeps (the FM-1 compares this many) */
export const BIN_PRESET_CHARS = 12;

/** a preset name as an entry's: the same, case aside, over the characters the FM-1 compares when one side is longer */
export const samePreset = (a: string | undefined, b: string): boolean =>
  !!a && (sameName(a, b) || ((a.length > BIN_PRESET_CHARS || b.length > BIN_PRESET_CHARS) && sameName(a.slice(0, BIN_PRESET_CHARS), b.slice(0, BIN_PRESET_CHARS))));

/** the devices of `patch` that hold a preset, as an entry keeps them: the device's index in the binary's device extras,
 *  its structure, the preset's namespace (the structure the preset belongs to: the device's own, or that of its instrument
 *  with its FX drawer, FXD1; 0 when not known, and the FM-1 looks the name up), the preset's name. A device with no preset
 *  name plays the slot's own values and is left out; the first PALETTE_DEVS are kept */
export function paletteDevices(patch: Patch): PaletteDevice[] {
  const out: PaletteDevice[] = [];
  layout(patch).devs.forEach((d, dev) => {
    const a = d.asm === undefined ? undefined : assemblyById(patch, d.asm);
    const name = devicePresetName(a?.preset ?? '');
    if (!a || !name) return;
    const structure = parseInt(structureAndRows(patch, a).structure, 16) >>> 0;
    if (!structure) return;
    const known = rememberedPreset(patch, a);
    out.push({ dev, structure, pstructure: known ? parseInt(known.structure, 16) >>> 0 : 0, name });
  });
  return out.slice(0, PALETTE_DEVS);
}

/** the user presets the entry of `patch` names, as this browser keeps them, each under the name the entry gives it: the
 *  ones the FM-1 needs to be sent (a factory preset is on it already; a name this browser has no preset of has nothing

/** two binaries are the same, byte for byte */
export const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.prototype.every.call(a, (x: number, i: number) => x === b[i]);

/** the selected pattern of `patch` (0-based) */
export const patchPattern = (patch: Patch): number => patch.modules.find((m) => m.type === 'fm1')?.seq?.pattern ?? 0;

/** the entry of `patch` in slot `slot` under `name`, the slot's own name (default: the patch's, as the editor names the
 *  slots it stores) */
export const entryOf = (patch: Patch, slot: number, name = deviceName(patch.name.trim() || 'PATCH')): PaletteEntry =>
  ({ slot, pattern: patchPattern(patch), name, devices: paletteDevices(patch) });

/** device `a` of `p` still plays its card's preset name (owner 2026-11-27, D-1226: a palette entry records a preset name
 *  only when it is true): its card values are exactly those of a preset of that name, one this browser has (factory or
 *  the user's) or one of `extra` (a saved sound's own presets, the FM-1's, the presets an add makes), compared as the
 *  FM-1 keeps values (Q16). An instrument with an FX drawer counts with its drawer or alone */
export function truePresetName(p: Patch, a: AssemblyInst, extra: readonly Preset[] = []): boolean {
  if (!a.preset) return false;
  if (matchesPreset(p, a)) return true;
  const now = [capturePreset(p, a, '')];
  if (drawerScope(p, a)) now.push({ structure: structureOf(p, a), name: '', values: currentValues(p, a) });
  return extra.some((x) => samePreset(x.name, a.preset!) && now.some((n) => n.structure === x.structure && n.values.length === x.values.length && n.values.every((v, i) => q16(v) === q16(x.values[i]))));
}

/** a copy of `patch` whose devices keep only the preset names that are true (truePresetName), the rest dropped: a stale
 *  "Init" after knob edits names nothing. `extra` as truePresetName's */
export function truePresetNames(patch: Patch, extra: readonly Preset[] = []): Patch {
  const out = structuredClone(patch);
  for (const a of out.assemblies ?? []) if (a.preset && !truePresetName(out, a, extra)) delete a.preset;
  return out;
}

/**
 * The entry applied to `patch` (a copy of its slot's patch) as the FM-1 applies it before its load: each device whose
 * preset name differs from the entry's takes the entry's preset (factory first, then the user's, by name), values only,
 * as the FM-1 brings no preset pattern; an FX drawer preset only where the drawer holds its effects already (the FM-1
 * never rebuilds a drawer). Then the entry's pattern is selected and no song plays. Returns the preset names this
 * browser has not got (those devices keep the slot's values, as on an FM-1 without them). `extra`: presets looked up
 * first, not stored yet (Add to palette trying the presets it would make, presetFit)
 */
export function applyEntry(patch: Patch, entry: PaletteEntry, extra: readonly Preset[] = []): string[] {
  const gone: string[] = [];
  const devs = layout(patch).devs;
  const structureOf = (asm: number | undefined): number => {
    const a = asm === undefined ? undefined : assemblyById(patch, asm);
    return a ? parseInt(structureAndRows(patch, a).structure, 16) >>> 0 : 0;
  };
  for (const e of entry.devices) {
    const d = structureOf(devs[e.dev]?.asm) === e.structure ? devs[e.dev] : devs.find((x) => structureOf(x.asm) === e.structure);
    const a = d?.asm === undefined ? undefined : assemblyById(patch, d.asm);
    if (!a) { gone.push(e.name); continue; }
    if (samePreset(a.preset, e.name)) continue;
    const mine = [structureAndRows(patch, a).structure, drawerScope(patch, a)?.structure];
    const list = [...extra.filter((p) => mine.includes(p.structure)), ...presetsOf(patch, a)];
    const preset = list.find((p) => samePreset(p.name, e.name) && (!e.pstructure || parseInt(p.structure, 16) >>> 0 === e.pstructure)) ?? list.find((p) => samePreset(p.name, e.name));
    if (!preset || !applyPreset(patch, a, { ...preset, factory: undefined })) gone.push(e.name);
  }
  const main = patch.modules.find((m) => m.type === 'fm1');
  if (main) {
    const seq = fixSeq({ ...main.seq, pattern: entry.pattern, song: 0 });
    if (seq) main.seq = seq;
    else delete main.seq;
  }
  return gone;
}

/** a patch's structure as device presets see it (the identity Add to palette needs to reach a sound with presets alone,
 *  owner 2026-11-24): its modules (id and type), its cables, and each assembly's structure, its FX drawers' chains
 *  with them; values, names, tempo and patterns aside */
export function patchStructure(p: Patch): string {
  return JSON.stringify([
    p.modules.map((m) => [m.id, m.type]),
    p.cables.map((c) => `${c.from.module}.${c.from.port}>${c.to.module}.${c.to.port}`).sort(),
    (p.assemblies ?? []).map((a) => [a.id, structureOf(p, a), !!a.chain, !!a.drawer]),
  ]);
}

/** what a palette entry plays from its slot whatever the sound added (owner 2026-11-24: "tempo and pattern difference
 *  should not send a new patch"): the Main module's tempo, its pattern and songs, and each Steps module's notes, patterns,
 *  P-locks and pattern origins with pattern 1's length and rate */
const TRACK_FIELDS = ['notes', 'patterns', 'locks', 'factoryPatterns'] as const;
const TRACK_PARAMS = ['len', 'rate'] as const;

/** `to` takes `from`'s tempo and patterns (TRACK_FIELDS; the same structure). `pair`: the module of `from` that stands for
 *  a module of `to` (default: the one with its id) */
export function takeTempoAndPatterns(to: Patch, from: Patch, pair: (m: Patch['modules'][number]) => Patch['modules'][number] | undefined = (m) => from.modules.find((x) => x.id === m.id)): void {
  for (const m of to.modules) {
    const o = pair(m);
    if (!o) continue;
    const keys: string[] = m.type === 'fm1' ? ['tempo'] : m.type === 'steps' ? [...TRACK_PARAMS] : [];
    for (const k of keys) {
      if (o.params[k] === undefined) delete m.params[k];
      else m.params[k] = o.params[k];
    }
    const fields: (keyof typeof m)[] = m.type === 'fm1' ? ['seq'] : m.type === 'steps' ? [...TRACK_FIELDS] : [];
    for (const k of fields) {
      if (o[k] === undefined) delete m[k];
      else (m as unknown as Record<string, unknown>)[k] = structuredClone(o[k]);
    }
  }
}

/**
 * `slot`, a slot's patch read back from the FM-1 (patch-reader.ts: its own module ids, its cards rebuilt), as a patch of
 * `sound`'s structure: the sound with each device's card values and preset names (an instrument's with its FX drawer), the
 * tempo and the patterns of the slot's patch, and its devices in the slot's order. Each device is paired with the slot's
 * of its kind (an assembly's structure, a plain module's type): the one of the same modules when the sound was read back
 * too (Consolidate: the reader numbers modules as the binary lists them, and both binaries list the same modules), else
 * the one in the same turn. So a sound whose cards sat elsewhere is still that patch: the device order is where the cards
 * sit (D-1458), and a Tidy may have changed it since the sound was saved (owner 2026-11-28: the 1.30 factory patches
 * against palettes saved before; Briefcase 3's mixers, all of one type, came in another order). Its cards then take the
 * slot's places. Null when their devices differ in number or kind. It encodes to the slot's bytes exactly when the two
 * differ in nothing else: then it is the slot's patch as presetFit compares it, which Add to palette needs when this
 * browser has no copy of what the slot holds (owner 2026-11-27: a slot stored by an earlier add, a hold-save of the
 * FM-1's own edits, another browser).
 */
export function asSlot(sound: Patch, slot: Patch): Patch | null {
  const out = structuredClone(sound);
  const mine = layout(out).devs, theirs = layout(slot).devs;
  if (mine.length !== theirs.length) return null;
  const asmOf = (p: Patch, d: (typeof mine)[number]): AssemblyInst | undefined => (d.asm === undefined ? undefined : assemblyById(p, d.asm));
  const kindOf = (p: Patch, d: (typeof mine)[number]): string => {
    const a = asmOf(p, d);
    return a ? `a${structureOf(p, a)}` : `m${p.modules.find((m) => m.id === d.module)?.type}`;
  };
  const left = theirs.map((t) => kindOf(slot, t));
  // (the same device: an assembly of the same modules, a plain module of the same id)
  const idOf = (p: Patch, d: (typeof mine)[number]): string => {
    const a = asmOf(p, d);
    return a ? `a${[...a.modules].sort((x, y) => x - y).join()}` : `m${d.module}`;
  };
  const same = mine.map((d) => theirs.findIndex((t, k) => left[k] === kindOf(out, d) && idOf(slot, t) === idOf(out, d)));
  const pairs: [(typeof mine)[number], (typeof theirs)[number]][] = [];
  if (same.every((k) => k >= 0) && new Set(same).size === same.length) mine.forEach((d, i) => pairs.push([d, theirs[same[i]]]));
  else for (const d of mine) {
    const k = left.indexOf(kindOf(out, d));
    if (k < 0) return null;
    left[k] = '';
    pairs.push([d, theirs[k]]);
  }
  for (const [d, td] of pairs) {
    const a = asmOf(out, d), t = asmOf(slot, td);
    if (!a || !t || a.chain || a.drawer) continue;
    const want = capturePreset(slot, t, ''), have = capturePreset(out, a, '');
    if (want.structure !== have.structure || want.values.length !== have.values.length || !applyPreset(out, a, want)) return null;
    if (t.preset) a.preset = t.preset;
    else delete a.preset;
    const there = drawerScope(slot, t)?.effects ?? [];
    (drawerScope(out, a)?.effects ?? []).forEach((e, k) => {
      if (there[k]?.preset) e.preset = there[k].preset;
      else delete e.preset;
    });
  }
  // (another order: each top-level card where the slot's paired card sits, so the reading order is the slot's)
  if (pairs.some(([, t], i) => t !== theirs[i])) {
    for (const [d, td] of pairs) {
      const a = asmOf(out, d), t = asmOf(slot, td);
      if (a && t) {
        if (parentOf(out, a.id) || a.drawer) continue;
        const to = placeOf(slot, t), at = placeOf(out, a);
        moveAssembly(out, a, to.x - at.x, to.y - at.y);
        continue;
      }
      const m = out.modules.find((x) => x.id === d.module), tm = slot.modules.find((x) => x.id === td.module);
      if (m && tm) [m.x, m.y] = [tm.x, tm.y];
    }
  }
  // (the Main module and the Steps modules, each paired with the slot's of its type in the same place: the binary keeps
  // their order)
  const main = out.modules.find((m) => m.type === 'fm1');
  const names = main?.seq?.names;
  takeTempoAndPatterns(out, slot, (m) => (m.type === 'fm1' || m.type === 'steps' ? slot.modules.filter((x) => x.type === m.type)[out.modules.filter((x) => x.type === m.type).indexOf(m)] : undefined));
  if (main && names) main.seq = { ...main.seq, names };   // (editor only, never in the binary: the reader has none)
  return out;
}

/** `to` with each card where `from`, of the same structure (patchStructure), has it: the canvas's reading order, which is
 *  the FM-1's device order (D-1458), becomes `from`'s */
function takePlaces(to: Patch, from: Patch): void {
  for (const m of to.modules) {
    const f = from.modules.find((x) => x.id === m.id);
    if (f) [m.x, m.y] = [f.x, f.y];
  }
  for (const a of to.assemblies ?? []) {
    const f = assemblyById(from, a.id);
    if (f) [a.x, a.y, a.open] = [f.x, f.y, f.open];
  }
}

/** two patch binaries hold the same modules and cables (bin-parse.ts): what no device preset changes */
export function sameWiring(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const x = parseBinary(a), y = parseBinary(b);
  return !!x && !!y && JSON.stringify([x.modules.map((m) => m.type), x.cables]) === JSON.stringify([y.modules.map((m) => m.type), y.cables]);
}

/** a patch binary's structure as no device preset, tempo, pattern or card place changes it, compared across slots (owner
 *  2026-11-27, D-1227: a sound is recognised by its structure, not its name): its module types, its cables, its devices'
 *  structure fingerprints and its FX drawers (each by its instrument's fingerprint), in no order, as a Tidy may change the
 *  device order (D-1458). Null when this editor does not read the binary */
export function binStructure(bin: ArrayLike<number>): string | null {
  const b = parseBinary(bin);
  if (!b) return null;
  return JSON.stringify([b.modules.map((m) => m.type), b.cables, b.extras.map((e) => e.structure).sort((x, y) => x - y),
    (b.rack?.drawers ?? []).map((d) => [b.extras[d.owner]?.structure ?? -1, d.count]).sort((x, y) => x[0] - y[0] || x[1] - y[1])]);
}

/** a patch binary's structure as binStructure has it with its FX rack's effects left out: its devices' structure
 *  fingerprints and the types of the modules outside every effect, in no order. Two slots of one patch whose FX drawers
 *  hold other effects (one added or taken out, or another order) have one, and no preset makes one the other: an FXD1
 *  preset sets the effects a drawer holds, never which (D-1215). Null when this editor does not read the binary */
export function binCore(bin: ArrayLike<number>): string | null {
  const b = parseBinary(bin);
  if (!b) return null;
  const effects = b.rack?.effects ?? [];
  const fx = new Set(effects.map((e) => e.device));
  const inFx = new Set(effects.flatMap((e) => [...e.targets, ...(b.extras[e.device]?.members ?? [])]));
  return JSON.stringify([b.extras.filter((_, i) => !fx.has(i)).map((e) => e.structure).sort((x, y) => x - y),
    b.modules.flatMap((m, i) => (inFx.has(i) ? [] : [m.type])).sort()]);
}

/** why the patch of binary `bin` is not that of `base` (slot `label`'s), one of the same binCore: what each FX drawer
 *  holds in both (owner 2026-11-28: a palette entry Consolidate leaves says why), else that their cables differ */
export function drawerDifference(bin: ArrayLike<number>, base: ArrayLike<number>, label: string): string {
  const fxOf = (b: BinPatch): Map<number, string> => new Map((b.rack?.drawers ?? []).map((d): [number, string] =>
    [b.extras[d.owner]?.structure ?? -1, b.rack!.effects.slice(d.first, d.first + d.count).map((e) => b.devices[e.device]?.name || 'an effect').join(', ') || 'no effects']));
  const x = parseBinary(bin), y = parseBinary(base);
  const mine = x ? fxOf(x) : new Map<number, string>(), theirs = y ? fxOf(y) : new Map<number, string>();
  const parts = [...new Set([...mine.keys(), ...theirs.keys()])].filter((k) => mine.get(k) !== theirs.get(k)).map((k) => {
    const a = mine.get(k), b = theirs.get(k);
    return `${a === undefined ? 'it has no FX drawer' : `its FX drawer holds ${a}`} and ${label}${b === undefined ? ' has none' : `'s holds ${b}`}`;
  });
  return parts.length ? `${parts.join('; ')}: a preset cannot add, take out or move an effect` : `it has other cables than ${label}`;
}

/** the notes of `p` as a palette entry would change them: its tracks' patterns and the song it plays and keeps (the
 *  selected pattern aside: the entry selects the sound's; pattern origins and store links aside: bookkeeping) */
const patternsOf = (p: Patch): string => JSON.stringify(p.modules.map((m) =>
  m.type === 'fm1' ? [m.seq?.song ?? 0, m.seq?.songs ?? []]
    : m.type === 'steps' ? [m.notes ?? [], m.patterns ?? [], m.locks ?? [], TRACK_PARAMS.map((k) => m.params[k])] : 0));

/** what a palette entry plays from its slot `slot` instead of `sound`'s own: "tempo", "patterns", "tempo and patterns",
 *  or '' (the same) */
export function slotPlays(sound: Patch, slot: Patch): string {
  const [tempo, was] = [sound, slot].map((p) => p.modules.find((m) => m.type === 'fm1')?.params.tempo ?? 120);
  const t = tempo !== was, n = patternsOf(sound) !== patternsOf(slot);
  return t && n ? 'tempo and patterns' : t ? 'tempo' : n ? 'patterns' : '';
}

/** a device preset a sound reached with presets names, for the device of assembly `asm`: one this browser has (`browser`,
 *  a user preset; `factory`), one only the FM-1 has (`fm1`), one only a saved sound brought (`sound`: sent, and it joins
 *  this browser's presets as a made one does), or one it makes (`new`) */
export interface PresetPick { preset: Preset; from: 'browser' | 'factory' | 'fm1' | 'sound' | 'new'; asm: number }

/** a sound reached from a slot's patch with device presets: the sound as the FM-1 plays it then (each device under the
 *  preset name the entry gives it), the presets named, and what the entry plays from the slot instead (slotPlays) */
export interface PresetFit { named: Patch; picks: PresetPick[]; plays: string }

/** why Add to palette stores a patch: no slot's patch has the sound's modules, cables and drawers */
export const NO_SAME_STRUCTURE = 'no patch with its modules and cables is on the FM-1';

/** `sound` and `held` are one patch as device presets see it: its name, as the FM-1 keeps names, and its structure */
export const samePatch = (sound: Patch, held: Patch): boolean =>
  deviceName(sound.name.trim()) === deviceName(held.name.trim()) && patchStructure(sound) === patchStructure(held);

/** values agree as the editor keeps them */
const sameValues = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
/** a value as the FM-1 keeps it (Q16) */
export const q16 = (v: number): number => Math.round(v * 65536);

/** a value as JSON writes it with each object's keys in one order, so two of the same content compare alike */
const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, x]) => [k, canonical(x)])) : v);

/** the button settings of a panel (MainPanel), each button's together */
const buttonsOf = (p: Patch['modules'][number]['panel'] = {}): Map<string, string> => {
  const keys = new Set([...(p.toggle ?? []), ...(p.on ?? []), ...[p.labels, p.kinds, p.targets, p.pages].flatMap((r) => Object.keys(r ?? {}))]);
  return new Map([...keys].map((b) => [b, JSON.stringify(canonical([p.toggle?.includes(b), p.on?.includes(b), p.labels?.[b], p.kinds?.[b], p.targets?.[b], p.pages?.[b]]))]));
};

/** one setting that differs between two patches of one structure: its name as a reason gives it (`the FX button`; a
 *  parameter's is its module's, `param` then naming it) and the change from the first patch's value to the second's */
interface SettingChange { name: string; change: string; param?: string }

/** a value as a change shows it */
const shown = (v: number | undefined): string => (v === undefined ? 'none' : Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2));
/** a button's kind as the editor's button card says it (Nothing is "unassigned") */
const kindName = (k: ButtonKind): string => (k === 'nothing' ? 'unassigned' : KIND_LABEL[k].toLowerCase());

/** the settings that differ between two patches of one structure (patchStructure), module by module: a switch, each
 *  parameter (Q16, as the FM-1 keeps values), each panel button's kind, label, press, target, pages and state, any other
 *  setting of a module; with no module's, an assembly's card rows and MIDI learn */
function settingChanges(a: Patch, b: Patch): SettingChange[] {
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(canonical(x)) === JSON.stringify(canonical(y));
  const named = (m: Patch['modules'][number]): string => m.name || DEFS[m.type]?.label || m.type;
  const target = (p: Patch, t: { module: number } | { asm: number } | undefined): string => {
    if (!t) return 'none';
    if ('asm' in t) return assemblyById(p, t.asm)?.label ?? 'an assembly';
    const m = p.modules.find((x) => x.id === t.module);
    return m ? named(m) : 'a module';
  };
  const out: SettingChange[] = [];
  for (const m of a.modules) {
    const o = b.modules.find((x) => x.id === m.id);
    if (!o) continue;
    const asm = (a.assemblies ?? []).find((x) => x.modules.includes(m.id));
    const name = asm ? `${asm.label || asm.name} › ${named(m)}` : named(m);
    const state = (x: Patch['modules'][number]): string => (x.bypass ? 'off' : 'on');
    if (!!m.bypass !== !!o.bypass) out.push({ name: `${name} switched ${state(m)}`, change: `${name} ${state(m)} → ${state(o)}` });
    for (const k of new Set([...Object.keys(m.params), ...Object.keys(o.params)])) {
      if (q16(m.params[k]) !== q16(o.params[k])) out.push({ name, param: k, change: `${name} ${k} ${shown(m.params[k])} → ${shown(o.params[k])}` });
    }
    const x = m.panel ?? {}, y = o.panel ?? {};
    const mine = buttonsOf(x), theirs = buttonsOf(y);
    for (const key of new Set([...mine.keys(), ...theirs.keys()])) {
      if (mine.get(key) === theirs.get(key)) continue;
      const B = key.toUpperCase(), parts: string[] = [];
      const kx = x.kinds?.[key] ?? 'gate', ky = y.kinds?.[key] ?? 'gate';
      if (kx !== ky) parts.push(`${kindName(kx)} → ${kindName(ky)}`);
      if ((x.labels?.[key] ?? '') !== (y.labels?.[key] ?? '')) parts.push(`label "${x.labels?.[key] ?? ''}" → "${y.labels?.[key] ?? ''}"`);
      const press = (p: typeof x): string => (p.toggle?.includes(key) ? 'switches' : 'holds');
      if (press(x) !== press(y)) parts.push(`press ${press(x)} → ${press(y)}`);
      if (!same(x.targets?.[key], y.targets?.[key])) parts.push(`target ${target(a, x.targets?.[key])} → ${target(b, y.targets?.[key])}`);
      if (!same(x.pages?.[key] ?? [], y.pages?.[key] ?? [])) parts.push(`pages ${(x.pages?.[key] ?? []).length} → ${(y.pages?.[key] ?? []).length}`);
      const lit = (p: typeof x): string => (p.on?.includes(key) ? 'on' : 'off');
      if (lit(x) !== lit(y)) parts.push(`${lit(x)} → ${lit(y)}`);
      for (const part of parts) out.push({ name: `the ${B} button`, change: `${B} button ${part}` });
    }
    const rest = (v: Patch['modules'][number]): unknown => ({ ...v, x: 0, y: 0, params: 0, bypass: 0, panel: 0 });
    if (!same(rest(m), rest(o))) out.push({ name, change: `${name}'s other settings` });
  }
  if (!out.length) {
    for (const x of a.assemblies ?? []) {
      const y = assemblyById(b, x.id);
      if (y && !same(x.params, y.params)) out.push({ name: `${x.label || x.name}'s card`, change: `${x.label || x.name}'s card rows` });
    }
    if (!same(a.midiLearn ?? [], b.midiLearn ?? [])) out.push({ name: 'MIDI learn', change: 'MIDI learn' });
  }
  return out;
}

/**
 * The settings that differ between two patches of one structure (patchStructure), as the user knows them: what a
 * device preset cannot hold when their presets agree (owner 2026-11-28: the line names it). A parameter by its module
 * (`Output level`; inside an assembly `Hera 6 › filter cutoff`), a module's switch as `a` has it (`Harmonizer switched
 * on`), a panel button (`the FX button`), any other setting of a module (`Main`); with no module's, an assembly's card or
 * MIDI learn. "settings no device preset holds", and what they are.
 */
export function unheldSettings(a: Patch, b: Patch): string {
  const params = new Map<string, string[]>(), order: string[] = [];
  for (const c of settingChanges(a, b)) {
    // (a module's parameters together: "Output level")
    const key = c.param === undefined ? c.name : `\0${c.name}`;
    if (!order.includes(key)) order.push(key);
    if (c.param !== undefined) params.set(c.name, [...(params.get(c.name) ?? []), c.param]);
  }
  const list = order.map((k) => {
    if (!k.startsWith('\0')) return k;
    const ps = params.get(k.slice(1))!;
    return `${k.slice(1)} ${ps.slice(0, 3).join(', ')}${ps.length > 3 ? '…' : ''}`;
  });
  return `settings no device preset holds${list.length ? `: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''}` : ''}`;
}

/** each setting that differs between two patches of one structure, as its change from `a`'s value to `b`'s: "Output
 *  level 1.00 → 0.39", "FX button unassigned → gate", "Harmonizer on → off" (Consolidate's Fold anyway lists them) */
export const unheldChanges = (a: Patch, b: Patch): string[] => settingChanges(a, b).map((c) => c.change);

/** `p` as the FM-1 plays its FX drawers: one switched off by its own ⏻ as one switched on with each effect off. The
 *  FM-1 keeps no drawer switch (the binary holds its modules' bypass, and a slot reads back so, assembly-match.ts
 *  rebuildRack), so an effect left on inside a drawer that is off plays off there, and a preset (FXD1) that switches it on
 *  would play it (owner 2026-11-28). The same bytes; `p` itself when no drawer is off, else a copy */
function drawersAsPlayed(p: Patch): Patch {
  if (!drawers(p).some((d) => d.bypass)) return p;
  const out = structuredClone(p);
  for (const d of drawers(out)) {
    if (!d.bypass) continue;
    bypassAssembly(out, d, false);
    for (const e of effectsOf(out, d)) setEffectEnabled(out, e, false);
  }
  return out;
}

/**
 * The sound `sound` reached from `slot` (a slot's patch) with device presets (owner 2026-11-24: "it should first
 * determine if it's a preset of the instrument the fm1 has already"), or why not. Both need one structure (patchStructure;
 * the names aside: a slot of another name holding that structure is that patch, D-1227). Each device (a top-level
 * assembly; an instrument with an FX drawer with its drawer, FXD1) whose card
 * values differ from the slot's takes a preset of exactly those values: one this browser has (factory or the user's, the
 * one the device remembers first), else one of `extra` (a saved sound's own presets), else one of `onFm1` (the FM-1's
 * own user presets), else a new one named `name` (the name the sound is added under, numbered when taken). A device
 * whose values agree keeps the slot's preset name, which the FM-1 leaves
 * as it is. Then the entry applied to `slot` (applyEntry) must give the sound byte for byte as `encode` writes it,
 * tempo and patterns aside (the entry plays the slot's, with the sound's selected pattern): anything else (a module's
 * setting outside its card, a device past PRESET_VALUES_MAX values, the panel, names) is a reason to store the patch.
 * Both are taken as the FM-1 plays their FX drawers (drawersAsPlayed).
 */
export function presetFit(sound: Patch, slot: Patch, name: string, encode: (p: Patch) => Uint8Array, onFm1: readonly Preset[] = [], extra: readonly Preset[] = []): PresetFit | { why: string } {
  if (patchStructure(sound) !== patchStructure(slot)) return { why: NO_SAME_STRUCTURE };
  const named = structuredClone(drawersAsPlayed(sound)), held = drawersAsPlayed(slot);
  // (its cards where the slot's are: they set the device order the binary lists, D-1458)
  takePlaces(named, held);
  const picks: PresetPick[] = [];
  const base = devicePresetName(name) || 'Preset';
  for (const d of layout(named).devs) {
    const a = d.asm === undefined ? undefined : assemblyById(named, d.asm);
    const h = a && assemblyById(held, a.id);
    if (!a || !h || a.chain || a.drawer) continue;
    const want = capturePreset(named, a, base), was = capturePreset(held, h, '');
    // (a drawer's effects go with their instrument's preset: their own preset names stay the slot's)
    for (const e of drawerScope(named, a)?.effects ?? []) {
      const he = assemblyById(held, e.id)?.preset;
      if (he) e.preset = he;
      else delete e.preset;
    }
    const keep = (n: string | undefined): void => { if (n) a.preset = n; else delete a.preset; };
    const same = (x: readonly number[]): boolean => x.length === want.values.length && x.every((v, i) => q16(v) === q16(want.values[i]));
    // (as the FM-1 keeps values: a slot read back holds them in Q16, and a device left as it is takes no preset of its own)
    if (want.structure === was.structure && same(was.values)) {
      // (it keeps the slot's preset name, unless the sound's own name is true and another: the entry then names that
      // preset, which has these values, D-1226)
      // (an instrument with an FX drawer: a preset with its drawer, or of the instrument alone)
      const mine = presetsOf(named, a), alone = { structure: structureOf(named, a), values: currentValues(named, a) };
      const truth = (p: Preset): boolean => sameName(p.name, a.preset) && (p.structure === want.structure ? same(p.values)
        : p.structure === alone.structure && p.values.length === alone.values.length && p.values.every((v, i) => q16(v) === q16(alone.values[i])));
      const own = a.preset && !samePreset(h.preset, a.preset) ? mine.find(truth) ?? extra.find(truth) ?? onFm1.find(truth) : undefined;
      if (!own) { keep(h.preset); continue; }
      const from = mine.includes(own) ? (own.factory ? 'factory' : 'browser') : extra.includes(own) ? 'sound' : 'fm1';
      const preset = from === 'fm1' ? { ...own, name: devicePresetName(own.name) } : own;
      keep(preset.name);
      picks.push({ preset, from, asm: a.id });
      continue;
    }
    const label = a.label || a.name;
    if (want.values.length > PRESET_VALUES_MAX) return { why: `${label} needs ${want.values.length} preset values, ${PRESET_VALUES_MAX} at most` };
    // (a preset of the slot's device's name is never applied by the FM-1: the name is all it compares)
    const usable = (p: Preset): boolean => p.structure === want.structure && !samePreset(h.preset, p.name);
    const known = presetsOf(named, a);
    const mine = [...known, ...extra.filter((p) => p.structure === want.structure && !known.some((x) => x.structure === p.structure && sameName(x.name, p.name)))];
    const theirs = onFm1.filter((p) => usable(p) && !mine.some((x) => x.structure === p.structure && sameName(x.name, p.name)));
    const found = mine.filter((p) => usable(p) && sameValues(p.values, want.values));
    const own = found.find((p) => sameName(p.name, a.preset)) ?? found[0];
    const there = own ? undefined : theirs.find((p) => p.values.length === want.values.length && p.values.every((v, i) => q16(v) === q16(want.values[i])));
    let pick: PresetPick;
    if (own) pick = { preset: own, from: own.factory ? 'factory' : known.includes(own) ? 'browser' : 'sound', asm: a.id };
    else if (there) pick = { preset: { ...want, name: devicePresetName(there.name) }, from: 'fm1', asm: a.id };
    else {
      const taken = (n: string): boolean => samePreset(h.preset, n) || [...mine, ...onFm1.filter((p) => p.structure === want.structure)].some((p) => sameName(p.name, n));
      let n = base;
      const room = samePreset(h.preset, base) ? BIN_PRESET_CHARS : PRESET_NAME_BYTES;
      for (let k = 2; taken(n) && k < 1000; k++) n = `${base.slice(0, room - 1 - String(k).length).trim()} ${k}`;
      pick = { preset: { ...want, name: n }, from: 'new', asm: a.id };
    }
    keep(pick.preset.name);
    picks.push(pick);
  }
  const played = structuredClone(held);
  const gone = applyEntry(played, entryOf(named, 0), picks.map((p) => p.preset));
  const norm = structuredClone(named);
  norm.name = played.name;
  takeTempoAndPatterns(norm, played);
  let same: boolean;
  try {
    same = !gone.length && sameBytes(encode(norm), encode(played));
  } catch (e) {
    return { why: (e as Error).message };
  }
  if (!same) return { why: `it changes ${unheldSettings(norm, played)}` };
  return { named, picks, plays: slotPlays(sound, held) };
}

/** the FM-1's own user presets of the structures `sound`'s devices' presets would have, with their values (none
 *  without the preset store) */
export async function fm1Presets(sound: Patch, d: Pick<DeviceLink, 'hasPresets' | 'listPresets' | 'getPreset'>): Promise<Preset[]> {
  if (!d.hasPresets) return [];
  const structures = new Set(layout(sound).devs.flatMap((x) => {
    const a = x.asm === undefined ? undefined : assemblyById(sound, x.asm);
    return a && !a.chain && !a.drawer ? [capturePreset(sound, a, '').structure] : [];
  }));
  const out: Preset[] = [];
  for (const e of await d.listPresets()) {
    if (!structures.has(e.structure)) continue;
    const values = await d.getPreset(e.structure, e.name);
    if (values) out.push({ structure: e.structure, name: e.name, values });
  }
  return out;
}
