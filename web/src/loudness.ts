// SPDX-License-Identifier: GPL-3.0-only
// Loudness (#448): ITU-R BS.1770-4 integrated loudness, in LUFS (loudness units relative to full scale). Each channel goes
// through the K-weighting (a high shelf about +4 dB above 1.5 kHz, then a high pass at 38 Hz), its mean square is taken
// over 400 ms blocks that overlap by 75 %, and the blocks are gated: those under -70 LUFS are dropped, then those more
// than 10 LU under the mean of the rest. The left and right channels weigh 1 each. The filter coefficients for any rate
// are worked out from the standard's analogue prototypes, as libebur128 does.

/** the K-weighting's two biquads at a rate: [b0, b1, b2, a1, a2] each */
function kWeights(sr: number): [number, number, number, number, number][] {
  // stage 1: the high shelf (the head's acoustic effect)
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: [number, number, number, number, number] = [
    (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0,
  ];
  // stage 2: the high pass (RLB weighting)
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const hp: [number, number, number, number, number] = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, hp];
}

/** a channel K-weighted and squared */
function weightedSquares(x: Float32Array, sr: number): Float64Array {
  const out = new Float64Array(x.length);
  const stages = kWeights(sr);
  let y: ArrayLike<number> = x;
  for (const [b0, b1, b2, a1, a2] of stages) {
    const z = new Float64Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const w = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = w;
      z[i] = w;
    }
    y = z;
  }
  for (let i = 0; i < out.length; i++) out[i] = y[i] * y[i];
  return out;
}

/** loudness of a mean square sum, in LUFS */
const lufsOf = (ms: number): number => -0.691 + 10 * Math.log10(ms);

/** the integrated, gated loudness of a stereo (or mono: `r` left out) signal at rate `sr`, in LUFS; -Infinity for one
 * shorter than a block or silent below the absolute gate */
export function integratedLoudness(l: Float32Array, r: Float32Array | null, sr: number): number {
  const chans = [l, ...(r ? [r] : [])].map((c) => weightedSquares(c, sr));
  const block = Math.round(0.4 * sr);
  const hop = Math.round(0.1 * sr);
  if (l.length < block) return -Infinity;
  // running sums over each channel, so each block's mean is a difference
  const sums = chans.map((c) => {
    const s = new Float64Array(c.length + 1);
    for (let i = 0; i < c.length; i++) s[i + 1] = s[i] + c[i];
    return s;
  });
  const blocks: number[] = [];
  for (let at = 0; at + block <= l.length; at += hop) {
    let z = 0;
    for (const s of sums) z += (s[at + block] - s[at]) / block;
    blocks.push(z);
  }
  const loud = blocks.filter((z) => z > 0 && lufsOf(z) > -70);
  if (!loud.length) return -Infinity;
  const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
  const gate = lufsOf(mean(loud)) - 10;
  const kept = loud.filter((z) => lufsOf(z) > gate);
  return lufsOf(mean(kept));
}
