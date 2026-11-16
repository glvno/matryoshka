// SPDX-License-Identifier: GPL-3.0-only
// Listening to one signal (#939): the speakers play an output (or a cable's source) on its own instead of the Output, as a
// hardware modular user puts headphones on a jack. Browser only: nothing goes to the FM-1. The worklet mixes it in after
// the engine has rendered (Engine.probe: a module that runs once per voice gives the sum of its voices, what a cable from
// it carries); whatever comes after that point in the patch (effects, the VCA, the Output's own cables) is not heard.
// The signal plays at the Output's level, as if it were cabled straight into the Output, through a DC blocker and a
// limiter that keeps its peaks under the factory peak cap (headroom.ts HEADROOM). Only audio outputs can be listened to:
// a control, gate or pitch signal played as audio is a click or a DC step, so it goes on a Scope instead.

/** an output listened to: a module's port (several: a merged jack, summed) */
export interface ListenSource {
  id: number;
  port: string;
}

/** the limiter's ceiling: the factory sounds' peak cap (headroom.ts HEADROOM, kept apart so the worklet stays small) */
export const LISTEN_CEILING = 0.88;
/** the limiter lets go with this time constant (s) */
const RELEASE_S = 0.15;
/** the DC blocker's corner (Hz): a high pass far under the audible range */
const DC_HZ = 5;
/** the fade between the Output and the listened signal (s), so switching does not click */
const FADE_S = 0.01;

/** an output of this kind can be listened to: only audio */
export const listenable = (kind: string | undefined): boolean => kind === 'audio';

/**
 * The listened signal mixed over the Output in the audio thread: the sources summed, at a gain (the Output's level),
 * DC-blocked and limited to LISTEN_CEILING, faded in over FADE_S; `set(null)` fades back to the Output.
 */
export class ListenMix {
  /** what is listened to; and what is summed (it stays while the mix fades back to the Output) */
  private srcs: ListenSource[] | null = null;
  private heard: ListenSource[] | null = null;
  /** 0: the Output, 1: the listened signal */
  private mix = 0;
  private fadeStep: number;
  private release: number;
  private dcPole: number;
  private dcX = 0;
  private dcY = 0;
  /** the limiter's gain now */
  private gain = 1;
  private sum = new Float32Array(128);

  constructor(sr: number) {
    this.fadeStep = 1 / Math.max(1, FADE_S * sr);
    this.release = 1 - Math.exp(-1 / (RELEASE_S * sr));
    this.dcPole = Math.exp((-2 * Math.PI * DC_HZ) / sr);
  }

  /** what is listened to; null: the Output again */
  set(srcs: ListenSource[] | null): void {
    if (srcs && !srcs.length) srcs = null;
    if (srcs && !this.heard) (this.dcX = 0), (this.dcY = 0), (this.gain = 1);
    this.srcs = srcs;
    if (srcs) this.heard = srcs;
  }

  /** the sources to pass to process this block (null: nothing to mix, the Output plays alone) */
  get sources(): ListenSource[] | null {
    return this.heard;
  }

  /** mix into the rendered left / right (n samples): `bufs` the sources' buffers this block (null: none), `level` the gain */
  process(left: Float32Array, right: Float32Array, n: number, bufs: readonly (Float32Array | null)[], level: number): void {
    if (this.sum.length < n) this.sum = new Float32Array(n);
    const sum = this.sum;
    sum.fill(0, 0, n);
    for (const b of bufs) if (b) for (let i = 0; i < n; i++) sum[i] += b[i];
    const target = this.srcs ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const x = Number.isFinite(sum[i]) ? sum[i] * level : 0;
      const y = x - this.dcX + this.dcPole * this.dcY;
      this.dcX = x;
      this.dcY = y;
      const a = Math.abs(y);
      if (a * this.gain > LISTEN_CEILING) this.gain = LISTEN_CEILING / a;
      const v = y * this.gain;
      this.gain += (1 - this.gain) * this.release;
      this.mix = target > this.mix ? Math.min(target, this.mix + this.fadeStep) : Math.max(target, this.mix - this.fadeStep);
      left[i] = left[i] * (1 - this.mix) + v * this.mix;
      right[i] = right[i] * (1 - this.mix) + v * this.mix;
    }
    if (!this.srcs && this.mix === 0) this.heard = null;
  }
}
