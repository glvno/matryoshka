// SPDX-License-Identifier: GPL-3.0-only
// The snapshot list (#943): automatic letters, the switch's order with the current patch as the last stop, what counts as
// the same version, and the snapshot keys (#1028).
import { describe, expect, it } from 'vitest';
import { body, letterAt, sameVersion, snapshotKey, snapshotRecord, storedSnapshots, Snapshots } from './snapshots';
import { relocatedPatches } from './community-factory';
import type { Patch } from './patch';

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('snapshots (#943)', () => {
  it('letters run A..Z, then AA, AB.. as spreadsheet columns do', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterAt)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('each snapshot takes the next letter, never one given before; the user never picks it', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    expect([s.take(p), s.take(p), s.take(p)].map((x) => x.letter)).toEqual(['A', 'B', 'C']);
    s.remove('B');
    expect(s.take(p).letter).toBe('D');
    s.remove('D');
    expect(s.nextLetter()).toBe('E');   // (D was cut: an undo step that names it never finds another snapshot)
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

  it('kept beside the remembered patch, the snapshots come back for that patch only (D-972)', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    s.take(p);
    s.take({ ...copy(p), name: 'bright' }, 'bright', 'A');
    s.list[0].mark = 'keep';   // (rank and cut's keep marks and origins come back too, #996)
    const text = JSON.stringify(p);
    const record = snapshotRecord(text, s.list)!;
    expect(storedSnapshots(record, text)).toEqual(s.list);
    // (a cut mark from before Alt+X removed at once, #1028, is dropped)
    const old = JSON.parse(record) as { list: Record<string, unknown>[] };
    old.list[1].mark = 'cut';
    expect(storedSnapshots(JSON.stringify(old), text)[1]).toEqual(s.list[1]);
    expect(storedSnapshots(record, JSON.stringify({ ...p, name: 'another' }))).toEqual([]);
    expect(storedSnapshots(record, null)).toEqual([]);
    expect(storedSnapshots('not json', text)).toEqual([]);
    expect(snapshotRecord(text, [])).toBeNull();
  });

  it('the snapshot keys, by the key\u2019s place: Alt+B or Alt+J the next stop, Alt+K the one before, Alt+X remove, Alt+C make it the current patch, Shift+Alt+B take (#1028, #1040)', () => {
    const press = (code: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}, typed = '\u222b') =>
      snapshotKey({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, ...mods, code, key: typed });
    expect(['KeyB', 'KeyJ', 'KeyK', 'KeyX', 'KeyC'].map((c) => press(c))).toEqual(['next', 'next', 'previous', 'remove', 'current']);
    expect(press('KeyC', {}, '\u00e7')).toBe('current');   // (Option+C types ç on a Mac)
    expect(press('KeyB', { shiftKey: true })).toBe('take');
    expect(press('Quote', {}, 'b')).toBe('next');   // (B by its letter too, on another layout)
    // Shift+Alt+X (once Cut the losers) and the other Shift and Ctrl/Cmd forms are free; without Alt nothing is a snapshot key
    for (const c of ['KeyJ', 'KeyK', 'KeyX', 'KeyC']) expect(press(c, { shiftKey: true })).toBeNull();
    for (const c of ['KeyB', 'KeyJ', 'KeyK', 'KeyX', 'KeyC']) expect([press(c, { ctrlKey: true }), press(c, { metaKey: true }), press(c, { altKey: false })]).toEqual([null, null, null]);
  });

  it('a snapshot moved in the list keeps its letter; the stops follow the list, the current patch last (#1040)', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    for (let i = 0; i < 3; i++) s.take(p);
    s.move('C', 0);
    s.move('A', -5);   // (held to the list: the first place)
    expect(s.list.map((x) => x.letter)).toEqual(['A', 'C', 'B']);
    s.shown = 'B';
    expect([s.next(), s.next(-1)]).toEqual([null, 'C']);
    expect(s.nextLetter()).toBe('D');
  });
});
