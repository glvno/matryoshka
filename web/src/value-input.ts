// SPDX-License-Identifier: GPL-3.0-only
// A value typed into a parameter's bar (double-click it): a number in the parameter's unit or a related one ("2k",
// "2 kHz", "120ms" for seconds, "50%" for a 0..1 parameter), a choice by name, a switch by on / off. No DOM.
import type { ParamDef } from './patch';

/** what a typed unit is worth in the parameter's own unit, by the parameter's unit ('' = none) */
const UNITS: Record<string, Record<string, number>> = {
  Hz: { hz: 1, khz: 1000 },
  s: { s: 1, sec: 1, ms: 0.001 },
  ms: { ms: 1, s: 1000, sec: 1000 },
  '%': { '%': 1 },
  '': { '%': 0.01 },
};

const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(k(?![a-z]*hz)|k(?=hz))?\s*([a-z%]*)$/;

/**
 * The value `text` means for `pd`, clamped to its range and on its steps; null when it cannot be read. `names` are the
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
  let v = Number(m[1]) * (m[2] ? 1000 : 1);
  const unit = m[3];
  const own = pd.unit ?? '';
  if (unit && unit !== own.toLowerCase()) {
    const factor = UNITS[own]?.[unit];
    if (factor === undefined) return null;
    v *= factor;
  }
  if (!Number.isFinite(v)) return null;
  const hi = pd.top ?? pd.max; // (a stretch both engines take: Steps swing to 80 %)
  v = Math.min(hi, Math.max(pd.min, v));
  if (pd.step) v = Math.min(hi, Math.max(pd.min, pd.min + Math.round((v - pd.min) / pd.step) * pd.step));
  return Number(v.toPrecision(12));
}
