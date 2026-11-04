// SPDX-License-Identifier: GPL-3.0-only
// A parameter input's depth in the parameter's own units (#526): "±2 oct" on a cutoff, "±150 ms" on a delay time. The
// patch keeps the depth as a share of the parameter's range (ModuleInst.att, −2..2: DEPTH_MAX), so this is how the editor
// shows and reads it; the engines and the FM-1 never see it. No DOM.
import { DEPTH_MAX, type ParamDef } from './patch';

/** what a depth of 1 (the whole range) moves a parameter by, in the unit its depth reads in: octaves for a logarithmic
 * parameter, its own unit for a linear one, steps for a choice; a bent one (the cutoff's slider) in % of the slider,
 * because the octaves a share of its travel spans depend on where it sits */
export function depthScale(pd: ParamDef): { per: number; unit: string } {
  if (pd.log && !pd.bend) return { per: Math.log2(pd.max / pd.min), unit: 'oct' };
  if (pd.log) return { per: 100, unit: '%' };
  if (pd.choices && !pd.toggle) return { per: pd.max - pd.min, unit: 'steps' };
  return { per: pd.max - pd.min, unit: pd.unit ?? '' };
}

/** a number with three significant figures and a real minus sign */
const sig3 = (v: number): string => {
  const s = String(Number(v.toPrecision(3)));
  return s.startsWith('-') ? `−${s.slice(1)}` : s;
};

/** a depth as the editor shows it: "+2 oct", "−150 ms", "0" */
export function depthText(pd: ParamDef, att: number): string {
  const { per, unit } = depthScale(pd);
  const v = att * per;
  if (Number(v.toPrecision(3)) === 0) return unit ? `0 ${unit}` : '0';
  return `${v > 0 ? '+' : ''}${sig3(v)}${unit ? ' ' + unit : ''}`;
}

/** the depth limits in the parameter's units (± DEPTH_MAX times the range) */
export const depthLimit = (pd: ParamDef): number => DEPTH_MAX * depthScale(pd).per;

/** a share of the range as the patch stores it: within ±DEPTH_MAX, on the binary's Q16 grid (patchbin.ts toQ16) */
export const storedDepth = (att: number): number => Math.round(Math.max(-DEPTH_MAX, Math.min(DEPTH_MAX, att)) * 65536) / 65536;

/** what a typed unit is worth in the unit the depth reads in */
const UNITS: Record<string, Record<string, number>> = {
  oct: { oct: 1, octave: 1, octaves: 1, st: 1 / 12, semi: 1 / 12, semitones: 1 / 12, ct: 1 / 1200, cent: 1 / 1200, cents: 1 / 1200 },
  ms: { ms: 1, s: 1000, sec: 1000 },
  s: { s: 1, sec: 1, ms: 0.001 },
  Hz: { hz: 1, khz: 1000 },
};

const NUMBER = /^([+\-−]?)\s*(\d+\.?\d*|\.\d+)(?:\s*\/\s*(\d+\.?\d*|\.\d+))?\s*([a-z%]*)$/;

/**
 * The depth (a share of the range, as stored) that `text` means for `pd`, or null when it cannot be read: a number or a
 * fraction ("1/8", "-7/12") in the parameter's depth unit (depthScale), with that unit or a related one ("7 st" or
 * "700 cents" on a depth in octaves, "0.2 s" on one in ms), or "%" of the range ("50%"). Kept as typed: clamped only to
 * ±DEPTH_MAX and rounded only to the binary's Q16 (#538's typing rule).
 */
export function parseDepth(text: string, pd: ParamDef): number | null {
  const m = NUMBER.exec(text.trim().toLowerCase().replace(/,/g, '.'));
  if (!m) return null;
  let v = Number(m[2]);
  if (m[3] !== undefined) {
    const d = Number(m[3]);
    if (!d) return null;
    v /= d;
  }
  if (m[1] === '-' || m[1] === '−') v = -v;
  const { per, unit } = depthScale(pd);
  const typed = m[4];
  let share: number;
  if (typed === '%' && unit !== '%') share = v / 100;
  else if (!typed || typed === unit.toLowerCase()) share = v / per;
  else {
    const f = UNITS[unit]?.[typed];
    if (f === undefined) return null;
    share = (v * f) / per;
  }
  return Number.isFinite(share) ? storedDepth(share) : null;
}
