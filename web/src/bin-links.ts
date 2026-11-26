// SPDX-License-Identifier: GPL-3.0-only
// Where a patch binary's stored pattern links section lies (format 59 and later, patchbin.ts linkRecord: u8 count, then per
// link u8 pattern index, u16 LE store id), read the way the firmware reads it (firmware/src/engine.c eng_section_at,
// eng_links_at and the walkers they take: the panel, the counted module records, the cables, format 51's morph B set, the
// fixed links and routes, then the notes, the patterns and songs, the P-locks). Only counted binaries (COUNTED and later)
// are walked: every binary with links is one. The Flash tab's restore of a bank backup puts a 1.26 slot's linked patterns
// back with new ids and rewrites its links to them (#1202 G8).
import { DEFS } from './modules';
import { PANEL_LABEL_KEYS, PANEL_LABEL_MAX } from './patch';
import { COUNTED, FLAG_LINKS, FORMAT_1_27, GROUP_REC, PANEL_BYTES, paramsAt, PRES_ATT1, PRES_ATT2, PRES_P1, PRES_P2, REC_STEREO, REC_TEMPLATE, SLIM, TYPE_ORDER } from './patchbin';
import { COUNT_ESC } from './track';

const REC_COUNT = 0x3f, PRES_ALL = 15;
/** header byte 6's bits and byte 7's (engine.h): morph B set, fixed links, routes, notes; cables 3, morph modules,
 *  patterns, P-locks, links */
const F6_MORPH = 1, F6_FIXED = 4, F6_ROUTES = 8, F6_NOTES = 16;
const F7_MORPH_MODULES = 2, F7_PATTERNS = 4, F7_LOCKS = 8, F7_CABLES3 = 16, F7_LINKS = FLAG_LINKS >> 8;

const typeOf = (p: Uint8Array, at: number): string | undefined => TYPE_ORDER[p[at] & 0x7f];
const npar = (type: string, v: number): number => paramsAt(type, v).length;
const maskBytes = (type: string, v: number): number => (npar(type, v) > 16 ? 4 : 2);

/** the panel section's bytes from `at` (engine.c eng_panel_bytes), 0 when cut short */
function panelBytes(p: Uint8Array, at: number): number {
  if (p[1] < SLIM) return at + PANEL_BYTES <= p.length ? PANEL_BYTES : 0;
  let n = 5;
  if (at + n > p.length || p[at + 4] >> PANEL_LABEL_KEYS.length) return 0;
  for (let i = 0; i < PANEL_LABEL_KEYS.length; i++) {
    if (!(p[at + 4] >> i & 1)) continue;
    if (at + n >= p.length || !p[at + n] || p[at + n] > PANEL_LABEL_MAX) return 0;
    n += 1 + p[at + n];
  }
  return at + n <= p.length ? n : 0;
}
/** where the module records start (engine.h eng_records_at), 0 when cut short */
function recordsAt(p: Uint8Array): number {
  const at = 8 + GROUP_REC * p[3] + (p[3] ? p[2] : 0), n = panelBytes(p, at);
  return n ? at + n : 0;
}
/** the counted record at `at` is whole enough to size (engine.c eng_rec_ok) */
function recOk(p: Uint8Array, at: number): boolean {
  const type = typeOf(p, at);
  if (!type || at + 1 >= p.length) return false;
  const c = p[at + 1], inputs = !!DEFS[type].paramInputs;
  // (bit 6, REC_STEREO: format 67 on an eligible type, #1141; engine.c eng_rec_ok)
  if ((c & REC_COUNT) > npar(type, p[1]) || (c & REC_STEREO && (p[1] < FORMAT_1_27 || !DEFS[type].stereo)) || (c & REC_TEMPLATE && !inputs)) return false;
  if (!inputs || c & REC_TEMPLATE) return true;
  const b = at + 2 + 4 * (c & REC_COUNT);
  return b < p.length && !(p[b] & ~PRES_ALL);
}
/** the counted record's size, its type byte included (engine.c eng_rec_size) */
function recSize(p: Uint8Array, at: number): number {
  const type = typeOf(p, at)!, c = p[at + 1];
  let n = 2 + 4 * (c & REC_COUNT) + (DEFS[type].data ?? 0);
  if (DEFS[type].paramInputs && !(c & REC_TEMPLATE)) {
    const pres = p[at + 2 + 4 * (c & REC_COUNT)];
    n += 1 + (pres & PRES_ATT1 ? 4 : 0) + (pres & PRES_ATT2 ? 4 : 0) + ((pres & PRES_P1 ? 1 : 0) + (pres & PRES_P2 ? 1 : 0)) * maskBytes(type, p[1]);
  }
  return n;
}
/** each module record's offset, and the records' end; null when malformed */
function records(p: Uint8Array): { at: number[]; end: number } | null {
  let r = recordsAt(p);
  if (!r) return null;
  const at: number[] = [];
  for (let i = 0; i < p[2]; i++) {
    if (!recOk(p, r)) return null;
    at.push(r);
    r += recSize(p, r);
  }
  return r <= p.length ? { at, end: r } : null;
}
/** the end of the cables from `at` (engine.c eng_cables_to), format 67's side section included (#1141, patchbin.ts
 * sideRecord: places ascending and under the cable count, sides 1 or 2), 0 when malformed */
