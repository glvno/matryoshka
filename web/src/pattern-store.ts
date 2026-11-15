// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's pattern store (#901, option D): patterns kept in their own flash store, loadable into any patch whose tracks
// they fit. One stored pattern is one pattern number across a patch's Steps tracks, written as a payload that the firmware
// (patlink.c) writes byte for byte the same (firmware/test/pattern_cases.h, scripts/pattern-vectors.ts, checks it):
//
//   u8  PAYLOAD_VERSION
//   u32 LE layout     0 when the pattern has no P-locks, else the patch's layout fingerprint (layoutOf)
//   u8  T             tracks written: 1 + the last track that has this pattern (at least 1)
//   per track k < T (track k: the k-th Steps module of the binary's module order):
//       u8 n          0xFF: the track has no such pattern (it plays its pattern 1); else n notes 0..128
//       if n != 0xFF: u8 len (bits 0..6: 0 the track's length, else 1..64; bit 7: short words), u8 rate (0xFF the
//                     track's, else a STEPS_RATES index), n words: u16 LE short ones when every note is short
//                     (track.ts isShortNote, shortWord), else u32 LE (noteWord), in the order the engine keeps them
//   u8  L             tracks with locks
//   per locked track, ascending k: u8 k, u8 c (1..64), c x (u8 step, u8 module index, u8 parameter index, i32 LE value
//                     Q16.16): the row's own parameter, in engine.c eng_locks_list order
//
// Pattern 1 (index 0) has no own length or rate: it is written with len 0 and rate 0xFF, and every track has it. A payload
// loaded into pattern index p (applyPayload) gives each track of the patch what the payload holds for it, and drops
// pattern p from the others; its locks apply only in the layout they were written for.
import { DEFS } from './modules';
import type { Patch } from './patch';
import { deviceView } from './poly';
import { lockPlan } from './locks';
import { TYPE_ORDER, toQ16 } from './patchbin';
import type { StoredPatternEntry } from './protocol';
import { PRESET_PATTERNS, type PresetPattern } from './preset-pattern-data';
import { fixLocks, fixNotes, fixPatterns, isShortNote, noteWord, shortWord, wordNote, wordShort, type Pattern, type StepLock, type StepNote } from './track';
import FACTORY_STORE from './factory-store.json';

export const PAYLOAD_VERSION = 1;
/** the most payload bytes a stored pattern takes (patstore.c PT_MAX) */
export const PAYLOAD_MAX = 2048;
/** a stored pattern's name: printable ASCII, 16 bytes (patstore.c PT_NAME) */
export const PATTERN_NAME_BYTES = 16;
/** the factory demonstration patterns' ids: FACTORY_ID + their index (the read-only ids from track.ts READ_ONLY_ID start
 * with the factory patches' patterns, factory-store.json) */
export const FACTORY_ID = 0xff00;
/** bytes a stored pattern takes in the store besides its payload (patstore.c pt_hdr_t), and its records' alignment */
export const RECORD_HEADER = 36;
export const recordBytes = (len: number): number => RECORD_HEADER + ((len + 3) & ~3);

/** FNV-1a, 32 bits (patstore.c pt_fnv): h ^= byte, h *= 0x01000193 */
export const FNV0 = 0x811c9dc5;
export function fnv(h: number, bytes: ArrayLike<number>): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return h >>> 0;
}

/** a patch's layout fingerprint (`dev`: its device form): FNV over the module count and each module's type index, in the
 * binary's module order; never 0 (0 means a payload without locks) */
export function layoutOf(dev: Patch): number {
  const h = fnv(FNV0, [dev.modules.length & 0xff, ...dev.modules.map((m) => TYPE_ORDER.indexOf(m.type) & 0x7f)]);
  return h || 1;
}

