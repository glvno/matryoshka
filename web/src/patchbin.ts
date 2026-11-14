// SPDX-License-Identifier: GPL-3.0-only
import { signalBuffers, type BufferAllocation } from './signal-buffers';
import { chainedHarmonizer, keyRouteError } from './key-routing';
// Compact binary patch format, read by firmware/src/engine.c (eng_load).
//
//   u8  magic 0xA1, u8 version (VERSION), u8 module count, u8 poly group count G (0..MAX_POLY), u16 LE cable count, u16 LE flags
//       (bit 0: a morph B set follows the cables; bit 2: disabled-input masks follow it; bit 3: additional input routes follow masks; bit 4: the tracks' notes follow them; bit 1: macro ranges are last;
//       bit 13, format 54: u16 count, then (module u8, pattern u8, identity u32 LE) origins before the final macro ranges;
//       bit 14, format 55: graph-proven master FX stages after origins and before macro ranges (fxRecord);
//       bit 12, format 51: the cables take 3 bytes, FLAG_CABLES3)
//   (everything below describes the patch's device form, poly.ts deviceView: Voice allocators become Part modules in the
//   poly groups they drive; module indices of the other modules are the patch's)
//   per poly group (poly.ts deviceView order, GROUP_REC bytes): u8 parts (low nibble 1..8, high nibble unison count 0..8; 0 means all), u8 assign, u8 legato (bit 7: unison, bit 6: shared unison), u8 priority (bit 7: no stealing), then for
//                each of MAX_PARTS parts its flaws (patch.ts PartFlaw): i8 detune, u8 drift, i8 bright, i8 env, u8 level, then
//                u8 its notes' source: 0 the keys, else 1 + the module index of the Arpeggiator or Steps module that plays it
//                u8 its MIDI channel (0: the device's, 1..16), u8 its lowest key, u8 its highest key (patch.ts takesKey)
//   with G > 0: one u8 per module, its poly group (0: it runs once, 1..G); delay, reverb, chorus, granular and output are always 0
//   the panel (PANEL_BYTES, always): u16 LE the buttons that switch (bit i = PANEL_BUTTONS[i]), u16 LE the switched ones that are
//                on, then PANEL_LABEL_KEYS.length labels of PANEL_LABEL_MAX bytes (ASCII, zero padded): the buttons
//   per module:  u8 type index (bit 7 set: the module is bypassed), then one i32 LE per parameter (Q16.16), in the order of the definition;
//                since format 51 (COUNTED, #667) a u8 parameter count n follows the type byte and only the first n parameters
//                follow it: the ones after them are at their defaults on both morph sides (storedParams), and the reader gives
//                them their defaults (engine.c eng_rec_npar);
//                modules with parameter inputs (paramInputs) then add i32 att1, i32 att2 (Q16.16, -2..2 since 1.9, #526; every firmware reads them unclamped) and
//                six matrix masks for the sources p1, p2, k1, k2, k3, k4 (bit n = the n-th parameter), each u16 LE, or u32 LE
//                for a type with more than 16 parameters (maskBytes; since format 35: every type of an older patch has at most 16, so
//                the older layouts are unchanged); the knob columns k1..k4 are written empty (nothing reads them since format 29);
//                format 51 (D-1000, D-1001): bit 7 of the count byte (REC_TEMPLATE) on such a module says att1 = att2 = 1 and the
//                p1 / p2 masks are its type's defaultMap (matrixTemplate), and nothing follows the parameters; without it a
//                presence byte follows them (PRES_ATT1, PRES_ATT2, PRES_P1, PRES_P2) and then only the items it marks, in that
//                order; there are no knob masks;
//                then the module's data (ModuleDef.data bytes): a Steps module's name (TRACK_NAME_MAX bytes, ASCII, zero
//                padded); a Drum map's u8 keys source (0 none, 1 Main's keys, 2 + the module index of a Steps module)
//   per cable:   u8 from module index, u8 from output index, u8 to module index, u8 to input index; with flag bit 12 (format 51,
//                D-1002, when every port index of the patch's cables is under 16): u8 from module index, u8 to module index, u8 from
//                output index << 4 | to input index
//   with flag bit 0, per module: one i32 LE per parameter its record holds (Q16.16), the B side of the morph (the Main module's morph
//                parameter and input fade every parameter from the record's value to this one)
//   with flag bit 9, after the B values: ceil(module count / 8) bytes, bit i marks module i as having a B side.
//   format 51 (D-1004) writes the B set otherwise (flag bits 0 and 9 together): the module mask first, then per module with a B
//                side, in module order, a bitmap of the parameters its record holds (ceil(n / 8) bytes, bit j: parameter j's B
//                value follows) and those B values (morphDiff: the ones that differ from the A value); the others' B is their A
//   with flag bit 2 (legacy, read by the firmware, never written since fixed links became permanent): one u8 disabled-input mask per module
//   with flag bit 3: u8 count, then u8 module index, u8 input index, the parameter mask per routed input (u16 LE, or u32 LE
//                when the module's type has more than 16 parameters: maskBytes)
//   with flag bit 4: the tracks' notes (#133): u8 count, then per Steps module with notes, in module order: u8 module index,
//                u8 n (1..TRACK_NOTES_MAX), n u32 LE notes (track.ts noteWord), sorted by start, then note; bit 31 of a
//                word (format 50, NOTE_WRAP): tied across the loop point
//   with flag bit 10 (format 48, written only when used: patternRecord): the patterns and songs (track.ts Pattern, SeqState):
//                u8 the selected pattern (0-based), u8 the song playing (0 none, 1..SONGS_MAX); u8 track count, per Steps module
//                with patterns past its first, in module order: u8 module index, u8 P, then patterns 2..P+1, each u8 n: 0xFF the
//                track has no such pattern (it plays its pattern 1), else n notes (0..TRACK_NOTES_MAX), u8 len (bits 0..6: 0 the
//                track's, else 1..STEPS_MAX; bit 7: short words), u8 rate (0xFF the track's, else a STEPS_RATES index), n
//                words: u16 LE short ones (track.ts shortWord, when every note of the pattern fits one: isShortNote) or u32 LE
//                (noteWord); then u8 song count, per song u8 entry count, per entry u8 pattern, i8 shift. Pattern 1 of every
//                track stays in the notes section, so a patch without patterns is written as before.
//   with flag bit 11 (format 49, #524, written only when used: lockRecord): the P-locks, right after the patterns: u8 track
//                count, per Steps module with locks, in module order: u8 module index, u8 T rows (1..LOCK_ROWS_MAX), per row
//                u8 n (1..LOCK_PAIRS_MAX) and n (u8 module index, u8 parameter index): the parameters it sets, its own
//                first, then the further ones its device page row sets (PageRow.also); then u8 P patterns with locks, per
//                pattern u8 its number (0-based), u8 L (1..LOCKS_MAX), L locks: u8 step, u8 row (0..T-1), i32 LE value
//                (Q16.16, the parameter's own units)
//   with flag bit 5: the device pages (pages.ts): u8 device count, then per device u8 kind: 0 a plain module, then u8 its
//                module index (the FM-1 makes its pages itself: its parameters in order, four to a page, named as in
//                defs.h); 2 (format 49, #518) a plain module with its own name (ModuleInst.name; not a Steps module, whose
//                record holds its name), then u8 its module index and its name (a text), its pages as kind 0's under that
//                name; 1 an assembly, then its name (a text: u8 length 0..NAME_MAX, ASCII) and u8 page count, per page its
//                name (text), u8 part (0-based), u8 parts, u8 the envelope drawn above it (1 + module index, 0 none), u8 row
//                count (1..PAGE_ROWS), per row u8 module index, u8 parameter index (bit 7: a setting of the poly group of
//                that Part, POLY_ROW_PARAMS; bit 6, format 35: the row's extras follow its label, ROW_MORE), its label
//                (text; format 51, D-1003: empty when it is the parameter's own name, and an empty page name is the device's),
//                and with bit 6 its extras (#357, #358): u8 n, n (u8 module index, u8 parameter index): the further
//                parameters the row sets to its value, then u8 k (0..ROW_NAMES_MAX), k texts: its positions' names (a
//                Selector's, position 1 first; capitals on the FM-1); on a poly row (bit 7; format 51, only the voices
//                row: polyTop) the extras are u8 top instead: the most voices the FM-1's VOICES row offers
//   with flag bit 8 (format 34; with the device pages, right after them): the device extras: u8 device count, then per
//                device u8 track (the device index of the Steps track that drives it, pages.ts Device.track; 0xFF none;
//                0xFE none, and it is an engine no keys cable reaches, KEYS_UNREACHED, #215: firmware before 1.9 reads it as
//                none, so any format carries it; 0x80 | t, KEYS_UNREACHED_TRACK, #633: the track t drives it through other
//                cables, and it is an engine no keys cable reaches: firmware before 1.10 reads it as no track),
//                u32 LE structure (an assembly's fingerprint, structure.ts; 0 a plain module), the name of the preset it was
//                set to (a text, AssemblyInst.preset; empty none), u8 n and n (u8 module index, u8 parameter byte as a page
//                row's): its card rows in canonical order (structure.ts rowOrder: the order of a preset's values; 0xFF 0xFF a
//                row the FM-1 has not got); n is 0 for a plain module; u8 m and m u8 module indices: the modules it is made
//                of (a plain module: itself; arming it on the FM-1 lets these hear Main's keys, #191); format 51 (D-1003): three
//                or more in one unbroken run are u8 MEMBER_RUN | m and u8 the first
//   with flag bit 6: the button kinds (buttons.ts): PANEL_BUTTONS.length u8 kinds (0 Gate, 1 Nothing, 2 Toggle, 3 Page),
//                then in button order per Toggle button u8 n (0..), n u8 module indices: the modules it bypasses (buttons.ts
//                toggleTargets); per Page button u8 n, n (u8 device, u8 page): its list, in the device pages section's
//                indices (binaryPage; pages that are gone are left out). A patch without it: every button is a Gate. The panel's switched-on mask holds a
//                switching Toggle as on while its targets are bypassed.
//   with flag bit 7 (format 33, the #139 follow-up): the Drum maps' row names: u8 count, then per Drum map in module order u8 module index,
//                DRUM_ROWS names of TRACK_NAME_MAX bytes (ASCII, zero padded; drumRowName: its own, else the default) for the
//                FM-1's SEQ page
//   with flag bit 1 (always last: the FM-1 edits it in place): u8 count, then per macro range: u8 module index, u8 pin (0 p1,
//                1 p2; bit 7, format 49: bipolar, RANGE_BIPOLAR), u8 parameter index, u8 low end, u8 high end (0..255 of the
//                parameter's range, octaves for a log one): the pin's value (0..1, or −1..1 when bipolar) lands between the ends
//
// Type indices are the position in TYPE_ORDER (append only: the firmware has the same list in defs.h).
// Port indices are positions in ModuleDef.outputs / inputs (explicit ports first, then the `<param>_cv` inputs).

