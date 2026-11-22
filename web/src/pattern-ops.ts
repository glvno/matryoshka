// SPDX-License-Identifier: GPL-3.0-only
// The pattern commands (#1177, #1178, D-544): copy a pattern of every Steps track to the first empty number after it, and
// clear every pattern and song. The editor's Steps card runs them (editor.ts), and so does the FM-1's SEQ page (SEQ held +
// SAVE, SEQ held + HOME; firmware/src/patlink.c pl_copy, pl_clear_all), which tells the editor with PATTERN_OP so its
// copy runs the same command. The FM-1's host test compares what both write (scripts/pattern-vectors.ts).
import type { Patch } from './patch';
import { fixPatterns, fixSeq, PATTERNS_MAX, type Pattern, type SeqState } from './track';

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

/** the patch has nothing clear all would clear */
export function patternsEmpty(patch: Patch): boolean {
  const seq = mainOf(patch)?.seq;
  return !tracks(patch).some((m) => m.notes?.length || m.patterns?.length || m.locks?.length)
    && !seq?.songs?.some((s) => s.length) && !Object.keys(seq?.links ?? {}).length && !seq?.pattern && !seq?.song;
}
