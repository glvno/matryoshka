// SPDX-License-Identifier: GPL-3.0-only
// Whether a sound is a version of a patch that device presets reach (D-1240, D-1319): the same patch (its name, modules,
// cables and drawers) with other card values, tempo or patterns, each differing device then taking a preset of its values
// (one this browser or the FM-1 has, else a new one). Add to palette (palette.ts) points a palette entry at an FM-1 slot
// with it; a candidate's Save… (candidate-save.ts) stores those presets instead of a new patch.
import { assemblyById, type AssemblyInst } from './assembly';
import { parseBinary } from './bin-parse';
import { deviceName } from './bank';
import type { DeviceLink } from './device';
import { applyPreset, capturePreset, currentValues, matchesPreset, presetsOf, rememberedPreset, sameName, type Preset } from './device-presets';
import { drawerScope } from './fx-preset';
import { DEFS } from './modules';
import type { Patch } from './patch';
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
 * tempo and the patterns of the slot's patch. Null when their devices differ in number or structure. It encodes to the
 * slot's bytes exactly when the two differ in nothing else: then it is the slot's patch as presetFit compares it, which
 * Add to palette needs when this browser has no copy of what the slot holds (owner 2026-11-27: a slot stored by an
 * earlier add, a hold-save of the FM-1's own edits, another browser).
 */
export function asSlot(sound: Patch, slot: Patch): Patch | null {
  const out = structuredClone(sound);
  const mine = layout(out).devs, theirs = layout(slot).devs;
  if (mine.length !== theirs.length) return null;
  for (const [i, d] of mine.entries()) {
    const a = d.asm === undefined ? undefined : assemblyById(out, d.asm);
    const t = theirs[i].asm === undefined ? undefined : assemblyById(slot, theirs[i].asm!);
    if (!a !== !t) return null;
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
  // (the Main module and the Steps modules, each paired with the slot's of its type in the same place: the binary keeps
  // their order)
  const main = out.modules.find((m) => m.type === 'fm1');
  const names = main?.seq?.names;
  takeTempoAndPatterns(out, slot, (m) => (m.type === 'fm1' || m.type === 'steps' ? slot.modules.filter((x) => x.type === m.type)[out.modules.filter((x) => x.type === m.type).indexOf(m)] : undefined));
  if (main && names) main.seq = { ...main.seq, names };   // (editor only, never in the binary: the reader has none)
  return out;
}

/** two patch binaries hold the same modules and cables (bin-parse.ts): what no device preset changes */
export function sameWiring(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const x = parseBinary(a), y = parseBinary(b);
  return !!x && !!y && JSON.stringify([x.modules.map((m) => m.type), x.cables]) === JSON.stringify([y.modules.map((m) => m.type), y.cables]);
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

/** why Add to palette stores a patch: no slot's patch has the sound's name (the patch's own, as the FM-1 keeps names),
 *  modules, cables and drawers */
export const NO_SAME_STRUCTURE = 'no patch of its name with its modules and cables is on the FM-1';

/** `sound` and `held` are one patch as device presets see it: its name, as the FM-1 keeps names, and its structure */
export const samePatch = (sound: Patch, held: Patch): boolean =>
  deviceName(sound.name.trim()) === deviceName(held.name.trim()) && patchStructure(sound) === patchStructure(held);

/** values agree as the editor keeps them */
const sameValues = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
/** a value as the FM-1 keeps it (Q16) */
export const q16 = (v: number): number => Math.round(v * 65536);

/** the module whose settings differ between two patches of one structure, as the user knows it: its assembly's label, or
 *  its own name */
function differing(a: Patch, b: Patch): string | null {
  const body = (m: Patch['modules'][number]): string => JSON.stringify({ ...m, x: 0, y: 0 });
  for (const m of a.modules) {
    const o = b.modules.find((x) => x.id === m.id);
    if (!o || body(m) === body(o)) continue;
    const asm = (a.assemblies ?? []).find((x) => x.modules.includes(m.id));
    return asm ? asm.label || asm.name : m.name || DEFS[m.type]?.label || m.type;
  }
  return null;
}

/**
 * The sound `sound` reached from `held` (a slot's patch) with device presets (owner 2026-11-24: "it should first
 * determine if it's a preset of the instrument the fm1 has already"), or why not. Both need one name and structure
 * (samePatch: a patch saved under another name is another patch, its slot named after it). Each device (a top-level
 * assembly; an instrument with an FX drawer with its drawer, FXD1) whose card
 * values differ from the slot's takes a preset of exactly those values: one this browser has (factory or the user's, the
 * one the device remembers first), else one of `extra` (a saved sound's own presets), else one of `onFm1` (the FM-1's
 * own user presets), else a new one named `name` (the name the sound is added under, numbered when taken). A device
 * whose values agree keeps the slot's preset name, which the FM-1 leaves
 * as it is. Then the entry applied to `held` (applyEntry) must give the sound byte for byte as `encode` writes it,
 * tempo and patterns aside (the entry plays the slot's, with the sound's selected pattern): anything else (a module's
 * setting outside its card, a device past PRESET_VALUES_MAX values, the panel, names) is a reason to store the patch.
 */
export function presetFit(sound: Patch, held: Patch, name: string, encode: (p: Patch) => Uint8Array, onFm1: readonly Preset[] = [], extra: readonly Preset[] = []): PresetFit | { why: string } {
  if (!samePatch(sound, held)) return { why: NO_SAME_STRUCTURE };
  const named = structuredClone(sound);
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
    // (as the FM-1 keeps values: a slot read back holds them in Q16, and a device left as it is takes no preset)
    if (want.structure === was.structure && want.values.length === was.values.length && want.values.every((v, i) => q16(v) === q16(was.values[i]))) { keep(h.preset); continue; }
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
  if (!same) {
    const who = differing(norm, played);
    return { why: who ? `it changes ${who} settings no device preset holds` : 'it changes settings no device preset holds' };
  }
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
