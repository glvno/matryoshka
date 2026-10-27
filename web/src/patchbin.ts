// SPDX-License-Identifier: GPL-3.0-only
// Compact binary patch format, read by firmware/src/engine.c (eng_load).
//
//   u8  magic 0xA1, u8 version (VERSION), u8 module count, u8 poly group count G (0..MAX_POLY), u16 LE cable count, u16 LE flags
//       (bit 0: a morph B set follows the cables; bit 2: disabled-input masks follow it; bit 3: additional input routes follow masks; bit 4: the tracks' notes follow them; bit 1: macro ranges are last)
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
//                modules with parameter inputs (paramInputs) then add i32 att1, i32 att2 (Q16.16, -1..1) and
//                six matrix masks for the sources p1, p2, k1, k2, k3, k4 (bit n = the n-th parameter), each u16 LE, or u32 LE
//                for a type with more than 16 parameters (maskBytes; since format 35: every type of an older patch has at most 16, so
//                the older layouts are unchanged);
//                then the module's data (ModuleDef.data bytes): a Steps module's name (TRACK_NAME_MAX bytes, ASCII, zero
//                padded); a Drum map's u8 keys source (0 none, 1 Main's keys, 2 + the module index of a Steps module)
//   per cable:   u8 from module index, u8 from output index, u8 to module index, u8 to input index
//   with flag bit 0, per module: one i32 LE per parameter (Q16.16), the B side of the morph (the Main module's morph
//                parameter and input fade every parameter from the record's value to this one)
//   with flag bit 9, after the B values: ceil(module count / 8) bytes, bit i marks module i as having a B side.
//   with flag bit 2 (legacy, read by the firmware, never written since fixed links became permanent): one u8 disabled-input mask per module
//   with flag bit 3: u8 count, then u8 module index, u8 input index, the parameter mask per routed input (u16 LE, or u32 LE
//                when the module's type has more than 16 parameters: maskBytes)
//   with flag bit 4: the tracks' notes (#133): u8 count, then per Steps module with notes, in module order: u8 module index,
//                u8 n (1..TRACK_NOTES_MAX), n u32 LE notes (track.ts noteWord), sorted by start, then note
//   with flag bit 10 (format 48, written only when used: patternRecord): the patterns and songs (track.ts Pattern, SeqState):
//                u8 the selected pattern (0-based), u8 the song playing (0 none, 1..SONGS_MAX); u8 track count, per Steps module
//                with patterns past its first, in module order: u8 module index, u8 P, then patterns 2..P+1, each u8 n: 0xFF the
//                track has no such pattern (it plays its pattern 1), else n notes (0..TRACK_NOTES_MAX), u8 len (bits 0..6: 0 the
//                track's, else 1..STEPS_MAX; bit 7: short words), u8 rate (0xFF the track's, else a STEPS_RATES index), n
//                words: u16 LE short ones (track.ts shortWord, when every note of the pattern fits one: isShortNote) or u32 LE
//                (noteWord); then u8 song count, per song u8 entry count, per entry u8 pattern, i8 shift. Pattern 1 of every
//                track stays in the notes section, so a patch without patterns is written as before.
//   with flag bit 5: the device pages (pages.ts): u8 device count, then per device u8 kind: 0 a plain module, then u8 its
//                module index (the FM-1 makes its pages itself: its parameters in order, four to a page, named as in
//                defs.h); 1 an assembly, then its name (a text: u8 length 0..NAME_MAX, ASCII) and u8 page count, per page its
//                name (text), u8 part (0-based), u8 parts, u8 the envelope drawn above it (1 + module index, 0 none), u8 row
//                count (1..PAGE_ROWS), per row u8 module index, u8 parameter index (bit 7: a setting of the poly group of
//                that Part, POLY_ROW_PARAMS; bit 6, format 35: the row's extras follow its label, ROW_MORE), its label
//                (text), and with bit 6 its extras (#357, #358): u8 n, n (u8 module index, u8 parameter index): the further
//                parameters the row sets to its value, then u8 k (0..ROW_NAMES_MAX), k texts: its positions' names (a
//                Selector's, position 1 first; capitals on the FM-1)
//   with flag bit 8 (format 34; with the device pages, right after them): the device extras: u8 device count, then per
//                device u8 track (the device index of the Steps track that drives it, pages.ts Device.track; 0xFF none),
//                u32 LE structure (an assembly's fingerprint, structure.ts; 0 a plain module), the name of the preset it was
//                set to (a text, AssemblyInst.preset; empty none), u8 n and n (u8 module index, u8 parameter byte as a page
//                row's): its card rows in canonical order (structure.ts rowOrder: the order of a preset's values; 0xFF 0xFF a
//                row the FM-1 has not got); n is 0 for a plain module; u8 m and m u8 module indices: the modules it is made
//                of (a plain module: itself; arming it on the FM-1 lets these hear Main's keys, #191)
//   with flag bit 6: the button kinds (buttons.ts): PANEL_BUTTONS.length u8 kinds (0 Gate, 1 Nothing, 2 Toggle, 3 Page),
//                then in button order per Toggle button u8 n (0..), n u8 module indices: the modules it bypasses (buttons.ts
//                toggleTargets); per Page button u8 n, n (u8 device, u8 page): its list, in the device pages section's
//                indices (binaryPage; pages that are gone are left out). A patch without it: every button is a Gate. The panel's switched-on mask holds a
//                switching Toggle as on while its targets are bypassed.
//   with flag bit 7 (format 33, the #139 follow-up): the Drum maps' row names: u8 count, then per Drum map in module order u8 module index,
//                DRUM_ROWS names of TRACK_NAME_MAX bytes (ASCII, zero padded; drumRowName: its own, else the default) for the
//                FM-1's SEQ page
//   with flag bit 1 (always last: the FM-1 edits it in place): u8 count, then per macro range: u8 module index, u8 pin (0 p1,
//                1 p2), u8 parameter index, u8 low end, u8 high end (0..255 of the parameter's range, octaves for a log
//                one): the pin's value lands between the ends
//
// Type indices are the position in TYPE_ORDER (append only: the firmware has the same list in defs.h).
// Port indices are positions in ModuleDef.outputs / inputs (explicit ports first, then the `<param>_cv` inputs).

