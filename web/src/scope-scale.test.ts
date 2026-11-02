// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AUTO_HOLD_MS, AutoRange, autoScale, extent, fixedScale, niceStep, perDivision, scopeNum, scopeScale } from './scope';
import { DEFS, SCOPE_SCALES } from './modules';
import { addModule, emptyPatch, validatePatch } from './patch';
import { encodePatch } from './patchbin';
import { readoutLines } from './scope-view';

describe('Scope scale (#518)', () => {
  it('steps are 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceStep(0.3)).toBe(0.5);
    expect(niceStep(0.5)).toBe(0.5);
    expect(niceStep(0.21)).toBe(0.25);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(7)).toBe(10);
  });

  it('fixed scales are ±1 and ±4 with labelled gridlines every half', () => {
    expect(fixedScale(1)).toEqual({ lo: -1, hi: 1, lines: [-1, -0.5, 0, 0.5, 1] });
    expect(scopeScale('±4', 0, 0.1)).toEqual({ lo: -4, hi: 4, lines: [-4, -2, 0, 2, 4] });
    expect(scopeScale('±1', -9, 9).hi).toBe(1);
  });

  it('auto fits a bipolar signal evenly around 0', () => {
    expect(autoScale(-0.98, 0.99)).toEqual({ lo: -1, hi: 1, lines: [-1, -0.5, 0, 0.5, 1] });
    const s = autoScale(-0.2, 0.15);
    expect([s.lo, s.hi]).toEqual([-0.2, 0.2]);
    expect(s.lines).toContain(0);
  });

  it('auto keeps 0 in sight for an envelope and fits a far-off signal alone', () => {
    const env = autoScale(0, 0.8);
    expect([env.lo, env.hi]).toEqual([0, 0.8]);
    expect(env.lines[0]).toBe(0);
    const pitch = autoScale(2.9, 3.1);
    expect(pitch.lo).toBeGreaterThan(2.5);
    expect(pitch.hi).toBeLessThan(3.5);
    expect(pitch.lo).toBeLessThanOrEqual(2.9);
    expect(pitch.hi).toBeGreaterThanOrEqual(3.1);
  });

  it('auto shows a constant from 0 to it, and nothing as ±1', () => {
    expect(autoScale(0.5, 0.5)).toMatchObject({ lo: 0, hi: 0.5 });
    expect(autoScale(-2, -2)).toMatchObject({ lo: -2, hi: 0 });
    expect(autoScale(0, 0)).toEqual(fixedScale(1));
    expect(autoScale(Infinity, -Infinity)).toEqual(fixedScale(1));
  });

  it('every gridline lies within the scale', () => {
    for (const [lo, hi] of [[-0.3, 0.7], [0.1, 0.9], [-3.3, -0.2], [12, 13], [-0.001, 0.002]]) {
      const s = autoScale(lo, hi);
      expect(s.lo).toBeLessThanOrEqual(lo);
      expect(s.hi).toBeGreaterThanOrEqual(hi);
      for (const l of s.lines) expect(l >= s.lo - 1e-9 && l <= s.hi + 1e-9).toBe(true);
      expect(s.lines.length).toBeGreaterThanOrEqual(2);
      expect(s.lines.length).toBeLessThanOrEqual(9);
    }
  });

  it('auto grows at once and shrinks only after the hold', () => {
    const a = new AutoRange();
    expect(a.next(-1, 1, 0).hi).toBe(1);
    expect(a.next(-0.1, 0.1, 10).hi).toBe(1);
    expect(a.next(-0.1, 0.1, 10 + AUTO_HOLD_MS - 1).hi).toBe(1);
    expect(a.next(-0.1, 0.1, 10 + AUTO_HOLD_MS).hi).toBe(0.1);
    expect(a.next(-3, 3, 10 + AUTO_HOLD_MS + 1).hi).toBe(3);
  });

  it('labels the time per division and the values', () => {
    expect(perDivision(16)).toBe('1.6 ms/div');
    expect(perDivision(2000)).toBe('200 ms/div');
    expect(perDivision(1)).toBe('100 µs/div');
    expect(scopeNum(-0.5)).toBe('−0.5');
    expect(scopeNum(1e-12)).toBe('0');
    expect(extent(new Float32Array([0.5, -2, NaN]), [3])).toEqual({ lo: -2, hi: 3 });
  });

  it('the readout gives each cabled input its lowest..highest, peak to peak, source and range', () => {
    const chans = [[{ id: 2, port: 'out', kind: 'control', label: 'LFO out', range: () => '−1..1 (±1 × depth)' }], []];
    expect(readoutLines(chans, [{ i: 0, lo: -0.98, hi: 0.99 }])).toEqual([
      { input: 'a', kind: 'control', value: '−0.98..0.99  p-p 1.97', from: 'LFO out', range: '−1..1 (±1 × depth)' },
    ]);
    expect(readoutLines(chans, null)[0].value).toBe('–');
    const two = [[], [{ id: 2, port: 'out', kind: 'audio', label: 'VCO out' }, { id: 3, port: 'out', kind: 'audio', label: 'Noise out', range: () => 'x' }]];
    expect(readoutLines(two, [{ i: 1, lo: Infinity, hi: -Infinity }])).toEqual([{ input: 'b', kind: 'audio', value: '–', from: 'VCO out + Noise out', range: '' }]);
  });

  it('the scale is an editor-only parameter: a patch with it encodes as without it, an old patch loads as auto', () => {
    expect(DEFS.scope.params.find((q) => q.name === 'scale')?.choices).toEqual(SCOPE_SCALES);
    const p = emptyPatch('s');
    addModule(p, DEFS.fm1, 0, 0);
    const sc = addModule(p, DEFS.scope, 0, 0);
    const before = encodePatch(p);
    sc.params.scale = 2;
    expect(encodePatch(p)).toEqual(before);
    const old = JSON.parse(JSON.stringify(p));
    delete old.modules[1].params.scale;
    expect(validatePatch(old, DEFS).modules[1].params.scale).toBe(0);
  });
});