import { DEFS, delayLine, DELAY_LENGTH_DEFAULT, DRUM_ROWS, drumRowName, PANEL_BUTTONS } from './modules';
import { KIND_CODE, kindOf, mainOf, switches, toggleEngaged, toggleTargets } from './buttons';
import { defaultMap, EDITOR_ONLY, flawOf, hasMorph, isBipolar, MAX_MODULES, MAX_PARTS, MODULES_1_10, PANEL_LABEL_KEYS, PANEL_LABEL_MAX, panelLabel, SOURCES, TRACK_NAME_MAX, trackName, type ModuleInst, type ParamDef, type Patch } from './patch';
import { isShortNote, noteWord, shortWord, type StepNote } from './track';
import { lockPlan, PATCH_LOCKS_MAX } from './locks';
import { deviceView, keysInto, MAX_POLY, type DeviceGroup, VOICING_CABLE_INPUTS } from './poly';
import { devicesOf, NAME_MAX, type Device, type PageRow } from './pages';
import { allModules, assemblyById, ROW_NAMES_MAX } from './assembly';
import { structureAndRows } from './structure';
import { CPU, cpuEstimate, scheduleCost, type CpuEstimate } from './cpu';
import { schedule, type Schedule } from './schedule';
import { instIsEngine } from './engines';
import { engineUnreached } from './arm';
import { FX_STAGE_TARGET_MAX, fxBusOf, type FxStageKind } from './fx-bus';
import './device-shown';   // (what the FM-1 shows, for the device compile pass)

export const TYPE_ORDER: string[] = Object.keys(DEFS).filter((t) => !EDITOR_ONLY.has(t));
/** bytes of a poly group record: parts, assign, legato, priority, five flaw bytes per part, the note source, the MIDI
 * channel (0 = the device's), the lowest and the highest key (engine.h ENG_GROUP_REC) */
export const GROUP_REC = 4 + 5 * MAX_PARTS + 4;
/** bytes of the panel section (engine.h ENG_PANEL_BYTES): two masks and the labels */
export const PANEL_BYTES = 4 + PANEL_LABEL_KEYS.length * PANEL_LABEL_MAX;
export const MAX_CABLES = 255;
export const VERSION = 55; // optional graph-proven master FX record, flag bit 14; ordinary patches retain their lowest format
/**
 * The lowest format the encoder writes: a patch that uses no parameter appended after it (ParamDef.since past it: a value
 * off its default on either morph side, a pin, macro range, input route or card row on it) is written in this format, its
 * records with this format's parameter counts, so an appended parameter costs bytes only in the patches that use it. The
 * FM-1 reads such a binary as it reads any older one (engine.c eng_npar: the rest at their defaults). Format 47's filter
 * `osc` is the first parameter written this way.
 */
export const WRITE_FLOOR = 46;
/** the formats past WRITE_FLOOR that only add something the encoder writes when the patch uses it (format 48: the patterns
 * and songs, flag bit 10; format 50: a note word's bit 31, NOTE_WRAP; format 51: counted records, when the patch would not
 * fit otherwise, COUNTED); every other format past WRITE_FLOOR appends parameters (ParamDef.since) */
export const SECTION_FORMATS: Record<number, string> = { 48: 'patterns and songs', 50: 'notes tied across the loop point', 51: 'counted records', 52: 'the Harmonizer module', 53: 'chained Harmonizer keys routes', 54: 'factory pattern origins', 55: 'master FX stages' };
/** the flag (u16 at offset 6) of the P-locks section (format 49, #524) */
export const FLAG_LOCKS = 2048;

/** the P-locks section's bytes (see the top of this file; locks.ts lockPlan), [] when no lock plays (`dev`: the device form) */
export function lockRecord(source: Patch, dev: Patch): number[] {
  const plan = lockPlan(source, dev);
  if (!plan.length) return [];
  const out: number[] = [plan.length];
  for (const t of plan) {
    out.push(t.track, t.rows.length);
    for (const r of t.rows) out.push(r.length, ...r.flat());
    out.push(t.pats.length);
    for (const x of t.pats) {
      out.push(x.p, x.locks.length);
      for (const l of x.locks) {
        const v = toQ16(l.value);
        out.push(l.at, l.row, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      }
    }
  }
  return out;
}
/**
 * The 1.9 format (#518, #519): the one format change of release 1.9. Everything it adds is written only when a patch
 * uses it, so a patch without it stays in an older format an FM-1 with older firmware plays: parameters appended with
 * `since: FORMAT_1_9`, values past a top that grew with it (`grew.since`), and what `uses19` lists. Later 1.9 work
 * extends this format (its parameters carry `since: FORMAT_1_9`, its other uses go into uses19), never a new one.
 */
export const FORMAT_1_9 = 49;
/**
 * The 1.10 format (#384): release 1.10's format change. A note tied across the loop point (track.ts StepNote.wrap, a
 * drone among them) sets bit 31 of its word, which only format 50 has. A patch without one stays in an older format.
 * Later 1.10 work extends this format, never a new one.
 */
export const FORMAT_1_10 = 50;
/**
 * The 1.11 format (#667): release 1.11's format change. A module record carries its parameter count (COUNTED) and leaves
 * out the parameters after it, which are at their defaults; it leaves out what is at its usual value elsewhere too: the
 * attenuverters and matrix at their template, the morph B values equal to A, a row label or page name that repeats a
 * name the FM-1 has, a cable's fourth byte, a run of member indices (D-1000..D-1004). The encoder writes it for a patch that uses something of 1.11
 * (a parameter appended with `since: FORMAT_1_11`) or that would not fit the FM-1's bytes in an older format, so every
 * other patch stays in the format an FM-1 with 1.10 firmware plays. Later 1.11 work extends this format, never a new one.
 */
export const FORMAT_1_11 = 51;
/**
 * The 1.12 format (#598): release 1.12's format change. It adds the Harmonizer module (ModuleDef.since), which a group may
 * take its notes from. A patch without one stays in an older format. Later 1.12 work extends this format (parameters
 * appended with `since: FORMAT_1_12`, other uses in uses112), never a new one.
 */
export const FORMAT_1_12 = 52;
/** the first format whose module records carry their parameter count (engine.c ENG_COUNTED) */
export const COUNTED = FORMAT_1_11;
/**
 * The parameters module `m`'s record holds in a binary of format `v`: before COUNTED, every parameter of its type in that
 * format (paramsAt); since, those up to the last one off its default on either morph side (`morph`: the patch has a B set),
 * so the record leaves out the trailing ones at their defaults, and at least the first `keep` (fm1Rows: the ones the FM-1
 * can change in its binary, so a knob or a preset there never makes it grow). Compared as written (Q16.16), as the FM-1
 * reads them.
 */
export function storedParams(m: ModuleInst, v: number, morph: boolean, keep = 0): ParamDef[] {
  const ps = paramsAt(m.type, v);
  if (v < COUNTED) return ps;
  let n = ps.length;
  for (; n > Math.min(keep, ps.length); n--) {
    const pd = ps[n - 1], d = toQ16(pd.default);
    const a = m.params[pd.name] ?? pd.default;
    if (toQ16(a) !== d || (morph && toQ16(m.paramsB?.[pd.name] ?? a) !== d)) break;
  }
  return ps.slice(0, n);
}
/** what a patch uses of FORMAT_1_11 besides its parameters (`dev`: its device form): a cable into a Part's assign or
 * unison input (#681; firmware before 1.11 refuses a cable into a port it does not know); a VOICES row with a top (polyTop:
 * firmware before 1.11 reads no extras on a poly row); more than 64 modules (#721: firmware before 1.11 takes 64) */
function uses111(source: Patch, dev: Patch): boolean {
  if (dev.modules.length > MODULES_1_10) return true;
  const parts = new Set(dev.modules.filter((m) => m.type === 'part').map((m) => m.id));
  if (dev.cables.some((c) => parts.has(c.to.module) && VOICING_CABLE_INPUTS.includes(c.to.port))) return true;
  if (!(source.assemblies ?? []).some((a) => a.params.some((r) => r.top !== undefined))) return false;
  return deviceSection(source, dev).some((d) => d.pages.some((pg) => pg.rows.some((r) => {
    const m = dev.modules.find((x) => x.id === r.module);
    return !!m && polyTop(rowParam(m.type, r.param), r) > 0;
  })));
}
/** what a patch uses of FORMAT_1_12 besides its parameters (`dev`: its device form): a module of a type added with it (the
 * Harmonizer, #598) */
function uses112(dev: Patch): boolean {
  return dev.modules.some((m) => (DEFS[m.type]?.since ?? 0) >= FORMAT_1_12);
}
/** what a patch uses of FORMAT_1_10 (`dev`: its device form): a note tied across the loop point, in any pattern */
function uses110(dev: Patch): boolean {
  return dev.modules.some((m) => m.type === 'steps' && [m.notes, ...(m.patterns ?? []).map((x) => x?.notes)].some((ns) => ns?.some((n) => n.wrap)));
}
/** a device of the device pages section's kind 2 (format 49): a plain module with its own name */
export const NAMED_MODULE = 2;
/** the name a plain module device carries in the binary (kind NAMED_MODULE), '' when it has none: its own name, as the
 * FM-1's font draws it; never a Steps module's (its record holds its name) */
export function moduleDeviceName(dev: Patch, d: Device): string {
  const m = d.module === undefined ? undefined : dev.modules.find((x) => x.id === d.module);
  return m && m.type !== 'steps' && m.name ? deviceText(m.name) : '';
}
/** what a patch uses of FORMAT_1_9 besides its parameters (`dev`: its device form): a module of a type added with it
 * (ModuleDef.since: the Shift register, the Comparator, #438; Range, #526), a bipolar macro range (RANGE_BIPOLAR, #526),
 * a module device with its own name, P-locks (#524) */
function uses19(source: Patch, dev: Patch): boolean {
  if (dev.modules.some((m) => (DEFS[m.type]?.since ?? 0) >= FORMAT_1_9)) return true;
  if (rangeList(dev).some((r) => r.bi)) return true;
  return (dev.modules.some((m) => m.name && m.type !== 'steps') && deviceSection(source, dev).some((d) => moduleDeviceName(dev, d) !== ''))
    || lockRecord(source, dev).length > 0;
}
/** a type's parameters in a binary of format `v` (appended ones, ParamDef.since, come last) */
export const paramsAt = (type: string, v: number): ParamDef[] => DEFS[type].params.filter((q) => (q.since ?? 0) <= v);
/** Format 55 gives a verified LFO/Harmony Toggle an enabled-state light even without a master FX bus. */
export function harmonyLfo(source: Patch, dev: Patch): boolean {
  if (kindOf(mainOf(source)?.panel, 'lfo') !== 'bypass') return false;
  const targets = toggleTargets(source, 'lfo');
  return targets.length > 0 && targets.every(id => dev.modules.some(m => m.id === id && m.type === 'harm'));
}

/** the format encodePatch writes for this patch: the lowest that holds it (baseFormat), or COUNTED when that one does
 * not fit the FM-1's bytes and the counted records are smaller (`view`: its device form) */
export const formatOf = (source: Patch, view: ReturnType<typeof deviceView> = deviceView(source, true)): number => layout(source, view).v;
/** the lowest format that holds what this patch uses: VERSION, or WRITE_FLOOR when it uses nothing appended since (`dev`: its device form) */
export function baseFormat(source: Patch, dev: Patch = deviceView(source, true).patch): number {
  const late = (type: string): ParamDef[] => DEFS[type].params.filter((q) => (q.since ?? 0) > WRITE_FLOOR || (q.grew?.since ?? 0) > WRITE_FLOOR);
  const floor = fxRecord(source, dev).length || harmonyLfo(source, dev) ? 55 : originRecord(dev).length ? 54 : chainedHarmonizer(source) ? 53 : uses112(dev) ? FORMAT_1_12 : uses111(source, dev) ? FORMAT_1_11 : uses110(dev) ? FORMAT_1_10 : uses19(source, dev) ? FORMAT_1_9 : patternRecord(source, dev).length ? 48 : WRITE_FLOOR;
  if (!dev.modules.some((m) => late(m.type).length)) return floor;
  let v = floor;
  const rows = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.module === 'number' && typeof o.param === 'string') rows.add(`${o.module}/${o.param}`);
      Object.values(o).forEach(walk);
    }
  };
  walk(source.assemblies ?? []);
  for (const m of dev.modules)
    for (const pd of late(m.type)) {
      if (pd.grew && [m.params[pd.name], m.paramsB?.[pd.name]].some((x) => x !== undefined && x > pd.grew!.from)) v = Math.max(v, pd.grew.since);
      if ((pd.since ?? 0) <= WRITE_FLOOR) continue;
      const off = (v: number | undefined): boolean => v !== undefined && v !== pd.default;
      const used = off(m.params[pd.name]) || off(m.paramsB?.[pd.name]) || rows.has(`${m.id}/${pd.name}`)
        || SOURCES.some((src) => m.map?.[src]?.includes(pd.name) || (m.range as Record<string, Record<string, unknown> | undefined> | undefined)?.[src]?.[pd.name] !== undefined)
        || Object.values(m.inputMap ?? {}).some((names) => names?.includes(pd.name));
      if (used) v = Math.max(v, pd.since!);
    }
  return v;
}
/** bytes of a parameter mask of this type (the matrix, an input route): u16, u32 past 16 parameters (engine.c eng_mask_bytes) */
export const maskBytes = (type: string): 2 | 4 => (DEFS[type].params.length > 16 ? 4 : 2);
/** the matrix masks a record of a format before COUNTED holds: p1, p2 and the four FM-1 knobs' columns k1..k4, which the
 * encoder writes empty (nothing reads them since format 29; format 51 has only p1 and p2, D-1001) */
