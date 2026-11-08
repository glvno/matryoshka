// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's VOICES row capped at what its CPU holds (owner's ruling of 2026-11-07): a card row's `top` on a Voice
// allocator's voices, set by gen-presets (scripts/factory-build.ts voiceTops) and carried in the binary (format 51).
import { describe, expect, it } from 'vitest';
import { assembliesOf } from './assembly';
import { deviceBudget, encodePatch, FORMAT_1_11, formatOf, POLY_ROW, ROW_MORE } from './patchbin';
import { FM1_PRESETS } from './presets';
import { MAX_PARTS, type Patch } from './patch';

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

describe("the FM-1's VOICES row top", () => {
  it('Cassia 1 stops at the most voices whose CPU estimate fits the FM-1 (six)', () => {
    const p = FM1_PRESETS['Cassia 1']();
    const r = voicesRow(p)!;
    expect(r.top).toBe(6);
    expect(deviceBudget(withVoices(p, 6)).fits).toBe(true);
    expect(deviceBudget(withVoices(p, 7)).fits).toBe(false);
    expect(deviceBudget(withVoices(p, 7)).over.map((o) => o.key)).toEqual(['cpu']);
  });

  it('Oracle V stops at six: five voices with the Prophet-5\'s functions back (#658)', () => {
    expect(voicesRow(FM1_PRESETS['Oracle V']())!.top).toBe(6);
  });

  it('no other factory patch has a top: each fits the FM-1 with eight voices', () => {
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make();
      const r = voicesRow(p);
      if (!r || name === 'Cassia 1' || name === 'Oracle V') continue;   // (Oracle V: its five voices, #658's functions)
      expect(r.top, name).toBeUndefined();
      expect(deviceBudget(withVoices(p, MAX_PARTS)).fits, name).toBe(true);
    }
  });

  it('goes to the FM-1 as the poly row\'s extras (format 51); a row without one is written as before', () => {
    const p = FM1_PRESETS['Cassia 1']();
    expect(formatOf(p)).toBe(FORMAT_1_11);
    const bin = encodePatch(p, true);
    const got = rowBytes(bin)!;
    expect(got[0]).toBe(POLY_ROW | ROW_MORE);
    expect(got[got.length - 1]).toBe(6);
    delete voicesRow(p)!.top;
    const plain = rowBytes(encodePatch(p, true))!;
    expect(plain[0]).toBe(POLY_ROW);
    // (in the same format the top is its one byte)
    expect(encodePatch(p, true, true).length).toBe(bin.length - 1);
  });
});
