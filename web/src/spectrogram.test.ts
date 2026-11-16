// SPDX-License-Identifier: GPL-3.0-only
// The Scope's spectrogram (#940, spectrogram.ts): a column puts a tone at its frequency's height on the log axis, the colour
// scale runs from dark at DB_LO to bright at 0 dB, and the image scrolls one column per update, the lowest row at the bottom.
import { expect, it } from 'vitest';
import { spectrum } from './scope';
import { DB_HI, DB_LO, GRAM_COLS, GRAM_ROWS, Gram, gramColumn, heat, logY } from './spectrogram';

const SR = 48000;
const tone = (f: number): Float32Array => Float32Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR));

it('puts a tone at the height of its frequency on the log axis', () => {
  for (const f of [110, 1000, 8000]) {
    const col = gramColumn(spectrum(tone(f)), SR);
    const loudest = col.indexOf(Math.max(...col));
    expect(Math.abs(loudest - logY(f, SR) * GRAM_ROWS)).toBeLessThanOrEqual(2);
    expect(col[loudest]).toBeGreaterThan(-6);   // (a full-scale sine reads about 0 dB)
    if (f * 4 < SR / 2) expect(Math.max(...col.slice(Math.round(logY(f * 4, SR) * GRAM_ROWS)))).toBeLessThan(-60);   // (nothing far above it)
  }
});

it('colours from dark to bright over DB_LO..DB_HI, held at both ends', () => {
  const lum = (db: number): number => heat(db).reduce((a, b) => a + b, 0);
  expect(heat(DB_LO - 40)).toEqual(heat(DB_LO));
  expect(heat(DB_HI + 10)).toEqual(heat(DB_HI));
  for (let db = DB_LO; db < DB_HI; db += 6) expect(lum(db + 6)).toBeGreaterThan(lum(db));
});

it('writes one column per update, oldest first from `at`, the lowest frequency in the bottom row', () => {
  const g = new Gram();
  const col = new Float32Array(GRAM_ROWS).fill(DB_LO);
  col[0] = DB_HI;
  g.push(col);
  const px = (x: number, y: number): number[] => [...g.image.slice((y * GRAM_COLS + x) * 4, (y * GRAM_COLS + x) * 4 + 3)];
  expect(px(0, GRAM_ROWS - 1)).toEqual(heat(DB_HI));
  expect(px(0, 0)).toEqual(heat(DB_LO));
  expect(g.at).toBe(1);
  for (let i = 1; i < GRAM_COLS; i++) g.push(col);
  expect(g.at).toBe(0);
  expect(g.filled).toBe(GRAM_COLS);
});
