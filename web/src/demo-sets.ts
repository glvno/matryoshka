// SPDX-License-Identifier: GPL-3.0-only
// The demo sets (#1179): the patterns and songs five factory patches shipped with up to 1.24.1, which they now ship
// without, loaded back in one step (the FM-1's SEQ page: SEQ held + SEL, then SEL again; the editor's Steps card: demo
// set). A demo set replaces the patch's patterns and songs: it is clear all (pattern-ops.ts), then the set. It is found by
// the patch's module layout (pattern-store.ts layoutOf: the module count and types in order), so a renamed or saved copy
// of the patch and one sent from the editor find it too, and one whose modules changed does not.
//
// The factory region carries every demo set (factory-region.ts, firmware/src/factory.c fc_demo): export-defs.ts writes
// them from the patches as factory-bank.ts builds them in full (bank.json). A record: u32 layout, name[20], u16 cost (the
// bytes a patch's notes, patterns and songs, P-locks, links and pattern origins sections take with the set: the FM-1
// checks the patch has room before it loads one), u32 hash (FNV-1a of the body), u16 the body's length, then the body:
// u8 items, each u8 pattern, u8 kind (0: u16 length and a stored pattern's payload, pattern-store.ts; 1: u16 the id of
// the factory entry it links), u8 origins, each u8 track and u32 its pattern 1's origin (D-882), u8 songs, each u8
// entries and per entry u8 pattern, i8 shift.
import type { Patch } from './patch';
import { layout as binLayout, SLIM } from './patchbin';
import { clearAllPatterns } from './pattern-ops';
import { encodePayload, fnv, FNV0, layoutOf } from './pattern-store';
import { deviceView } from './poly';
import { fixSeq, type Pattern, type PatternLink, type SongEntry, type StepLock, type StepNote } from './track';

/** the factory patches that ship without patterns and songs, their demo set a step away (owner 2026-11-21) */
export const DEMO_SET_PATCHES: readonly string[] = ['808 Kit', '909 Kit', 'Verona Drum 1', 'Scrounge', 'Silver Box'];

/** one Steps track's part of a demo set (by the patch's Steps track order) */
export interface DemoTrack { notes?: StepNote[]; patterns?: (Pattern | null)[]; locks?: StepLock[]; factoryPatterns?: { version: 1; ids: (string | null)[] } }
export interface DemoSet {
  /** the factory patch it comes from, and its module layout (the key) */
  name: string;
  layout: number;
  tracks: DemoTrack[];
  songs?: SongEntry[][];
  links?: Record<number, PatternLink>;
}

const tracks = (p: Patch) => p.modules.filter((m) => m.type === 'steps');
const mainOf = (p: Patch) => p.modules.find((m) => m.type === 'fm1');

/** the module layout a demo set is found by */
export const demoLayout = (p: Patch): number => layoutOf(deviceView(p, true).patch);

/** factory patch `full`'s patterns and songs as its demo set */
export function demoSetOf(full: Patch): DemoSet {
  const seq = mainOf(full)?.seq;
  return structuredClone({
    name: full.name,
    layout: demoLayout(full),
    tracks: tracks(full).map((m): DemoTrack => ({
      ...(m.notes ? { notes: m.notes } : {}), ...(m.patterns ? { patterns: m.patterns } : {}), ...(m.locks ? { locks: m.locks } : {}),
      ...(m.factoryPatterns ? { factoryPatterns: m.factoryPatterns } : {}),
    })),
    ...(seq?.songs ? { songs: seq.songs } : {}),
    ...(seq?.links ? { links: seq.links } : {}),
  });
}

/** `full` without its patterns and songs: the patch as it ships */
export function withoutDemoSet(full: Patch): Patch {
  const p = structuredClone(full);
  clearAllPatterns(p);
  return p;
}

/** demo set `set` loaded into `patch` (in place): every pattern and song cleared, then the set's, track by track as far as
 *  both have tracks; pattern 1 selected, no song playing */
export function applyDemoSet(patch: Patch, set: DemoSet): void {
  clearAllPatterns(patch);
  tracks(patch).forEach((m, i) => {
    const t = set.tracks[i];
    if (!t) return;
    if (t.notes) m.notes = structuredClone(t.notes);
    if (t.patterns) m.patterns = structuredClone(t.patterns);
    if (t.locks) m.locks = structuredClone(t.locks);
    if (t.factoryPatterns) m.factoryPatterns = structuredClone(t.factoryPatterns);
  });
  const main = mainOf(patch);
  if (!main) return;
  const v = fixSeq({ ...(main.seq ?? {}), ...(set.songs ? { songs: structuredClone(set.songs) } : {}), ...(set.links ? { links: structuredClone(set.links) } : {}) });
  if (v) main.seq = v;
  else delete main.seq;
}

/** the patch (a factory patch in full, or any patch with its demo set loaded) with the set's patterns as the region holds
 *  them: its record (see the top of this file) */
export function demoSetRecord(full: Patch): Uint8Array {
  const dev = deviceView(full, true).patch, links = mainOf(full)?.seq?.links ?? {};
  const used = new Set<number>([0]);
  for (const m of tracks(full)) m.patterns?.forEach((x, i) => { if (x) used.add(i + 1); });
  const body: number[] = [];
  const u16 = (v: number): void => { body.push(v & 0xff, (v >> 8) & 0xff); };
  const items = [...used].sort((a, b) => a - b);
  body.push(items.length);
  for (const p of items) {
    body.push(p);
    if (links[p]) {
      body.push(1);
      u16(links[p].id);
      continue;
    }
    const payload = encodePayload(full, p, dev);
    body.push(0);
    u16(payload.length);
    body.push(...payload);
  }
  const origins = tracks(full).flatMap((m, t) => {
    const ids = m.factoryPatterns?.ids ?? [];
    if (ids.some((id, p) => p > 0 && id)) throw new Error(`${full.name}: a demo set keeps pattern 1's origins only`);
    return ids[0] ? [[t, parseInt(ids[0], 16) >>> 0]] : [];
  });
  body.push(origins.length);
  for (const [t, id] of origins) body.push(t, id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff);
  const songs = mainOf(full)?.seq?.songs ?? [];
  body.push(songs.length);
  for (const s of songs) {
    body.push(s.length);
    for (const e of s) body.push(e.pat, e.shift & 0xff);
  }
  const cost = binLayout(full, undefined, SLIM).size - binLayout(withoutDemoSet(full), undefined, SLIM).size;
  const name = full.name.toUpperCase().slice(0, 20);
  const out: number[] = [];
  const w32 = (v: number): void => { out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
  w32(demoLayout(full));
  for (let k = 0; k < 20; k++) out.push(k < name.length ? name.charCodeAt(k) : 0);
  out.push(cost & 0xff, (cost >> 8) & 0xff);
  w32(fnv(FNV0, body));
  out.push(body.length & 0xff, (body.length >> 8) & 0xff, ...body);
  return Uint8Array.from(out);
}

/** a record's hash (what PATTERN_OP's op 3 names) */
export const demoSetHash = (record: Uint8Array): number => (record[26] | (record[27] << 8) | (record[28] << 16) | (record[29] << 24)) >>> 0;

/** the region's demo sets section: the count, then the records */
export const demoSetsSection = (records: readonly Uint8Array[]): Uint8Array => Uint8Array.from([records.length, ...records.flatMap((r) => [...r])]);
