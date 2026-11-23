// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 bank backup (#1202 P2, G8): its lists in this browser and in a backup file (bank-backup.ts, migrate.ts), the
// restore into an FM-1's slots (a 1.26-only slot's patterns into the store first, its links renamed), and SLOT_GET's frames.
import { describe, expect, it } from 'vitest';
import { BANK_BACKUP_KEY, KEPT_PATTERNS_KEY, keepBackup, keptJson, readKeptJson, readSlotsJson, restoreBankBackup, savedSlots, slotsJson, type RestoreLink, type SlotBackup } from './bank-backup';
import { linksOf } from './bin-links';
import { planImport } from './migrate';
import { encodePatch } from './patchbin';
import { encodePayload, fnv, FNV0 } from './pattern-store';
import { factoryWithPatterns } from './presets';
import { CMD, frame, parse, parsePatEntry, parseSlotData, readSlotBinary, slotGetFrame, SLOT_INLINE, type StoredPatternEntry } from './protocol';

/** a Storage in memory */
function memory(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear() };
}

const kit = factoryWithPatterns('909 Kit');   // (its patterns 2.. linked to the legacy factory ids)
const stored = encodePatch(kit, true, 0, 0, 'assume');
const links = linksOf(stored);
const payloads = links.map(([q]) => encodePayload(kit, q));
const onlyNew: SlotBackup = { slot: 4, name: '909 KIT', binary: stored, patterns: links.map(([, id], k) => ({ id, name: `909 KIT P${k + 2}`, payload: payloads[k] })), saved: 2 };
const inline: SlotBackup = { slot: 0, name: 'LEAD', binary: Uint8Array.from([0xa1, 65, 1, 2, 3]), saved: 1 };

describe('the bank backup in this browser and in a file', () => {
  it('keeps the slots and kept copies as JSON, merged without twins', () => {
    expect(readSlotsJson(slotsJson([inline, onlyNew]))).toEqual([inline, onlyNew]);
    expect(readKeptJson(keptJson([{ name: 'K', payload: Uint8Array.from([1, 2]) }]))).toEqual([{ name: 'K', payload: Uint8Array.from([1, 2]) }]);
    expect(readSlotsJson('nonsense')).toEqual([]);
    const s = memory();
    keepBackup([inline], [{ name: 'K', payload: Uint8Array.from([1, 2]) }], s);
    keepBackup([inline, onlyNew], [{ name: 'K', payload: Uint8Array.from([1, 2]) }], s);
    expect(savedSlots(s)).toEqual([inline, onlyNew]);
    expect(readKeptJson(s.getItem(KEPT_PATTERNS_KEY))).toHaveLength(1);
  });

  it('Load patch from .json of a backup file brings both lists in, an identical entry once', () => {
    const here = memory();
    here.setItem(BANK_BACKUP_KEY, slotsJson([inline]));
    here.setItem(KEPT_PATTERNS_KEY, keptJson([{ name: 'K', payload: Uint8Array.from([1, 2]) }]));
    const plan = planImport({ [BANK_BACKUP_KEY]: slotsJson([{ ...inline, saved: 9 }, onlyNew]), [KEPT_PATTERNS_KEY]: keptJson([{ name: 'K', payload: Uint8Array.from([1, 2]) }, { name: 'J', payload: Uint8Array.from([3]) }]) }, (k) => here.getItem(k), () => true);
    expect(readSlotsJson(plan.writes[BANK_BACKUP_KEY]).map((x) => x.slot)).toEqual([0, 4]);
    expect(readKeptJson(plan.writes[KEPT_PATTERNS_KEY]).map((k) => k.name)).toEqual(['K', 'J']);
    expect(plan.brought).toEqual(['1 FM-1 bank backup slot', '1 kept pattern copy']);
  });
});