import { DEFS, DRUM_ROWS, drumRowName, PANEL_BUTTONS } from './modules';
import { KIND_CODE, kindOf, mainOf, switches, toggleEngaged, toggleTargets } from './buttons';
import { EDITOR_ONLY, flawOf, hasMorph, MAX_MODULES, MAX_PARTS, PANEL_LABEL_KEYS, PANEL_LABEL_MAX, panelLabel, SOURCES, TRACK_NAME_MAX, trackName, type ParamDef, type Patch } from './patch';
import { isShortNote, noteWord, shortWord, type StepNote } from './track';
import { deviceView, keysInto, MAX_POLY, type DeviceGroup } from './poly';
import { devicesOf, NAME_MAX, type Device } from './pages';
import { allModules, assemblyById, ROW_NAMES_MAX } from './assembly';
import { structureAndRows } from './structure';
import { cpuEstimate, type CpuEstimate } from './cpu';

export const TYPE_ORDER: string[] = Object.keys(DEFS).filter((t) => !EDITOR_ONLY.has(t));
/** bytes of a poly group record: parts, assign, legato, priority, five flaw bytes per part, the note source, the MIDI
 * channel (0 = the device's), the lowest and the highest key (engine.h ENG_GROUP_REC) */
export const GROUP_REC = 4 + 5 * MAX_PARTS + 4;
/** bytes of the panel section (engine.h ENG_PANEL_BYTES): two masks and the labels */
export const PANEL_BYTES = 4 + PANEL_LABEL_KEYS.length * PANEL_LABEL_MAX;
export const MAX_CABLES = 255;
export const VERSION = 48; // 48: the patterns and songs section (flag bit 10, patternRecord: Steps patterns 2..64, short note words, the selected pattern, up to eight songs), written only when the patch has patterns or songs; 47: the filter's osc parameter (self-oscillation, off by default) after its existing parameters; 46: the Follower module (esp, after the MS-20's External Signal Processor) appended after Ratio; 45: the filter's hp6 output (a resonant 6 dB high pass) after its existing outputs; 44: Steps play direction; 43: appended Ratio module; 42: appended Rate Env module; 41: ADSR hold input after existing ports; 40: LFO wide-rate parameter; 39: group legato bit 6 selects shared unison, together with bit 7; 38: group parts byte high nibble selects unison voice count (0 means all); 37: group priority bit 7 disables voice stealing, assign 3 rotates with reset after all keys lift; 36: a module mask after the morph B set (flag bit 9) preserves which modules have a B side; 35: Tier 1 of #351: the types pd (phase distortion), env8 (eight-step envelope), select (Selector); a device page row's extras (bit 6 of its parameter byte, ROW_MORE: the further parameters it sets and its positions' names, #357, #358; a row without them is written as before); a type with more than 16 parameters writes its matrix and route masks as u32 (maskBytes); parameters appended to existing types (ParamDef.since): drummap repeat (9 parameters), adsr long, lfo phase / range / dir / mult, delay note / swell, reverb freeze, pulse inf, so a record of an older binary holds fewer parameters (the FM-1 reads it with its format's count and gives the rest their defaults: engine.c eng_npar); the Steps rate's choices 7..8 (1/2, 1/64) and swing past 75 (ParamDef.top); 34: the device extras section (flag bit 8: per device its driving Steps track, structure and preset name; #194, #197); 33: the Drum maps' row names section (flag bit 7, the #139 follow-up); 32: the Drum map module (#137; its record's data byte is the source of its keys); 31: the Steps module holds notes (#133): its record carries only its name, the notes section (flag bit 4) replaces the step values, its acc output is gone and it has a keys output (a group's note source may be a Steps module); 30: the button kinds section (flag bit 6: Nothing / Gate / Toggle and a Toggle's modules); 29: the device pages section (flag bit 5); the Main module lost the knob outputs and parameters k1..k6 (its knobs edit the page in focus), the panel section the knob labels (7 labels); the Macro module; 28: the level / rate envelope (env) got the shot parameter; 27: the step values section (flag bit 4), the Steps module's transpose input and pitch / vel outputs; 26: the Steps module (its record ends with its name and pattern), the Main module lost the seq and rec button outputs (the panel section has 7 buttons, 13 labels); 25: a group record ends with its MIDI channel and key range (low, high); 24: the panel section (button modes, switched states, labels) after the group bytes, the Main module's k5 / k6 and button outputs; 23: the group record ends with its note source (an Arpeggiator), the Main module got the tempo parameter and the run output, the Arpeggiator module; 22: bit 7 of a group's legato byte = unison (a patch without unison still encodes as 21); 21: per-part flaws in the group record (GROUP_REC), the unit is gone; 20: poly assemblies (the group section after the header; the Main module lost legato, priority, unit and the spread, legato, jump, tol, drift outputs, the oscillator its drift; part and random modules); 19: voicing and drift: the Main module got legato, priority, unit (and the legato, jump, tol, drift outputs), the oscillator blend, stack, drift, the glide curve; 18: arbitrary side-input fan-out (flag bit 3); 17: switchable fixed input links (flag bit 2); unmodified patches still encode as 16; 16: the shaper got the sym and stages parameters; 15: macro ranges (flag bit 1); 14: the Main module got the morph input and parameter, header flag bit 0 = a morph B set follows the cables; 13: the shaper and the digitizer got the os (oversampling) parameter, the sequencer glide and gate; 12: bit 7 of the type byte marks a bypassed module; 11: the oscillator got the unison and detune parameters; 10: the merge of the two lines below: the Main module's clock output comes before spread, the lfo's inputs are clk, reset (the restart input was sync), the delay as in 8b, modules of the second and third batch; 9: the matrix masks are u16 (modules with more than 8 parameters), the modules of the second module batch; 8a: osc and lfo got the sync input (p1 / p2 moved), glide and shape modules, the panel's spread output; 8b: the delay has the clk input, r output and sync, pingpong parameters, the lfo got the clk and reset inputs and the sync, div, bpm parameters, the Main module's clock output; 7: the oscillator got the fb parameter; 6: the filter's outputs are lp24, lp12, bp, hp, mix; 5: the filter got the morph input (ports after cv moved), track and morph parameters; 4: the reverb module was added before the output
/**
 * The lowest format the encoder writes: a patch that uses no parameter appended after it (ParamDef.since past it: a value
 * off its default on either morph side, a pin, macro range, input route or card row on it) is written in this format, its
 * records with this format's parameter counts, so an appended parameter costs bytes only in the patches that use it. The
 * FM-1 reads such a binary as it reads any older one (engine.c eng_npar: the rest at their defaults). Format 47's filter
 * `osc` is the first parameter written this way.
 */
