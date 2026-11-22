// SPDX-License-Identifier: GPL-3.0-only
// The pattern commands (#1177, #1178): where a copy goes, what it carries, what clear all leaves. The FM-1's side is
// firmware/test/patlink_test.c (against scripts/pattern-vectors.ts) and panel_test.c.
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, emptyPatch, type Patch } from './patch';
import { clearAllPatterns, copyPattern, nextEmptyPattern, patternFree, patternHasNotes, patternsEmpty } from './pattern-ops';
import { PATTERNS_MAX, type StepNote } from './track';

const n = (at: number, note: number): StepNote => ({ at, len: 1, note, vel: 100 });

function rig(): Patch {
  const p = emptyPatch('RIG');
  addModule(p, DEFS.fm1, 0, 0);
  const a = addModule(p, DEFS.steps, 0, 0), b = addModule(p, DEFS.steps, 0, 0);
  a.notes = [n(0, 36)];
  a.patterns = [{ notes: [n(2, 40)], len: 5 }, { notes: [n(1, 41)], rate: 2 }];
  b.patterns = [null, null, { notes: [] }];
  return p;
}
const main = (p: Patch) => p.modules.find((m) => m.type === 'fm1')!;
const steps = (p: Patch) => p.modules.filter((m) => m.type === 'steps');

describe('copy a pattern (#1177)', () => {
  it('goes to the first empty number after the source, round from pattern 2; -1 when all 64 are used', () => {
    const p = rig();
    expect(nextEmptyPattern(p, 1)).toBe(4);           // (P03 and P04 are used: P05)
    expect(nextEmptyPattern(p, 0)).toBe(4);
    main(p).seq = { links: { 4: { id: 7, hash: 1 } } };
    expect(patternFree(p, 4)).toBe(false);            // (a link holds its number)
    expect(nextEmptyPattern(p, 1)).toBe(5);
    const a = steps(p)[0];
    a.patterns = Array.from({ length: PATTERNS_MAX - 1 }, (_, i) => (i === 5 ? null : { notes: [n(0, 50 + (i % 20))] }));
    expect(nextEmptyPattern(p, 40)).toBe(6);          // (none after P41 is empty: round to P07)
    a.patterns[5] = { notes: [n(0, 1)] };
    expect(nextEmptyPattern(p, 40)).toBe(-1);
  });

  it('carries notes, P-locks and its own length and rate, track by track, and no link or origin', () => {
    const p = rig();
    const [a, b] = steps(p);
    a.patterns![0]!.locks = [{ at: 2, module: a.id, param: 'gate', value: 0.5 }];
    a.factoryPatterns = { version: 1, ids: ['abc'] };
    main(p).seq = { links: { 1: { id: 9, hash: 3 } } };
    copyPattern(p, 1, 4);
    expect(a.patterns![3]).toEqual(a.patterns![0]);
    expect(a.patterns![3]).not.toBe(a.patterns![0]);
    expect(b.patterns?.[3] ?? null).toBe(null);       // (the second track has no pattern 2)
    expect(main(p).seq!.links).toEqual({ 1: { id: 9, hash: 3 } });
    expect(a.factoryPatterns!.ids).toEqual(['abc']);
    copyPattern(p, 0, 5);
    expect(a.patterns![4]).toEqual({ notes: [n(0, 36)] });
    expect(b.patterns![4]).toEqual({});              // (pattern 1 of a track without notes: an empty pattern, as the FM-1 makes it)
    expect(patternHasNotes(p, 3)).toBe(false);
    expect(patternHasNotes(p, 1)).toBe(true);
  });
});

describe('clear all (#1178)', () => {
  it('leaves pattern 1 empty and selected, no patterns, links, locks, origins or songs; the 303 names stay', () => {
    const p = rig();
    const [a] = steps(p);
    a.locks = [{ at: 0, module: a.id, param: 'gate', value: 0.5 }];
    a.factoryPatterns = { version: 1, ids: ['abc'] };
    main(p).seq = { pattern: 2, song: 1, songs: [[{ pat: 1, shift: 0 }]], links: { 1: { id: 9, hash: 3 } }, names: '303' };
    expect(patternsEmpty(p)).toBe(false);
    clearAllPatterns(p);
    for (const m of steps(p)) expect([m.notes, m.patterns, m.locks, m.factoryPatterns]).toEqual([undefined, undefined, undefined, undefined]);
    expect(main(p).seq).toEqual({ names: '303' });
    expect(patternsEmpty(p)).toBe(true);
  });
});
