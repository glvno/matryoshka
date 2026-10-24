// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { addToBank, bankMatches, bankPatches, knownCopy, slotFor, uploadLoses } from './bank';
import type { Patch } from './patch';
import { PRESETS } from './presets';
import { SLOTS, type SlotInfo } from './protocol';

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
  const [name, make] = Object.entries(PRESETS)[0];
  mem.set('matryoshka.bank', JSON.stringify([{ name }]));
  expect(addToBank({ ...make(), name: 'Mine' })).toMatch(/kept in the bank/);
  expect(addToBank({ ...make(), name: 'Mine' })).toMatch(/updated in the bank/);
  expect(addToBank({ ...make(), name })).toMatch(/factory patch/); // the factory entry of that name stays
  const huge = make();
  huge.modules = [...huge.modules, ...Array.from({ length: 400 }, (_, i) => ({ ...huge.modules.find((m) => m.type === 'output')!, id: 1000 + i }))];
  expect(addToBank({ ...huge, name: 'Huge' })).toMatch(/too big/);
  expect(bankPatches().map((e) => e.name)).not.toContain('Huge');
});
