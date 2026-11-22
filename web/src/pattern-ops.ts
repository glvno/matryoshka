// SPDX-License-Identifier: GPL-3.0-only
// The pattern commands (#1177, #1178, D-544, D-838): copy a pattern of every Steps track to the first empty number after
// it, clear every pattern and song, and double the shown pattern of every track. The editor's Steps card runs them
// (editor.ts), and so does the FM-1's SEQ page (SEQ held + SAVE, SEQ held + HOME, SEQ held + OCT+; firmware/src/patlink.c
// pl_copy, pl_clear_all, pl_double), which tells the editor with PATTERN_OP so its copy runs the same command. The FM-1's
// host test compares what both write (scripts/pattern-vectors.ts).
import type { Patch } from './patch';
import { PATCH_LOCKS_MAX } from './locks';
import { fixLocks, fixNotes, fixPatterns, fixSeq, isDrone, LOCKS_MAX, patternOf, PATTERNS_MAX, STEPS_MAX, TRACK_NOTES_MAX, wordCount, type Pattern, type SeqState, type StepNote } from './track';

const tracks = (patch: Patch) => patch.modules.filter((m) => m.type === 'steps');
const mainOf = (patch: Patch) => patch.modules.find((m) => m.type === 'fm1');

/** pattern p (1..63) is empty: no Steps track holds it and it has no link (a link holds its number) */
export function patternFree(patch: Patch, p: number): boolean {
  return !tracks(patch).some((m) => !!m.patterns?.[p - 1]) && !mainOf(patch)?.seq?.links?.[p];
}

/** pattern p has a note on some Steps track (pattern 1: the tracks' own notes) */
export function patternHasNotes(patch: Patch, p: number): boolean {
  return tracks(patch).some((m) => !!(p ? m.patterns?.[p - 1]?.notes : m.notes)?.length);
}

/** the first empty pattern after `from` (0-based), round from pattern 2 when none after it is; -1 when all 64 are used */
export function nextEmptyPattern(patch: Patch, from: number): number {
  for (let k = 1; k < PATTERNS_MAX; k++) {
    const q = (from + k) % PATTERNS_MAX;
    if (q && patternFree(patch, q)) return q;
  }
  return -1;
}

/** pattern `from` of every track copied to pattern `to`: notes, P-locks, its own length and rate; a track without `from`
 *  loses `to` too. A plain pattern: no link and no pattern origin go with it */
export function copyPattern(patch: Patch, from: number, to: number): void {
  if (from === to || to < 0 || to >= PATTERNS_MAX) return;
  for (const m of tracks(patch)) {
    const src: Pattern | null = from <= 0 ? { ...(m.notes ? { notes: m.notes } : {}), ...(m.locks ? { locks: m.locks } : {}) } : m.patterns?.[from - 1] ?? null;
    if (to <= 0) {
      if (src) {
        if (src.notes?.length) m.notes = structuredClone(src.notes);
        else delete m.notes;
        if (src.locks?.length) m.locks = structuredClone(src.locks);
        else delete m.locks;
      }
      continue;
    }
    const pats: (Pattern | null)[] = [...(m.patterns ?? [])];
    while (pats.length < to) pats.push(null);
    pats[to - 1] = src ? structuredClone(src) : null;
    const fixed = fixPatterns(pats);
    if (fixed) m.patterns = fixed;
    else delete m.patterns;
  }
  const main = mainOf(patch);
  if (to > 0 && main?.seq?.links?.[to]) {
    const s: SeqState = structuredClone(main.seq);
    delete s.links![to];
    const v = fixSeq(s);
    if (v) main.seq = v;
    else delete main.seq;
  }
}

/** every pattern of every track and every song cleared: pattern 1 empty and selected, no other pattern, no link, no P-lock,
 *  no pattern origin, no song entry and none playing (the editor's 303 names stay) */
export function clearAllPatterns(patch: Patch): void {
  for (const m of tracks(patch)) {
    delete m.notes;
    delete m.patterns;
    delete m.locks;
    delete m.factoryPatterns;
  }
  const main = mainOf(patch);
  if (!main?.seq) return;
  const v = fixSeq({ ...(main.seq.names ? { names: main.seq.names } : {}) });
  if (v) main.seq = v;
  else delete main.seq;
}

/** the most note words a patch holds, every pattern of every track (engine.c ENG_MAX_NOTES; patchbin.ts DEVICE.notes) */
const PATCH_NOTES_MAX = 1536;

/** a pattern's notes on `len` steps doubled (D-838), unchecked: steps len..2len-1 become a copy of steps 0..len-1 (what
 *  was there unplayed goes), notes from step 2len on stay. A note that ran past the end (cut there, or tied across the
 *  loop point) keeps the length it sounded for: the first copy ends in the copy's half or runs into it, the second keeps
 *  its tie. A drone stays one note */
