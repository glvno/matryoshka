// SPDX-License-Identifier: GPL-3.0-only
// Factory presets (#193): every factory engine ships with presets, read-only (device-presets.ts). "Init" is the engine as
// it comes; the others are the same engine with a few card rows moved by a rule that reads parameter names only (a
// filter's cutoff, an envelope's times, an effect's mix), so a rule that finds nothing to move makes no preset. The
// FM-1 gets the same list in ROM (export-defs, #194). The XL patches' engines get the same variations, made from the
// engine as the XL ships it; they stay in the browser, as the XLs do.
import { FACTORY } from './assemblies';
import { toDef, type AssemblyDef } from './assembly';
import { setFactoryPresets, type Preset } from './device-presets';
import { defIsEngine, instIsEngine } from './engines';
import { DEFS } from './modules';
import { XL_PRESETS } from './presets';
import { defStructureAndOrder } from './structure';

/** a row as a rule sees it: its module's type, the parameter, its label on the card, the value now */
interface Row { type: string; param: string; label: string; value: number }
type Rule = (r: Row) => number | undefined;

const times = (k: number, floor = 0): ((v: number) => number) => (v) => Math.max(floor, v * k);
const CUTOFF = (r: Row): boolean => r.param === 'cutoff' && (r.type === 'filter' || r.type === 'ladder');
const ENV = (r: Row): boolean => r.type === 'adsr' || r.type === 'env' || r.type === 'env8';

/** an Env 8 (Cassia 1: the CZ's envelopes, the sustain at step 3) plucked as an Env L/R: an instant first step, short
 * second and third ones, nothing held at step 3, a short step 4 after the key is let go */
const ENV8_PLUCK: Rule = (r) => (r.param === 'r1' ? 0.002 : r.param === 'r2' || r.param === 'r3' ? Math.min(0.35, r.value) : r.param === 'l3' ? 0 : r.param === 'r4' ? Math.min(0.3, r.value) : undefined);

/** the variations, in the order they are listed */
export const RULES: { name: string; rule: Rule }[] = [
  { name: 'Bright', rule: (r) => (CUTOFF(r) ? times(2.2)(r.value) : r.param === 'res' ? r.value + 0.1 : undefined) },
  { name: 'Dark', rule: (r) => (CUTOFF(r) ? times(0.4)(r.value) : undefined) },
  { name: 'Pad', rule: (r) => (!ENV(r) ? undefined : r.param === 'a' || r.param === 'r1' ? Math.max(0.4, r.value * 6) : r.param === 'r' || r.param === 'r4' ? Math.max(1.2, r.value * 2.5) : r.param === 's' ? Math.max(0.7, r.value) : undefined) },
  { name: 'Pluck', rule: (r) => (!ENV(r) ? undefined : r.param === 'a' ? 0.002 : r.param === 'd' ? Math.min(0.35, r.value) : r.param === 's' ? 0 : r.param === 'r' ? Math.min(0.3, r.value) : r.type === 'env8' ? ENV8_PLUCK(r) : undefined) },
  { name: 'Tight', rule: (r) => ((r.type === 'env' || r.type === 'env8') && /^r[23]$/.test(r.param) ? times(0.5)(r.value) : undefined) },
  { name: 'Long', rule: (r) => ((r.type === 'env' || r.type === 'env8') && /^r[23]$/.test(r.param) ? times(1.8)(r.value) : undefined) },
  { name: 'Wet', rule: (r) => (r.type === 'delay' || r.type === 'reverb' || r.type === 'chorus') && r.param === 'mix' ? Math.min(1, Math.max(0.35, r.value * 1.6)) : r.type === 'delay' && r.param === 'fb' ? r.value + 0.15 : undefined },
];

/** a cutoff factor as a move of a Macro spanning the filters' cutoff range (0..1 over 20..16000 Hz, log) */
const CUTOFF_UNIT = (k: number): number => {
  const pd = DEFS.filter.params.find((d) => d.name === 'cutoff')!;
  return Math.log(k) / Math.log(pd.max / pd.min);
};

/** the XLs' rules: the same variations, also reaching controls only an XL has (a DX envelope's levels and rates, a
 * delay's wet mix and feedback on a Crossfader or a Macro), so an XL keeps every preset its FM-1 version has. Kept apart
 * from RULES so the FM-1's list (its ROM) stays as it is. */
