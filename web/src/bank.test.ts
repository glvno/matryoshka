// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { addToBank, bankMatches, bankPatches, binLength, knownCopy, slotCopy, slotFor, uploadLoses } from './bank';
import { encodePatch } from './patchbin';
import { readLabel } from './patch-reader';
import type { Patch } from './patch';
import { FM1_PRESETS, PRESETS } from './presets';
import { SLOTS_MAX as SLOTS, type SlotInfo } from './protocol';
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

it('this browser’s copy of a slot’s patch is the candidate with its name and length (knownCopy, which never asks the FM-1)', () => {
  const p = { name: 'x' } as Patch;
  const len = (q: Patch): number => (q === p ? 100 : 50);
  const s = bank(['ACID'])[0];
  expect(knownCopy(s, [{ name: 'Acid', patch: () => ({ name: 'y' }) as Patch }, { name: 'acid', patch: () => p, factory: true }], len)).toEqual({ name: 'acid', patch: p, factory: true });
  expect(knownCopy(s, [{ name: 'Bass', patch: () => p }], len)).toBeNull();
  expect(knownCopy(bank([])[0], [{ name: '', patch: () => p }], len)).toBeNull(); // an empty slot
});

it('a slot this browser has no copy of is read from an FM-1 that sends slots back (← and Save as bank); a copy still wins', async () => {
  const p = FM1_PRESETS['Monolith D']();
  const bin = encodePatch(p);
  const asked: number[] = [];
  const fm1 = { readsSlots: true, readSlotBin: async (slot: number) => (asked.push(slot), slot === 3 ? bin : null), getPattern: async () => null };
  const s: SlotInfo = { slot: 3, used: true, length: bin.length, name: 'MONOLITH D' };
  const read = await slotCopy(s, [], fm1);
  expect(read).toMatchObject({ name: 'MONOLITH D', factory: false });
  expect(read!.patch.name).toBe('MONOLITH D');
  expect(readLabel(read!.read!)).toMatch(/^Read from the FM-1/);
  expect(asked).toEqual([3]);
  // (this browser's copy of the slot's name and binary length: the FM-1 is not asked, D-605)
  const copy = await slotCopy({ ...s, length: binLength(p) }, [{ name: 'Monolith D', patch: () => p, factory: true }], fm1);
  expect(copy).toEqual({ name: 'Monolith D', patch: p, factory: true });
  expect(asked).toEqual([3]);
  expect(await slotCopy(s, [], { ...fm1, readsSlots: false })).toBeNull();   // (firmware before 1.26: no SLOT_GET)
  expect(await slotCopy({ ...s, slot: 4 }, [], fm1)).toBeNull();   // (the FM-1 sends nothing back)
  expect(await slotCopy(s, [], { ...fm1, readSlotBin: async () => Uint8Array.from([1, 2, 3]) })).toBeNull();   // (not a patch binary)
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
  // (a name-only Hera 3, the default of 1.14 and 1.15, follows its instrument to today's name)
  const expected = [
    { name: 'Hera 4', patch: relocatedPatches['Hera 4']() },
    { name: 'Hera 6', patch: FM1_PRESETS['Hera 6']() },
    { name: mine.name, patch: mine },
    { name: 'Oracle V XL', patch: relocatedPatches['Oracle V XL']() },
  ];
  expect(bankPatches()).toEqual(expected);
  expect(bankPatches(() => false)).toEqual(expected.filter(entry => entry.name !== 'Hera 6'));
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
