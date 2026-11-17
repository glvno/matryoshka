// SPDX-License-Identifier: GPL-3.0-only
// The candidate list (#943, #1048; `Snapshots` in the code): A is the current patch, the others take automatic letters from
// B, the switch's order with A as the first stop, what counts as the same version, what a row says a candidate came from,
// the candidate keys (#1028), and stored candidates from before A was the current patch, lettered once more.
import { describe, expect, it } from 'vitest';
import { body, CURRENT_LETTER, fitText, letterAt, originText, sameVersion, snapshotKey, snapshotRecord, storedSnapshots, Snapshots, type Snapshot } from './snapshots';
import { relocatedPatches } from './community-factory';
import type { Patch } from './patch';

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('candidates (#943, #1048)', () => {
  it('letters run A..Z, then AA, AB.. as spreadsheet columns do', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterAt)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('A is the current patch: each candidate takes the next letter from B, never one given before; the user never picks it', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    expect(CURRENT_LETTER).toBe('A');
    expect(s.nextLetter()).toBe('B');
    expect([s.take(p), s.take(p), s.take(p)].map((x) => x.letter)).toEqual(['B', 'C', 'D']);
    s.remove('C');
    expect(s.take(p).letter).toBe('E');
    s.remove('E');
    expect(s.nextLetter()).toBe('F');   // (E was cut: an undo step that names it never finds another candidate)
    s.clear();
    expect(s.take(p).letter).toBe('B');
  });

  it('A is the first stop: the switch goes from A through every candidate in order, then round to A, both ways', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    expect(s.next()).toBeUndefined();
    expect(s.stops()).toEqual([null]);
    s.take(p);
    expect(s.next()).toBe('B');
    s.shown = 'B';
    expect(s.next()).toBeNull();   // (one candidate: B and A, the current patch)
    s.take(p);
    expect(s.stops()).toEqual([null, 'B', 'C']);
    expect(s.next()).toBe('C');
    s.shown = 'C';
    expect(s.next()).toBeNull();
    expect(s.next(-1)).toBe('B');
    s.shown = null;
    expect(s.next()).toBe('B');
    expect(s.next(-1)).toBe('C');
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

  it('holding finds the candidate that keeps a version already', () => {
    const a = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    s.take(a);
    const moved = copy(a);
    moved.modules[0].y += 50;
    expect(s.holding(moved)?.letter).toBe('B');
    expect(s.holding({ ...copy(a), name: 'other' })).toBeUndefined();
  });

  it('a row says where its candidate came from and, with an aim, whether it sounds like it or only kind of does (#1048)', () => {
    expect([undefined, 'A', 'B', 'B+D', 'B+C+E', 'mutate', 'use'].map((from) => originText({ from })))
      .toEqual(['taken by hand', 'from A', 'from B', 'from B and D', 'from B, C and E', 'kept for you before the first Mutate', 'was A, the current patch']);
    expect(fitText({})).toBeNull();
    expect(fitText({ aim: { kind: 'pad', fits: true } })).toBe('sounds like a pad');
    expect(fitText({ aim: { kind: 'pad', fits: false } })).toBe('kind of sounds like a pad');
    expect(fitText({ aim: { kind: 'lead', fits: false } })).toBe('kind of sounds like a lead');
    expect(fitText({ aim: { kind: 'keys', fits: true } })).toBe('sounds like keys');
  });

  it('kept beside the remembered patch, the candidates come back for that patch only (D-972)', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    s.take(p);
    s.take({ ...copy(p), name: 'bright' }, 'bright', 'B');
    s.list[0].mark = 'keep';   // (rank and cut's keep marks, origins and aims come back too, #996, #1048)
    s.list[1].aim = { kind: 'pad', fits: false };
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

  it('candidates stored before A was the current patch are lettered once more, each moving on by one, so there are never two A\u2019s (#1048)', () => {
    const p = relocatedPatches['Oracle V']();
    const text = JSON.stringify(p);
    const patch = JSON.stringify(p);
    // a record as 1.18.3's editor wrote it: no lettering, the first candidate lettered A, `current` for the current patch
    const fingerprint = (JSON.parse(snapshotRecord(text, [{ letter: 'B', patch }])!) as { patch: string }).patch;
    const before: Snapshot[] = [
      { letter: 'A', patch, name: 'before mutate' },
      { letter: 'B', patch, from: 'current', mark: 'keep' },
      { letter: 'C', patch, from: 'A' },
      { letter: 'Z', patch, from: 'A+B' },
    ];
    const once = storedSnapshots(JSON.stringify({ patch: fingerprint, list: before }), text);
    expect(once.map((s) => [s.letter, s.from, s.name, s.mark])).toEqual([
      ['B', 'mutate', 'before mutate', undefined],
      ['C', 'A', undefined, 'keep'],
      ['D', 'B', undefined, undefined],
      ['AA', 'B+C', undefined, undefined],
    ]);
    expect(once.some((s) => s.letter === CURRENT_LETTER)).toBe(false);
    // written back with the new lettering, it reads back as it is: lettered once only
    expect(storedSnapshots(snapshotRecord(text, once), text)).toEqual(once);
    // a record that says it has the new lettering but holds an A (hand-edited, damaged) is lettered once more too
    const odd = JSON.parse(snapshotRecord(text, once)!) as { list: Snapshot[] };
    odd.list.push({ letter: 'A', patch });
    expect(storedSnapshots(JSON.stringify(odd), text).some((s) => s.letter === CURRENT_LETTER)).toBe(false);
    // the next letter after a re-lettered list never repeats one
    const s = new Snapshots();
    s.list.push(...once);
    expect(s.nextLetter()).toBe('AB');
  });

  it('the candidate keys, by the key\u2019s place: Alt+B or Alt+J the next stop, Alt+K the one before, Alt+X remove, Alt+C Use, Shift+Alt+B Nominate (#1028, #1040)', () => {
    const press = (code: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}, typed = '\u222b') =>
      snapshotKey({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, ...mods, code, key: typed });
    expect(['KeyB', 'KeyJ', 'KeyK', 'KeyX', 'KeyC'].map((c) => press(c))).toEqual(['next', 'next', 'previous', 'remove', 'current']);
    expect(press('KeyC', {}, '\u00e7')).toBe('current');   // (Option+C types ç on a Mac)
    expect(press('KeyB', { shiftKey: true })).toBe('take');
    expect(press('Quote', {}, 'b')).toBe('next');   // (B by its letter too, on another layout)
    // Shift+Alt+X (once Cut the losers) and the other Shift and Ctrl/Cmd forms are free; without Alt nothing is a candidate key
    for (const c of ['KeyJ', 'KeyK', 'KeyX', 'KeyC']) expect(press(c, { shiftKey: true })).toBeNull();
    for (const c of ['KeyB', 'KeyJ', 'KeyK', 'KeyX', 'KeyC']) expect([press(c, { ctrlKey: true }), press(c, { metaKey: true }), press(c, { altKey: false })]).toEqual([null, null, null]);
  });

  it('a candidate moved in the list keeps its letter; the stops follow the list, A first (#1040)', () => {
    const p = relocatedPatches['Oracle V']();
    const s = new Snapshots();
    for (let i = 0; i < 3; i++) s.take(p);
    s.move('D', 0);
    s.move('B', -5);   // (held to the list: the first place)
    expect(s.list.map((x) => x.letter)).toEqual(['B', 'D', 'C']);
    expect(s.stops()).toEqual([null, 'B', 'D', 'C']);
    s.shown = 'C';
    expect([s.next(), s.next(-1)]).toEqual([null, 'D']);
    expect(s.nextLetter()).toBe('E');
  });
});