export const WRITE_FLOOR = 46;
/** the formats past WRITE_FLOOR that only add a section the encoder writes when the patch uses it (format 48: the patterns
 * and songs, flag bit 10); every other format past WRITE_FLOOR appends parameters (ParamDef.since) */
export const SECTION_FORMATS: Record<number, string> = { 48: 'patterns and songs' };
/** a type's parameters in a binary of format `v` (appended ones, ParamDef.since, come last) */
export const paramsAt = (type: string, v: number): ParamDef[] => DEFS[type].params.filter((q) => (q.since ?? 0) <= v);
/** the format encodePatch writes for this patch: VERSION, or WRITE_FLOOR when it uses nothing appended since (`dev`: its device form) */
export function formatOf(source: Patch, dev: Patch = deviceView(source, true).patch): number {
  const late = (type: string): ParamDef[] => DEFS[type].params.filter((q) => (q.since ?? 0) > WRITE_FLOOR);
  const floor = patternRecord(source, dev).length ? 48 : WRITE_FLOOR;
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
      const off = (v: number | undefined): boolean => v !== undefined && v !== pd.default;
      const used = off(m.params[pd.name]) || off(m.paramsB?.[pd.name]) || rows.has(`${m.id}/${pd.name}`)
        || SOURCES.some((src) => m.map?.[src]?.includes(pd.name) || (m.range as Record<string, Record<string, unknown> | undefined> | undefined)?.[src]?.[pd.name] !== undefined)
        || Object.values(m.inputMap ?? {}).some((names) => names?.includes(pd.name));
      if (used) v = Math.max(v, pd.since!);
    }
  return v;
}
/** bytes of a module record */
/** bytes of a parameter mask of this type (the matrix, an input route): u16, u32 past 16 parameters (engine.c eng_mask_bytes) */
export const maskBytes = (type: string): 2 | 4 => (DEFS[type].params.length > 16 ? 4 : 2);
export const recordSize = (type: string, v = VERSION): number =>
  1 + 4 * paramsAt(type, v).length + (DEFS[type].paramInputs ? 8 + SOURCES.length * maskBytes(type) : 0) + (DEFS[type].data ?? 0);
