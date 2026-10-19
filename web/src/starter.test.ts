// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { STARTER, starterPatch } from './starter';
import { deviceBudget, encodePatch } from './patchbin';
import { Engine } from './engine';

describe('the first-run patch', () => {
  it('is the factory Vernon 100, fits the FM-1 and plays a chord without clipping', () => {
    const p = starterPatch();
    expect(p.name).toBe(STARTER);
    expect(p.assemblies?.some((a) => a.name === 'Vernon 100')).toBe(true);
    const b = deviceBudget(p);
    expect(b.over, JSON.stringify(b.over)).toEqual([]);
    expect(() => encodePatch(p)).not.toThrow();
    const e = new Engine(48000);
    e.load(p);
    for (const n of [57, 60, 64, 67]) e.noteOn(n);
    const N = 48000 * 2;
    const l = new Float32Array(N), r = new Float32Array(N);
    e.render(l, r);
    let peak = 0, sum = 0;
    for (let i = N / 2; i < N; i++) { peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i])); sum += l[i] * l[i]; }
    const rms = Math.sqrt(sum / (N / 2));
    expect(rms).toBeGreaterThan(0.03);
    expect(peak).toBeLessThan(0.99);
  });
});
