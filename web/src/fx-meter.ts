// SPDX-License-Identifier: GPL-3.0-only
// The level meter on a closed FX drawer's tab (fx-tab.ts, D-1341): the instrument's sound after its effects, measured
// live. Each meter asks the audio thread for a short stream of the drawer's outputs (worklet.ts `view`, as a Scope's
// screen does) and shows its peak on a dB scale, falling back slowly.
import type { ViewData } from './scope-stream';
import type { HostMsg } from './worklet';

/** a meter as the editor drew it: its stream's key, the element whose `--lv` it sets, per side the outputs it sums */
export interface FxMeterSpec {
  key: string;
  el: HTMLElement;
  chans: { id: number; port: string }[][];
}

/** the samples each update looks at (about 20 ms) */
const SAMPLES = 1024;
/** the scale's bottom, dB: quieter shows empty */
const FLOOR_DB = -48;
/** how far the shown level falls per update when the sound gets quieter (0..1 of the scale) */
const FALL = 0.04;

/** a peak (linear, 1 = full scale) on the meter's scale, 0..1 */
export function meterLevel(peak: number): number {
  if (!(peak > 0)) return 0;
  return Math.min(1, Math.max(0, 1 - (20 * Math.log10(peak)) / FLOOR_DB));
}

export class FxMeters {
  private meters = new Map<string, { el: HTMLElement; sent: string; level: number }>();

  constructor(private send: (msg: HostMsg) => void) {}

  /** the meters the editor drew this time (after every rebuild): streams follow them */
  sync(specs: readonly FxMeterSpec[]): void {
    const next = new Map<string, { el: HTMLElement; sent: string; level: number }>();
    for (const s of specs) {
      const old = this.meters.get(s.key);
      const msg: HostMsg = { t: 'view', key: s.key, chans: s.chans, samples: SAMPLES };
      const sent = JSON.stringify(msg);
      if (old?.sent !== sent) this.send(msg);
      const level = old?.level ?? 0;
      s.el.style.setProperty('--lv', `${(level * 100).toFixed(1)}%`);
      next.set(s.key, { el: s.el, sent, level });
    }
    for (const key of this.meters.keys()) if (!next.has(key)) this.send({ t: 'unview', key });
    this.meters = next;
  }

  /** a stream's latest history from the audio thread; false when it is not a meter's */
  receive(key: string, chans: readonly ViewData[]): boolean {
    const m = this.meters.get(key);
    if (!m) return false;
    let peak = 0;
    for (const c of chans) for (const buf of 'raw' in c ? [c.raw] : [c.min, c.max]) for (const v of buf) peak = Math.max(peak, Math.abs(v));
    m.level = Math.max(meterLevel(peak), m.level - FALL);
    m.el.style.setProperty('--lv', `${(m.level * 100).toFixed(1)}%`);
    return true;
  }

  /** the audio stopped or started: the meters start from empty */
  reset(): void {
    for (const m of this.meters.values()) {
      m.level = 0;
      m.el.style.setProperty('--lv', '0%');
    }
  }
}
