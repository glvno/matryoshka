// SPDX-License-Identifier: GPL-3.0-only
// The Install panel's look at the bank before firmware 1.26 (#1202, G9), and before older firmware goes onto a 1.26 FM-1
// (P2): install-bank.ts's decisions.
import { describe, expect, it } from 'vitest';
import { binLength } from './bank';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { bankBackup, bankPlan, BACKUP_TEXT, movesText, needsBankCheck, OLDER_FIRMWARE_TEXT, packageBeforeStore, packageHasSmallBank, storesEveryPattern, tooManyText } from './install-bank';
import { encodePayload, fnv, FNV0 } from './pattern-store';
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
    expect(needsBankCheck(info([48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]))).toBe(false);       // 1.26
    expect(needsBankCheck(info([60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]))).toBe(false);       // 1.26 that kept 60 slots: it says so itself
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

describe('older firmware over a 1.26 FM-1 (#1202 P2)', () => {
  it('warns for a Matryoshka package before 1.26 over an FM-1 that stores every pattern', () => {
    expect(packageBeforeStore('FM-1_7012500')).toBe(true);
    expect(packageBeforeStore('FM-1_717')).toBe(true);
    expect(packageBeforeStore('FM-1_7012600')).toBe(false);
    expect(packageBeforeStore('FM-1_7000000')).toBe(false);   // (a dev or CI build is the current source)
    expect(packageBeforeStore('FM-1_015')).toBe(false);
    const base = [1, 128, 255, 3, 1, 0, 0, 31, 59, 1, 25, 0, 0, 0, 2, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(storesEveryPattern(parseInfo({ cmd: CMD.info, payload: [...base, 2] })!)).toBe(true);
    expect(storesEveryPattern(parseInfo({ cmd: CMD.info, payload: [...base, 0] })!)).toBe(false);
    expect(storesEveryPattern(parseInfo({ cmd: CMD.info, payload: base.slice(0, 16) })!)).toBe(false);
    expect(OLDER_FIRMWARE_TEXT).toContain('patterns 2 to 64');
    expect(BACKUP_TEXT).toContain('cannot send its patches');
  });

  it('backs up each slot this browser has a copy of, with the FM-1’s stored patterns inside and no link', async () => {
    const groove = (name: string, note: number): Patch => {
      const p = emptyPatch(name);
      addModule(p, DEFS.fm1, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      const st = addModule(p, DEFS.steps, 0, 0);
      connect(p, DEFS, { module: st.id, port: 'pitch' }, { module: out.id, port: 'l' });
      st.patterns = [null, { notes: [{ at: 0, len: 1, note, vel: 100 }] }];
      return p;
    };
    // this browser's copy links pattern 3 to entry 5; the FM-1's entry 5 holds another pattern (SAVE on the FM-1 wrote it)
    const copy = groove('Groove', 40);
    copy.modules.find((m) => m.type === 'fm1')!.seq = { links: { 2: { id: 5, hash: fnv(FNV0, encodePayload(copy, 2)) } } };
    const onFm1 = encodePayload(groove('Other', 52), 2);
    const slots: SlotInfo[] = [
      { slot: 0, used: true, length: binLength(copy, 'every'), name: 'GROOVE' },
      { slot: 1, used: false, length: 0, name: '' },
      { slot: 2, used: true, length: 700, name: 'LOST ONE' },
    ];
    const asked: number[] = [];
    const b = await bankBackup(slots, [{ name: 'Groove', patch: () => copy }], async (id) => (asked.push(id), id === 5 ? onFm1 : null));
    expect(asked).toEqual([5]);
    expect(b.missing.map((s) => s.slot)).toEqual([2]);
    expect(b.patches.map((x) => [x.slot, x.patch.name])).toEqual([[0, 'Groove']]);
    const kept = b.patches[0].patch;
    expect(kept.modules.find((m) => m.type === 'fm1')!.seq?.links).toBeUndefined();
    expect(Array.from(encodePayload(kept, 2))).toEqual(Array.from(onFm1));
  });
});
