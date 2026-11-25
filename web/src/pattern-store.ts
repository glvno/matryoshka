// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's pattern store (#901, option D): patterns kept in their own flash store, loadable into any patch whose tracks
// they fit. One stored pattern is one pattern number across a patch's Steps tracks, written as a payload that the firmware
// (patlink.c) writes byte for byte the same (firmware/test/pattern_cases.h, scripts/pattern-vectors.ts, checks it):
//
//   u8  version       PAYLOAD_VERSION; PAYLOAD_WIDE when a track's n passes TRACK_NOTES_1_26 (#1292: firmware before 1.27
//                     refuses it, which is all it can do with one)
//   u32 LE layout     0 when the pattern has no P-locks, else the patch's layout fingerprint (layoutOf)
//   u8  T             tracks written: 1 + the last track that has this pattern (at least 1)
//   per track k < T (track k: the k-th Steps module of the binary's module order):
//       n             0xFF: the track has no such pattern (it plays its pattern 1); else n words 0..128 (version 2:
//                     0..TRACK_NOTES_MAX, track.ts countBytes)
//       if n != 0xFF: u8 len (bits 0..6: 0 the track's length, else 1..64; bit 7: short words), u8 rate (0xFF the
//                     track's, else a STEPS_RATES index), n words: u16 LE short ones when every note is short
//                     (track.ts isShortNote, shortWord), else u32 LE (noteWords: a note with a trig condition, #674, and
//                     its condition word), in the order the engine keeps them
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
import { patternOneHasContent, patternsWithContent, TYPE_ORDER, toQ16 } from './patchbin';
import type { StoredPatternEntry } from './protocol';
import { COUNT_ESC, countBytes, fixLocks, fixNotes, fixPatterns, LINK_ID_MAX, patternWords, TRACK_NOTES_1_26, TRACK_NOTES_MAX, withoutLinks, wordShort, wordsNotes, type Pattern, type PatternLink, type StepLock, type StepNote } from './track';
import LEGACY_FACTORY_PATTERNS from './factory-store.json';

