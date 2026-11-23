// SPDX-License-Identifier: GPL-3.0-only
// The halve (D-841, pattern-ops.ts halvePattern): every track's pattern half as long, rounded down, its notes and P-locks
// as they were, as the length box shortens it; all or nothing. The FM-1's side is firmware/test/patlink_test.c (the same
// patches halved byte for byte, scripts/pattern-vectors.ts) and panel_test.c (SEQ held + OCT-).
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, emptyPatch, type ModuleInst, type Patch } from './patch';
import { halvePattern } from './pattern-ops';
import { type StepNote } from './track';

const n = (at: number, len: number, note: number, more: Partial<StepNote> = {}): StepNote => ({ at, len, note, vel: 100, ...more });
const lock = (at: number, module: number, value: number) => ({ at, module, param: 'value', value });

interface Rig { p: Patch; a: ModuleInst; b: ModuleInst; c: ModuleInst; k: number }
function rig(): Rig {
  const p = emptyPatch('RIG');
  addModule(p, DEFS.fm1, 0, 0);
  const [a, b, c] = [0, 1, 2].map(() => addModule(p, DEFS.steps, 0, 0));
  const k = addModule(p, DEFS.const, 0, 0).id;
  a.params.len = b.params.len = c.params.len = 16;
  return { p, a, b, c, k };
}

describe('the halve (D-841)', () => {
  it('halves the own length, rounded down, and keeps every note and P-lock as the length box does', () => {
    const { p, a, k } = rig();
    const notes = [n(0, 1, 36, { chance: 50 }), n(5, 4, 40, { wrap: true }), n(9, 1, 42), n(14, 1, 44)];
    const locks = [lock(2, k, 0.25), lock(10, k, -0.5)];
    a.patterns = [{ len: 15, rate: 3, notes: structuredClone(notes), locks: structuredClone(locks) }];
    const box = structuredClone(p);
    box.modules.find((m) => m.id === a.id)!.patterns![0]!.len = 7;   // (the length box set to 7)
    expect(halvePattern(p, 1)).toEqual({ len: 8 });
    expect(a.patterns).toEqual([{ len: 7, rate: 3, notes, locks }]);
    expect(p.modules.find((m) => m.id === a.id)).toEqual(box.modules.find((m) => m.id === a.id));
  });

  it('pattern 1: the track\'s length halves, its other patterns on the track\'s length keep it as their own', () => {
    const { p, a } = rig();
    a.notes = [n(0, 1, 36), n(12, 2, 38)];
    a.patterns = [{ notes: [n(0, 1, 37)] }, null, { notes: [], len: 10 }];
    expect(halvePattern(p, 0)).toEqual({ len: 8 });
    expect(a.params.len).toBe(8);
    expect(a.notes).toEqual([n(0, 1, 36), n(12, 2, 38)]);
    expect(a.patterns).toEqual([{ notes: [n(0, 1, 37)], len: 16 }, null, { notes: [], len: 10 }]);
  });

  it('a track without the pattern gets its pattern 1 first, notes and P-locks (D-542); the longest track is what it says', () => {
    const { p, a, b, c, k } = rig();
    a.patterns = [{ notes: [n(1, 1, 50)], len: 6 }];
    b.params.len = 32;
    b.notes = [n(3, 1, 60), n(20, 1, 62)];
    b.locks = [lock(20, k, 1)];
    expect(halvePattern(p, 1)).toEqual({ len: 16 });
    expect(a.patterns).toEqual([{ notes: [n(1, 1, 50)], len: 3 }]);
    expect(b.patterns).toEqual([{ len: 16, notes: [n(3, 1, 60), n(20, 1, 62)], locks: [lock(20, k, 1)] }]);
    expect(b.notes).toEqual([n(3, 1, 60), n(20, 1, 62)]);
    expect(c.patterns).toEqual([{ len: 8 }]);
  });

  it('down to 1 step; a track at 1 step refuses for all, changing nothing', () => {
    const { p, a, b } = rig();
    b.params.len = 3;
    expect(halvePattern(p, 0)).toEqual({ len: 8 });
    expect([a.params.len, b.params.len]).toEqual([8, 1]);
    const was = structuredClone(p);
    expect(halvePattern(p, 0)).toEqual({ refused: 'steps' });
    expect(p).toEqual(was);
  });

  it('refuses, changing nothing, when the first copy of a pattern 1 would pass 1536 notes or 256 P-locks in the patch', () => {
    const cases: [string, (r: Rig) => void, string][] = [
      ['patch notes', ({ a, b }) => {
        b.notes = Array.from({ length: 60 }, (_, i) => n(i % 16, 1, 30 + Math.floor(i / 16)));
        a.patterns = Array.from({ length: 12 }, (_, q) => ({ notes: Array.from({ length: q ? 128 : 20 }, (_, i) => n(i % 16, 1, 30 + Math.floor(i / 16))) }));
      }, 'notes'],
      ['patch locks', ({ a, b, k }) => {
        b.locks = [lock(0, k, 0.5)];
        a.patterns = Array.from({ length: 4 }, (_, q) => ({ locks: Array.from({ length: q ? 64 : 63 }, (_, i) => ({ at: i, module: k, param: 'value', value: 1 })) }));
      }, 'locks'],
    ];
    for (const [name, set, why] of cases) {
      const r = rig();
      set(r);
      const was = structuredClone(r.p);
      expect(halvePattern(r.p, 1), name).toEqual({ refused: why });
      expect(r.p, name).toEqual(was);
    }
  });
});
