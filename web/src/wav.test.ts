// SPDX-License-Identifier: GPL-3.0-only
// The WAV export's file (#946): 44.1 kHz stereo 32-bit float, the samples untouched; the name carries the patch and date.
import { describe, expect, it } from 'vitest';
import { WAV_RATE, encodeWav, joinChunks, wavName } from './wav';

describe('encodeWav', () => {
  it('writes a 44.1 kHz stereo float WAV that keeps every sample as it is, past full scale too', () => {
    const l = new Float32Array([0, 0.5, -1, 1.5]), r = new Float32Array([0.25, -0.25, 2, -3]);
    const bytes = encodeWav(l, r);
    const v = new DataView(bytes.buffer);
    const text = (at: number, n: number): string => String.fromCharCode(...bytes.subarray(at, at + n));
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
    expect(v.getUint16(20, true)).toBe(3);   // IEEE float
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(WAV_RATE);
    expect(v.getUint32(28, true)).toBe(WAV_RATE * 8);
    expect(v.getUint16(32, true)).toBe(8);
    expect(v.getUint16(34, true)).toBe(32);
    expect(v.getUint32(40, true)).toBe(4 * 8);
    const back = Array.from({ length: 8 }, (_, i) => v.getFloat32(44 + i * 4, true));
    expect(back).toEqual([0, 0.25, 0.5, -0.25, -1, 2, 1.5, -3]);
  });
});

describe('wavName', () => {
  it('names the patch, what was rendered and the local date and time', () => {
    expect(wavName('Glass_Bell', 'Chord-C4', new Date(2026, 10, 6, 9, 5))).toBe('Glass_Bell_Chord-C4_2026-11-06_0905.wav');
  });
});

describe('joinChunks', () => {
  it('joins the recording in order', () => {
    expect(Array.from(joinChunks([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]))).toEqual([1, 2, 3]);
  });
});
