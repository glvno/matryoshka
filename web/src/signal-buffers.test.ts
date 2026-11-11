// SPDX-License-Identifier: GPL-3.0-only
import { chipOf } from './sandbox';
import { describe, expect, it } from 'vitest';
import { bufferAllocation } from './signal-buffers';
import { recoveredLines } from './test-buffer-budget';
import { BUF_BYTES, deviceBudget, encodePatch, lineBudget } from './patchbin';
import { CMD, parseInfo } from './protocol';

describe('signal-buffer allocation rule', () => {
  it('defaults missing and unknown INFO rules to conservative admission', () => {
    for (const rule of [undefined, 0, 2, 255]) {
      const payload = [1, 128, 255, 3, 255, 0, 0, 31, 53, 1, 13, 0, 0, ...(rule === undefined ? [] : [rule])];
      expect(bufferAllocation(parseInfo({ cmd: CMD.info, payload })?.bufferAllocation)).toBe(0);
    }
    expect(bufferAllocation(parseInfo({ cmd: CMD.info, payload: [1, 128, 255, 3, 255, 0, 0, 31, 53, 0, 0, 0, 0, 1] })?.bufferAllocation)).toBe(1);
  });
  it('charges actual physical buffers only under rule 1 while preserving logical caps, CPU, and encoded bytes', () => {
    const p = recoveredLines(), old = deviceBudget(p), shared = deviceBudget(p, 1);
    expect(old.over.map((x) => x.key)).toEqual(['memory']);
    expect(shared.fits).toBe(true);
    expect(chipOf(p, 1).fits).toBe(true);
    expect(chipOf(p).fits).toBe(false);
    expect(chipOf(p, 1).fits).toBe(true); // cache is keyed by capability too
    expect(shared.buffers).toBe(old.buffers);
    expect(shared.cpu).toEqual(old.cpu);
    expect(shared.items.filter((x) => x.key !== 'memory')).toEqual(old.items.filter((x) => x.key !== 'memory'));
    expect(old.lines.used - shared.lines.used).toBe((86 - 3) * BUF_BYTES);
    expect(lineBudget(p, 1)).toEqual(shared.lines);
    expect(() => encodePatch(p)).toThrow('over the FM-1 budget');
    expect(encodePatch(p, false, false, 1)).toEqual(encodePatch(p, true));
  });
});
