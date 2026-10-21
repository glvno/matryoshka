// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { uploadLoses } from './bank';
import { SLOTS, type SlotInfo } from './protocol';

const bank = (names: (string | null)[]): SlotInfo[] =>
  Array.from({ length: SLOTS }, (_, slot) => ({ slot, used: names[slot] != null, length: names[slot] != null ? 100 : 0, name: names[slot] ?? '' }));

it('an upload loses the used slots past the list and the ones whose patch the list does not hold', () => {
  expect(uploadLoses(bank([]), ['Acid'])).toEqual([]);
  expect(uploadLoses(bank(['ACID', 'PAD']), ['Pad', 'Acid'])).toEqual([]); // same patches, another order
  expect(uploadLoses(bank(['ACID', 'PAD', 'BASS']), ['Acid', 'Pad']).map((s) => s.name)).toEqual(['BASS']);
  expect(uploadLoses(bank(['ACID', 'MINE']), ['Acid', 'Pad']).map((s) => s.slot)).toEqual([1]);
  expect(uploadLoses(bank(['A VERY LONG PATCH NA']), ['A very long patch name indeed'])).toEqual([]); // the device keeps 20 characters
});