export const OLD_MASKS = 6;
/** bytes of a module record of this type in a binary of format `v` before COUNTED (every parameter of its format) */
export const recordSize = (type: string, v = COUNTED - 1): number => {
  if (v >= COUNTED) throw new Error('recordSize: a counted record\'s size depends on its values (moduleRecordSize)');
  return 1 + 4 * paramsAt(type, v).length + (DEFS[type].paramInputs ? 8 + OLD_MASKS * maskBytes(type) : 0) + (DEFS[type].data ?? 0);
};
/** bit 7 of a counted record's count byte (format 51, D-1000): the module's attenuverters and matrix are at their
 * template (matrixTemplate), and the record leaves them out; else a presence byte follows the parameters (PRES_*) and
 * then only the items it marks. A type has fewer than 64 parameters, so bits 6 and 7 of the count are free */
export const REC_TEMPLATE = 0x80;
/** the presence byte's bits (format 51): att1, att2 (i32 each), the p1 mask, the p2 mask (maskBytes each), in that order */
export const PRES_ATT1 = 1, PRES_ATT2 = 2, PRES_P1 = 4, PRES_P2 = 8;
/** a module's mask of source `s` (bit n: the n-th parameter) */
export const maskOf = (m: ModuleInst, s: 'p1' | 'p2', names = m.map?.[s]): number => {
  const def = DEFS[m.type];
  let mask = 0;
  for (const name of names ?? []) {
    const i = def.params.findIndex((q) => q.name === name);
    if (i >= 0) mask = (mask | (1 << i)) >>> 0;
  }
  return mask;
};
/** the usual attenuverters and matrix of a type with parameter inputs: att1 = att2 = 1, p1 and p2 on their defaultMap
 * (engine.c eng_mask_template) */
export const matrixTemplate = (type: string): { att: [number, number]; p1: number; p2: number } => {
  const dm = defaultMap(DEFS[type]);
  const m = { type, map: dm } as unknown as ModuleInst;
  return { att: [1, 1], p1: maskOf(m, 'p1'), p2: maskOf(m, 'p2') };
};
/** the presence byte of module `m`'s record in format 51: the items off the template (0: the record leaves them all out) */
export function presenceOf(m: ModuleInst): number {
  const t = matrixTemplate(m.type), att = m.att ?? [1, 1];
  return (toQ16(att[0]) !== toQ16(t.att[0]) ? PRES_ATT1 : 0) | (toQ16(att[1]) !== toQ16(t.att[1]) ? PRES_ATT2 : 0)
    | (maskOf(m, 'p1') !== t.p1 ? PRES_P1 : 0) | (maskOf(m, 'p2') !== t.p2 ? PRES_P2 : 0);
}
/** bytes of a presence byte's items (format 51) for a type */
const presenceBytes = (type: string, pres: number): number =>
  ((pres & PRES_ATT1 ? 4 : 0) + (pres & PRES_ATT2 ? 4 : 0) + ((pres & PRES_P1 ? 1 : 0) + (pres & PRES_P2 ? 1 : 0)) * maskBytes(type));
/** bytes of module `m`'s record after its type byte, its count and its parameters in format `v`: the attenuverters and
 * masks (format 51: the presence byte and its items, or nothing at the template), then its data */
const recordExtra = (m: ModuleInst, v: number): number => {
  const def = DEFS[m.type];
  let n = def.data ?? 0;
  if (!def.paramInputs) return n;
  if (v < COUNTED) return n + 8 + OLD_MASKS * maskBytes(m.type);
  const pres = presenceOf(m);
  return n + (pres ? 1 + presenceBytes(m.type, pres) : 0);
};
/** bytes of module `m`'s record in a binary of format `v` (`morph`: the patch has a B set; `keep`: storedParams) */
export const moduleRecordSize = (m: ModuleInst, v: number, morph: boolean, keep = 0): number =>
  1 + (v >= COUNTED ? 1 : 0) + 4 * storedParams(m, v, morph, keep).length + recordExtra(m, v);
/** the parameters (indices into `ps`, the ones the record holds) whose morph B value a format 51 binary writes: those
 * that differ from the A value (as written, Q16.16); the others take the A value (D-1004) */
export const morphDiff = (m: ModuleInst, ps: ParamDef[]): number[] =>
  ps.flatMap((pd, j) => (toQ16(m.paramsB?.[pd.name] ?? m.params[pd.name] ?? pd.default) !== toQ16(m.params[pd.name] ?? pd.default) ? [j] : []));
/** bytes of the morph B set in format `v` (`p`: the device form, with a B set): before COUNTED every value of every
 * record and the module mask after them; since, the module mask first, then per module with a B side a bitmap of the
 * parameters its record holds (ceil(n / 8) bytes) and the B values it marks (morphDiff) */
const morphBytes = (p: Patch, v: number, keep: Map<number, number>): number => {
  let n = Math.ceil(p.modules.length / 8);
  for (const m of p.modules) {
    const ps = storedParams(m, v, true, keep.get(m.id));
    if (v < COUNTED) n += 4 * ps.length;
    else if (m.paramsB) n += Math.ceil(ps.length / 8) + 4 * morphDiff(m, ps).length;
  }
  return n;
};
/**
 * The bytes the budget keeps for the morph B values the FM-1 may add to its copy (format 51, D-1005): turning a knob or
 * loading a preset there sets a parameter's A value, and a module with a B side whose binary has no B value for it gets
 * one first (proto.c m1_patch_param, engine.c eng_b_keep), so the B side stays where it was. 4 bytes per such parameter
 * the FM-1 can change (fm1Edits) that the B set leaves out.
 */
export function morphRoom(p: Patch, v: number, edits: Map<number, Set<number>>, keep: Map<number, number>): number {
  if (v < COUNTED || !hasMorph(p)) return 0;
  let n = 0;
  for (const m of p.modules) {
    const e = edits.get(m.id);
    if (!m.paramsB || !e) continue;
    const ps = storedParams(m, v, true, keep.get(m.id));
    const kept = new Set(morphDiff(m, ps));
    for (const j of e) if (!kept.has(j)) n += 4;
  }
  return n;
}
/**
 * Per module id, how many of its first parameters the FM-1 can change in its copy of the patch (proto.c m1_patch_param):
 * up to the last one a device page row (or a parameter the row also sets) or a device's card row names, every one of a
 * plain module's device (the FM-1 makes its pages from all of them), and Main's tempo.
 * A counted record keeps them (storedParams), so the binary keeps its size when the FM-1 turns a knob or loads a preset.
 * `dev`: the device form; `devs`: its device pages (deviceSection).
 */
export function fm1Rows(source: Patch, dev: Patch, devs: Device[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, e] of fm1Edits(source, dev, devs)) out.set(id, e.size ? Math.max(...e) + 1 : 0);
  return out;
}
/** per module id, the parameters (indices) the FM-1 can change in its copy of the patch (fm1Rows: up to the last of them) */
export function fm1Edits(source: Patch, dev: Patch, devs: Device[]): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  const byId = new Map(dev.modules.map((m) => [m.id, m]));
  const add = (id: number, i: number): void => { let e = out.get(id); if (!e) out.set(id, (e = new Set())); e.add(i); };
  const take = (module: number, param: string): void => {
    const m = byId.get(module);
    const i = m ? rowParam(m.type, param) : -1;
    if (m && i >= 0 && !(i & POLY_ROW) && m.type !== 'part') add(module, i);
  };
  for (const d of devs) {
    const own = d.module === undefined ? undefined : byId.get(d.module);
    if (own) {   // (a plain module's device: the FM-1 pages all its parameters)
      if (!out.has(own.id)) out.set(own.id, new Set());
      DEFS[own.type].params.forEach((q, i) => add(own.id, i));
    }
    for (const pg of d.pages) for (const r of pg.rows) {
      take(r.module, r.param);
      for (const t of r.also ?? []) take(t.module, t.param);
    }
    const a = d.asm === undefined ? undefined : assemblyById(source, d.asm);
    if (a) for (const r of cardRows(source, a).rows) take(r.module, r.param);
  }
  for (const m of dev.modules) if (m.type === 'fm1') take(m.id, 'tempo');
  return out;
}
/** structureAndRows, worked out once per assembly while `layout` runs (it sizes the patch in two forms, each with its
 * device extras); the patch does not change meanwhile */
let rowsMemo: Map<object, ReturnType<typeof structureAndRows>> | null = null;
/** the device pages and extras sections' bytes by the preset names they carry, while `layout` runs */
let sizesMemo: Map<string, number> | null = null;
const cardRows = (source: Patch, a: Parameters<typeof structureAndRows>[1]): ReturnType<typeof structureAndRows> => {
  let r = rowsMemo?.get(a);
  if (!r) {
    r = structureAndRows(source, a);
    rowsMemo?.set(a, r);
  }
  return r;
};
export const Q = 65536;

