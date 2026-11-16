// SPDX-License-Identifier: GPL-3.0-only
// The snapshot list (#943): automatic letters, the switch's order with the current patch as the last stop, and what counts
// as the same version.
import { describe, expect, it } from 'vitest';
import { body, letterAt, sameVersion, Snapshots } from './snapshots';
import { relocatedPatches } from './community-factory';
import type { Patch } from './patch';

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('snapshots (#943)', () => {
  it('letters run A..Z, then AA, AB.. as spreadsheet columns do', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterAt)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('each snapshot takes the letter after the newest one; the user never picks it', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    expect([s.take(p), s.take(p), s.take(p)].map((x) => x.letter)).toEqual(['A', 'B', 'C']);
    s.remove('B');
    expect(s.take(p).letter).toBe('D');
    s.remove('D');
    expect(s.nextLetter()).toBe('D');
    s.clear();
    expect(s.take(p).letter).toBe('A');
  });

  it('the switch goes through every snapshot in order, then the current patch, then loops', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    expect(s.next()).toBeUndefined();
    s.take(p);
    expect(s.next()).toBe('A');
    s.shown = 'A';
    expect(s.next()).toBeNull();   // one snapshot: A and the current patch
    s.take(p);
    expect(s.next()).toBe('B');
    s.shown = 'B';
    expect(s.next()).toBeNull();
    expect(s.next(-1)).toBe('A');
    s.shown = null;
    expect(s.next()).toBe('A');
    expect(s.next(-1)).toBe('B');
  });

  it('the same version ignores the canvas layout, not the sound or the name', () => {
    const a = relocatedPatches['Oracle V']();
    const b = copy(a);
    b.modules[0].x += 300;
    b.view = { x: 10, y: 20, zoom: 2 } as Patch['view'];
    b.octave = 2;
    if (b.assemblies?.[0]) b.assemblies[0].open = !b.assemblies[0].open;
    expect(sameVersion(a, b)).toBe(true);
    const c = copy(a);
    const m = c.modules.find((x) => Object.keys(x.params).length)!;
    const k = Object.keys(m.params)[0];
    m.params[k] += 1;
    expect(body(a)).not.toBe(body(c));
    expect(sameVersion(a, { ...copy(a), name: 'other' })).toBe(false);
  });

  it('holding finds the snapshot that keeps a version already', () => {
    const a = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    s.take(a);
    const moved = copy(a);
    moved.modules[0].y += 50;
    expect(s.holding(moved)?.letter).toBe('A');
    expect(s.holding({ ...copy(a), name: 'other' })).toBeUndefined();
  });
});
