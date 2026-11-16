// SPDX-License-Identifier: GPL-3.0-only
// The Output card's loudness readout (#940): what the engine plays, measured live as the factory loudness rule measures a
// sound (levels.ts, loudness.ts: BS.1770 integrated loudness), so a sound being designed can be set against the rule.
// The audio thread K-weights the Output and sends 100 ms steps (worklet.ts, loudness.ts KMeter); this keeps the reading
// (LoudnessReading): the short-term loudness over the last 3 s and the integrated loudness since the last reset, beside the
// rule's target (one key held at LOUDNESS within LOUDNESS_TOLERANCE, a chord at most CHORD_LOUDNESS). The reading is of the
// Output before the master volume, also while a signal is being listened to on its own (listen.ts).
import { LoudnessReading } from './loudness';
import { CHORD_LOUDNESS, HOLD_SECS, LOUDNESS, LOUDNESS_TOLERANCE } from './levels';

/** the bar's range (LUFS) */
const BAR_LO = -42;
const BAR_HI = -6;
/** how often the numbers change (ms): slow enough to read */
const SHOW_MS = 250;

/** where an integrated reading sits against the one-key target: none yet, under it, on it (within the tolerance), over it */
export function ruleState(lufs: number): 'none' | 'quiet' | 'on' | 'hot' {
  if (!Number.isFinite(lufs)) return 'none';
  return lufs < LOUDNESS - LOUDNESS_TOLERANCE ? 'quiet' : lufs > LOUDNESS + LOUDNESS_TOLERANCE ? 'hot' : 'on';
}

/** a loudness as the readout shows it: one decimal, a real minus sign; '–' for none */
export function lufsText(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const s = v.toFixed(1);
  return s.startsWith('-') ? `−${s.slice(1)}` : s;
}

/** a loudness's place along the bar, 0..100 % */
const barAt = (v: number): number => (100 * (Math.min(BAR_HI, Math.max(BAR_LO, v)) - BAR_LO)) / (BAR_HI - BAR_LO);

export class OutputLoudness {
  private reading = new LoudnessReading();
  private el: { root: HTMLElement; short: HTMLElement; int: HTMLElement; fill: HTMLElement; mark: HTMLElement; time: HTMLElement } | null = null;
  private shownAt = 0;

  /** steps from the audio thread (AudioHost.onLoud) */
  push(steps: readonly number[]): void {
    this.reading.push(steps);
    const now = performance.now();
    if (now - this.shownAt < SHOW_MS) return;
    this.shownAt = now;
    this.show();
  }

  /** start the integrated reading again */
  reset(): void {
    this.reading.reset();
    this.show();
  }

  /** the readout for the Output card (the editor makes the card again at every rebuild; the reading carries on) */
  element(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'loud-readout';
    root.title = `Loudness of the Output, measured as the factory loudness rule measures a sound (ITU-R BS.1770, in LUFS) before the master volume. short: the last 3 s. int: integrated since the reset. The rule: one key held ${HOLD_SECS} s at ${lufsText(LOUDNESS)} LUFS (±${LOUDNESS_TOLERANCE}), a 4-key chord at most ${lufsText(CHORD_LOUDNESS)}. Press reset, then play the sound the way it will be judged.`;
    const row = document.createElement('div');
    row.className = 'loud-row';
    const part = (label: string, cls: string): HTMLElement => {
      const k = document.createElement('span');
      k.className = 'loud-k';
      k.textContent = label;
      const v = document.createElement('b');
      v.className = cls;
      row.append(k, v);
      return v;
    };
    const short = part('short', 'loud-short');
    const int = part('int', 'loud-int');
    const unit = document.createElement('span');
    unit.className = 'loud-k';
    unit.textContent = 'LUFS';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'loud-reset';
    reset.textContent = 'reset';
    reset.title = 'Start the integrated reading again';
    reset.onclick = (e) => { e.stopPropagation(); this.reset(); };
    row.append(unit, reset);
    const bar = document.createElement('div');
    bar.className = 'loud-bar';
    const band = document.createElement('span');
    band.className = 'loud-band';
    band.style.left = `${barAt(LOUDNESS - LOUDNESS_TOLERANCE)}%`;
    band.style.width = `${barAt(LOUDNESS + LOUDNESS_TOLERANCE) - barAt(LOUDNESS - LOUDNESS_TOLERANCE)}%`;
    const target = document.createElement('span');
    target.className = 'loud-target';
    target.style.left = `${barAt(LOUDNESS)}%`;
    const fill = document.createElement('span');
    fill.className = 'loud-fill';
    const mark = document.createElement('span');
    mark.className = 'loud-mark';
    bar.append(band, fill, target, mark);
    const rule = document.createElement('div');
    rule.className = 'loud-rule';
    const time = document.createElement('span');
    rule.append(`target ${lufsText(LOUDNESS)} (one key), chord ≤ ${lufsText(CHORD_LOUDNESS)}`, time);
    root.append(row, bar, rule);
    // its presses are its own: no card drag, no row focus
    root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el = { root, short, int, fill, mark, time };
    this.show();
    return root;
  }

  private show(): void {
    const el = this.el;
    if (!el) return;
    const s = this.reading.short(), i = this.reading.integrated();
    el.short.textContent = lufsText(s);
    el.int.textContent = lufsText(i);
    el.int.dataset.rule = ruleState(i);
    el.fill.style.width = Number.isFinite(s) ? `${barAt(s)}%` : '0';
    el.mark.hidden = !Number.isFinite(i);
    el.mark.style.left = `${barAt(i)}%`;
    el.mark.dataset.rule = ruleState(i);
    const secs = this.reading.seconds();
    el.time.textContent = secs ? ` · int over ${secs < 60 ? `${secs.toFixed(1)} s` : `${Math.floor(secs / 60)} min`}` : '';
  }
}
