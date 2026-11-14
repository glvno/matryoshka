// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's VOICES row capped at what its CPU holds (owner's ruling of 2026-11-07): a card row's `top` on a Voice
// allocator's voices, set by gen-presets (scripts/factory-build.ts voiceTops) and carried in the binary (format 51).
import { describe, expect, it } from 'vitest';
import { assembliesOf } from './assembly';
import { CPU_VOICE_TOP } from './cpu';
import { deviceBudget, encodePatch, FORMAT_1_11, formatOf, POLY_ROW, ROW_MORE } from './patchbin';
import { relocatedPatches } from './community-factory';
import type { Patch } from './patch';

const voicesRow = (p: Patch) => assembliesOf(p).flatMap((a) => a.params).find((r) => r.param === 'voices' && p.modules.find((m) => m.id === r.module)?.type === 'alloc');
const withVoices = (p: Patch, v: number): Patch => {
  const q = structuredClone(p);
  for (const m of q.modules) if (m.type === 'alloc') m.params.voices = v;
  return q;
};
/** the bytes of the voices row in the device pages: its parameter byte, its label, what follows */
const rowBytes = (bin: Uint8Array): number[] | undefined => {
  const label = Array.from('voices', (c) => c.charCodeAt(0));
  for (let i = 1; i + 2 + label.length < bin.length; i++)
    if ((bin[i] & ~ROW_MORE) === POLY_ROW && bin[i + 1] === label.length && label.every((c, k) => bin[i + 2 + k] === c)) return Array.from(bin.subarray(i, i + 3 + label.length));
  return undefined;
};

/** the former factory patches whose VOICES row has a top (D-870 as amended 2026-11-08, kept unchanged in Community): the
 * top fits the FM-1's budget with the CPU estimate at CPU_VOICE_TOP or under. It was the most voices that did; the two-core
 * schedule (#802, D-1101) may fit more, and a preserved original does not move */
const TOPS: Record<string, number> = { 'Oracle V': 4, 'Expander S': 6, 'Cassia 1': 4 };

describe("the FM-1's VOICES row top", () => {
  for (const [name, top] of Object.entries(TOPS))
    it(`${name} stops at ${top}, where its CPU estimate stays at ${100 * CPU_VOICE_TOP} % or under`, () => {
      const p = relocatedPatches[name]();
      expect(voicesRow(p)!.top).toBe(top);
      const b = deviceBudget(withVoices(p, top));
      expect(b.fits && b.cpu.use <= CPU_VOICE_TOP).toBe(true);
    });


  it('goes to the FM-1 as the poly row\'s extras (format 51); a row without one is written as before', () => {
    const p = relocatedPatches['Cassia 1']();
    expect(formatOf(p)).toBe(FORMAT_1_11);
    const bin = encodePatch(p, true);
    const got = rowBytes(bin)!;
    expect(got[0]).toBe(POLY_ROW | ROW_MORE);
    expect(got[got.length - 1]).toBe(TOPS['Cassia 1']);
    delete voicesRow(p)!.top;
    const plain = rowBytes(encodePatch(p, true))!;
    expect(plain[0]).toBe(POLY_ROW);
    // (in the same format the top is its one byte)
    expect(encodePatch(p, true, true).length).toBe(bin.length - 1);
  });
});