function cablesTo(p: Uint8Array, at: number): number {
  const ncab = p[4] | p[5] << 8;
  if (!(p[1] >= SLIM && p[7] & F7_CABLES3)) at += (p[7] & F7_CABLES3 && p[1] < SLIM ? 3 : 4) * ncab;
  else {
    const nb = (p[2] + 1) >> 1;
    if (at + nb > p.length || (p[2] & 1 && p[at + nb - 1] >> 4)) return 0;
    let n = 0;
    for (let i = 0; i < p[2]; i++) n += p[at + (i >> 1)] >> (4 * (i & 1)) & 15;
    if (n !== ncab) return 0;
    at += nb + 2 * ncab;
  }
  if (p[1] >= FORMAT_1_27) {
    if (at >= p.length) return 0;
    const n = p[at++];
    if (at + 2 * n > p.length) return 0;
    for (let k = 0; k < n; k++, at += 2)
      if (p[at] >= ncab || (k && p[at] <= p[at - 2]) || p[at + 1] < 1 || p[at + 1] > 2) return 0;
  }
  return at <= p.length ? at : 0;
}
const bits = (p: Uint8Array, at: number, n: number): number => {
  let c = 0;
  for (let k = 0; k < n; k++) c += p[at + (k >> 3)] >> (k & 7) & 1;
  return c;
};
/** the end of format 51's morph B set from `at` (engine.c eng_bset_walk), 0 when malformed */
function bsetEnd(p: Uint8Array, recs: number[], at: number): number {
  const mk = at;
  at += (p[2] + 7) >> 3;
  if (at > p.length) return 0;
  for (let i = 0; i < p[2]; i++) {
    if (!(p[mk + (i >> 3)] >> (i & 7) & 1)) continue;
    const n = p[recs[i] + 1] & REC_COUNT;
    if (at + ((n + 7) >> 3) > p.length || (n & 7 && p[at + (n >> 3)] >> (n & 7))) return 0;
    at += ((n + 7) >> 3) + 4 * bits(p, at, n);
  }
  return at <= p.length ? at : 0;
}
/** the end of a section that starts at `at` from a walker that reads it, 0 when cut short */
type End = (p: Uint8Array, at: number) => number;
const routesEnd = (recs: number[]): End => (p, at) => {
  if (at >= p.length) return 0;
  const n = p[at++];
  for (let i = 0; i < n; i++) {
    if (at + 2 > p.length || p[at] >= recs.length) return 0;
    at += 2 + maskBytes(typeOf(p, recs[p[at]])!, p[1]);
  }
  return at <= p.length ? at : 0;
};
/** a word count at `at` (track.ts COUNT_ESC, format 67): its value and bytes */
const countAt = (p: Uint8Array, at: number): [number, number] => (p[at] === COUNT_ESC ? [COUNT_ESC + p[at + 1], 2] : [p[at], 1]);
const notesEnd: End = (p, at) => {
  if (at >= p.length) return 0;
  const n = p[at++];
  for (let i = 0; i < n; i++) {
    if (at + 3 > p.length) return 0;
    const [c, b] = countAt(p, at + 1);
    at += 1 + b + 4 * c;
  }
  return at <= p.length ? at : 0;
};
const patternsEnd: End = (p, at) => {
  if (at + 3 > p.length) return 0;
  const nt = p[at + 2];
  at += 3;
  for (let t = 0; t < nt; t++) {
    if (at + 2 > p.length) return 0;
    const np = p[at + 1];
    at += 2;
    for (let k = 0; k < np; k++) {
      if (at + 1 >= p.length) return 0;
      if (p[at] === 0xff) {
        at++;
        continue;
      }
      const [n, b] = countAt(p, at);
      at += b;
      if (at + 2 > p.length) return 0;
      at += 2 + n * (p[at] & 0x80 ? 2 : 4);
    }
  }
  if (at >= p.length) return 0;
  const ns = p[at++];
  for (let k = 0; k < ns; k++) {
    if (at >= p.length) return 0;
    at += 1 + 2 * p[at];
  }
  return at <= p.length ? at : 0;
};
const locksEnd: End = (p, at) => {
  if (at >= p.length) return 0;
  const nt = p[at++];
  for (let t = 0; t < nt; t++) {
    if (at + 2 > p.length) return 0;
    let n = p[at + 1];
    at += 2;
    for (let k = 0; k < n; k++) {
      if (at >= p.length) return 0;
      at += 1 + 2 * p[at];
    }
    if (at >= p.length) return 0;
    n = p[at++];
    for (let k = 0; k < n; k++) {
      if (at + 2 > p.length) return 0;
      at += 2 + 6 * p[at + 1];
    }
  }
  return at <= p.length ? at : 0;
};

