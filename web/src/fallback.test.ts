// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cpuEstimate } from './cpu';
import { Engine } from './engine';
import { fallbackPatch } from './fallback';
import { deviceBudget, encodePatch } from './patchbin';

describe('the fallback patch (safe mode)', () => {
  it('fits the FM-1 with room to spare: it must never overload', () => {
    const p = fallbackPatch();
    expect(deviceBudget(p).fits).toBe(true);
    expect(cpuEstimate(p).use).toBeLessThan(0.2);
    expect(encodePatch(p).length).toBeLessThan(512);
  });

  it('is silent without a key and plays one', () => {
    const e = new Engine(44100);
    e.load(fallbackPatch());
    const L = new Float32Array(128), R = new Float32Array(128);
    const peak = (): number => {
      let m = 0;
      for (let b = 0; b < 40; b++) {
        e.render(L, R);
        for (const v of L) m = Math.max(m, Math.abs(v));
      }
      return m;
    };
    expect(peak()).toBe(0);
    e.noteOn(60, 0.8);
    expect(peak()).toBeGreaterThan(0.05);
  });
});
