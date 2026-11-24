// SPDX-License-Identifier: GPL-3.0-only
// The candidates of one patch (#943, #1048, owner 2026-11-24; `Snapshots` in the code): all alike, the opened patch is A,
// letters in the order made and never given twice, each with its hidden original; the switch goes round the list in its
// order; Recently deleted and its places; the limit of 32; what counts as the same version; what a row says a candidate
// came from; the palette name; the candidate keys (D-984).
import { describe, expect, it } from 'vitest';
import { body, CANDIDATE_LIMIT, fitText, letterAt, originText, paletteName, sameVersion, snapshotKey, Snapshots } from './snapshots';
import { relocatedPatches } from './community-factory';
import type { Patch } from './patch';

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const oracle = (): Patch => relocatedPatches['Oracle V']();
const letters = (s: Snapshots): string[] => s.list.map((x) => x.letter);

describe('the candidates of a patch (D-970, D-1425)', () => {
  it('letters run A..Z, then AA, AB.. as spreadsheet columns do', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterAt)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('the opened patch is A, the current one, as opened; its original is itself', () => {
    const p = oracle();
    const s = Snapshots.fresh(p);
    expect(letters(s)).toEqual(['A']);
    expect(s.current).toBe('A');
    expect(s.shown).toEqual({ letter: 'A', patch: JSON.stringify(p), original: JSON.stringify(p), from: 'opened' });
    expect(s.name).toBe(p.name);
  });

  it('each candidate takes the next letter, never one given before, deleted ones included; its original is itself as made', () => {
    const p = oracle();
    const s = Snapshots.fresh(p);
    expect([s.take(p), s.take(p, 'A'), s.take(p)].map((x) => x.letter)).toEqual(['B', 'C', 'D']);
    expect(s.get('C')).toMatchObject({ from: 'A', original: JSON.stringify(p) });
    s.remove('D');
    expect(s.take(p).letter).toBe('E');
    s.remove('A');   // (A is an ordinary candidate: it can go)
    expect(s.nextLetter()).toBe('F');
    expect(s.take(p, 'copy:B', 1).letter).toBe('F');   // (a place: Duplicate puts the copy under its candidate)
    expect(letters(s)).toEqual(['B', 'F', 'C', 'E']);
  });

  it('the switch goes round the list in its order, both ways; with one candidate there is nowhere to go', () => {
    const p = oracle();
    const s = Snapshots.fresh(p);
    expect(s.next()).toBeUndefined();
    s.take(p);
    s.take(p);
    expect([s.next(), s.next(-1)]).toEqual(['B', 'C']);
    s.current = 'C';
    expect([s.next(), s.next(-1)]).toEqual(['A', 'B']);
  });

  it('a candidate moved in the list keeps its letter; the switch follows the list (#1040)', () => {
    const p = oracle();
    const s = Snapshots.fresh(p);
    for (let i = 0; i < 3; i++) s.take(p);
    s.move('D', 0);
    s.move('B', -5);   // (held to the list: the first place)
    expect(letters(s)).toEqual(['B', 'D', 'A', 'C']);
    s.current = 'C';
    expect([s.next(), s.next(-1)]).toEqual(['B', 'A']);
    expect(s.nextLetter()).toBe('E');
  });

  it('Recently deleted keeps each with its place, newest first; put back returns it there (D-986)', () => {
    const p = oracle();
    const s = Snapshots.fresh(p);
    for (let i = 0; i < 3; i++) s.take(p);
    s.remove('B');
    s.remove('D');
    expect(s.deleted.map((d) => [d.s.letter, d.at])).toEqual([['D', 2], ['B', 1]]);
    expect(s.putBack()?.letter).toBe('D');
    expect(letters(s)).toEqual(['A', 'C', 'D']);
    expect(s.putBack(0)?.letter).toBe('B');
    expect(letters(s)).toEqual(['A', 'B', 'C', 'D']);
    expect(s.putBack()).toBeUndefined();
    s.remove('A');
    s.remove('C');
    expect(s.putBack(1)?.letter).toBe('A');   // (any one of them, not only the newest)
    expect(letters(s)).toEqual(['A', 'B', 'D']);
  });

  it(`up to ${CANDIDATE_LIMIT} candidates: no room, no put back; Recently deleted keeps the newest ${CANDIDATE_LIMIT} (D-972)`, () => {
    const p = oracle();
    const s = Snapshots.fresh(p);
    while (s.list.length < CANDIDATE_LIMIT) s.take(p);
    expect(s.room()).toBe(0);
    s.remove('B');
    s.take(p);
    expect(s.putBack()).toBeUndefined();
    expect(s.deleted).toHaveLength(1);
    for (const x of [...s.list].slice(1)) s.remove(x.letter);
    for (let i = 0; i < 3; i++) s.remove(s.take(p).letter);
    expect(s.deleted).toHaveLength(CANDIDATE_LIMIT);
  });

  it('kept as candidate-store.ts keeps it and back: the letters given, the current one and Recently deleted stay', () => {
    const p = oracle();
    const s = Snapshots.fresh(p);
    s.take(p);
    s.take(p);
    s.remove('C');
    s.current = 'B';
    s.opened = 42;
    const set = s.toSet();
    expect(set).toMatchObject({ id: s.id, name: p.name, current: 'B', given: 3, opened: 42 });
    const back = Snapshots.of(set);
    expect([letters(back), back.current, back.nextLetter(), back.deleted]).toEqual([['A', 'B'], 'B', 'D', s.deleted]);
    expect(Snapshots.of({ ...set, current: 'Z' }).current).toBe('A');   // (a current letter that is gone: the first)
  });

  it('the same version ignores the canvas layout, not the sound or the name', () => {
    const a = oracle();
    const b = copy(a);
    b.modules[0].x += 300;
    b.view = { x: 10, y: 20, zoom: 2 } as Patch['view'];
    b.octave = 2;
    if (b.assemblies?.[0]) b.assemblies[0].open = !b.assemblies[0].open;
    expect(sameVersion(a, b)).toBe(true);
    const c = copy(a);
    const m = c.modules.find((x) => Object.keys(x.params).length)!;
    m.params[Object.keys(m.params)[0]] += 1;
    expect(body(a)).not.toBe(body(c));
    expect(sameVersion(a, { ...copy(a), name: 'other' })).toBe(false);
  });

  it('a row says where its candidate came from and, with an aim, whether it sounds like it or only kind of does (#1048)', () => {
    expect([undefined, 'opened', 'A', 'B+D', 'B+C+E', 'copy:D', 'mutate', 'use'].map((from) => originText({ from })))
      .toEqual(['taken by hand', 'as opened', 'from A', 'bred from B × D', 'bred from B × C × E', 'copy of D', 'kept before a Mutate', 'was the current patch']);
    expect(fitText({})).toBeNull();
    expect(fitText({ aim: { kind: 'pad', fits: true } })).toBe('sounds like a pad');
    expect(fitText({ aim: { kind: 'pad', fits: false } })).toBe('kind of sounds like a pad');
    expect(fitText({ aim: { kind: 'keys', fits: true } })).toBe('sounds like keys');
  });

  it('the palette name: the patch and the candidate\u2019s name, or its letter with 2 or more, or the patch alone (D-1319)', () => {
    expect(paletteName('Night Bus', { letter: 'D' }, 4)).toBe('Night Bus D');
    expect(paletteName('Night Bus', { letter: 'D', name: 'Bright' }, 4)).toBe('Night Bus Bright');
    expect(paletteName('Night Bus', { letter: 'A', name: 'Bright' }, 1)).toBe('Night Bus Bright');
    expect(paletteName('Night Bus', { letter: 'A' }, 1)).toBe('Night Bus');
    expect(paletteName('  ', { letter: 'B' }, 2)).toBe('Untitled B');
  });

  it('the candidate keys, by the key\u2019s place: Alt+B or Alt+J the next, Alt+K the one before, Alt+X delete, Shift+Alt+B Duplicate; Alt+C is free (D-984)', () => {
    const press = (code: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}, typed = '\u222b') =>
      snapshotKey({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, ...mods, code, key: typed });
    expect(['KeyB', 'KeyJ', 'KeyK', 'KeyX', 'KeyC'].map((c) => press(c))).toEqual(['next', 'next', 'previous', 'remove', null]);
    expect(press('KeyB', { shiftKey: true })).toBe('duplicate');
    expect(press('Quote', {}, 'b')).toBe('next');   // (B by its letter too, on another layout)
    for (const c of ['KeyJ', 'KeyK', 'KeyX']) expect(press(c, { shiftKey: true })).toBeNull();
    for (const c of ['KeyB', 'KeyJ', 'KeyK', 'KeyX']) expect([press(c, { ctrlKey: true }), press(c, { metaKey: true }), press(c, { altKey: false })]).toEqual([null, null, null]);
  });
});