/** bit 7 of a module record's type byte: the module is bypassed */
export const BYPASS_BIT = 0x80;
/** header flags (u16 at offset 6) */
export const FLAG_MORPH = 1;
/** one bit per module after the B set: only modules with a B side morph (#355, format 36) */
export const FLAG_MORPH_MODULES = 512;
/** Format 54: explicit factory pattern provenance, immediately before macro ranges. */
export const FLAG_PATTERN_ORIGINS = 1 << 13;
export function originRecord(p: Patch): Uint8Array {
  const records: { module: number; pattern: number; id: string }[] = [];
  p.modules.forEach((m, module) => {
    if (m.type !== 'steps' || !m.factoryPatterns || m.factoryPatterns.version !== 1) return;
    if (m.factoryPatterns.ids.length > 64) throw new Error('Factory pattern index exceeds 63');
    m.factoryPatterns.ids.forEach((id, pattern) => {
      if (id === null) return;
      if (!/^[0-9a-f]{8}$/.test(id) || id === '00000000') throw new Error('Invalid factory pattern identity');
      records.push({ module, pattern, id });
    });
  });
  if (!records.length) return new Uint8Array();
  if (records.length > 16 * 64) throw new Error('Too many factory pattern origins');
  const bytes = new Uint8Array(2 + 6 * records.length), view = new DataView(bytes.buffer);
  view.setUint16(0, records.length, true);
  records.forEach((r, i) => {
    const at = 2 + 6 * i;
    bytes[at] = r.module; bytes[at + 1] = r.pattern;
    view.setUint32(at + 2, parseInt(r.id, 16), true);
  });
  return bytes;
}
/** Format 55: graph-proven master FX, after origins and before the final macro ranges (engine.h ENG_FX_*). */
export const FLAG_FX_BUS = 1 << 14;
export const FX_STAGE_COUNT = 4, FX_TARGETS_MAX = FX_STAGE_TARGET_MAX;
const FX_KINDS: readonly FxStageKind[] = ['drive', 'chorus', 'delay', 'reverb'];
const FX_TYPES = ['shape', 'chorus', 'delay', 'reverb'] as const;
/** Resolve only after compilation: editor IDs, names and helper nodes are never wire module indices. */
export function fxRecord(source: Patch, dev: Patch, devs = deviceSection(source, dev)): number[] {
  const bus = fxBusOf(source);
  if (!bus) return [];
  if (!bus.stages.length || bus.stages.length > FX_STAGE_COUNT) throw new Error('Invalid master FX stage count');
  const device = devs.findIndex((d) => d.asm === bus.assembly);
  if (device < 0 || device >= MAX_DEVICES) throw new Error('Master FX device was dropped by compilation');
  const pagesBefore = devs.slice(0, device).reduce((n, d) => n + d.pages.length, 0);
  const index = new Map(dev.modules.map((m, i) => [m.id, i]));
  const used = new Set<number>(), out = [bus.stages.length];
  let previous = -1;
  bus.stages.forEach((stage) => {
    const kind = FX_KINDS.indexOf(stage.kind);
    if (kind <= previous || !stage.targets.length || stage.targets.length > FX_TARGETS_MAX)
      throw new Error('Invalid master FX stage');
    previous = kind;
    const targets = stage.targets.map((id) => {
      const i = index.get(id);
      if (i === undefined || i >= MAX_MODULES || dev.modules[i].type !== FX_TYPES[kind] || used.has(i))
        throw new Error('Invalid, dropped or overlapping master FX target');
      used.add(i);
      return i;
    });
    const page = devs[device].pages.findIndex((pg) => pg.rows.some((r) =>
      stage.targets.includes(r.module) || r.also?.some((t) => stage.targets.includes(t.module))));
    if (page < 0 || page >= MAX_PAGES || pagesBefore + page >= MAX_DEVICE_PAGES)
      throw new Error('Master FX parameter page was dropped by compilation');
    out.push(kind, device, page, targets.length, ...targets);
  });
  return out;
}
export const FLAG_RANGE = 2;
export const FLAG_INPUTS = 4; // legacy: disabled fixed links (format 17); the encoder no longer sets it
export const FLAG_INPUT_MAP = 8;
export const FLAG_NOTES = 16;
export const FLAG_DEVICES = 32;
/** the device extras section (format 34): with the device pages, always */
export const FLAG_EXTRAS = 256;
/** format 51 (D-1002): every cable takes 3 bytes, u8 from module, u8 to module, u8 its ports (from output << 4 | to
 * input); set when every port index of the patch's cables is under 16 (cables3), else they take 4 bytes as before */
export const FLAG_CABLES3 = 4096;
/** can the patch's cables (`p`: the device form) take 3 bytes in format `v` */
export const cables3 = (p: Patch, v: number): boolean => v >= COUNTED && p.cables.every((c) => {
  const from = p.modules.find((m) => m.id === c.from.module)!, to = p.modules.find((m) => m.id === c.to.module)!;
  return DEFS[from.type].outputs.findIndex((o) => o.name === c.from.port) < 16 && DEFS[to.type].inputs.findIndex((i) => i.name === c.to.port) < 16;
});
/** bit 7 of the device extras' member count (format 51, D-1003): the members are one unbroken run, u8 first follows and
 * the count is the low 7 bits (a device has at most 127 members: a patch has at most 128 modules, #721, and Main is never one) */
export const MEMBER_RUN = 0x80;
export const FLAG_BUTTONS = 64;
export const FLAG_NAMES = 128;
/** the most Toggle targets a patch can list, all buttons together (engine.h ENG_BTN_TARGETS) */
export const BUTTON_TARGETS_MAX = 128;

/** the button kinds section (flag bit 6), or [] when every button is a Gate (see the top of this file) */
export function buttonRecord(source: Patch, p: Patch): number[] {
  const panel = mainOf(source)?.panel;
  if (!PANEL_BUTTONS.some((b) => kindOf(panel, b) !== 'gate')) return [];
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  // Ordinary assembly Toggles still own the real kernel, but cannot mute a
  // format55 wet-only return helper while that kernel is spilling its tail.
  const wetHelpers = new Set(fxBusOf(source)?.stages.flatMap(s => s.kind === 'reverb' && s.targets.length === 1 ? s.helpers : []) ?? []);
  const out = PANEL_BUTTONS.map((b) => KIND_CODE[kindOf(panel, b)]);
  let total = 0;
  for (const b of PANEL_BUTTONS) {
    if (kindOf(panel, b) === 'page') {
      const at = (panel?.pages?.[b] ?? []).map((x) => binaryPage(source, x.device, x.page)).filter((x): x is [number, number] => !!x);
      out.push(at.length, ...at.flat());
      continue;
    }
    if (kindOf(panel, b) !== 'bypass') continue;
    const ids = toggleTargets(source, b).filter((id) => index.has(id) && !wetHelpers.has(id));
    total += ids.length;
    if (total > BUTTON_TARGETS_MAX) throw new Error(`the buttons toggle more than ${BUTTON_TARGETS_MAX} modules`);
    out.push(ids.length, ...ids.map((id) => index.get(id)!));
  }
  return out;
}
/** the most devices, and pages per device, the binary lists (the rest are left out) */
export const MAX_DEVICES = 32, MAX_PAGES = 32;
/** Total page slots in firmware/src/pages_ui.c PG_PAGES. FX metadata may only reference pages the actual panel holds. */
export const MAX_DEVICE_PAGES = 160;
/** the Steps modules of a (device form) patch that hold notes, by module index */
const noteTracks = (p: Patch): number[] => p.modules.flatMap((m, i) => (m.type === 'steps' && m.notes?.length ? [i] : []));
/** bytes of a track's entry in the notes section: module index, count, the notes */
export const trackRecSize = (n: number): number => 2 + 4 * n;
/** the flag (u16 at offset 6) of the patterns and songs section, format 48 */
export const FLAG_PATTERNS = 1024;
/** a pattern's words are short ones (track.ts shortWord): every note fits one */
export const shortPattern = (notes: readonly StepNote[] | undefined): boolean => (notes ?? []).every(isShortNote);

/** the patterns and songs section's bytes (see the top of this file), [] when the patch has no pattern past the first on
 * any track, pattern 1 selected, no song playing and no song entries: such a patch is written as before (`dev`: the
 * device form, its module indices) */
export function patternRecord(source: Patch, dev: Patch): number[] {
  const seq = source.modules.find((m) => m.type === 'fm1')?.seq;
  const tracks = dev.modules.flatMap((m, i) => (m.type === 'steps' && m.patterns?.length ? [i] : []));
  const songs = seq?.songs ?? [];
  if (!tracks.length && !seq?.pattern && !seq?.song && !songs.some((s) => s.length)) return [];
  const out = [seq?.pattern ?? 0, seq?.song ?? 0, tracks.length];
  for (const i of tracks) {
    const pats = dev.modules[i].patterns!;
    out.push(i, pats.length);
    for (const x of pats) {
      if (!x) {
        out.push(0xff);
        continue;
      }
      const notes = x.notes ?? [];
      const short = shortPattern(notes);
      out.push(notes.length, (x.len ?? 0) | (short ? 0x80 : 0), x.rate ?? 0xff);
      for (const n of notes) {
        const w = short ? shortWord(n) : noteWord(n);
        out.push(w & 0xff, (w >>> 8) & 0xff);
        if (!short) out.push((w >>> 16) & 0xff, w >>> 24);
      }
    }
  }
  out.push(songs.length);
  for (const s of songs) {
    out.push(s.length);
    for (const e of s) out.push(e.pat, e.shift & 0xff);
  }
  return out;
}
/** bit 7 of a macro range's pin byte (format 49, #526): the pin's value −1..1 spans the range (patch.ts Range), not 0..1.
 * Firmware before format 49 skips such an entry (its pin reads past 1), so a patch with one is written in format 49 (uses19). */
export const RANGE_BIPOLAR = 0x80;
/** the macro ranges of a patch as the binary lists them (module index, pin, parameter index, ends 0..255, bipolar) */
export function rangeList(p: Patch): { mod: number; pin: number; par: number; lo: number; hi: number; bi: boolean }[] {
  const out: { mod: number; pin: number; par: number; lo: number; hi: number; bi: boolean }[] = [];
  p.modules.forEach((m, mod) => {
    const def = DEFS[m.type];
    (['p1', 'p2'] as const).forEach((s, pin) => {
      for (const [name, r] of Object.entries(m.range?.[s] ?? {})) {
        const par = def.params.findIndex((q) => q.name === name);
        if (par >= 0 && m.map?.[s].includes(name)) out.push({ mod, pin, par, lo: Math.round(r[0] * 255), hi: Math.round(r[1] * 255), bi: isBipolar(r) });
      }
    });
  });
  return out;
}

export const toQ16 = (v: number): number => Math.max(-0x80000000, Math.min(0x7fffffff, Math.round(v * Q)));

/** the additional input routes the binary lists (flag bit 3): module index, input index, parameter mask */
function routesOf(p: Patch): { mod: number; input: number; mask: number; bytes: 2 | 4 }[] {
  return p.modules.flatMap((m, mod) => DEFS[m.type].inputs.flatMap((port, input) => {
    if (port.name === 'p1' || port.name === 'p2') return [];
    const mask = DEFS[m.type].params.reduce((mask, pd, i) => (mask | (pd.input !== port.name && m.inputMap?.[port.name]?.includes(pd.name) ? 1 << i : 0)) >>> 0, 0);
    return mask ? [{ mod, input, mask, bytes: maskBytes(m.type) }] : [];
  }));
}

/** a Voice allocator's settings on a page: in the device form the allocator is the Part of its group (poly.ts deviceView),
 * and a row names the group setting with bit 7 set (0x80 + the index here; engine.h ENG_POLY_*, appended fields keep their indices) */
export const POLY_ROW_PARAMS = ['voices', 'assign', 'legato', 'priority', 'unison', 'steal', 'stack'];
export const POLY_ROW = 0x80;
/** bit 6 of a page row's parameter byte (format 35): the row's extras follow its label (engine.h ENG_ROW_MORE); a type
 * has fewer than 64 parameters, so the bit is free */
