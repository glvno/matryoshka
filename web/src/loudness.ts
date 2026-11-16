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

// ---- live loudness (#940): the same measure, fed as the audio plays

/** a streaming biquad's state: x1 x2 y1 y2 */
type BiquadState = Float64Array;

/**
 * The live loudness meter's audio side (worklet.ts): each channel K-weighted as integratedLoudness does it, and the
 * squares summed over 100 ms steps (the blocks' hop). `take` hands over each finished step's mean square (the channels
 * added, as a block's power is), oldest first.
 */
export class KMeter {
  /** samples per step: integratedLoudness's hop */
  readonly hop: number;
  private stages: [number, number, number, number, number][];
  private state: BiquadState[][];
  private acc = 0;
  private n = 0;
  private done: number[] = [];

  constructor(sr: number) {
    this.hop = Math.round(0.1 * sr);
    this.stages = kWeights(sr);
    this.state = [0, 1].map(() => this.stages.map(() => new Float64Array(4)));
  }

  /** n samples of the left and right channels (`r` null: mono) */
  push(l: Float32Array, r: Float32Array | null, n: number): void {
    const chans = r ? [l, r] : [l];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < chans.length; c++) {
        let v: number = chans[c][i];
        const st = this.state[c];
        for (let k = 0; k < this.stages.length; k++) {
          const [b0, b1, b2, a1, a2] = this.stages[k];
          const s = st[k];
          const w = b0 * v + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
          s[1] = s[0]; s[0] = v; s[3] = s[2]; s[2] = w;
          v = w;
        }
        this.acc += v * v;
      }
      if (++this.n === this.hop) {
        this.done.push(this.acc / this.hop);
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  /** the steps finished since the last take, their mean squares */
  take(): number[] {
    const out = this.done;
    this.done = [];
    return out;
  }
}

/** steps of 100 ms in a 400 ms block (BS.1770) and in the 3 s short-term window (EBU R 128) */
const BLOCK_STEPS = 4;
const SHORT_STEPS = 30;

/**
 * The live loudness meter's reading (the Output card, loudness-view.ts), from KMeter's steps: the short-term loudness
 * (the last 3 s, ungated) and the integrated loudness since the last reset, gated as integratedLoudness gates it, over
 * 400 ms blocks every 100 ms. Fed with the steps of a whole recording it reads what integratedLoudness reads for it.
 */
export class LoudnessReading {
  private steps: number[] = [];
  /** each 400 ms block's power (the mean of its four steps) since the reset */
  private blocks: number[] = [];
  /** the integrated reading, worked out again only after new blocks */
  private cached: number | null = null;

  push(steps: readonly number[]): void {
    for (const z of steps) {
      this.steps.push(z);
      if (this.steps.length > SHORT_STEPS) this.steps.shift();
      const n = this.steps.length;
      if (n < BLOCK_STEPS) continue;
      let s = 0;
      for (let i = n - BLOCK_STEPS; i < n; i++) s += this.steps[i];
      this.blocks.push(s / BLOCK_STEPS);
      this.cached = null;
    }
  }

  /** the short-term loudness, LUFS (fewer than 3 s since the reset: over what there is); -Infinity before a block */
  short(): number {
    if (this.steps.length < BLOCK_STEPS) return -Infinity;
    let s = 0;
    for (const z of this.steps) s += z;
    return s > 0 ? lufsOf(s / this.steps.length) : -Infinity;
  }

  /** the integrated loudness since the reset, LUFS; -Infinity before a block over the absolute gate */
  integrated(): number {
    if (this.cached !== null) return this.cached;
    const loud = this.blocks.filter((z) => z > 0 && lufsOf(z) > -70);
    if (!loud.length) return (this.cached = -Infinity);
    const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
    const gate = lufsOf(mean(loud)) - 10;
    return (this.cached = lufsOf(mean(loud.filter((z) => lufsOf(z) > gate))));
  }

  /** seconds the integrated reading covers (every block since the reset, the gated ones too) */
  seconds(): number {
    return this.blocks.length ? (this.blocks.length + BLOCK_STEPS - 1) / 10 : 0;
  }

  reset(): void {
    this.steps = [];
    this.blocks = [];
    this.cached = null;
  }
}
