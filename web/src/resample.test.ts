// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Resampler } from './resample';

const IN = 44118;

/** a sine at f Hz, rate IN, as a block source */
function sine(f: number): (l: Float32Array, r: Float32Array) => number {
  let k = 0;
  return (l, r) => {
    for (let i = 0; i < l.length; i++, k++) {
      l[i] = Math.sin((2 * Math.PI * f * k) / IN);
      r[i] = -l[i];
    }
    return l.length;
  };
}

/** n samples of the resampled sine past the first `skip` (the window filling) and the worst error against the ideal one */
function error(f: number, out: number, n = 8192, skip = 512): { err: number; right: number } {
  const rs = new Resampler(IN, out, sine(f));
  const l = new Float32Array(skip + n);
  const r = new Float32Array(skip + n);
  for (let at = 0; at < l.length; at += 128) rs.pull(l.subarray(at), r.subarray(at), Math.min(128, l.length - at));
  let err = 0;
  let right = 0;
  for (let i = skip; i < skip + n; i++) {
    const want = Math.sin((2 * Math.PI * f * i) / out);
    err = Math.max(err, Math.abs(l[i] - want));
    right = Math.max(right, Math.abs(r[i] + l[i]));
  }
  return { err, right };
}

it('takes the FM-1 rate to 48 kHz and 44.1 kHz at the same pitch, flat and clean through the audible band', () => {
  for (const out of [48000, 44100]) {
    for (const f of [100, 1000, 5000, 12000, 19000]) {
      const { err, right } = error(f, out);
      expect(err, `${f} Hz at ${out}`).toBeLessThan(1e-3);   // (-60 dB: phase, level and the images together)
      expect(right).toBeLessThan(1e-6);                       // (the right side the same way)
    }
  }
});

it('copies when the rates are the same', () => {
  const rs = new Resampler(IN, IN, sine(440));
  const l = new Float32Array(300);
  const r = new Float32Array(300);
  rs.pull(l, r, 300);
  for (let i = 0; i < 300; i++) expect(l[i]).toBeCloseTo(Math.sin((2 * Math.PI * 440 * i) / IN), 6);
});

it('pulls only the source blocks the output needs', () => {
  let made = 0;
  const src = sine(440);
  const rs = new Resampler(IN, 48000, (l, r) => (made += l.length, src(l, r)));
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  for (let b = 0; b < 375; b++) rs.pull(l, r, 128);   // one second at 48 kHz
  expect(made).toBeGreaterThanOrEqual(IN);
  expect(made).toBeLessThanOrEqual(IN + 2 * 128);
});