export const ROW_MORE = 0x40;
/** the parameter byte of a row on a module of `type` in the device form, -1 when it has none */
export const rowParam = (type: string, param: string): number =>
  type === 'part' ? (POLY_ROW_PARAMS.includes(param) ? POLY_ROW | POLY_ROW_PARAMS.indexOf(param) : -1) : DEFS[type].params.findIndex((q) => q.name === param);

/** a name as the FM-1's font draws it: printable ASCII (an arrow becomes >), NAME_MAX characters. A longer name that ends
 * in a number loses the space before it, so the number stays ("Verona Drum 1" is "Verona Drum1", D-862) */
export const deviceText = (s: string): string => {
  const t = s.replace(/→/g, '>').replace(/←/g, '<').replace(/[–—−]/g, '-').replace(/[^\x20-\x7e]/g, '').trim();
  return (t.length > NAME_MAX ? t.replace(/ +(\d+)$/, '$1') : t).slice(0, NAME_MAX).trim();
};

/** the device pages as the binary lists them: rows on modules the device form dropped are left out, and so are pages
 * and devices left empty */
export function deviceSection(source: Patch, dev: Patch): Device[] {
  const byId = new Map(dev.modules.map((m) => [m.id, m]));
  const kept = (r: { module: number; param: string }): boolean => { const m = byId.get(r.module); return !!m && rowParam(m.type, r.param) >= 0; };
  return devicesOf(source, DEFS).slice(0, MAX_DEVICES).map((d) => ({
    ...d,
    pages: d.pages.map((pg) => ({ ...pg, rows: pg.rows.filter(kept) })).filter((pg) => pg.rows.length).slice(0, MAX_PAGES),
  })).filter((d) => d.pages.length);
}

/** a device page of the editor (pages.ts devicesOf) as the binary lists it, [device, page]; null when the binary has
 * none for it (every row on modules the device form drops) */
export function binaryPage(source: Patch, key: string, page: number): [number, number] | null {
  const pg = devicesOf(source, DEFS).find((d) => d.key === key)?.pages[page];
  const devs = deviceSection(source, deviceView(source, true).patch);
  const d = devs.findIndex((x) => x.key === key);
  const i = d < 0 || !pg ? -1 : devs[d].pages.findIndex((x) => x.name === pg.name && x.part === pg.part);
  return i < 0 ? null : [d, i];
}

/** the reverse of binaryPage: the editor's device key and page for the binary's [device, page] */
export function editorPage(source: Patch, device: number, page: number): { device: string; page: number } | null {
  const d = deviceSection(source, deviceView(source, true).patch)[device];
  const pg = d?.pages[page];
  const i = pg ? devicesOf(source, DEFS).find((x) => x.key === d.key)?.pages.findIndex((x) => x.name === pg.name && x.part === pg.part) ?? -1 : -1;
  return i < 0 ? null : { device: d.key, page: i };
}

/** bytes of a patch's device pages section (0 without one) */
export const deviceBytes = (source: Patch): number => {
  const l = layout(source);
  return devicesSize(l.devs, l.p, l.v, source, l.names);
};

const devicesSize = (devs: Device[], p: Patch, v: number, source?: Patch, names?: string[]): number => {
  const key = sizesMemo && source ? `${v >= COUNTED ? 1 : 0}\u0000${(names ?? ['\u0001']).join('\u0000')}` : undefined;   // (while layout runs)
  const known = key === undefined ? undefined : sizesMemo!.get(key);
  if (known !== undefined) return known;
  const n = deviceRecord(devs, p, v).length + (source ? extrasRecord(devs, source, p, names, v).length : 0);
  if (key !== undefined) sizesMemo!.set(key, n);
  return n;
};

/**
 * The preset names the device extras write, one per device, and the room the FM-1 budget keeps for them (#452). An engine
 * device (an engine assembly: it can load presets, the factory's or the user's) has NAME_MAX bytes counted for its name
 * whether it has one or not (`reserve`: what its name leaves of them), so loading or storing a preset never takes a patch
 * over the FM-1's bytes. Another device's name is written only while it fits in what the patch leaves (in device order),
 * else left out, as the FM-1 skips a name that does not fit (proto.c m1_preset_name). `tail`: the bytes after the
 * device section that sizeOf does not count (the button kinds).
 */
export function presetNames(source: Patch, p: Patch, dg: DeviceGroup[], devs: Device[], tail: number, v = formatOf(source), keep = fm1Rows(source, p, devs)): { names: string[]; reserve: number } {
  const asm = devs.map((d) => (d.asm === undefined ? undefined : assemblyById(source, d.asm)));
  const kept = asm.map((a) => !!a && instIsEngine(source, a));
  const full = asm.map((a) => deviceText(a?.preset ?? ''));
  const names = full.map((n, i) => (kept[i] ? n : ''));
  const reserve = names.reduce((k, n, i) => k + (kept[i] ? NAME_MAX - n.length : 0), 0);
  if (full.every((n, i) => kept[i] || !n)) return { names, reserve };
  let room = DEVICE.bytes - sizeOf(p, dg, devs, v, keep, source, names) - tail - reserve;
  full.forEach((n, i) => {
    if (kept[i] || !n || n.length > room) return;
    names[i] = n;
    room -= n.length;
  });
  return { names, reserve };
}

/** the top a poly row carries in the binary (format 51, #649 follow-up): a VOICES row's (PageRow.top, 1 .. MAX_PARTS - 1),
 * 0 none (the FM-1 offers MAX_PARTS) */
export const polyTop = (par: number, r: PageRow): number =>
  par === POLY_ROW && r.top !== undefined && Number.isInteger(r.top) && r.top >= 1 && r.top < MAX_PARTS ? r.top : 0;

/** the device pages section's bytes in format `v` (see the top of this file; format 51 writes a page name equal to its
 * device's and a row label equal to its parameter's name empty, D-1003) */
export function deviceRecord(devs: Device[], p: Patch, v = COUNTED - 1): number[] {
  if (!devs.length) return [];
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const out = [devs.length];
  const text = (s: string): void => { const t = deviceText(s); out.push(t.length, ...Array.from(t, (c) => c.charCodeAt(0))); };
  const short = v >= COUNTED;
  for (const d of devs) {
    const own = d.module !== undefined ? moduleDeviceName(p, d) : '';
    if (own) { out.push(NAMED_MODULE, index.get(d.module!)!); text(own); continue; }
    if (d.module !== undefined) { out.push(0, index.get(d.module)!); continue; }
    out.push(1);
    text(d.name);
    out.push(d.pages.length);
    for (const pg of d.pages) {
      text(short && deviceText(pg.name) === deviceText(d.name) ? '' : pg.name);
      out.push(pg.part, pg.parts, pg.display !== undefined && index.has(pg.display) ? index.get(pg.display)! + 1 : 0, pg.rows.length);
      for (const r of pg.rows) {
        const m = p.modules[index.get(r.module)!];
        const par = rowParam(m.type, r.param);
        // the further parameters it sets: plain ones of modules the device form kept (a poly setting has none)
        const also = par & POLY_ROW ? [] : (r.also ?? []).flatMap((t) => {
          const i = index.get(t.module);
          const q = i === undefined ? -1 : rowParam(p.modules[i].type, t.param);
          return q < 0 || q & POLY_ROW ? [] : [[i!, q]];
        });
        const names = par & POLY_ROW ? [] : (r.names ?? []).slice(0, ROW_NAMES_MAX);
        // a VOICES row with a top (format 51, PageRow.top): ROW_MORE on a poly row, then u8 the top
        const top = polyTop(par, r);
        const more = also.length > 0 || names.length > 0 || top > 0;
        out.push(index.get(r.module)!, par | (more ? ROW_MORE : 0));
        text(short && !(par & POLY_ROW) && deviceText(r.label).toUpperCase() === r.param.toUpperCase() ? '' : r.label);
        if (top) { out.push(top); continue; }
        if (!more) continue;
        out.push(also.length, ...also.flat(), names.length);
        for (const n of names) text(n.toUpperCase());
      }
    }
  }
  return out;
}

/** the device extras' track byte of an engine that no keys cable reaches and no track drives (#215, D-905): the FM-1 says
 * NO KEYS REACH THIS DEVICE on SEL there, not NOTHING HERE TAKES KEYS. Firmware before 1.9 finds no device with this
 * index, so it reads it as no track (ENG_NO_TRACK), the same as 0xFF: the byte needs no newer format */
export const KEYS_UNREACHED = 0xfe;
/** the bit of the track byte that marks an engine no keys cable reaches that a Steps track drives through other cables,
 * such as pitch and gate (#633, D-295): 0x80 | the track's device index. Firmware before 1.10 finds no device with this
 * index, so it reads it as no track: the device plays the same and its environment row is not listed under the track */
export const KEYS_UNREACHED_TRACK = 0x80;
/** an engine device (engines.ts instIsEngine) whose keys input no keys cable reaches (arm.ts engineUnreached). The device
 * form leaves its Voicing out, so without this mark the FM-1 cannot tell it from a device with no keys input. The editor
 * does not arm it either (arm.ts noKeysReach, D-818) */
export function keysUnreached(source: Patch, d: Device): boolean {
  const a = d.asm === undefined ? undefined : assemblyById(source, d.asm);
  return !!a && engineUnreached(source, a);
}

/** the device extras section's bytes in format `v` (see the top of this file); `dev` is the device form (its module indices) */
export function extrasRecord(devs: Device[], source: Patch, dev: Patch = deviceView(source, true).patch, names?: string[], v = COUNTED - 1): number[] {
  if (!devs.length) return [];
  const index = new Map(dev.modules.map((m, i) => [m.id, i]));
  const out = [devs.length];
  devs.forEach((d, di) => {
    const t = d.track === undefined ? -1 : devs.findIndex((x) => x.module === d.track);
    const a = d.asm === undefined ? undefined : assemblyById(source, d.asm);
    const sr = a ? cardRows(source, a) : undefined;
    const h = sr ? parseInt(sr.structure, 16) >>> 0 : 0;
    const name = names ? names[di] : deviceText(a?.preset ?? '');
    const marked = keysUnreached(source, d);
    out.push(t >= 0 ? (marked ? KEYS_UNREACHED_TRACK | t : t) : marked ? KEYS_UNREACHED : 0xff, h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff, h >>> 24, name.length, ...Array.from(name, (c) => c.charCodeAt(0)));
    const rows = sr ? sr.rows : [];
    out.push(rows.length);
    for (const r of rows) {
      const i = index.get(r.module);
      const par = i === undefined ? -1 : rowParam(dev.modules[i].type, r.param);
      out.push(par < 0 ? 0xff : i!, par < 0 ? 0xff : par);
    }
    const members = (a ? allModules(source, a) : [d.module!]).map((id) => index.get(id)).filter((i): i is number => i !== undefined);
    if (v >= COUNTED && members.length > 2 && members.every((x, i) => x === members[0] + i)) out.push(MEMBER_RUN | members.length, members[0]);
    else out.push(members.length, ...members);
  });
  return out;
}

/** bytes of the binary patch (what the FM-1 must hold, M1_PATCH_MAX) */
export const encodedSize = (source: Patch): number => layout(source).size;

/**
 * How a patch is written (`view`: its device form): its format `v` (the lowest that holds it, baseFormat; COUNTED when
 * that one is over the FM-1's bytes and the counted records are smaller, #667), the preset names the device extras carry
 * and the room kept for them (presetNames), the binary's `size` and the device pages and button kinds it holds. `need`:
 * the bytes the budget counts, the smaller of the two forms with the room kept, so the room counted records free shows
 * in every patch while a patch that fits an older format is still written in it. `force`: counted records whatever the
 * size (tests and golden kits).
 */