describe('Restore FM-1 bank backup', () => {
  function fm1(bankSlots: number, patternsStored = true) {
    const entries: StoredPatternEntry[] = [{ id: 30, len: payloads[0].length, hash: fnv(FNV0, payloads[0]), layout: 0, tracks: 1, readOnly: false, kept: false, name: 'SAME' }];
    const written = new Map<number, Uint8Array>(), puts: string[] = [];
    let next = 100;
    const link: RestoreLink = {
      connected: true, bankSlots, hasPatternStore: true, patternsStored,
      listPatterns: async () => entries.map((e) => ({ ...e })),
      putPattern: async (_id, name) => (puts.push(name), next++),
      uploadSlotBin: async (slot, _name, bin) => void written.set(slot, bin),
    } as RestoreLink;
    return { link, written, puts };
  }

  it('writes the newest backup of each slot, asking first; a 1.26-only slot’s patterns go into the store and its links name them', async () => {
    const s = memory();
    s.setItem(BANK_BACKUP_KEY, slotsJson([inline, onlyNew, { ...inline, slot: 50, name: 'FAR' }]));
    const { link, written, puts } = fm1(48);
    const asked: string[] = [];
    const said = await restoreBankBackup(link, (q) => (asked.push(q), true), s);
    expect(asked[0]).toContain('01 LEAD, 05 909 KIT');
    expect(asked[0]).toContain('51 FAR: past this FM-1');
    expect([...written.keys()]).toEqual([0, 4]);
    expect(Array.from(written.get(0)!)).toEqual(Array.from(inline.binary));
    // (pattern 2's payload is on the FM-1 as entry 30: reused; the others are new entries 100..)
    expect(puts).toHaveLength(links.length - 1);
    expect(linksOf(written.get(4)!).map(([, id]) => id)).toEqual([30, ...links.slice(1).map((_, k) => 100 + k)]);
    expect(said).toContain('Restored 2 slots (01, 05)');
    expect(await restoreBankBackup(link, () => false, s)).toBe('Nothing restored.');
  });

  it('a 1.26-only slot does not go onto older firmware', async () => {
    const s = memory();
    s.setItem(BANK_BACKUP_KEY, slotsJson([onlyNew]));
    const { link, written } = fm1(60, false);
    expect(await restoreBankBackup(link, () => true, s)).toContain('only onto an FM-1 with firmware 1.26');
    expect(written.size).toBe(0);
  });
});

describe('SLOT_GET (#1202 G8)', () => {
  it('asks by slot, offset and mode, and reads SLOT_DATA back in pieces or with its refusals', async () => {
    expect(parse(slotGetFrame(3, 256, SLOT_INLINE))).toEqual({ cmd: CMD.slotGet, payload: [3, 0, 1, 1] });
    const data = (slot: number, total: number, offset: number, bytes: number[] = []) => parse(frame(CMD.slotData, [slot, total & 0xff, total >> 8, offset & 0xff, offset >> 8, ...bytes]))!;
    expect(parseSlotData(data(2, 0xfffe, 0))!.total).toBe('too big');
    expect(parseSlotData(data(2, 0xfffc, 0))!.total).toBe('running');
    const bin = Array.from({ length: 300 }, (_, i) => i & 0xff);
    const asks: number[][] = [];
    const ask = async (f: Uint8Array) => {
      const q = parse(f)!.payload;
      asks.push(q);
      const off = q[1] | q[2] << 8;
      return data(q[0], bin.length, off, bin.slice(off, off + 256));
    };
    expect(Array.from(await readSlotBinary(ask, 7, SLOT_INLINE) as Uint8Array)).toEqual(bin);
    expect(asks).toEqual([[7, 0, 0, 1], [7, 0, 1, 1]]);
    expect(await readSlotBinary(async () => data(7, 0xfffd, 0), 7, SLOT_INLINE)).toBe('edited');
    expect(await readSlotBinary(async () => data(7, 0xffff, 0), 7)).toBe('empty');
  });

  it('PAT’s flags: bit 1 a kept copy, bit 0 read-only (firmware before 1.26)', () => {
    const pat = (flags: number) => parsePatEntry(parse(frame(CMD.pat, [0, 0, 1, 0, 5, 0, 9, 0, 1, 2, 3, 4, 0, 0, 0, 0, 1, flags, ...Array.from('MY KEEP', (c) => c.charCodeAt(0)), ...new Array(9).fill(0)]))!)!.entry!;
    expect(pat(2)).toMatchObject({ id: 5, len: 9, kept: true, readOnly: false, name: 'MY KEEP' });
    expect(pat(1)).toMatchObject({ kept: false, readOnly: true });
  });
});
