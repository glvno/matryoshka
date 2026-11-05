// SPDX-License-Identifier: GPL-3.0-only
// "Store to an FM-1 slot…" (#635): the slots with their names or EMPTY, the first empty one offered
import { describe, expect, it } from 'vitest';
import { SLOTS, type SlotInfo } from './protocol';
import { firstFree, slotNote, slotText } from './store-slot';

const bank = (used: Record<number, string>): SlotInfo[] =>
  Array.from({ length: SLOTS }, (_, slot) => ({ slot, used: slot in used, length: slot in used ? 100 : 0, name: used[slot] ?? '' }));

describe('Store to an FM-1 slot (#635)', () => {
  it('offers the first empty slot, not the one the FM-1 plays', () => {
    expect(firstFree(bank({ 0: 'ORACLE V', 1: '808 KIT', 3: 'HERA 6' }), 0)).toBe(2);
    expect(firstFree(bank({}), 5)).toBe(0);
  });

  it('with every slot used: the slot the FM-1 plays, else the first', () => {
    const full = bank(Object.fromEntries(Array.from({ length: SLOTS }, (_, i) => [i, `P${i}`])));
    expect(firstFree(full, 7)).toBe(7);
    expect(firstFree(full)).toBe(0);
    expect(firstFree(full, 99)).toBe(0);
  });

  it('lists each slot by its number and name, or EMPTY', () => {
    const b = bank({ 0: 'ORACLE V', 2: '' });
    expect(slotText(b[0])).toBe('01  ORACLE V');
    expect(slotText(b[1])).toBe('02  EMPTY');
    expect(slotText(b[2])).toBe('03  (no name)');
  });

  it('says what storing does: fills an empty slot, replaces a used one', () => {
    const b = bank({ 0: 'ORACLE V' });
    expect(slotNote(b[1], 'Verona 1')).toBe('Slot 02 is empty.');
    expect(slotNote(b[0], 'Verona 1')).toBe('Slot 01 holds "ORACLE V": storing replaces it with "Verona 1".');
  });
});