export function layout(source: Patch, view: ReturnType<typeof deviceView> = deviceView(source, true), force = false) {
  if (rowsMemo) return layoutOf(source, view, force);
  rowsMemo = new Map();
  sizesMemo = new Map();
  try {
    return layoutOf(source, view, force);
  } finally {
    rowsMemo = sizesMemo = null;
  }
}
function layoutOf(source: Patch, view: ReturnType<typeof deviceView>, force: boolean) {
  const { patch: p, groups } = view;
  const devs = deviceSection(source, p);
  const kinds = buttonRecord(source, p);
  const keep = fm1Rows(source, p, devs);
  const edits = hasMorph(p) ? fm1Edits(source, p, devs) : new Map<number, Set<number>>();
  const at = (v: number) => {
    const room = morphRoom(p, v, edits, keep);
    const named = presetNames(source, p, groups, devs, kinds.length + room, v, keep);
    return { v, names: named.names, reserve: named.reserve + room, size: sizeOf(p, groups, devs, v, keep, source, named.names) + kinds.length };
  };
  const base = at(baseFormat(source, p));
  const counted = base.v < COUNTED ? at(COUNTED) : base;
  const need = Math.min(base.size + base.reserve, counted.size + counted.reserve);
  const w = !force && (base.size + base.reserve <= DEVICE.bytes || need === base.size + base.reserve) ? base : counted;
  return { p, groups, devs, kinds, keep, ...w, need, base: { v: base.v, bytes: base.size + base.reserve }, counted: counted.size + counted.reserve };
}

function sizeOf(p: Patch, dg: DeviceGroup[], devs: Device[], v: number, keep: Map<number, number>, source?: Patch, names?: string[]): number {
  const groups = dg.length;
  const routes = routesOf(p);
  const ranges = rangeList(p).length;
  const morph = hasMorph(p);
  let size = 8 + GROUP_REC * groups + (groups ? p.modules.length : 0) + PANEL_BYTES;
  for (const m of p.modules) size += moduleRecordSize(m, v, morph, keep.get(m.id));
  size += (cables3(p, v) ? 3 : 4) * p.cables.length;
  if (morph) size += morphBytes(p, v, keep);
  if (routes.length) size += 1 + routes.reduce((n, r) => n + 2 + r.bytes, 0);
  const tracks = noteTracks(p);
  if (tracks.length) size += 1 + tracks.reduce((n, i) => n + trackRecSize(p.modules[i].notes!.length), 0);
  size += patternRecord(source ?? p, p).length;
  size += lockRecord(source ?? p, p).length;
  size += originRecord(p).length;
  if (source) size += fxRecord(source, p, devs).length;
  if (ranges) size += 1 + 5 * ranges;
  const maps = drumMaps(p).length;
  if (maps) size += 1 + maps * (1 + DRUM_ROWS * TRACK_NAME_MAX);
  return size + devicesSize(devs, p, v, source, names);
}

/** the module indices of the Drum maps (their row names go into the binary, flag bit 7) */
export const drumMaps = (p: Patch): number[] => p.modules.flatMap((m, i) => (m.type === 'drummap' ? [i] : []));

/** the binary patch; refused when it is over the FM-1 budget, unless `anyway` (tools that count the engine's work on patches the
 * estimate has not seen yet: scripts/cpu-costs.ts). `counted`: in format COUNTED whatever its size (tests, golden kits) */
export function encodePatch(source: Patch, anyway = false, counted = false, allocation: BufferAllocation = 0): Uint8Array {
  const routingError = keyRouteError(source);
  if (routingError) throw new Error(routingError);
  const budget = deviceBudget(source, allocation);
  if (!budget.fits && !anyway) throw new Error(`over the FM-1 budget: ${budget.over.map((i) => (i.key === 'browser' ? i.label : `${i.label} ${i.used} of ${i.max}`)).join(', ')}`);
  const { p, groups, devs, kinds, keep, names, size, v: ver } = layout(source, undefined, counted);
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const morph = hasMorph(p);
  const ranges = rangeList(p);
  const routes = routesOf(p);
  const valued = noteTracks(p);
  const pats = patternRecord(source, p);
  const locks = lockRecord(source, p);
  const origins = originRecord(p);
  const fx = fxRecord(source, p, devs);
  // Saved/portable graphs bypass the ordinary helpers with their stage. Format55's
  // wet-only kernel wrapper owns OFF/tails, so only its compiled helper flags are active.
  const fxHelpers = new Set(fxBusOf(source)?.stages.flatMap(s => s.kind === 'reverb' && s.targets.length === 1 ? s.helpers : []) ?? []);
  const short = cables3(p, ver);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0xa1;
  out[1] = ver;
  out[2] = p.modules.length;
  out[3] = groups.length;
  dv.setUint16(4, p.cables.length, true);
  dv.setUint16(6, (short ? FLAG_CABLES3 : 0) | (morph ? FLAG_MORPH | FLAG_MORPH_MODULES : 0) | (ranges.length ? FLAG_RANGE : 0) | (routes.length ? FLAG_INPUT_MAP : 0) | (valued.length ? FLAG_NOTES : 0) | (devs.length ? FLAG_DEVICES | FLAG_EXTRAS : 0) | (kinds.length ? FLAG_BUTTONS : 0) | (drumMaps(p).length ? FLAG_NAMES : 0) | (pats.length ? FLAG_PATTERNS : 0) | (locks.length ? FLAG_LOCKS : 0) | (origins.length ? FLAG_PATTERN_ORIGINS : 0) | (fx.length ? FLAG_FX_BUS : 0), true);
  let at = 8;
  for (const { cfg, src } of groups) {
    out.set([cfg.parts | (Math.min(MAX_PARTS, cfg.unisonParts ?? 0) << 4), cfg.assign, cfg.legato | (cfg.unison ? 0x80 : 0) | (cfg.unisonShare ? 0x40 : 0), cfg.priority | (cfg.steal === false ? 0x80 : 0)], at);
    for (let v = 0; v < MAX_PARTS; v++) {
      const f = flawOf(cfg, v);
      out.set([f.detune & 0xff, f.drift, f.bright & 0xff, f.env & 0xff, f.level], at + 4 + 5 * v);
    }
    out[at + 4 + 5 * MAX_PARTS] = src === undefined ? 0 : index.get(src)! + 1;
    out.set([cfg.channel ?? 0, cfg.low ?? 0, cfg.high ?? 127], at + 5 + 5 * MAX_PARTS);
    at += GROUP_REC;
  }
  if (groups.length) for (const m of p.modules) out[at++] = groups.findIndex((g) => g.modules.has(m.id)) + 1;
  {   // the panel: what the patch makes of the FM-1's buttons, the labels of its knobs and buttons
    const panel = p.modules.find((m) => m.type === 'fm1')?.panel;
    const mask = (on: (b: string) => boolean): number => PANEL_BUTTONS.reduce((k, b, i) => (on(b) ? k | (1 << i) : k), 0);
    // a switching Toggle is on while its targets are bypassed; a button that does nothing never switches
    const lit = (b: string): boolean => switches(panel, b) && (kindOf(panel, b) === 'bypass' ? toggleEngaged(source, b) : !!panel?.on?.includes(b));
    dv.setUint16(at, mask((b) => switches(panel, b)), true);
    dv.setUint16(at + 2, mask(lit), true);
    PANEL_LABEL_KEYS.forEach((k, i) => {
      const s = panelLabel(panel?.labels?.[k]);
      for (let j = 0; j < s.length; j++) out[at + 4 + i * PANEL_LABEL_MAX + j] = s.charCodeAt(j);
    });
    at += PANEL_BYTES;
  }
  for (const m of p.modules) {
    const def = DEFS[m.type];
    out[at++] = TYPE_ORDER.indexOf(m.type) | (m.bypass && !fxHelpers.has(m.id) ? BYPASS_BIT : 0);
    const ps = storedParams(m, ver, morph, keep.get(m.id));
    const pres = def.paramInputs && ver >= COUNTED ? presenceOf(m) : 0;
    if (ver >= COUNTED) out[at++] = ps.length | (def.paramInputs && !pres ? REC_TEMPLATE : 0);
    for (const pd of ps) {
      dv.setInt32(at, toQ16(m.params[pd.name] ?? pd.default), true);
      at += 4;
    }
    if (def.paramInputs) {
      const mask = (x: number): void => {
        if (maskBytes(m.type) === 4) dv.setUint32(at, x, true);
        else dv.setUint16(at, x, true);
        at += maskBytes(m.type);
      };
      const att = m.att ?? [1, 1];
      if (ver < COUNTED) {   // (both attenuverters, the masks of p1 and p2 and four empty knob columns)
        for (const a of att) {
          dv.setInt32(at, toQ16(a), true);
          at += 4;
        }
        for (let k = 0; k < OLD_MASKS; k++) mask(k < SOURCES.length ? maskOf(m, SOURCES[k]) : 0);
      } else if (pres) {     // (the presence byte, then the items off the template)
        out[at++] = pres;
        for (const [bit, a] of [[PRES_ATT1, att[0]], [PRES_ATT2, att[1]]]) if (pres & bit) {
          dv.setInt32(at, toQ16(a), true);
          at += 4;
        }
        if (pres & PRES_P1) mask(maskOf(m, 'p1'));
        if (pres & PRES_P2) mask(maskOf(m, 'p2'));
      }
    }
    if (m.type === 'steps') {
      const name = trackName(m.name);
      for (let j = 0; j < name.length; j++) out[at + j] = name.charCodeAt(j);
    }
    if (m.type === 'drummap') {
      const from = keysInto(source, source.modules.find((x) => x.id === m.id) ?? m);
      out[at] = !from ? 0 : from.type === 'fm1' ? 1 : index.has(from.id) ? 2 + index.get(from.id)! : 0;
    }
    at += def.data ?? 0;
  }
  for (const c of p.cables) {
    const from = p.modules[index.get(c.from.module)!];
    const to = p.modules[index.get(c.to.module)!];
    const fp = DEFS[from.type].outputs.findIndex((o) => o.name === c.from.port), tp = DEFS[to.type].inputs.findIndex((i) => i.name === c.to.port);
    if (short) out.set([index.get(c.from.module)!, index.get(c.to.module)!, fp << 4 | tp], (at += 3) - 3);
    else out.set([index.get(c.from.module)!, fp, index.get(c.to.module)!, tp], (at += 4) - 4);
  }
  const bValue = (m: ModuleInst, pd: ParamDef): void => {
    dv.setInt32(at, toQ16(m.paramsB?.[pd.name] ?? m.params[pd.name] ?? pd.default), true);
    at += 4;
  };
  const moduleMask = (): void => {
    p.modules.forEach((m, i) => { if (m.paramsB) out[at + (i >> 3)] |= 1 << (i & 7); });
    at += Math.ceil(p.modules.length / 8);
  };
  if (morph && ver < COUNTED) {   // (every value of every record, then the module mask)
    for (const m of p.modules) for (const pd of storedParams(m, ver, morph, keep.get(m.id))) bValue(m, pd);
    moduleMask();
  } else if (morph) {             // (format 51: the module mask, then per module with a B side its bitmap and the B values off A)
    moduleMask();
    for (const m of p.modules) {
      if (!m.paramsB) continue;
      const ps = storedParams(m, ver, morph, keep.get(m.id));
      const diff = morphDiff(m, ps);
      for (const j of diff) out[at + (j >> 3)] |= 1 << (j & 7);
      at += Math.ceil(ps.length / 8);
      for (const j of diff) bValue(m, ps[j]);
    }
  }
  if (routes.length) {
    out[at++] = routes.length;
    for (const r of routes) {
      out[at++] = r.mod; out[at++] = r.input;
      if (r.bytes === 4) dv.setUint32(at, r.mask, true);
      else dv.setUint16(at, r.mask, true);
      at += r.bytes;
    }
  }
  if (valued.length) {
    out[at++] = valued.length;
    for (const i of valued) {
      const notes = p.modules[i].notes!;
      out[at] = i;
      out[at + 1] = notes.length;
      notes.forEach((n, j) => dv.setUint32(at + 2 + 4 * j, noteWord(n), true));
      at += trackRecSize(notes.length);
    }
  }
  if (pats.length) {
    out.set(pats, at);
    at += pats.length;
  }
  if (locks.length) {
    out.set(locks, at);
    at += locks.length;
  }
  if (devs.length) {
    const rec = [...deviceRecord(devs, p, ver), ...extrasRecord(devs, source, p, names, ver)];
    out.set(rec, at);
    at += rec.length;
  }
  if (kinds.length) {
    out.set(kinds, at);
    at += kinds.length;
  }
  const maps = drumMaps(p);
  if (maps.length) {
    out[at++] = maps.length;
    for (const i of maps) {
      out[at++] = i;
      for (let r = 0; r < DRUM_ROWS; r++, at += TRACK_NAME_MAX) {
        const name = trackName(drumRowName(p.modules[i].names, r));
        for (let c = 0; c < name.length && c < TRACK_NAME_MAX; c++) out[at + c] = name.charCodeAt(c) & 0x7f;
      }
    }
  }
  out.set(origins, at);
  at += origins.length;
  out.set(fx, at);
  at += fx.length;
  if (ranges.length) {
    out[at++] = ranges.length;
    for (const r of ranges) out.set([r.mod, r.pin | (r.bi ? RANGE_BIPOLAR : 0), r.par, r.lo, r.hi], (at += 5) - 5);
  }
  return out;
}

