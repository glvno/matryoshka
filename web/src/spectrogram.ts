// SPDX-License-Identifier: GPL-3.0-only
// The Scope's scrolling spectrogram (#940, scope-view.ts): each screen update's spectrum (scope.ts spectrum, the last 2048
// samples) becomes one column, the newest at the right; up the screen the frequency on a log axis from 20 Hz to half the
// sample rate, the level in dB as a colour from dark (DB_LO and under) to bright (0 dB, a full-scale sine).

/** the columns a screen keeps: one per screen update (scope-stream.ts DISPLAY_EVERY blocks: about 32 ms), about 5 s */
export const GRAM_COLS = 160;
/** the frequency rows a column is resampled to (the screen scales them to its height) */
export const GRAM_ROWS = 128;
/** the lowest frequency shown (Hz) */
export const GRAM_FMIN = 20;
/** the colour scale's ends (dB): the Scope's spectrum scale */
export const DB_LO = -96;
export const DB_HI = 0;

/** a frequency's height on the log axis, 0 (GRAM_FMIN) .. 1 (sr / 2) */
export const logY = (f: number, sr: number): number => Math.log(f / GRAM_FMIN) / Math.log(sr / 2 / GRAM_FMIN);

/**
 * A spectrum (bins 0..N/2 of an N-point FFT at rate sr, in dB) resampled to `rows` log-spaced rows, the lowest first:
 * each row the loudest bin in its band, or where a band is narrower than a bin, the bins either side interpolated.
 */
export function gramColumn(sp: Float32Array, sr: number, rows = GRAM_ROWS): Float32Array {
  const out = new Float32Array(rows);
  const last = sp.length - 1;
  const binOf = (f: number): number => (f / (sr / 2)) * last;
  const fAt = (y: number): number => GRAM_FMIN * Math.pow(sr / 2 / GRAM_FMIN, y);
  for (let r = 0; r < rows; r++) {
    const lo = binOf(fAt(r / rows)), hi = binOf(fAt((r + 1) / rows));
    const a = Math.ceil(lo), b = Math.min(last, Math.floor(hi));
    if (b >= a) {
      let m = -Infinity;
      for (let k = a; k <= b; k++) m = Math.max(m, sp[k]);
      out[r] = m;
    } else {
      const mid = Math.min(last, (lo + hi) / 2), k = Math.min(last - 1, Math.floor(mid)), t = mid - k;
      out[r] = sp[k] * (1 - t) + sp[k + 1] * t;
    }
  }
  return out;
}

/** the colour scale's stops (dark to bright), as r g b */
const STOPS: [number, number, number][] = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];

/** the colour for a level in dB (DB_LO and under: the darkest, DB_HI and over: the brightest), as r g b */
export function heat(db: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (db - DB_LO) / (DB_HI - DB_LO))) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i;
  const [a, b] = [STOPS[i], STOPS[i + 1]];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** one input's spectrogram: the last GRAM_COLS columns as an image GRAM_COLS wide and GRAM_ROWS high (the lowest row at the
 *  bottom), written one column at a time into a ring (`at`: the next column to write, the oldest) */
export class Gram {
  readonly image = new Uint8ClampedArray(GRAM_COLS * GRAM_ROWS * 4);
  at = 0;
  /** columns written since it was made (up to GRAM_COLS) */
  filled = 0;

  constructor() {
    for (let i = 0; i < GRAM_COLS * GRAM_ROWS; i++) this.image.set([...heat(-Infinity), 255], i * 4);
  }

  push(col: Float32Array): void {
    for (let r = 0; r < GRAM_ROWS; r++) {
      const i = ((GRAM_ROWS - 1 - r) * GRAM_COLS + this.at) * 4;
      const [R, G, B] = heat(col[r]);
      this.image[i] = R;
      this.image[i + 1] = G;
      this.image[i + 2] = B;
      this.image[i + 3] = 255;
    }
    this.at = (this.at + 1) % GRAM_COLS;
    this.filled = Math.min(GRAM_COLS, this.filled + 1);
  }
}