export const PAYLOAD_VERSION = 1;
/** the version of a payload with a track of more than TRACK_NOTES_1_26 words (#1292), written only then */
export const PAYLOAD_WIDE = 2;
/** the most payload bytes a stored pattern takes (patstore.c PT_MAX) */
export const PAYLOAD_MAX = 2048;
/** a stored pattern's name: printable ASCII, 16 bytes (patstore.c PT_NAME) */
export const PATTERN_NAME_BYTES = 16;
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
  const wide = tracks.some((_, k) => patternWords(pattern(k)?.notes).words.length > TRACK_NOTES_1_26);
  const out = [wide ? PAYLOAD_WIDE : PAYLOAD_VERSION, layout & 0xff, (layout >>> 8) & 0xff, (layout >>> 16) & 0xff, layout >>> 24, t];
  for (let k = 0; k < t; k++) {
    const x = k < tracks.length ? pattern(k) : null;
    if (!x) {
      out.push(0xff);
      continue;
    }
    const { short, words } = patternWords(x.notes);
    out.push(...countBytes(words.length), (p ? x.len ?? 0 : 0) | (short ? 0x80 : 0), p ? x.rate ?? 0xff : 0xff);
    for (const w of words) {
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
  const version = bytes.length <= PAYLOAD_MAX ? u8() : bad();
  if (version !== PAYLOAD_VERSION && version !== PAYLOAD_WIDE) bad();
  const layout = u32();
  const t = u8();
  if (!t) bad();
  const tracks: Payload['tracks'] = [];
  for (let k = 0; k < t; k++) {
    let n = u8();
    if (n === 0xff) {
      tracks.push(null);
      continue;
    }
    if (n === COUNT_ESC && version === PAYLOAD_WIDE) n += u8();
    if (n > (version === PAYLOAD_WIDE ? TRACK_NOTES_MAX : TRACK_NOTES_1_26)) bad();
    const len = u8(), rate = u8(), short = !!(len & 0x80);
    const notes = short ? Array.from({ length: n }, () => wordShort(u16())) : wordsNotes(Array.from({ length: n }, u32));
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
/** the name of an entry the editor makes when it sends a patch to an FM-1 that stores every pattern (#1202): the patch's
 *  name, its first 12 characters, and the pattern number in two digits ("909 KIT P03") */
export const entryName = (patchName: string, p: number): string =>
  storedName(`${storedName(patchName).slice(0, PATTERN_NAME_BYTES - 4).trim()} P${String(p + 1).padStart(2, '0')}`);

/** the patch's links to the legacy factory patterns (factory-store.json: frozen data, the 808 Kit's and 909 Kit's patterns
 *  that were read-only entries of the FM-1's store up to 1.25, ids from track.ts READ_ONLY_ID) whose payload is the one the
 *  link was made for */
function factoryLinks(p: Patch): { k: number; payload: Uint8Array }[] {
  const links = p.modules.find((m) => m.type === 'fm1')?.seq?.links ?? {};
  return Object.entries(links).flatMap(([k, l]) => {
    const e = LEGACY_FACTORY_PATTERNS.find((x) => x.id === l.id);
    const payload = e && fromHex(e.payload);
    return payload && fnv(FNV0, payload) === l.hash ? [{ k: Number(k), payload }] : [];
  });
}
/** the legacy factory patterns as a link store (id → payload hash): what firmware that holds them compiled in resolves
 *  (the FM-1 tab's emulator: a patch that still links one plays it from there, as on the FM-1) */
export const legacyFactoryStore = (): Map<number, number> => new Map(LEGACY_FACTORY_PATTERNS.map((e) => [e.id, fnv(FNV0, fromHex(e.payload))]));
/** the patch as it leaves the editor (G2, #1202: the editor's copy, patch files, share links, Community): every pattern
 *  inside it and no link, so whoever opens it has every pattern without this FM-1's store. A pattern held only as a link
 *  to a legacy factory pattern gets its payload (factory-store.json); a linked pattern keeps the content the patch holds.
 *  The patch itself when it links nothing */
export function portablePatch(p: Patch): Patch {
  if (!p.modules.some((m) => m.seq?.links)) return p;
  return withoutLinks(withFactoryPatterns(structuredClone(p)));
}
/** the patterns a patch links to legacy factory patterns but does not hold (a share link or a browser copy made before
 *  1.26 left them out, #923), back from factory-store.json (changed in place) */
export function withFactoryPatterns(p: Patch): Patch {
  const steps = p.modules.filter((m) => m.type === 'steps');
  for (const x of factoryLinks(p)) if (!steps.some((m) => m.patterns?.[x.k - 1])) applyPayload(p, x.k, x.payload);
  return p;
}

/** one entry a send makes (storePlan): the patterns (0-based) it holds, its name, payload and payload hash */
export interface EntryToPut { ps: number[]; name: string; payload: Uint8Array; hash: number }
/**
 * What sending `patch` to an FM-1 that stores every pattern 2..64 takes (#1202): each pattern with content links an entry
 * of `entries` (the FM-1's list) whose payload has the same hash and length (the one the patch links already first, then
 * the lowest id; never an id above LINK_ID_MAX), else a new entry named after `name` (entryName), one for patterns with
 * the same payload. With `one` (an FM-1 that reads format 67, and a patch that cannot hold its pattern 1: patchbin.ts
 * patternOneSpills, #1292) pattern 1 too, when it has notes or P-locks. `links`: the patterns already stored, by pattern
 */
export function storePlan(patch: Patch, entries: readonly StoredPatternEntry[], name = patch.name, one = false): { links: Record<number, PatternLink>; put: EntryToPut[] } {
  const dev = deviceView(patch, true).patch;
  const had = patch.modules.find((m) => m.type === 'fm1')?.seq?.links ?? {};
  const links: Record<number, PatternLink> = {};
  const put: EntryToPut[] = [];
  for (const p of [...(one && patternOneHasContent(dev) ? [0] : []), ...patternsWithContent(dev)]) {
    const payload = encodePayload(patch, p, dev), hash = fnv(FNV0, payload);
    const same = (e: StoredPatternEntry): boolean => e.hash === hash && e.len === payload.length && e.id <= LINK_ID_MAX;
    const e = entries.find((x) => x.id === had[p]?.id && same(x)) ?? entries.filter(same).sort((a, b) => a.id - b.id)[0];
    if (e) links[p] = { id: e.id, hash };
    else {
      const twin = put.find((x) => x.hash === hash && x.payload.length === payload.length);
      if (twin) twin.ps.push(p);
      else put.push({ ps: [p], name: entryName(name, p), payload, hash });
    }
  }
  return { links, put };
}
/** the patch with exactly these links (patterns 1..63, and 0: pattern 1, #1292): what a send to an FM-1 that stores every
 *  pattern encodes */
export function withLinks(patch: Patch, links: Record<number, PatternLink>): Patch {
  const out = withoutLinks(patch);
  if (!Object.keys(links).length) return out;
  return { ...out, modules: out.modules.map((m) => (m.type === 'fm1' ? { ...m, seq: { ...(m.seq ?? {}), links } } : m)) };
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