const XL_EXTRA: Record<string, Rule> = {
  // a cutoff or resonance on a Macro that sets filters over their whole range (Oracle V XL: one knob for two filters);
  // the cutoff moves by the same factor as a filter's own, in its range's unit (log 20..16000 Hz)
  Bright: (r) => (r.type !== 'macro' ? undefined : r.label === 'cutoff' ? r.value + CUTOFF_UNIT(2.2) : r.label === 'res' ? r.value + 0.1 : undefined),
  Dark: (r) => (r.type === 'macro' && r.label === 'cutoff' ? r.value + CUTOFF_UNIT(0.4) : undefined),
  // Lyra's card exposes FAST and SHARP, not its fixed envelope times: use its panel for the same musical variations.
  Pad: (r) => (r.type === 'select' && r.label.startsWith('fast ') ? 1 : r.type === 'macro' && r.label.startsWith('sharp ') ? 0.05 : undefined),
  Pluck: (r) => (r.type === 'select' && r.label.startsWith('fast ') ? 2 : r.type !== 'env' ? undefined : r.param === 'r1' ? 0.002 : r.param === 'r2' || r.param === 'r3' ? Math.min(0.35, r.value) : r.param === 'l3' ? 0 : r.param === 'r4' ? Math.min(0.3, r.value) : undefined),
  Wet: (r) => (r.type === 'select' && r.label === 'chorus' ? 3 : r.type === 'xfade' && r.label === 'mix' ? Math.min(1, Math.max(0.35, r.value * 1.6)) : r.type === 'macro' && r.label === 'feedback' ? r.value + 0.15 : undefined),
};
/** Rate controls run faster as they rise; zero decay must remain a hold when making Long/Tight variations. */
const RATE_VARIATIONS: Record<string, Rule> = {
  Pad: (r) => ({ ar: Math.min(10, r.value), d1l: Math.max(14, r.value), d2r: 0, rr: Math.min(4, r.value) })[r.param],
  Pluck: (r) => ({ ar: 31, d1r: Math.max(18, r.value), d1l: 0, d2r: Math.max(18, r.value), rr: Math.max(10, r.value) })[r.param],
  Tight: (r) => r.param === 'd1r' || r.param === 'd2r' ? r.value ? r.value + 2 : 0 : undefined,
  Long: (r) => r.param === 'd1r' || r.param === 'd2r' ? r.value ? Math.max(1, r.value - 2) : 0 : undefined,
};
export const XL_RULES: { name: string; rule: Rule }[] = RULES.map(({ name, rule }) => {
  const extra = XL_EXTRA[name];
  return { name, rule: (r: Row) => r.type === 'rateenv' ? RATE_VARIATIONS[name]?.(r) : rule(r) ?? extra?.(r) };
});

/** a factory engine's presets: Init and every rule that moves at least one row */
export function presetsOfDef(def: AssemblyDef, rules = RULES): Preset[] {
  const { structure, order } = defStructureAndOrder(def);
  const rows: Row[] = order.map((i) => {
    const r = def.params[i];
    const m = def.modules.find((x) => x.id === r.module)!;
    const pd = DEFS[m.type]?.params.find((d) => d.name === r.param);
    return { type: m.type, param: r.param, label: r.label, value: m.params[r.param] ?? pd?.default ?? 0 };
  });
  const clamp = (r: Row, v: number): number => {
    const pd = DEFS[r.type]?.params.find((d) => d.name === r.param);
    return pd ? Math.min(pd.top ?? pd.max, Math.max(pd.min, v)) : v;
  };
  const out: Preset[] = [{ structure, name: 'Init', values: rows.map((r) => r.value), factory: true }];
  for (const { name, rule } of rules) {
    const values = rows.map((r) => { const v = rule(r); return v === undefined ? r.value : clamp(r, v); });
    if (values.some((v, i) => Math.abs(v - rows[i].value) > 1e-9)) out.push({ structure, name, values, factory: true });
  }
  return out;
}

/** worked out once, when first asked (not as the page loads) */
const once = <T>(f: () => T): (() => T) => {
  let v: T | undefined;
  let done = false;
  return () => (done ? v! : ((done = true), (v = f())));
};

/** every factory engine's presets (the FM-1's ROM list) */
export const factoryPresets = once((): Preset[] => FACTORY.filter((d) => defIsEngine(d)).flatMap((d) => presetsOfDef(d)));

/** the XL patches' engines' presets, by XL name: browser only */
export const xlEnginePresets = once((): Record<string, Preset[]> => Object.fromEntries(
  Object.entries(XL_PRESETS).map(([name, make]) => {
    const p = make();
    return [name, (p.assemblies ?? []).filter((a) => instIsEngine(p, a)).flatMap((a) => presetsOfDef(toDef(p, a), XL_RULES))];
  }),
));

/** an XL engine of a factory engine's structure already has that engine's presets; two XLs sharing an engine list it once.
 * By structure: a factory engine's structure needs no XL worked out, so the XLs' presets are made only when a structure no
 * factory engine has is asked for */
const fm1Structures = once(() => new Set(factoryPresets().map((p) => p.structure)));
const xlOnly = once((): Preset[] => {
  const seen = fm1Structures();
  const list = Object.values(xlEnginePresets()).flat().filter((p) => !seen.has(p.structure));
  return list.filter((p, i) => list.findIndex((q) => q.structure === p.structure && q.name === p.name) === i);
});
/** every factory preset the browser offers: the FM-1's, then the XLs' own */
export const allFactoryPresets = (): Preset[] => [...factoryPresets(), ...xlOnly()];
setFactoryPresets((structure) => (fm1Structures().has(structure) ? factoryPresets() : xlOnly()).filter((p) => p.structure === structure));
