// SPDX-License-Identifier: GPL-3.0-only
// The loudness meter (loudness.ts) against EBU Tech 3341's first test cases: a stereo 1 kHz sine at -23 dBFS reads
// -23 LUFS, at -33 dBFS -33 LUFS, at any rate; a tone with a quiet part reads the loud part alone (the gates).
import { expect, it } from 'vitest';
import { integratedLoudness } from './loudness';

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
