import { describe, expect, it } from 'vitest';
import { lufs, peakDb } from './loudness';

const sine = (amp: number, hz: number, sr: number, secs: number): Float32Array =>
  Float32Array.from({ length: Math.round(sr * secs) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));

describe('loudness', () => {
  it('reads a stereo 997 Hz sine at -20 dBFS as -20 LUFS (BS.1770 reference)', () => {
    for (const sr of [44100, 48000]) {
      const s = sine(0.1, 997, sr, 5);
      expect(lufs([s, s], sr)).toBeCloseTo(-20, 1);
    }
  });
  it('gates out silence and reads it as -Infinity', () => {
    const quiet = new Float32Array(44100 * 3);
    expect(lufs([quiet, quiet], 44100)).toBe(-Infinity);
    const s = sine(0.1, 997, 44100, 3);
    const padded = new Float32Array(44100 * 9);
    padded.set(s, 0);
    expect(Math.abs(lufs([padded, padded], 44100) + 20)).toBeLessThan(0.5); // (the blocks across the edge count, a little quieter)
  });
  it('gives the sample peak in dBFS', () => {
    expect(peakDb([sine(0.5, 997, 44100, 1)])).toBeCloseTo(-6.02, 1);
  });
});
