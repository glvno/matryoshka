// SPDX-License-Identifier: GPL-3.0-only
// Integrated loudness after ITU-R BS.1770-4 (K-weighting, 400 ms blocks with 75 % overlap, the -70 LUFS absolute and
// -10 LU relative gates), and the sample peak. Used by listen-renders.ts.

/** a biquad (b0 b1 b2 a1 a2, a0 = 1) run over x */
function biquad(x: Float32Array, [b0, b1, b2, a1, a2]: number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** the two K-weighting stages for sample rate sr (the standard's 48 kHz filters, re-derived for any rate) */
function kStages(sr: number): number[][] {
  let K = Math.tan((Math.PI * 1681.974450955533) / sr);
  const Q1 = 0.7071752369554196, Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q1 + K * K;
  const shelf = [(Vh + (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0];
  K = Math.tan((Math.PI * 38.13547087602444) / sr);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0];
  return [shelf, hp];
}

/** integrated loudness in LUFS of the channels (left, right), -Infinity for silence */
export function lufs(channels: Float32Array[], sr: number): number {
  const [shelf, hp] = kStages(sr);
  const z = channels.map((c) => biquad(Float32Array.from(biquad(c, shelf)), hp));
  const len = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), n = channels[0].length;
  const powers: number[] = [];
  for (let s = 0; s + len <= n; s += hop) {
    let p = 0;
    for (const zc of z) {
      let acc = 0;
      for (let i = s; i < s + len; i++) acc += zc[i] * zc[i];
      p += acc / len;
    }
    powers.push(p);
  }
  const L = (p: number): number => -0.691 + 10 * Math.log10(p);
  const mean = (ps: number[]): number => ps.reduce((a, b) => a + b, 0) / ps.length;
  const abs = powers.filter((p) => L(p) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(mean(abs)) - 10;
  const gated = abs.filter((p) => L(p) > rel);
  return L(mean(gated));
}

/** the largest absolute sample over the channels, in dBFS */
export function peakDb(channels: Float32Array[]): number {
  let m = 0;
  for (const c of channels) for (const v of c) m = Math.max(m, Math.abs(v));
  return 20 * Math.log10(m);
}
