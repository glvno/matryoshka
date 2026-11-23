// SPDX-License-Identifier: GPL-3.0-only
// The pattern sets the 808 and 909 Kits shipped with up to 1.24.1 (#923, D-829), kept in the bank in full as test and
// measurement material: patterns 2.. linked to the legacy factory patterns (factory-store.json, frozen data: the links
// name its payloads), the binaries carrying the links instead of the notes, and the songs over them.
import { describe, expect, it } from 'vitest';
import STORE from './factory-store.json';
import { buildSelectedFactoryBank } from './factory-bank';
import { FACTORY_KITS, KIT_FIRST_ID, KIT_IDS_PER_KIT, gridNotes } from './factory-kit-patterns';
import { DEVICE, deviceBudget, encodePatch, linkPlan } from './patchbin';
import { decodePayload, fnv, FNV0, PATTERN_NAME_BYTES, storedName } from './pattern-store';
import { deviceView } from './poly';
import { COND_FILL, LINK_ID_MAX, PATTERNS_MAX, READ_ONLY_ID, SONG_LEN_MAX, type StepNote } from './track';
import SOURCE from '../factory/bank.json';

const bank = buildSelectedFactoryBank({ full: true });
const patchOf = (name: string) => bank.find((x) => x.name === name)!.patch;

describe('the factory kits\' linked patterns', () => {
  it('gives each kit its own block of read-only ids, one per pattern 2..64, append-only', () => {
    expect(KIT_FIRST_ID).toBe(READ_ONLY_ID);
    expect(FACTORY_KITS.map((k) => k.first)).toEqual(FACTORY_KITS.map((_, i) => KIT_FIRST_ID + i * KIT_IDS_PER_KIT));
    expect(FACTORY_KITS.slice(0, 2).map((k) => [k.patch, k.first])).toEqual([['808 Kit', 0xe000], ['909 Kit', 0xe040]]);
    for (const kit of FACTORY_KITS) {
      expect(kit.patterns.length).toBeLessThan(Math.min(PATTERNS_MAX, KIT_IDS_PER_KIT));
      expect(kit.first + kit.patterns.length - 1).toBeLessThanOrEqual(LINK_ID_MAX);
    }
  });

  it('writes every grid as 16 steps of known rows, and names fit the store', () => {
    for (const kit of FACTORY_KITS)
      kit.patterns.forEach((x) => {
        for (const steps of Object.values(x.grid)) expect(steps).toMatch(/^[.xXf]{16}$/);
        expect(gridNotes(kit, x.grid).length).toBeGreaterThan(0);
        const name = `${kit.prefix} ${x.name}`;
        expect(name.length).toBeLessThanOrEqual(PATTERN_NAME_BYTES);
        expect(storedName(name)).toBe(name);
      });
  });

  it('the 808 Kit has the TR-808\'s 12 rhythms with A and B variations; the 909 Kit 12 patterns', () => {
    const k808 = FACTORY_KITS.find((k) => k.patch === '808 Kit')!;
    expect(k808.patterns).toHaveLength(23);   // (pattern 1, ELECTRO A, is the patch's own)
    k808.patterns.forEach((x, i) => expect(x.name.endsWith(i % 2 ? ' A' : ' B')).toBe(true));   // (ELECTRO B, DISCO A, DISCO B, ..)
    expect(new Set(k808.patterns.map((x) => x.name.slice(0, -2))).size).toBe(12);
    expect(FACTORY_KITS.find((k) => k.patch === '909 Kit')!.patterns).toHaveLength(11);
  });

  it('fill-ins (#852, D-831): with FILL let go every pattern plays as its grid; each linked 808 pattern and 909 groove has one', () => {
    const plain = (ns: readonly StepNote[] | undefined) => (ns ?? []).filter((n) => n.cond !== COND_FILL).map(({ cond: _, ...n }) => n);
    for (const kit of FACTORY_KITS) {
      const track = patchOf(kit.patch).modules.find((m) => m.type === 'steps')!;
      const own = (SOURCE as { name: string; patch: { modules: { type: string; notes?: StepNote[] }[] } }[]).find((x) => x.name === kit.patch)!.patch.modules.find((m) => m.type === 'steps')!;
      // (pattern 1 is the factory demonstration pattern the kit's presets swap for their own: it stays as it is)
      expect(track.notes).toEqual(own.notes);
      kit.patterns.forEach((x, k) => {
        const notes = track.patterns![k]!.notes!;
        expect(plain(notes)).toEqual(gridNotes(kit, x.grid));
        expect(notes.some((n) => n.cond === COND_FILL)).toBe(!!x.fill);
        for (const steps of Object.values(x.fill?.grid ?? {})) expect(steps).toMatch(new RegExp(`^[.xXf]{${16 - x.fill!.from}}$`));
      });
    }
    expect(FACTORY_KITS.find((k) => k.patch === '808 Kit')!.patterns.every((x) => x.fill)).toBe(true);
    expect(FACTORY_KITS.find((k) => k.patch === '909 Kit')!.patterns.filter((x) => x.fill).map((x) => x.name))
      .toEqual(['HOUSE', 'TECHNO A', 'TECHNO B', 'ACID', 'JACK', 'GARAGE', 'ELECTRO', 'BREAKS']);
  });

  for (const kit of FACTORY_KITS) {
    it(`${kit.patch}: links its patterns 2.., the binary carries the links, not the notes, and fits`, () => {
      const p = patchOf(kit.patch), dev = deviceView(p, true).patch;
      const main = p.modules.find((m) => m.type === 'fm1')!;
      const track = p.modules.find((m) => m.type === 'steps')!;
      expect(track.patterns).toHaveLength(kit.patterns.length);
      const links = main.seq!.links!;
      kit.patterns.forEach((_, k) => {
        const entry = STORE.find((e) => e.id === kit.first + k)!;
        expect(links[k + 1].id).toBe(kit.first + k);
        expect(links[k + 1].hash).toBe(fnv(FNV0, Uint8Array.from(entry.payload.match(/../g)!, (x) => parseInt(x, 16))));
        expect(decodePayload(Uint8Array.from(entry.payload.match(/../g)!, (x) => parseInt(x, 16))).tracks).toHaveLength(1);
      });
      expect(linkPlan(p, dev, 'assume').refs).toEqual(kit.patterns.map((_, k) => k + 1));
      const bin = encodePatch(p, true, 0, 1);
      expect(bin.length).toBeLessThanOrEqual(DEVICE.bytes);
      expect(deviceBudget(p, 1).over.filter((i) => i.key !== 'cpu')).toEqual([]);
      // (an FM-1 whose store lists none of them, an older firmware: every pattern goes inline, and the patch outgrows it)
      expect(encodePatch(p, true, 0, 1, new Map()).length).toBeGreaterThan(DEVICE.bytes);
      // the songs: over the linked patterns, as the FM-1 shows them
      expect(main.seq!.songs!.map((s) => s.map((e) => e.pat + 1))).toEqual(kit.songs);
      for (const s of kit.songs) {
        expect(s.length).toBeLessThanOrEqual(SONG_LEN_MAX);
        for (const n of s) expect(n).toBeLessThanOrEqual(kit.patterns.length + 1);
      }
      expect(main.seq!.song ?? 0).toBe(0);   // (it loads playing its pattern 1, as before)
    });
  }
});
