// SPDX-License-Identifier: GPL-3.0-only
// The FFT behind the Scope module's spectrum view (scope-view.ts).
const FFT_N = 2048;

/** in-place radix-2 FFT of re / im (length a power of two) */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** the magnitude spectrum (dB, 0 = full scale sine) of the last FFT_N samples, Hann windowed; bins 0..N/2 */
export function spectrum(data: Float32Array): Float32Array {
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  const off = Math.max(0, data.length - FFT_N);
  for (let i = 0; i < FFT_N; i++) re[i] = (data[off + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));
  fft(re, im);
  const out = new Float32Array(FFT_N / 2 + 1);
  for (let i = 0; i <= FFT_N / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / (FFT_N / 4) + 1e-9); // a full-scale sine reads 0 dB
  return out;
}