/** a line of the FM-1's line areas in bytes, rounded to whole words (engine.c LINE_BYTES) */
const lineBytes = (n: number): number => (n + 3) & ~3;
/** the lines of the fixed-size line modules, bytes (engine.c): a string or comb line per copy (STR_LEN), the granular's 1 s
 * and its grain records (grain_line_t), the reverb's eight lines, allpasses and pre-delay (RV_LEN) and its ring of the last
 * block's inputs (RV_MEM, D-1103: 128 int32), the chorus's (CH_LEN) */
export const LINES = {
  string: lineBytes(2 * 1104), grain: lineBytes(2 * 44118 + 8 * 24), reverb: lineBytes(2 * 8074 + 4 * 128), chorus: lineBytes(2 * 927),
} as const;
/** a Delay's line, bytes, from its length (modules.ts delayLine; engine.c dly_samples) */
export const delayBytes = (ms: number): number => lineBytes(2 * delayLine(ms));
/** bytes of one module copy (engine.c inst_t, ENG_INST_BYTES), one signal buffer (ENG_BUF_BYTES: 128 samples of 4 bytes) and
 * one parameter value in the FM-1's memory */
export const INST_BYTES = 264, BUF_BYTES = 512, PAR_BYTES = 4;
/** bytes of one module in the FM-1's memory (engine.c node_t, ENG_NODE_BYTES): its settings and connections, taken from the
 * arena per module since #721 (the fixed table of 64 they had before is part of the arena now) */
export const NODE_BYTES = 92;
/**
 * The FM-1's memory a patch takes (#649, engine.c eng_arena, ENG_ARENA): one arena divided when the patch loads, as big
 * as the fixed pools it replaced (128 copies, 255 buffers, 1536 values, and the line area of a 700 ms delay line, 8 string
 * lines and a granular line, D-375, and the spare copy: every patch that fitted before fits), and since #721 the table of
 * 64 modules (NODE_BYTES each) it took over: a patch's modules come from it. Modules, module copies (and the spare copy the
 * FM-1 keeps), signal buffers and parameter values take their bytes first; the lines go into what is left or into `LINE_LOW`, the area in the RAM below the RAM
 * region (.lowram, D-373: what the reverb and chorus lines took there and 8 KiB more). A line goes whole into one area
 * (linePlace).
 */
export const ARENA = delayBytes(DELAY_LENGTH_DEFAULT) + 8 * LINES.string + LINES.grain + 255 * BUF_BYTES + 129 * INST_BYTES + 1536 * PAR_BYTES + 64 * NODE_BYTES;
export const LINE_LOW = lineBytes(2 * 8074) + LINES.chorus + 8192;   /* (engine.c LINE_LOW: the reverb's lines before its ring) */
/** the FM-1's limits (firmware/src/engine.c: ENG_MAX_MODULES, ENG_MAX_CABLES, POLY_MAX_GROUPS, POLY_MAX_PARTS, ENG_MAX_ARPS, ENG_MAX_HARMS,
 * ENG_MAX_TRACKS, ENG_MAX_NOTES; proto.c M1_PATCH_MAX). `memory`: the arena and the low line area, bytes (memoryBudget):
 * the module copies, signal buffers, parameter values and lines share it. `instances` and `buffers` are sanity caps
 * (ENG_MAX_INST, ENG_NBUF): the memory is the real limit.
 */
export const DEVICE = {
  modules: MAX_MODULES, cables: MAX_CABLES, poly: MAX_POLY, parts: MAX_PARTS, instances: 254, buffers: 1023,
  memory: ARENA + LINE_LOW, arps: 2, harms: 2, tracks: 16, notes: 1536, locks: PATCH_LOCKS_MAX, bytes: 3840,
} as const;

export type BudgetKey = keyof typeof DEVICE;
/** one line of the budget: what the patch uses of one FM-1 limit (`cpu`: the estimated load in percent of 100; `browser`: a
 * browser-only ability the patch uses, `label` says which, used 1 of 0) */
export interface BudgetItem { key: BudgetKey | 'cpu' | 'browser'; label: string; used: number; max: number }

/** kilobytes, one decimal under 10 KB, else whole */
export const kb = (bytes: number): string => (bytes < 10240 ? (bytes / 1024).toFixed(1) : String(Math.round(bytes / 1024)));
/** a budget line over its limit in words: "CPU 130 %", "Memory 400 of 362 KB", "130 modules of 128" */
export const overText = (i: BudgetItem): string => (i.key === 'cpu' ? `CPU ${i.used} %` : i.key === 'browser' ? i.label
  : i.key === 'memory' ? `Memory ${kb(i.used)} of ${kb(i.max)} KB${i.used <= i.max ? ' (the lines do not fit what is left)' : ''}` : `${i.used} ${i.label} of ${i.max}`);

/** the types whose modules take lines from the FM-1's memory */
export const LINE_TYPES = ['delay', 'string', 'comb', 'grain', 'reverb', 'chorus'];
/** the line of each fixed-size line type, bytes (the comb uses a string line) */
const FIXED_LINE: Record<string, number> = { string: LINES.string, comb: LINES.string, grain: LINES.grain, reverb: LINES.reverb, chorus: LINES.chorus };

/**
 * Where the FM-1 puts lines of these sizes (bytes), as engine.c line_place does when a patch loads: the largest first (of
 * equal ones the first), each into the area with the least room that holds it (`low` when both have the same). The area of
 * each line (0 low, 1 what the arena has left: `pool` bytes), or null when one does not fit.
 */
export function linePlace(sizes: number[], pool: number = ARENA): (0 | 1)[] | null {
  const free = [LINE_LOW, pool];
  const out: (0 | 1)[] = new Array(sizes.length);
  const order = sizes.map((b, i) => i).sort((x, y) => sizes[y] - sizes[x] || x - y);
  for (const i of order) {
    const b = sizes[i];
    const ok0 = b <= free[0], ok1 = b <= free[1];
    if (!ok0 && !ok1) return null;
    const r: 0 | 1 = ok0 && (!ok1 || free[0] <= free[1]) ? 0 : 1;
    free[r] -= b;
    out[i] = r;
  }
  return out;
}

/** one line-type module's share of the memory: its lines (one per copy: a string or comb in a poly assembly has one per
 * part), bytes */
export interface LineUse { id: number; type: string; copies: number; bytes: number }
/** what a patch's device form takes of the FM-1's arena besides its lines (engine.c eng_load): its module copies (one per
 * part of its poly group, and the spare copy), signal buffers (one per connected output port and copy, and one per input
 * copy with two or more sources: a module outside a poly assembly reading a per-part output has one source per part) and
 * parameter values (per module its type's, twice that with a morph B side, and per copy their effective values) */
export interface PoolUse { instances: number; buffers: number; params: number; physicalBuffers?: number }
/** the memory a patch takes on the FM-1 (#649): each line-type module's lines, the module copies, signal buffers and
 * parameter values; `used` the total bytes of the arena and the low line area, `max` theirs, and whether the lines fit
 * what the others leave (`fits`, linePlace) */
export interface LineBudget { modules: LineUse[]; pool: PoolUse; used: number; max: number; fits: boolean; lines: number; copiesBytes: number; buffersBytes: number; paramsBytes: number;
  /** the modules (#721): how many, their bytes (NODE_BYTES each) */
  nodes: number; nodesBytes: number; keyBytes: number }