function doubled(notes: readonly StepNote[] | undefined, len: number): StepNote[] {
  const out: StepNote[] = [];
  for (const n of notes ?? []) {
    if (n.at >= 2 * len || (n.at < len && isDrone(n))) out.push(n);
    else if (n.at < len && n.at + n.len <= len) out.push(n, { ...n, at: n.at + len });
    else if (n.at < len) {
      const l = n.wrap ? Math.min(n.len, len) : len - n.at;
      const first: StepNote = { ...n, len: l };
      delete first.wrap;
      out.push(first, { ...n, at: n.at + len, len: l });
    }
  }
  return out;
}

/** why a double changed nothing: a track would pass 64 steps (D-505), a pattern 128 note words or the patch 1536 (D-542),
 *  a pattern 64 P-locks or the patch 256 (D-813) */
export type DoubleRefusal = 'steps' | 'notes' | 'locks';

/** the pattern p (0-based) of every Steps track doubled (D-838): twice its length, its steps copied into the new second
 *  half (doubled), so it plays the same twice. Pattern p's own length doubles; one on the track's length gets its own,
 *  twice that; pattern 1 (which has none) doubles the track's length, and the track's other patterns on the track's
 *  length get it as their own, so they do not change. A track without pattern p gets it first, from its pattern 1 (notes
 *  and P-locks, D-542). All or nothing: the refusal when a limit would be passed. Links and pattern origins stay (the
 *  link's hash tells the content changed, as after any edit). Returns the longest new length */
export function doublePattern(patch: Patch, p: number): { len: number } | { refused: DoubleRefusal } {
  const ts = tracks(patch);
  const plan = ts.map((m) => {
    const x = p > 0 ? m.patterns?.[p - 1] ?? null : null;
    const { notes, len } = patternOf(m, p);
    const locks = x ? x.locks : m.locks;
    // (P-locks: those on steps 0..len-1 copied len steps later, those on len..2len-1 gone, those from 2len on kept)
    const twice = (locks ?? []).flatMap((l) => (l.at >= 2 * len ? [l] : l.at < len ? [l, { ...l, at: l.at + len }] : []));
    return { m, len, notes: doubled(notes, len), locks: twice, was: p === 0 || x ? { n: wordCount(notes), l: locks?.length ?? 0 } : { n: 0, l: 0 } };
  });
  const words = (m: (typeof ts)[number]): number => wordCount(m.notes) + (m.patterns ?? []).reduce((k, x) => k + wordCount(x?.notes), 0);
  const nlocks = (m: (typeof ts)[number]): number => (m.locks?.length ?? 0) + (m.patterns ?? []).reduce((k, x) => k + (x?.locks?.length ?? 0), 0);
  const sum = (f: (t: (typeof plan)[number]) => number): number => plan.reduce((k, t) => k + f(t), 0);
  if (plan.some((t) => 2 * t.len > STEPS_MAX)) return { refused: 'steps' };
  if (plan.some((t) => wordCount(t.notes) > TRACK_NOTES_MAX) || sum((t) => words(t.m) - t.was.n + wordCount(t.notes)) > PATCH_NOTES_MAX) return { refused: 'notes' };
  if (plan.some((t) => t.locks.length > LOCKS_MAX) || sum((t) => nlocks(t.m) - t.was.l + t.locks.length) > PATCH_LOCKS_MAX) return { refused: 'locks' };
  for (const { m, len, notes, locks } of plan) {
    const n = fixNotes(notes), l = fixLocks(locks);
    if (p === 0) {
      if (n) m.notes = n;
      else delete m.notes;
      if (l) m.locks = l;
      else delete m.locks;
      for (const x of m.patterns ?? []) if (x && x.len === undefined) x.len = len;
      m.params.len = 2 * len;
      continue;
    }
    const pats: (Pattern | null)[] = [...(m.patterns ?? [])];
    while (pats.length < p) pats.push(null);
    const x: Pattern = { ...(pats[p - 1] ?? {}), len: 2 * len };
    if (n) x.notes = n;
    else delete x.notes;
    if (l) x.locks = l;
    else delete x.locks;
    pats[p - 1] = x;
    m.patterns = fixPatterns(pats);
  }
  return { len: Math.max(0, ...plan.map((t) => 2 * t.len)) };
}

/** the patch has nothing clear all would clear */
export function patternsEmpty(patch: Patch): boolean {
  const seq = mainOf(patch)?.seq;
  return !tracks(patch).some((m) => m.notes?.length || m.patterns?.length || m.locks?.length)
    && !seq?.songs?.some((s) => s.length) && !Object.keys(seq?.links ?? {}).length && !seq?.pattern && !seq?.song;
}
