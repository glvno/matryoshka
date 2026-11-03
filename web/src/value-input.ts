// SPDX-License-Identifier: GPL-3.0-only
// A value typed into a parameter's bar (double-click it): a number in the parameter's unit or a related one ("2k",
// "2 kHz", "120ms" for seconds, "50%" for a 0..1 parameter), a fraction ("1/8", "-1/3"), a choice by name, a switch by
// on / off. A typed number is kept as typed (#538); only a row of whole steps snaps. Also how the bar's controls (a drag,
// the arrow keys, the wheel, Main's knobs) move a value: by steps from where it is, without putting it back on the grid,
// a tenth of a step with Shift. No DOM.
import { topOf, type ParamDef } from './patch';

/** what a typed unit is worth in the parameter's own unit, by the parameter's unit ('' = none) */
const UNITS: Record<string, Record<string, number>> = {
  Hz: { hz: 1, khz: 1000 },
  s: { s: 1, sec: 1, ms: 0.001 },
  ms: { ms: 1, s: 1000, sec: 1000 },
  '%': { '%': 1 },
  '': { '%': 0.01 },
};

const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(?:\s*\/\s*(\d+\.?\d*|\.\d+))?\s*(k(?![a-z]*hz)|k(?=hz))?\s*([a-z%]*)$/;

/**
 * A row that holds whole steps only: a switch, a choice, or a linear row whose step is a whole number (a count, semitones,
 * cents, milliseconds, a tempo). A typed value snaps to its steps; every other row keeps what is typed.
 */
export function wholeSteps(pd: ParamDef): boolean {
  return !!pd.toggle || !!pd.choices || (!pd.log && !!pd.step && Number.isInteger(pd.step) && pd.step >= 1);
}

/** the step a control moves a row by: its own, else a two-hundredth of its range (the bar's resolution) */
export const stepOf = (pd: ParamDef): number => pd.step || (pd.max - pd.min) / 200;

/** how much finer Shift moves a row: a tenth of a step, as the FM-1's fine turn (HOME held) */
export const FINE = 0.1;

/**
 * Where a control that aims at `to` takes a row's value `from` (#538): by whole steps from `from` (a tenth of one when
 * `fine`), so a value typed off the grid (1/8 on a row of 0.01 steps) stays off it as a drag moves it. `atLeastOne`: a
 * key press or a wheel notch moves at least one step toward `to`. The range's ends are reached exactly. A row of whole
 * steps lands on its steps. `hi`: the top of the control (the browser-only stretch).
 */
export function stepToward(pd: ParamDef, from: number, to: number, o: { fine?: boolean; atLeastOne?: boolean; hi?: number } = {}): number {
  const lo = pd.min;
  const hi = o.hi ?? topOf(pd);
  if (to >= hi) return hi;
  if (to <= lo) return lo;
  const step = stepOf(pd);
  if (wholeSteps(pd)) {
    let v = lo + Math.round((to - lo) / step) * step;
    if (o.atLeastOne && v === from && to !== from) v = from + Math.sign(to - from) * step;
    return Math.min(hi, Math.max(lo, v));
  }
  const g = step * (o.fine ? FINE : 1);
  let n = Math.round((to - from) / g);
  if (!n && o.atLeastOne && to !== from) n = Math.sign(to - from);
  return Math.min(hi, Math.max(lo, Number((from + n * g).toPrecision(12))));
}

/**
 * The value `text` means for `pd`, clamped to its range (on its steps only for a row of whole steps, `wholeSteps`); null
 * when it cannot be read. `names` are the
 * choice names as the bar shows them (a selector), matched whole first, then by their start.
 */
export function parseValue(text: string, pd: ParamDef, names?: string[]): number | null {
  const t = text.trim().toLowerCase().replace(/,/g, '.');
  if (!t) return null;
  if (pd.toggle) {
    if (['on', '1', 'yes', 'true'].includes(t)) return 1;
    if (['off', '0', 'no', 'false'].includes(t)) return 0;
    return null;
  }
  if (pd.choices) {
    const list = (names ?? pd.choices).map((n) => n.toLowerCase());
    const whole = list.indexOf(t);
    if (whole >= 0) return whole;
    const start = list.findIndex((n) => n.startsWith(t));
    if (start >= 0) return start;
    const i = Number(t);
    return Number.isInteger(i) && i >= 1 && i <= list.length ? i - 1 : null; // a position, counted from 1
  }
  const m = NUMBER.exec(t);
  if (!m) return null;
  const over = m[2] === undefined ? 1 : Number(m[2]);
  if (!over) return null;
  let v = (Number(m[1]) / over) * (m[3] ? 1000 : 1);
  const unit = m[4];
  const own = pd.unit ?? '';
  if (unit && unit !== own.toLowerCase()) {
    const factor = UNITS[own]?.[unit];
    if (factor === undefined) return null;
    v *= factor;
  }
  if (!Number.isFinite(v)) return null;
  const hi = pd.top ?? pd.max; // (a stretch both engines take: Steps swing to 80 %)
  v = Math.min(hi, Math.max(pd.min, v));
  if (pd.step && wholeSteps(pd)) v = Math.min(hi, Math.max(pd.min, pd.min + Math.round((v - pd.min) / pd.step) * pd.step));
  return Number(v.toPrecision(12));
}