export const Q = 65536;

/** bit 7 of a module record's type byte: the module is bypassed */
export const BYPASS_BIT = 0x80;
/** header flags (u16 at offset 6) */
export const FLAG_MORPH = 1;
/** one bit per module after the B set: only modules with a B side morph (#355, format 36) */
export const FLAG_MORPH_MODULES = 512;
export const FLAG_RANGE = 2;
export const FLAG_INPUTS = 4; // legacy: disabled fixed links (format 17); the encoder no longer sets it
export const FLAG_INPUT_MAP = 8;
export const FLAG_NOTES = 16;
export const FLAG_DEVICES = 32;
/** the device extras section (format 34): with the device pages, always */
export const FLAG_EXTRAS = 256;
export const FLAG_BUTTONS = 64;
export const FLAG_NAMES = 128;
/** the most Toggle targets a patch can list, all buttons together (engine.h ENG_BTN_TARGETS) */
export const BUTTON_TARGETS_MAX = 128;

/** the button kinds section (flag bit 6), or [] when every button is a Gate (see the top of this file) */
export function buttonRecord(source: Patch, p: Patch): number[] {
  const panel = mainOf(source)?.panel;
  if (!PANEL_BUTTONS.some((b) => kindOf(panel, b) !== 'gate')) return [];
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const out = PANEL_BUTTONS.map((b) => KIND_CODE[kindOf(panel, b)]);
  let total = 0;
  for (const b of PANEL_BUTTONS) {
    if (kindOf(panel, b) === 'page') {
      const at = (panel?.pages?.[b] ?? []).map((x) => binaryPage(source, x.device, x.page)).filter((x): x is [number, number] => !!x);
      out.push(at.length, ...at.flat());
      continue;
    }
    if (kindOf(panel, b) !== 'bypass') continue;
    const ids = toggleTargets(source, b).filter((id) => index.has(id));
    total += ids.length;
    if (total > BUTTON_TARGETS_MAX) throw new Error(`the buttons toggle more than ${BUTTON_TARGETS_MAX} modules`);
    out.push(ids.length, ...ids.map((id) => index.get(id)!));
  }
  return out;
}
/** the most devices, and pages per device, the binary lists (the rest are left out) */
export const MAX_DEVICES = 32, MAX_PAGES = 32;
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
/** the macro ranges of a patch as the binary lists them (module index, pin, parameter index, ends 0..255) */
export function rangeList(p: Patch): { mod: number; pin: number; par: number; lo: number; hi: number }[] {
  const out: { mod: number; pin: number; par: number; lo: number; hi: number }[] = [];
  p.modules.forEach((m, mod) => {
    const def = DEFS[m.type];
    (['p1', 'p2'] as const).forEach((s, pin) => {
      for (const [name, r] of Object.entries(m.range?.[s] ?? {})) {
        const par = def.params.findIndex((q) => q.name === name);
        if (par >= 0 && m.map?.[s].includes(name)) out.push({ mod, pin, par, lo: Math.round(r[0] * 255), hi: Math.round(r[1] * 255) });
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

/** a name as the FM-1's font draws it: printable ASCII (an arrow becomes >), NAME_MAX characters */
export const deviceText = (s: string): string => s.replace(/→/g, '>').replace(/←/g, '<').replace(/[–—−]/g, '-').replace(/[^\x20-\x7e]/g, '').slice(0, NAME_MAX).trim();

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
export const deviceBytes = (source: Patch): number => { const p = deviceView(source, true).patch; return devicesSize(deviceSection(source, p), p, source); };

const devicesSize = (devs: Device[], p: Patch, source?: Patch): number => deviceRecord(devs, p).length + (source ? extrasRecord(devs, source, p).length : 0);

/** the device pages section's bytes (see the top of this file) */
export function deviceRecord(devs: Device[], p: Patch): number[] {
  if (!devs.length) return [];
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const out = [devs.length];
  const text = (s: string): void => { const t = deviceText(s); out.push(t.length, ...Array.from(t, (c) => c.charCodeAt(0))); };
  for (const d of devs) {
    if (d.module !== undefined) { out.push(0, index.get(d.module)!); continue; }
    out.push(1);
    text(d.name);
    out.push(d.pages.length);
    for (const pg of d.pages) {
      text(pg.name);
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
        const more = also.length > 0 || names.length > 0;
        out.push(index.get(r.module)!, par | (more ? ROW_MORE : 0));
        text(r.label);
        if (!more) continue;
        out.push(also.length, ...also.flat(), names.length);
        for (const n of names) text(n.toUpperCase());
      }
    }
  }
  return out;
}

/** the device extras section's bytes (see the top of this file); `dev` is the device form (its module indices) */
export function extrasRecord(devs: Device[], source: Patch, dev: Patch = deviceView(source, true).patch): number[] {
  if (!devs.length) return [];
  const index = new Map(dev.modules.map((m, i) => [m.id, i]));
  const out = [devs.length];
  for (const d of devs) {
    const t = d.track === undefined ? -1 : devs.findIndex((x) => x.module === d.track);
    const a = d.asm === undefined ? undefined : assemblyById(source, d.asm);
    const sr = a ? structureAndRows(source, a) : undefined;
    const h = sr ? parseInt(sr.structure, 16) >>> 0 : 0;
    const name = deviceText(a?.preset ?? '');
    out.push(t < 0 ? 0xff : t, h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff, h >>> 24, name.length, ...Array.from(name, (c) => c.charCodeAt(0)));
    const rows = sr ? sr.rows : [];
    out.push(rows.length);
    for (const r of rows) {
      const i = index.get(r.module);
      const par = i === undefined ? -1 : rowParam(dev.modules[i].type, r.param);
      out.push(par < 0 ? 0xff : i!, par < 0 ? 0xff : par);
    }
    const members = (a ? allModules(source, a) : [d.module!]).map((id) => index.get(id)).filter((i): i is number => i !== undefined);
    out.push(members.length, ...members);
  }
  return out;
}

/** bytes of the binary patch (what the FM-1 must hold, M1_PATCH_MAX) */
export function encodedSize(source: Patch): number {
  const { patch: p, groups: dg } = deviceView(source, true);
  return sizeOf(p, dg, deviceSection(source, p), source) + buttonRecord(source, p).length;
}

function sizeOf(p: Patch, dg: DeviceGroup[], devs: Device[], source?: Patch): number {
  const groups = dg.length;
  const routes = routesOf(p);
  const ranges = rangeList(p).length;
  const v = formatOf(source ?? p, p);
  let size = 8 + GROUP_REC * groups + (groups ? p.modules.length : 0) + PANEL_BYTES;
  for (const m of p.modules) size += recordSize(m.type, v);
  size += 4 * p.cables.length;
  if (hasMorph(p)) {
    for (const m of p.modules) size += 4 * paramsAt(m.type, v).length;
    size += Math.ceil(p.modules.length / 8);
  }
  if (routes.length) size += 1 + routes.reduce((n, r) => n + 2 + r.bytes, 0);
  const tracks = noteTracks(p);
  if (tracks.length) size += 1 + tracks.reduce((n, i) => n + trackRecSize(p.modules[i].notes!.length), 0);
  size += patternRecord(source ?? p, p).length;
  if (ranges) size += 1 + 5 * ranges;
  const maps = drumMaps(p).length;
  if (maps) size += 1 + maps * (1 + DRUM_ROWS * TRACK_NAME_MAX);
  return size + devicesSize(devs, p, source);
}

/** the module indices of the Drum maps (their row names go into the binary, flag bit 7) */
export const drumMaps = (p: Patch): number[] => p.modules.flatMap((m, i) => (m.type === 'drummap' ? [i] : []));

/** the binary patch; throws when the patch does not fit the FM-1 (deviceBudget): only a patch that fits is ever sent */
/** the binary patch; refused when it is over the FM-1 budget, unless `anyway` (tools that count the engine's work on patches the
 * estimate has not seen yet: scripts/cpu-costs.ts) */
export function encodePatch(source: Patch, anyway = false): Uint8Array {
  const budget = deviceBudget(source);
  if (!budget.fits && !anyway) throw new Error(`over the FM-1 budget: ${budget.over.map((i) => (i.key === 'browser' ? i.label : `${i.label} ${i.used} of ${i.max}`)).join(', ')}`);
  const { patch: p, groups } = deviceView(source, true);
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const morph = hasMorph(p);
  const ranges = rangeList(p);
  const routes = routesOf(p);
  const valued = noteTracks(p);
  const devs = deviceSection(source, p);
  const kinds = buttonRecord(source, p);
  const pats = patternRecord(source, p);
  const size = sizeOf(p, groups, devs, source) + kinds.length;
  const ver = formatOf(source, p);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0xa1;
  out[1] = ver;
  out[2] = p.modules.length;
  out[3] = groups.length;
  dv.setUint16(4, p.cables.length, true);
  dv.setUint16(6, (morph ? FLAG_MORPH | FLAG_MORPH_MODULES : 0) | (ranges.length ? FLAG_RANGE : 0) | (routes.length ? FLAG_INPUT_MAP : 0) | (valued.length ? FLAG_NOTES : 0) | (devs.length ? FLAG_DEVICES | FLAG_EXTRAS : 0) | (kinds.length ? FLAG_BUTTONS : 0) | (drumMaps(p).length ? FLAG_NAMES : 0) | (pats.length ? FLAG_PATTERNS : 0), true);
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
    out[at++] = TYPE_ORDER.indexOf(m.type) | (m.bypass ? BYPASS_BIT : 0);
    for (const pd of paramsAt(m.type, ver)) {
      dv.setInt32(at, toQ16(m.params[pd.name] ?? pd.default), true);
      at += 4;
    }
    if (def.paramInputs) {
      for (const a of m.att ?? [1, 1]) {
        dv.setInt32(at, toQ16(a), true);
        at += 4;
      }
      for (const s of SOURCES) {
        let mask = 0;
        for (const name of m.map?.[s] ?? []) {
          const i = def.params.findIndex((q) => q.name === name);
          if (i >= 0) mask = (mask | (1 << i)) >>> 0;
        }
        if (maskBytes(m.type) === 4) dv.setUint32(at, mask, true);
        else dv.setUint16(at, mask, true);
        at += maskBytes(m.type);
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
    out[at++] = index.get(c.from.module)!;
    out[at++] = DEFS[from.type].outputs.findIndex((o) => o.name === c.from.port);
    out[at++] = index.get(c.to.module)!;
    out[at++] = DEFS[to.type].inputs.findIndex((i) => i.name === c.to.port);
  }
  if (morph)
    for (const m of p.modules)
      for (const pd of paramsAt(m.type, ver)) {
        dv.setInt32(at, toQ16(m.paramsB?.[pd.name] ?? m.params[pd.name] ?? pd.default), true);
        at += 4;
      }
  if (morph) {
    p.modules.forEach((m, i) => { if (m.paramsB) out[at + (i >> 3)] |= 1 << (i & 7); });
    at += Math.ceil(p.modules.length / 8);
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
  if (devs.length) {
    const rec = [...deviceRecord(devs, p), ...extrasRecord(devs, source, p)];
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
  if (ranges.length) {
    out[at++] = ranges.length;
    for (const r of ranges) out.set([r.mod, r.pin, r.par, r.lo, r.hi], (at += 5) - 5);
  }
  return out;
}

/** the FM-1's limits (firmware/src/engine.c, the one-voice build: ENG_MAX_MODULES, ENG_MAX_CABLES, POLY_MAX_GROUPS,
 * POLY_MAX_PARTS, ENG_MAX_INST, ENG_NBUF, ENG_PAR_WORDS, ENG_NDELAY, ENG_NREV, ENG_NSTRING, ENG_NCHORUS, ENG_NGRAIN, ENG_MAX_TRACKS, ENG_MAX_NOTES; proto.c M1_PATCH_MAX).
 */
export const DEVICE = {
  modules: MAX_MODULES, cables: MAX_CABLES, poly: MAX_POLY, parts: MAX_PARTS, instances: 128, buffers: 255, params: 1536,
  delays: 1, reverbs: 1, strings: 8, chorus: 1, grains: 1, arps: 2, tracks: 16, notes: 1536, bytes: 3840,
} as const;

export type BudgetKey = keyof typeof DEVICE;
/** one line of the budget: what the patch uses of one FM-1 limit (`cpu`: the estimated load in percent of 100; `browser`: a
 * browser-only ability the patch uses, `label` says which, used 1 of 0) */
export interface BudgetItem { key: BudgetKey | 'cpu' | 'browser'; label: string; used: number; max: number }

/** a budget line over its limit in words: "CPU 130 %", "Delay over 520 ms: browser only", "70 modules of 64" */
export const overText = (i: BudgetItem): string => (i.key === 'cpu' ? `CPU ${i.used} %` : i.key === 'browser' ? i.label : `${i.used} ${i.label} of ${i.max}`);

/**
 * The browser-only abilities a patch uses, one reason each ("Delay over 520 ms: browser only"); none: the FM-1 can play
 * everything in it. Today: a parameter past the FM-1's range into its browser-only stretch (ParamDef.browserMax), on either
 * morph side. A patch with any is over the FM-1 budget (deviceBudget), so it is never sent.
 */
export function browserOnly(p: Patch): string[] {
  const out = new Set<string>();
  for (const m of p.modules) {
    const def = DEFS[m.type];
    if (!def) continue;
    for (const pd of def.params) {
      if (pd.browserMax === undefined) continue;
      if ([m.params[pd.name], m.paramsB?.[pd.name]].some((v) => v !== undefined && v > pd.max)) out.add(`${def.label} over ${pd.max}${pd.unit ? ` ${pd.unit}` : ''}: browser only`);
    }
  }
  return [...out];
}

const LABELS: Record<BudgetKey, string> = {
  modules: 'modules', cables: 'cables', poly: 'poly assemblies', parts: 'parts', instances: 'module instances', buffers: 'signal buffers', params: 'parameter values',
  delays: 'delays', reverbs: 'reverbs', strings: 'string / comb lines', chorus: 'choruses', grains: 'granular lines', arps: 'arpeggiators', tracks: 'step tracks', notes: 'step notes', bytes: 'patch bytes',
};

/**
 * What a patch costs on the FM-1, counted the way eng_load allocates: one instance per copy of a module (a module in a
 * poly assembly has one per part); one signal buffer per connected output port and copy, plus one per input copy with
 * two or more sources (a module outside a poly assembly reading a per-part output has one source per part); per module its
 * type's parameters (twice that when the patch has a morph B side) and per copy their effective values; the shared
 * lines (delay, reverb, chorus, granular) once each, a string or comb line per copy. `items` lists every limit, `over`
 * those the patch exceeds, `memory` the fullest one as a fraction (single lines count only when exceeded) and `fullest` that
 * line; `cpu` the estimated processor load (cpu.ts); `use` the larger of the two. `fits` is false when the firmware would
 * refuse the patch or, by the estimate, could not render it in time, or when the patch uses a browser-only ability
 * (browserOnly: a `browser` line in `over`).
 * The editor and the browser engine have none of these limits.
 */
export interface Budget {
  buffers: number;
  instances: number;
  fits: boolean;
  items: BudgetItem[];
  over: BudgetItem[];
  memory: number;
  fullest: BudgetItem | undefined;
  cpu: CpuEstimate;
  use: number;
}

export function deviceBudget(source: Patch): Budget {
  const { patch: p, groups } = deviceView(source, true);
  const copies = new Map<number, number>();
  const groupOf = new Map<number, number>();
  groups.forEach((g, i) => g.modules.forEach((id) => (groupOf.set(id, i), copies.set(id, g.cfg.parts))));
  const ninst = (id: number): number => copies.get(id) ?? 1;
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
  const count = (...types: string[]): number => p.modules.filter((m) => types.includes(m.type)).reduce((n, m) => n + ninst(m.id), 0);
  const used: Record<BudgetKey, number> = {
    modules: p.modules.length, cables: p.cables.length, poly: groups.length, parts: Math.max(1, ...[...copies.values()]),
    instances, buffers, params, delays: count('delay'), reverbs: count('reverb'), strings: count('string', 'comb'), chorus: count('chorus'),
    grains: count('grain'), arps: count('arp'), tracks: count('steps'), notes: p.modules.reduce((n, m) => n + (m.type === 'steps' ? (m.notes?.length ?? 0) + (m.patterns ?? []).reduce((k, x) => k + (x?.notes?.length ?? 0), 0) : 0), 0), bytes: sizeOf(p, groups, deviceSection(source, p), source) + buttonRecord(source, p).length,
  };
  const items = (Object.keys(DEVICE) as BudgetKey[]).map((key) => ({ key, label: LABELS[key], used: used[key], max: DEVICE[key] }));
  const over: BudgetItem[] = items.filter((i) => i.used > i.max);
  // a one- or two-of-a-kind slot (one delay, one reverb, two arpeggiators ...) is either there or not: it shows only when
  // exceeded, so a patch with its one reverb or one of its two arpeggiators does not read as half full or full
  const counted = items.filter((i) => i.max > 2 || i.used > i.max);
  const fullest = counted.reduce<BudgetItem | undefined>((a, i) => (!a || i.used / i.max > a.used / a.max ? i : a), undefined);
  const memory = fullest ? fullest.used / fullest.max : 0;
  const cpu = cpuEstimate(source);
  if (cpu.use > 1) over.push({ key: 'cpu', label: 'CPU (estimate)', used: Math.round(cpu.use * 100), max: 100 });
  for (const label of browserOnly(source)) over.push({ key: 'browser', label, used: 1, max: 0 });
  return { buffers, instances, fits: !over.length, items, over, memory, fullest, cpu, use: Math.max(memory, cpu.use) };
}

