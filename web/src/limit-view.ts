// SPDX-License-Identifier: GPL-3.0-only
// The Limiter card's gain reduction readout (#1019): how many dB the Limiter takes off right now, as a number and a bar.
// It watches the card's own `gr` output (1 − the gain) through the worklet's watch (worklet.ts feedWatch: the mean of 256
// samples), as the sidebar sliders watch their sources. It reads the browser engine, as every meter does (D-983).
import type { HostMsg } from './worklet';

/** the watch keys of these readouts: `gr:<module id>` */
const KEY = 'gr:';
/** the bar's range: 0 to this many dB of reduction */
const BAR_DB = 24;
/** how often the number changes (ms): slow enough to read */
const SHOW_MS = 100;

/** the reduction in dB (0 and up) for a gr value (1 − the gain) */
export const grDb = (gr: number): number => (gr > 0 ? -20 * Math.log10(Math.max(1e-6, 1 - gr)) : 0);
/** a reduction as the readout shows it: one decimal, a real minus sign, 0.0 while nothing is limited */
export const grText = (db: number): string => (db < 0.05 ? '0.0' : `−${db.toFixed(1)}`);

interface Readout { root: HTMLElement; value: HTMLElement; fill: HTMLElement; db: number; shownAt: number }

export class LimiterMeters {
  private els = new Map<number, Readout>();
  /** the cards made since the last sync: the editor makes every card again at a rebuild */
  private made = new Set<number>();

  constructor(private send: (msg: HostMsg) => void) {}

  /** the readout for Limiter `id`'s card; watches its gr output */
  element(id: number): HTMLElement {
    const root = document.createElement('div');
    root.className = 'gr-readout';
    root.title = 'Gain reduction: how much the Limiter turns the sound down right now, in dB (the browser engine\'s).';
    const k = document.createElement('span');
    k.className = 'gr-k';
    k.textContent = 'GR';
    const value = document.createElement('b');
    const unit = document.createElement('span');
    unit.className = 'gr-k';
    unit.textContent = 'dB';
    const bar = document.createElement('div');
    bar.className = 'gr-bar';
    const fill = document.createElement('span');
    bar.append(fill);
    root.append(k, value, unit, bar);
    const r: Readout = { root, value, fill, db: this.els.get(id)?.db ?? 0, shownAt: 0 };
    this.els.set(id, r);
    this.made.add(id);
    this.send({ t: 'watch', key: `${KEY}${id}`, id, port: 'gr' });
    this.show(r);
    return root;
  }

  /** a watched value from the audio thread (AudioHost.onWatch); false when `key` is not one of these readouts' */
  push(key: string, v: number): boolean {
    if (!key.startsWith(KEY)) return false;
    const r = this.els.get(Number(key.slice(KEY.length)));
    if (!r) return true;
    r.db = grDb(v);
    const now = performance.now();
    if (now - r.shownAt >= SHOW_MS) this.show(r, now);
    return true;
  }

  /** after a rebuild: stop watching the Limiters whose cards are gone */
  sync(): void {
    for (const id of this.els.keys())
      if (!this.made.has(id)) {
        this.els.delete(id);
        this.send({ t: 'unwatch', key: `${KEY}${id}` });
      }
    this.made.clear();
  }

  private show(r: Readout, now = performance.now()): void {
    r.shownAt = now;
    r.value.textContent = grText(r.db);
    r.fill.style.width = `${(100 * Math.min(BAR_DB, r.db)) / BAR_DB}%`;
  }
}