/** where binary `p`'s links section starts (it holds one: header byte 7 bit 7), 0 when it has none or is malformed or not
 *  counted (engine.c eng_links_at) */
export function linksAt(p: Uint8Array): number {
  if (p.length < 8 || p[0] !== 0xa1 || p[1] < COUNTED || !(p[7] & F7_LINKS)) return 0;
  const recs = records(p);
  if (!recs) return 0;
  let at = cablesTo(p, recs.end);
  if (at && p[6] & F6_MORPH) at = bsetEnd(p, recs.at, at);
  else if (at && p[7] & F7_MORPH_MODULES) at += (p[2] + 7) >> 3;
  if (!at || at > p.length) return 0;
  if (p[6] & F6_FIXED) at += p[2];
  const walk: [boolean, End][] = [[!!(p[6] & F6_ROUTES), routesEnd(recs.at)], [!!(p[6] & F6_NOTES), notesEnd], [!!(p[7] & F7_PATTERNS), patternsEnd], [!!(p[7] & F7_LOCKS), locksEnd]];
  for (const [has, end] of walk) if (has && !(at = end(p, at))) return 0;
  return at < p.length && at + 1 + 3 * p[at] <= p.length ? at : 0;
}

/** binary `p`'s links: [pattern index (1..63), store id] in the order it holds them; [] when it has none */
export function linksOf(p: Uint8Array): [number, number][] {
  const at = linksAt(p);
  return at ? Array.from({ length: p[at] }, (_, k): [number, number] => [p[at + 1 + 3 * k], p[at + 2 + 3 * k] | p[at + 3 + 3 * k] << 8]) : [];
}

/** binary `p` with its links' store ids renamed (`ids`: old id → new id; an id not in it stays) */
export function withLinkIds(p: Uint8Array, ids: ReadonlyMap<number, number>): Uint8Array {
  const at = linksAt(p), out = p.slice();
  if (!at) return out;
  for (let k = 0; k < p[at]; k++) {
    const o = at + 2 + 3 * k, id = ids.get(p[o] | p[o + 1] << 8);
    if (id === undefined) continue;
    out[o] = id & 0xff;
    out[o + 1] = id >> 8;
  }
  return out;
}