/** the copies of each module of a device form: the parts of its poly group, else one */
function copiesOf(groups: DeviceGroup[]): (id: number) => number {
  const copies = new Map<number, number>();
  groups.forEach((g) => g.modules.forEach((id) => copies.set(id, g.cfg.parts)));
  return (id) => copies.get(id) ?? 1;
}
/** PoolUse of a device form (`groups`: its poly groups), counted as eng_load takes them */
export function poolUse(p: Patch, groups: DeviceGroup[], allocation: BufferAllocation = 0): PoolUse {
  const ninst = copiesOf(groups);
  const groupOf = new Map<number, number>();
  groups.forEach((g, i) => g.modules.forEach((id) => groupOf.set(id, i)));
  let instances = 0;
  for (const m of p.modules) instances += ninst(m.id);
  let buffers = 0;
  const seen = new Set<string>();
  for (const c of p.cables) {
    const key = `${c.from.module}:${c.from.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    buffers += ninst(c.from.module);
  }
  for (const m of p.modules) {
    const n = ninst(m.id);
    for (const port of DEFS[m.type].inputs) {
      let sources = 0;
      for (const c of p.cables)
        if (c.to.module === m.id && c.to.port === port.name) sources += groupOf.get(c.from.module) !== groupOf.get(m.id) ? ninst(c.from.module) : 1;
      if (sources >= 2) buffers += n;
    }
  }
  let params = 0; // engine.c par_take: a node's values (and morph B side), each instance's effective values
  const morph = hasMorph(p);
  for (const m of p.modules) params += DEFS[m.type].params.length * ((morph ? 2 : 1) + ninst(m.id));
  return { instances, buffers, params, ...(allocation === 1 ? { physicalBuffers: signalBuffers(p, groups).physical } : {}) };
}
/** the memory of a patch's device form (what eng_load takes, a copy per part as it counts them) */
export function lineBudget(source: Patch, allocation: BufferAllocation = 0): LineBudget {
  const { patch: p, groups } = deviceView(source, true);
  return linesOf(p, copiesOf(groups), poolUse(p, groups, allocation));
}
/** does a two-core schedule's allocation fit (#802, engine.c eng_load): its buffers (the lanes' own) and the lines, beside
 * the copies and values of allocation rule 1. Input: deviceView(source, true) */
export function scheduleFits(p: Patch, groups: DeviceGroup[], s: Schedule): boolean {
  return linesOf(p, copiesOf(groups), { ...poolUse(p, groups, 1), physicalBuffers: signalBuffers(p, groups, false, s).physical }).fits;
}
/** the physical signal buffers engine.c allocates (rule 1): its two-core schedule's while they fit, else the one-core
 * allocation's. Input: deviceView(source, true) */
export function deviceBuffers(p: Patch, groups: DeviceGroup[]): number {
  const s = schedule(p, groups, (type) => scheduleCost(CPU, type));
  return signalBuffers(p, groups, false, s.on && scheduleFits(p, groups, s) ? s : undefined).physical;
}
export const KEY_ROUTING_BYTES = 8040;
function linesOf(p: Patch, ninst: (id: number) => number, pool: PoolUse): LineBudget {
  const modules: LineUse[] = [];
  const sizes: number[] = [];
  for (const m of p.modules) {
    if (!LINE_TYPES.includes(m.type)) continue;
    const one = m.type === 'delay' ? delayBytes(m.params.length ?? DELAY_LENGTH_DEFAULT) : FIXED_LINE[m.type];
    const n = ninst(m.id);
    for (let k = 0; k < n; k++) sizes.push(one);
    modules.push({ id: m.id, type: m.type, copies: n, bytes: one * n });
  }
  const lines = sizes.reduce((a, b) => a + b, 0);
  const copiesBytes = (pool.instances + 1) * INST_BYTES, buffersBytes = (pool.physicalBuffers ?? pool.buffers) * BUF_BYTES, paramsBytes = pool.params * PAR_BYTES;
  const nodes = p.modules.length, nodesBytes = nodes * NODE_BYTES;
  // engine.c key_memory_t: bounded queues and transient chord/entry state, allocated only by chained routes.
  const keyBytes = chainedHarmonizer(p) && p.modules.some(m => m.type === 'steps') ? KEY_ROUTING_BYTES : 0;
  const taken = copiesBytes + buffersBytes + paramsBytes + nodesBytes + keyBytes;
  const fits = taken <= ARENA && sizes.length <= MAX_LINES && linePlace(sizes, ARENA - taken) !== null;
  return { modules, pool, used: taken + lines, max: DEVICE.memory, fits, lines, copiesBytes, buffersBytes, paramsBytes, nodes, nodesBytes, keyBytes };
}
/** the most lines a patch can have (engine.c ENG_MAX_LINES) */
export const MAX_LINES = 128;
/**
 * The longest length (ms, a whole step of the row) Delay `id` can take with every other line of the patch where it is, at
 * least `floor`; 0 when even the shortest does not fit. The editor's length row stops there (lengthRoom).
 */
export function delayRoom(source: Patch, id: number, allocation: BufferAllocation = 0): number {
  const pd = DEFS.delay.params.find((q) => q.name === 'length')!;
  const m = source.modules.find((x) => x.id === id);
  if (!m || m.type !== 'delay') return 0;
  const was = m.params.length;
  const fits = (ms: number): boolean => {
    m.params.length = ms;
    try { return lineBudget(source, allocation).fits; } finally { if (was === undefined) delete m.params.length; else m.params.length = was; }
  };
  const step = pd.step ?? 10;
  if (!fits(pd.min)) return 0;
  let lo = pd.min, hi = pd.max;
  if (fits(hi)) return hi;
  while (hi - lo > step) {
    const mid = lo + Math.floor((hi - lo) / 2 / step) * step;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}
/**
 * What to say when a patch does not fit the FM-1's memory (or a length stops at what is left): the memory used, and what
 * takes the most of it besides `except` (a module id: the one being changed), so the user knows what to shorten or remove.
 * "Memory full: 350 of 362 KB used. Shorten the other Delay or remove the Granular (86 KB)." When the module copies take
 * more than any line, fewer voices come first.
 */
export function linesAdvice(source: Patch, except?: number, allocation: BufferAllocation = 0): string {
  const b = lineBudget(source, allocation);
  const others = b.modules.filter((u) => u.id !== except).sort((x, y) => y.bytes - x.bytes);
  const name = (u: LineUse): string => `the ${DEFS[u.type].label}${u.copies > 1 ? ` (×${u.copies})` : ''}`;
  const delays = others.filter((u) => u.type === 'delay');
  const big = others.find((u) => u.type !== 'delay');
  const voices = b.copiesBytes > Math.max(0, ...others.map((u) => u.bytes)) ? `use fewer voices (the module copies take ${kb(b.copiesBytes)} KB)` : '';
  const tips = [voices, delays.length ? `shorten ${delays.length > 1 ? 'another Delay' : 'the other Delay'}` : '', big ? `remove ${name(big)} (${kb(big.bytes)} KB)` : ''].filter(Boolean);
  return `Memory full: ${kb(b.used)} of ${kb(b.max)} KB used.${tips.length ? ` ${tips.join(' or ').replace(/^./, (c) => c.toUpperCase())}.` : ''}`;
}

/**
 * The browser-only abilities a patch uses, one reason each ("Delay over 700 ms on the morph B side: browser only"); none:
 * the FM-1 can play everything in it. A parameter past the FM-1's range into its browser-only stretch
 * (ParamDef.browserMax), on either morph side. The Delay's time is the one such parameter: past 700 ms on its A side
 * the FM-1 plays it too (up to the Delay's length, which the FM-1's memory holds: lineBudget), so only a B side past it
 * is the browser's (the FM-1 keeps a B side past the range in 16 bits). A patch with any is over the FM-1 budget
 * (deviceBudget), so it is never sent.
 */
export function browserOnly(p: Patch): string[] {
  const out = new Set<string>();
  for (const m of p.modules) {
    const def = DEFS[m.type];
    if (!def) continue;
    for (const pd of def.params) {
      if (pd.browserMax === undefined) continue;
      const past = (v: number | undefined): boolean => v !== undefined && v > pd.max;
      const aOk = m.type === 'delay' && pd.name === 'time';
      const over = `${def.label} over ${pd.max}${pd.unit ? ` ${pd.unit}` : ''}`;
      if (!aOk && past(m.params[pd.name])) out.add(`${over}: browser only`);
      if (past(m.paramsB?.[pd.name])) out.add(`${over}${aOk ? ' on the morph B side' : ''}: browser only`);
    }
  }
  return [...out];
}

/** the limits that are sanity caps (#649): the memory is the real limit, so they show only when exceeded */
export const SANITY_CAPS: ReadonlySet<string> = new Set<BudgetKey>(['instances', 'buffers']);
const LABELS: Record<BudgetKey, string> = {
  modules: 'modules', cables: 'cables', poly: 'poly assemblies', parts: 'parts', instances: 'module copies', buffers: 'signal buffers',
  memory: 'memory', arps: 'arpeggiators', harms: 'harmonizers', tracks: 'step tracks', notes: 'step notes', locks: 'P-locks', bytes: 'patch bytes',
};

/**
 * What a patch costs on the FM-1, counted the way eng_load allocates: one instance per copy of a module (a module in a
 * poly assembly has one per part); one signal buffer per connected output port and copy, plus one per input copy with
 * two or more sources (a module outside a poly assembly reading a per-part output has one source per part); per module its
 * type's parameters (twice that when the patch has a morph B side) and per copy their effective values; all of them and
 * the lines of the line-type modules share the FM-1's memory (`memory`, `lines`: lineBudget, over when they do not fit;
 * #649: instances and buffers are only sanity caps). `items` lists every limit, `over`
 * those the patch exceeds, `memory` the fullest one as a fraction (single lines count only when exceeded) and `fullest` that
 * line; `cpu` the estimated processor load (cpu.ts); `use` the larger of the two. `fits` is false when the firmware would
 * refuse the patch or, by the estimate, could not render it in time, or when the patch uses a browser-only ability
 * (browserOnly: a `browser` line in `over`).
 * The editor and the browser engine have none of these limits.
 */
export interface Budget {
  buffers: number;
  instances: number;
  /** the parameter values eng_load takes (host_test checks them against the binary's) */
  params: number;
  fits: boolean;
  items: BudgetItem[];
  over: BudgetItem[];
  memory: number;
  fullest: BudgetItem | undefined;
  cpu: CpuEstimate;
  use: number;
  /** the memory: what takes it (lineBudget) */
  lines: LineBudget;
}

/** the patch bytes the budget counts: the binary's, plus the room kept for the engine devices' preset names (presetNames) */
const bytesOf = (source: Patch, view: ReturnType<typeof deviceView>): number => layout(source, view).need;

export function deviceBudget(source: Patch, allocation: BufferAllocation = 0): Budget {
  const view = deviceView(source, true);
  const { patch: p, groups } = view;
  const ninst = copiesOf(groups);
  const pool = poolUse(p, groups, allocation);
  const { instances, buffers, params } = pool;
  const count = (...types: string[]): number => p.modules.filter((m) => types.includes(m.type)).reduce((n, m) => n + ninst(m.id), 0);
  const lines = linesOf(p, ninst, pool);
  const used: Record<BudgetKey, number> = {
    modules: p.modules.length, cables: p.cables.length, poly: groups.length, parts: Math.max(1, ...groups.map((g) => g.cfg.parts)),
    instances, buffers, memory: lines.used, arps: count('arp'), harms: count('harm'), tracks: count('steps'), notes: p.modules.reduce((n, m) => n + (m.type === 'steps' ? (m.notes?.length ?? 0) + (m.patterns ?? []).reduce((k, x) => k + (x?.notes?.length ?? 0), 0) : 0), 0),
    locks: p.modules.reduce((n, m) => n + (m.type === 'steps' ? (m.locks?.length ?? 0) + (m.patterns ?? []).reduce((k, x) => k + (x?.locks?.length ?? 0), 0) : 0), 0), bytes: bytesOf(source, view),
  };
  const items = (Object.keys(DEVICE) as BudgetKey[]).map((key) => ({ key, label: LABELS[key], used: used[key], max: DEVICE[key] }));
  const over: BudgetItem[] = items.filter((i) => (i.key === 'memory' ? !lines.fits : i.used > i.max));
  // a one- or two-of-a-kind slot (one delay, one reverb, two arpeggiators ...) is either there or not: it shows only when
  // exceeded, so a patch with its one reverb or one of its two arpeggiators does not read as half full or full; the sanity
  // caps (instances, buffers: the memory is the real limit) likewise
  const counted = items.filter((i) => (i.max > 2 && !SANITY_CAPS.has(i.key)) || i.used > i.max);
  const fullest = counted.reduce<BudgetItem | undefined>((a, i) => (!a || i.used / i.max > a.used / a.max ? i : a), undefined);
  const memory = fullest ? fullest.used / fullest.max : 0;
  const cpu = cpuEstimate(source, CPU, 2, (s) => scheduleFits(p, groups, s));
  if (cpu.use > 1) over.push({ key: 'cpu', label: 'CPU (estimate)', used: Math.round(cpu.use * 100), max: 100 });
  for (const label of browserOnly(source)) over.push({ key: 'browser', label, used: 1, max: 0 });
  return { buffers, instances, params, fits: !over.length, items, over, memory, fullest, cpu, use: Math.max(memory, cpu.use), lines };
}

