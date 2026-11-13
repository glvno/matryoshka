// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { addToBank, bankMatches, bankPatches, knownCopy, slotFor, uploadLoses } from './bank';
import type { Patch } from './patch';
import { FM1_PRESETS, PRESETS } from './presets';
import { SLOTS, type SlotInfo } from './protocol';
import { relocatedPatches } from './community-factory';

const bank = (names: (string | null)[], length = 100): SlotInfo[] =>
  Array.from({ length: SLOTS }, (_, slot) => ({ slot, used: names[slot] != null, length: names[slot] != null ? length : 0, name: names[slot] ?? '' }));

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

it('an upload loses the used slots past the list and the ones whose patch the list does not hold', () => {
  expect(uploadLoses(bank([]), ['Acid'])).toEqual([]);
  expect(uploadLoses(bank(['ACID', 'PAD']), ['Pad', 'Acid'])).toEqual([]); // same patches, another order
  expect(uploadLoses(bank(['ACID', 'PAD', 'BASS']), ['Acid', 'Pad']).map((s) => s.name)).toEqual(['BASS']);
  expect(uploadLoses(bank(['ACID', 'MINE']), ['Acid', 'Pad']).map((s) => s.slot)).toEqual([1]);
  expect(uploadLoses(bank(['A VERY LONG PATCH NA']), ['A very long patch name indeed'])).toEqual([]); // the device keeps 20 characters
});

it('→ on the FM-1 replaces the slot of that name, else takes the first empty one', () => {
  expect(slotFor(bank(['ACID', null, 'PAD']), 'Pad')).toEqual({ slot: 2, replaces: expect.objectContaining({ name: 'PAD' }) });
  expect(slotFor(bank(['ACID', null, 'PAD']), 'Bass')).toEqual({ slot: 1, replaces: null });
  expect(slotFor(bank(Array.from({ length: SLOTS }, (_, i) => `P${i}`)), 'Bass')).toBeNull();
});

it('the FM-1 holds the bank when its used slots are the list, in order, by name and binary length', () => {
  const copy = [{ name: 'Acid', length: 100 }, { name: 'Pad', length: 100 }];
  expect(bankMatches(bank(['ACID', 'PAD']), copy)).toBe(true);
  expect(bankMatches(bank(['PAD', 'ACID']), copy)).toBe(false); // another order
  expect(bankMatches(bank(['ACID', 'PAD'], 99), copy)).toBe(false); // edited on the FM-1 (SAVE)
  expect(bankMatches(bank(['ACID', null, 'PAD']), copy)).toBe(false);
  expect(bankMatches(bank(['ACID', 'PAD', 'BASS']), copy)).toBe(false);
  expect(bankMatches(bank([]), [])).toBe(true);
});

it('a slot’s patch comes from this browser’s copy with its name and length, never from the FM-1', () => {
  const p = { name: 'x' } as Patch;
  const len = (q: Patch): number => (q === p ? 100 : 50);
  const s = bank(['ACID'])[0];
  expect(knownCopy(s, [{ name: 'Acid', patch: () => ({ name: 'y' }) as Patch }, { name: 'acid', patch: () => p, factory: true }], len)).toEqual({ name: 'acid', patch: p, factory: true });
  expect(knownCopy(s, [{ name: 'Bass', patch: () => p }], len)).toBeNull();
  expect(knownCopy(bank([])[0], [{ name: '', patch: () => p }], len)).toBeNull(); // an empty slot
});

it('the bank takes patches that fit, never one over the FM-1 budget', () => {
  const name = 'Monolith D', make = PRESETS.Init;
  mem.set('matryoshka.bank', JSON.stringify([{ name }]));
  expect(addToBank({ ...make(), name: 'Mine' })).toMatch(/kept in the bank/);
  expect(addToBank({ ...make(), name: 'Mine' })).toMatch(/updated in the bank/);
  expect(addToBank({ ...make(), name })).toMatch(/factory patch/); // the factory entry of that name stays
  const huge = make();
  huge.modules = [...huge.modules, ...Array.from({ length: 400 }, (_, i) => ({ ...huge.modules.find((m) => m.type === 'output')!, id: 1000 + i }))];
  expect(addToBank({ ...huge, name: 'Huge' })).toMatch(/too big/);
  expect(bankPatches().map((e) => e.name)).not.toContain('Huge');
});

it('retains old example-name bank entries and edited user graphs after examples leave the defaults', () => {
  const mine = { ...PRESETS.Init(), name: 'Mine', notes: 'saved by the user' };
  mem.set('matryoshka.bank', JSON.stringify([{ name: 'Init' }, { name: '<7PH' }, { name: 'Mine', patch: mine }]));
  expect(bankPatches()).toEqual([
    { name: 'Init', patch: PRESETS.Init() },
    { name: '<7PH', patch: PRESETS['<7PH']() },
    { name: 'Mine', patch: mine },
  ]);
});

it('retains archived name-only defaults beside selected defaults and saved graphs without rewriting the bank', () => {
  const mine = { ...relocatedPatches['Monolith D'](), notes: 'saved by the user' };
  mine.modules.find(module => module.type === 'output')!.params.level = 0.123;
  const stored = JSON.stringify([{ name: 'Hera 4' }, { name: 'Hera 3' }, { name: mine.name, patch: mine }, { name: 'Oracle V XL' }]);
  mem.set('matryoshka.bank', stored);
  const expected = [
    { name: 'Hera 4', patch: relocatedPatches['Hera 4']() },
    { name: 'Hera 3', patch: FM1_PRESETS['Hera 3']() },
    { name: mine.name, patch: mine },
    { name: 'Oracle V XL', patch: relocatedPatches['Oracle V XL']() },
  ];
  expect(bankPatches()).toEqual(expected);
  expect(bankPatches(() => false)).toEqual(expected.filter(entry => entry.name !== 'Hera 3'));
  expect(expected[0].patch.name).toBe('Hera 4');
  expect(expected[0].patch.modules.filter(m => m.type === 'alloc').map(m => m.params.voices)).toContain(4);
  expect(mem.get('matryoshka.bank')).toBe(stored);
  bankPatches()[0].patch.name = 'Changed copy';
  expect(bankPatches()).toEqual(expected);
});

it('still drops unknown name-only entries and uses defaults for corrupt bank JSON', () => {
  mem.set('matryoshka.bank', JSON.stringify([{ name: 'Unknown historical patch' }, null, { name: 42 }, { name: 'Hera 4' }]));
  expect(bankPatches()).toEqual([{ name: 'Hera 4', patch: relocatedPatches['Hera 4']() }]);
  mem.set('matryoshka.bank', '{');
  expect(bankPatches().map(entry => entry.name)).toEqual(Object.keys(FM1_PRESETS));
});
