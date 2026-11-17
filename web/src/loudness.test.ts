// SPDX-License-Identifier: GPL-3.0-only
// The loudness meter (loudness.ts) against EBU Tech 3341's first test cases: a stereo 1 kHz sine at -23 dBFS reads
// -23 LUFS, at -33 dBFS -33 LUFS, at any rate; a tone with a quiet part reads the loud part alone (the gates). The live
// reading (the Output card, #940) reads the same as the offline measure.
import { expect, it } from 'vitest';
import { integratedLoudness, KMeter, LoudnessReading } from './loudness';
import { renderPlay } from './headroom';
import { HOLD_SECS, keysOf, measure } from './levels';
import { DEVICE_SR } from './modules';
import './factory-presets';
import { PRESETS } from './presets';

const sine = (sr: number, secs: number, db: number): Float32Array => {
  const a = Math.pow(10, db / 20);
  return Float32Array.from({ length: Math.round(sr * secs) }, (_, i) => a * Math.sin((2 * Math.PI * 1000 * i) / sr));
};

it('reads a stereo 1 kHz sine at its level in dBFS', () => {
  for (const sr of [44118, 48000]) {
    for (const db of [-23, -33]) {
      const s = sine(sr, 20, db);
      expect(integratedLoudness(s, s, sr)).toBeCloseTo(db, 1);
    }
  }
});

it('gates out silence and a part more than 10 LU under the rest', () => {
  const sr = 48000;
  const loud = sine(sr, 10, -23);
  const quiet = sine(sr, 10, -50);
  const s = new Float32Array(loud.length + quiet.length + sr * 10);
  s.set(loud, 0);
  s.set(quiet, loud.length);
  expect(Math.abs(integratedLoudness(s, s, sr) + 23)).toBeLessThan(0.1);
});

// ---- the live reading (#940): KMeter in the audio thread, LoudnessReading on the Output card

/** a recording through the live meter as the worklet feeds it, 128 samples at a time */
const live = (l: Float32Array, r: Float32Array | null, sr: number): LoudnessReading => {
  const meter = new KMeter(sr);
  const reading = new LoudnessReading();
  for (let at = 0; at < l.length; at += 128) {
    const n = Math.min(128, l.length - at);
    meter.push(l.subarray(at, at + n), r ? r.subarray(at, at + n) : null, n);
    reading.push(meter.take());
  }
  return reading;
};

it('reads live what integratedLoudness reads, the gates too', () => {
  for (const sr of [44118, 48000]) {
    const s = sine(sr, 5, -23);
    const reading = live(s, s, sr);
    expect(reading.integrated()).toBeCloseTo(-23, 1);
    expect(reading.short()).toBeCloseTo(-23, 1);   // (steady: the last 3 s read the same)
  }
  const sr = 48000;
  const loud = sine(sr, 4, -23), quiet = sine(sr, 4, -50);
  const s = new Float32Array(loud.length + quiet.length + sr * 2);
  s.set(loud, 0);
  s.set(quiet, loud.length);
  expect(Math.abs(live(s, s, sr).integrated() - integratedLoudness(s, s, sr))).toBeLessThan(0.01);
});

it('matches integratedLoudness within 0.1 LU on a factory sound played the way the loudness rule plays it', () => {
  const p = PRESETS['Mono Lead']();
  const got: number[] = [];
  for (const sr of [DEVICE_SR, 48000]) {
    const [l, r] = renderPlay({ label: '', patch: p, notes: keysOf(p).key, run: false }, HOLD_SECS, sr);
    const want = integratedLoudness(l, r, sr);
    expect(Number.isFinite(want)).toBe(true);
    got.push(live(l, r, sr).integrated());
    expect(Math.abs(got.at(-1)! - want)).toBeLessThan(0.1);
  }
  // the browser's rate (48 kHz) against the rule's own measure at the FM-1's rate (levels.ts measure): within 0.25 LU
  expect(Math.abs(got[1] - measure(p).single)).toBeLessThan(0.25);
}, 60_000);

it('starts the integrated reading again at a reset, and has none before a block', () => {
  const sr = 48000;
  const meter = new KMeter(sr);
  const reading = new LoudnessReading();
  const loud = sine(sr, 2, -10), soft = sine(sr, 2, -30);
  meter.push(loud, loud, loud.length);
  reading.push(meter.take());
  expect(reading.integrated()).toBeCloseTo(-10, 0);
  reading.reset();
  expect(reading.integrated()).toBe(-Infinity);
  expect(reading.short()).toBe(-Infinity);
  expect(reading.seconds()).toBe(0);
  meter.push(soft, soft, soft.length);
  reading.push(meter.take());
  expect(reading.integrated()).toBeCloseTo(-30, 0);   // (the loud part before the reset is gone; the filters' tail is gated out)
});
