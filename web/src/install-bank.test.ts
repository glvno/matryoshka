// SPDX-License-Identifier: GPL-3.0-only
// The Install panel's look at the bank before firmware 1.26 (#1202, G9): install-bank.ts's decisions.
import { describe, expect, it } from 'vitest';
import { bankPlan, movesText, needsBankCheck, packageHasSmallBank, tooManyText } from './install-bank';
import { CMD, parseInfo, type SlotInfo } from './protocol';

/** a bank of `n` slots with these used ones */
const bank = (n: number, used: number[]): SlotInfo[] =>
  Array.from({ length: n }, (_, slot) => ({ slot, used: used.includes(slot), length: used.includes(slot) ? 900 : 0, name: used.includes(slot) ? `PATCH ${slot + 1}` : '' }));
const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

describe('the bank before firmware 1.26', () => {
  it('only a 1.26 or later package (or a dev or CI build) has the small bank', () => {
    expect(packageHasSmallBank('FM-1_7012600')).toBe(true);
    expect(packageHasSmallBank('FM-1_7012701')).toBe(true);
    expect(packageHasSmallBank('FM-1_7020000')).toBe(true);
    expect(packageHasSmallBank('FM-1_7000000')).toBe(true);
    expect(packageHasSmallBank('FM-1_7012500')).toBe(false);
    expect(packageHasSmallBank('FM-1_717')).toBe(false);
    expect(packageHasSmallBank('FM-1_015')).toBe(false);
  });

  it('looks only at an FM-1 with more than 48 slots whose firmware does not store every pattern', () => {
    const base = [1, 128, 255, 3, 1, 0, 0, 31, 59, 1, 25, 0, 0, 0, 2];
    const info = (rest: number[]) => parseInfo({ cmd: CMD.info, payload: [...base, ...rest] })!;
    expect(needsBankCheck(info([60, 0, 0, 0, 0]))).toBe(true);           // 1.25: 60 slots
    expect(needsBankCheck(parseInfo({ cmd: CMD.info, payload: base.slice(0, 12) })!)).toBe(true);   // before the store: 64
    expect(needsBankCheck(info([48, 0, 0, 0, 0, 1]))).toBe(false);       // 1.26
    expect(needsBankCheck(info([60, 0, 0, 0, 0, 1]))).toBe(false);       // 1.26 that kept 60 slots: it says so itself
  });

  it('installs over empty slots 49..60, says which move when 48 or fewer are used, and asks above 48', () => {
    expect(bankPlan(bank(60, range(0, 48)))).toEqual({ kind: 'install' });
    expect(bankPlan(bank(60, []))).toEqual({ kind: 'install' });
    const moves = bankPlan(bank(60, [0, 1, 51, 56]));
    expect(moves.kind).toBe('moves');
    expect(moves.kind === 'moves' && moves.moving.map((s) => s.slot)).toEqual([51, 56]);
    const full = bankPlan(bank(60, [...range(0, 46), 48, 59]));
    expect(full.kind).toBe('moves');   // (exactly 48: they all fit)
    const over = bankPlan(bank(60, [...range(0, 48), 50, 59]));
    expect(over.kind === 'choose' && [over.used.length, over.over]).toEqual([50, 2]);
    expect(bankPlan(bank(64, range(0, 64)))).toMatchObject({ kind: 'choose', over: 16 });
  });

  it('names the slots in what it says', () => {
    const moving = bank(60, [51, 56]).filter((s) => s.used);
    expect(movesText(moving)).toContain('52 PATCH 52, 57 PATCH 57');
    const used = bank(60, [...range(0, 48), 50, 59]).filter((s) => s.used);
    const text = tooManyText(used);
    expect(text).toContain('50 patches');
    expect(text).toContain('51 PATCH 51, 60 PATCH 60');
    expect(text).toContain('Free 2 slots');
  });
});
