// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { around } from '../scripts/factory-build';
import { Engine } from './engine';
import { DEVICE_SR } from './modules';

/** the fundamental of a held A4 (the Silver Box plays it an octave down) from the upward zero crossings over one second */
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

it('Silver Box TUNING reaches the TB-303 knob\'s ±500 cents', () => {
  const at0 = pitch(0);
  expect(at0).toBeGreaterThan(215);
  expect(at0).toBeLessThan(225);
  expect(pitch(5 / 12) / at0).toBeCloseTo(2 ** (5 / 12), 2);
  expect(pitch(-5 / 12) / at0).toBeCloseTo(2 ** (-5 / 12), 2);
});
