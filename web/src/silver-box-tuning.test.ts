// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { around } from '../scripts/factory-build';
import { Engine } from './engine';
import { DEFS, DEVICE_SR } from './modules';
import { rowDef } from './patch';

/** the fundamental of a held A4 (the Silver Box plays it an octave down) on the square wave (one clean pair of edges per
 * cycle: on the saw the filtered edge adds zero crossings), from the upward zero crossings over one second */
function pitch(tuning: number): number {
  const { p, set } = around('test', 'Silver Box');
  set('waveform', 2); // SQUARE: one zero crossing per cycle (the saw's filtered edge adds more)
  set('cut off freq', 5000);
  set('tuning', tuning);
  const e = new Engine(DEVICE_SR);
  e.load(p);
  e.noteOn(69, 0.5);
  const l = new Float32Array(128), r = new Float32Array(128);
  for (let i = 0; i < 40; i++) e.render(l, r);
  let first = -1, lastAt = -1, count = 0, prev = 0, t = 0;
  while (t < DEVICE_SR) {
    e.render(l, r);
    for (const v of l) {
      if (prev <= 0 && v > 0) {
        const at = t - 1 + -prev / (v - prev); // the crossing, between this sample and the last
        if (first < 0) first = at;
        else count++;
        lastAt = at;
      }
      prev = v;
      t++;
    }
  }
  return (count * DEVICE_SR) / (lastAt - first);
}

it('Silver Box TUNING spans the TB-303 knob\'s ±500 cents, and no more', () => {
  const mid = pitch(0.5);
  expect(mid).toBeGreaterThan(218);
  expect(mid).toBeLessThan(222);
  const cents = (f: number): number => 1200 * Math.log2(f / mid);
  expect(Math.abs(cents(pitch(1)) - 500)).toBeLessThan(3);
  expect(Math.abs(cents(pitch(0)) + 500)).toBeLessThan(3);
  // the row's ends are the knob's: the row is a Macro, 0 .. 1, so turning it all the way stops at ±5 semitones
  const { a, p } = around('test', 'Silver Box');
  const row = a.params.find((r) => r.label === 'tuning')!;
  const m = p.modules.find((x) => x.id === row.module)!;
  const pd = rowDef(DEFS[m.type], row.param)!;
  expect([pd.min, pd.max, pd.top ?? pd.max, m.params[row.param]]).toEqual([0, 1, 1, 0.5]);
});