/** pattern p (0-based) of a patch as a stored pattern's payload (`dev`: its device form) */
export function encodePayload(source: Patch, p: number, dev: Patch = deviceView(source, true).patch): Uint8Array {
  const tracks = dev.modules.filter((m) => m.type === 'steps');   // (the payload's tracks, in the binary's order)
  const pattern = (k: number): Pattern | null => (p === 0 ? { notes: tracks[k].notes } : tracks[k].patterns?.[p - 1] ?? null);
  let t = 1;
  tracks.forEach((_, k) => { if (pattern(k)) t = k + 1; });
  const locks: number[][] = [];
  for (const lt of lockPlan(source, dev)) {
    const list = lt.pats.find((x) => x.p === p)?.locks;
    if (!list?.length) continue;
    const k = tracks.indexOf(dev.modules[lt.track]);
    locks.push([k, list.length, ...list.flatMap((l) => {
      const [mod, par] = lt.rows[l.row][0], v = toQ16(l.value);
      return [l.at, mod, par, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    })]);
  }
  locks.sort((a, b) => a[0] - b[0]);
  const layout = locks.length ? layoutOf(dev) : 0;
  const out = [PAYLOAD_VERSION, layout & 0xff, (layout >>> 8) & 0xff, (layout >>> 16) & 0xff, layout >>> 24, t];
  for (let k = 0; k < t; k++) {
    const x = k < tracks.length ? pattern(k) : null;
    if (!x) {
      out.push(0xff);
      continue;
    }
    const notes = x.notes ?? [];
    const short = notes.every(isShortNote);
    out.push(notes.length, (p ? x.len ?? 0 : 0) | (short ? 0x80 : 0), p ? x.rate ?? 0xff : 0xff);
    for (const n of notes) {
      const w = short ? shortWord(n) : noteWord(n);
      out.push(w & 0xff, (w >>> 8) & 0xff);
      if (!short) out.push((w >>> 16) & 0xff, w >>> 24);
    }
  }
  out.push(locks.length);
  for (const l of locks) out.push(...l);
  return Uint8Array.from(out);
}

/** pattern p's payload hash (patstore.c's record hash): what a link compares to see whether the pattern is still the
 * stored one */
export const payloadHash = (source: Patch, p: number, dev?: Patch): number => fnv(FNV0, encodePayload(source, p, dev));

/** a payload read back: its layout, per track its notes, own length (0: the track's) and rate (0xFF: the track's) or
 * null where the track has no such pattern, and per locked track its locks (device-form module and parameter indices) */
export interface Payload {
  layout: number;
  tracks: ({ notes: StepNote[]; len: number; rate: number } | null)[];
  locks: { track: number; locks: { at: number; module: number; param: number; value: number }[] }[];
}

/** a payload's contents; throws when it is not one */
export function decodePayload(bytes: ArrayLike<number>): Payload {
  let at = 0;
  const bad = (): never => { throw new Error('not a stored pattern'); };
  const u8 = (): number => (at < bytes.length ? bytes[at++] : bad());
  const u16 = (): number => u8() | (u8() << 8);
  const u32 = (): number => (u16() | (u16() << 16)) >>> 0;
  if (bytes.length > PAYLOAD_MAX || u8() !== PAYLOAD_VERSION) bad();
  const layout = u32();
  const t = u8();
  if (!t) bad();
  const tracks: Payload['tracks'] = [];
  for (let k = 0; k < t; k++) {
    const n = u8();
    if (n === 0xff) {
      tracks.push(null);
      continue;
    }
    if (n > 128) bad();
    const len = u8(), rate = u8(), short = !!(len & 0x80);
    const notes = Array.from({ length: n }, () => (short ? wordShort(u16()) : wordNote(u32())));
    tracks.push({ notes, len: len & 0x7f, rate });
  }
  const locks: Payload['locks'] = [];
  for (let l = u8(); l > 0; l--) {
    const track = u8(), c = u8();
    if (track >= t || !c || c > 64) bad();
    locks.push({ track, locks: Array.from({ length: c }, () => {
      const lock = { at: u8(), module: u8(), param: u8(), value: 0 };
      lock.value = (u32() | 0) / 65536;
      return lock;
    }) });
  }
  if (at !== bytes.length || (layout === 0) !== !locks.length) bad();
  return { layout, tracks, locks };
}

/** what loading a payload did with its locks: it had none, they apply, or they were left out (another layout) */
export type LocksLoaded = 'none' | 'applied' | 'dropped';

/**
 * A payload loaded into pattern index p (0-based) of `patch` (changed in place): each Steps track of the patch takes what
 * the payload holds for it (pattern 1 takes only the notes); a track the payload has nothing for loses pattern p (pattern
 * 1: its notes). Pattern p's locks are replaced by the payload's when the layouts match, else removed.
 */
export function applyPayload(patch: Patch, p: number, bytes: ArrayLike<number>): LocksLoaded {
  const pl = decodePayload(bytes);
  const dev = deviceView(patch, true).patch;
  const locked = pl.layout !== 0 && pl.layout === layoutOf(dev);
  dev.modules.filter((m) => m.type === 'steps').forEach((d, k) => {
    const m = patch.modules.find((x) => x.id === d.id);
    if (!m) return;
    const x = pl.tracks[k] ?? null;
    const raw = pl.locks.find((l) => l.track === k)?.locks ?? [];
    const locks = fixLocks(locked ? raw.flatMap((l): StepLock[] => {
      const target = dev.modules[l.module], pd = target ? DEFS[target.type]?.params[l.param] : undefined;
      return target && pd ? [{ at: l.at, module: target.id, param: pd.name, value: l.value }] : [];
    }) : []);
    if (p === 0) {
      const notes = fixNotes(x?.notes);
      if (notes) m.notes = notes;
      else delete m.notes;
      if (locks && x) m.locks = locks;
      else delete m.locks;
      return;
    }
    const pats: (Pattern | null)[] = [...(m.patterns ?? [])];
    while (pats.length < p) pats.push(null);
    let next: Pattern | null = null;
    if (x) {
      next = {};
      const notes = fixNotes(x.notes);
      if (notes) next.notes = notes;
      if (x.len) next.len = x.len;
      if (x.rate !== 0xff) next.rate = x.rate;
      if (locks) next.locks = locks;
    }
    pats[p - 1] = next;
    const fixed = fixPatterns(pats);
    if (fixed) m.patterns = fixed;
    else delete m.patterns;
  });
  return !pl.locks.length ? 'none' : locked ? 'applied' : 'dropped';
}

/** a stored pattern's name as the FM-1 keeps it: printable ASCII in capitals, PATTERN_NAME_BYTES at most */
export const storedName = (s: string): string => s.toUpperCase().replace(/[^\x20-\x7e]/g, '').slice(0, PATTERN_NAME_BYTES).trim();
/** the name a new stored pattern gets from its patch and pattern number, as the FM-1's SEQ page names one ("SCROUNGE P3") */
export function autoName(patchName: string, p: number): string {
  const tail = ` P${p + 1}`;
  return storedName(`${storedName(patchName).slice(0, PATTERN_NAME_BYTES - tail.length).trim()}${tail}`);
}

/** a factory demonstration pattern (PRESET_PATTERNS, D-882 / D-1009) as a payload: one track, its notes, length and rate */
export function factoryPayload(e: PresetPattern): Uint8Array {
  const notes = e.notes.map(wordNote);
  const short = notes.every(isShortNote);
  const out = [PAYLOAD_VERSION, 0, 0, 0, 0, 1, notes.length, (e.len & 0x7f) | (short ? 0x80 : 0), e.rate];
  for (const n of notes) {
    const w = short ? shortWord(n) : noteWord(n);
    out.push(w & 0xff, (w >>> 8) & 0xff);
    if (!short) out.push((w >>> 16) & 0xff, w >>> 24);
  }
  out.push(0);
  return Uint8Array.from(out);
}

/** the store's read-only factory entries as the FM-1 lists them after the user's (C_PATS), in id order, with their
 * payloads: the factory patches' patterns (`kit`: the patch that links them), then the demonstration patterns (`structure`:
 * the engine whose sound they belong to). The editor has them without an FM-1 */
export function factoryEntries(): (StoredPatternEntry & { payload: Uint8Array; kit?: string; structure?: string })[] {
  const entry = (id: number, name: string, payload: Uint8Array): StoredPatternEntry & { payload: Uint8Array } =>
    ({ id, len: payload.length, hash: fnv(FNV0, payload), layout: (payload[1] | payload[2] << 8 | payload[3] << 16 | payload[4] << 24) >>> 0, tracks: payload[5], readOnly: true, name, payload });
  return [
    ...FACTORY_STORE.map((e) => ({ ...entry(e.id, e.name, fromHex(e.payload)), kit: e.kit })),
    ...PRESET_PATTERNS.map((e, i) => ({ ...entry(FACTORY_ID + i, storedName(e.name), factoryPayload(e)), structure: e.structure })),
  ];
}

/** bytes as hexadecimal text, two digits each (pattern files, factory-store.json), and back */
export const hexBytes = (bytes: ArrayLike<number>): string => Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/** a stored pattern as a file (Download): its name and payload */
export const PATTERN_FILE_FORMAT = 'matryoshka-pattern';
export const PATTERN_FILE_VERSION = 1;
export const patternFile = (name: string, payload: ArrayLike<number>): string =>
  JSON.stringify({ format: PATTERN_FILE_FORMAT, version: PATTERN_FILE_VERSION, name: storedName(name), payload: hexBytes(payload) }, null, 1);
/** a pattern file read back (Upload): its name and payload; throws when it is not one */
export function readPatternFile(text: string): { name: string; payload: Uint8Array } {
  const o = JSON.parse(text) as Record<string, unknown>;
  if (o?.format !== PATTERN_FILE_FORMAT || o.version !== PATTERN_FILE_VERSION || typeof o.payload !== 'string' || !/^([0-9a-f]{2})+$/i.test(o.payload))
    throw new Error('not a Matryoshka pattern file');
  const payload = fromHex(o.payload);
  decodePayload(payload);
  return { name: storedName(typeof o.name === 'string' ? o.name : '') || 'PATTERN', payload };
}
