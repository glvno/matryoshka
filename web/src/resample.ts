// SPDX-License-Identifier: GPL-3.0-only
// A band-limited stereo resampler (#941): the FM-1 engine renders at the FM-1's rate (DEVICE_SR, 44118 Hz), the
// AudioContext runs at its own (44100, 48000, ...). Windowed-sinc interpolation from a table of PHASES kernels, linearly
// interpolated between neighbouring kernels: within -70 dB of the ideal to 19 kHz, about 1 dB down at 20 kHz. The source is pulled a
// block at a time as the output needs it.

/** kernels in the table, between two input samples */
const PHASES = 512;
/** input samples each output sample is made from */
const TAPS = 64;
const HALF = TAPS / 2;
/** Kaiser window shape (about 80 dB stopband) */
const BETA = 8;

/** the zeroth-order modified Bessel function (the Kaiser window's) */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** the kernels: row p (0..PHASES) weights input samples i0 - HALF + 1 .. i0 + HALF for an output at i0 + p / PHASES.
 *  `cutoff`: the passband edge as a fraction of the input's Nyquist frequency. Each row sums to 1 (DC passes exactly) */
function kernels(cutoff: number): Float32Array {
  const t = new Float32Array((PHASES + 1) * TAPS);
  const norm = bessel0(BETA);
  for (let p = 0; p <= PHASES; p++) {
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const tau = p / PHASES + HALF - 1 - j;
      const x = Math.PI * cutoff * tau;
      const sinc = tau === 0 ? 1 : Math.sin(x) / x;
      const w = Math.abs(tau) >= HALF ? 0 : bessel0(BETA * Math.sqrt(1 - (tau / HALF) ** 2)) / norm;
      t[p * TAPS + j] = cutoff * sinc * w;
      sum += t[p * TAPS + j];
    }
    for (let j = 0; j < TAPS; j++) t[p * TAPS + j] /= sum;
  }
  return t;
}

/** the source: up to l.length frames into l / r; returns how many it wrote (at least one) */
export type Produce = (l: Float32Array, r: Float32Array) => number;

export class Resampler {
  /** input samples per output sample */
  readonly ratio: number;
  private readonly table: Float32Array | null;
  private l: Float32Array;
  private r: Float32Array;
  /** valid samples in l / r */
  private len: number;
  /** where the next output sample is, in input samples from l[0] */
  private pos: number;

  constructor(inRate: number, outRate: number, private readonly produce: Produce, private readonly block = 128) {
    this.ratio = inRate / outRate;
    // the same rate: a copy. Otherwise the cutoff is at 0.94 of the lower rate's Nyquist frequency
    this.table = inRate === outRate ? null : kernels(0.94 * Math.min(1, outRate / inRate));
    const room = 4 * block + TAPS + Math.ceil(this.ratio * block);
    this.l = new Float32Array(room);
    this.r = new Float32Array(room);
    // HALF zeros before the first input sample, so the first outputs have a full window; output sample i is the input at
    // i * ratio (the source runs HALF input samples ahead, about half a millisecond)
    this.len = this.table ? HALF : 0;
    this.pos = this.table ? HALF : 0;
  }

  /** n output frames into outL / outR */
  pull(outL: Float32Array, outR: Float32Array, n: number): void {
    const t = this.table;
    for (let i = 0; i < n; i++) {
      const i0 = Math.floor(this.pos);
      while (this.len < i0 + (t ? HALF + 1 : 1)) this.more();
      if (!t) {
        outL[i] = this.l[i0];
        outR[i] = this.r[i0];
      } else {
        const f = (this.pos - i0) * PHASES;
        const p = Math.floor(f);
        const a = f - p;
        const k0 = p * TAPS;
        const k1 = k0 + TAPS;
        const s = i0 - HALF + 1;
        let yl = 0;
        let yr = 0;
        for (let j = 0; j < TAPS; j++) {
          const w = t[k0 + j] + a * (t[k1 + j] - t[k0 + j]);
          yl += w * this.l[s + j];
          yr += w * this.r[s + j];
        }
        outL[i] = yl;
        outR[i] = yr;
      }
      this.pos += t ? this.ratio : 1;
    }
    this.compact();
  }

  /** one more block from the source at the end of the buffer */
  private more(): void {
    if (this.len + this.block > this.l.length) {
      const grow = (b: Float32Array): Float32Array => { const x = new Float32Array(2 * b.length); x.set(b); return x; };
      this.l = grow(this.l);
      this.r = grow(this.r);
    }
    this.len += this.produce(this.l.subarray(this.len, this.len + this.block), this.r.subarray(this.len, this.len + this.block));
  }

  /** drop the samples no later output reads */
  private compact(): void {
    const drop = Math.floor(this.pos) - (this.table ? HALF - 1 : 0);
    if (drop <= 0) return;
    this.l.copyWithin(0, drop, this.len);
    this.r.copyWithin(0, drop, this.len);
    this.len -= drop;
    this.pos -= drop;
  }
}
