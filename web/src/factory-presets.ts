// SPDX-License-Identifier: GPL-3.0-only
// Factory presets (#193): every factory engine ships with presets, read-only (device-presets.ts). "Init" is the engine as
// it comes; the others are the same engine with a few card rows moved by a rule that reads parameter names only (a
// filter's cutoff, an envelope's times, an effect's mix), so a rule that finds nothing to move makes no preset. The
// FM-1 gets the same list in ROM (export-defs, #194).
import { FACTORY } from './assemblies';
import type { AssemblyDef } from './assembly';
import { setFactoryPresets, type Preset } from './device-presets';
import { defIsEngine } from './engines';
import { DEFS } from './modules';
import { defRowOrder, defStructure } from './structure';

/** a row as a rule sees it: its module's type, the parameter, the value now */
interface Row { type: string; param: string; value: number }
type Rule = (r: Row) => number | undefined;

const times = (k: number, floor = 0): ((v: number) => number) => (v) => Math.max(floor, v * k);
const CUTOFF = (r: Row): boolean => r.param === 'cutoff' && (r.type === 'filter' || r.type === 'ladder');
const ENV = (r: Row): boolean => r.type === 'adsr' || r.type === 'env';

/** the variations, in the order they are listed */
export const RULES: { name: string; rule: Rule }[] = [
  { name: 'Bright', rule: (r) => (CUTOFF(r) ? times(2.2)(r.value) : r.param === 'res' ? r.value + 0.1 : undefined) },
  { name: 'Dark', rule: (r) => (CUTOFF(r) ? times(0.4)(r.value) : undefined) },
  { name: 'Pad', rule: (r) => (!ENV(r) ? undefined : r.param === 'a' || r.param === 'r1' ? Math.max(0.4, r.value * 6) : r.param === 'r' || r.param === 'r4' ? Math.max(1.2, r.value * 2.5) : r.param === 's' ? Math.max(0.7, r.value) : undefined) },
  { name: 'Pluck', rule: (r) => (!ENV(r) ? undefined : r.param === 'a' ? 0.002 : r.param === 'd' ? Math.min(0.35, r.value) : r.param === 's' ? 0 : r.param === 'r' ? Math.min(0.3, r.value) : undefined) },
  { name: 'Tight', rule: (r) => (r.type === 'env' && /^r[23]$/.test(r.param) ? times(0.5)(r.value) : undefined) },
  { name: 'Long', rule: (r) => (r.type === 'env' && /^r[23]$/.test(r.param) ? times(1.8)(r.value) : undefined) },
  { name: 'Wet', rule: (r) => (r.type === 'delay' || r.type === 'reverb' || r.type === 'chorus') && r.param === 'mix' ? Math.min(1, Math.max(0.35, r.value * 1.6)) : r.type === 'delay' && r.param === 'fb' ? r.value + 0.15 : undefined },
];

/** a factory engine's presets: Init and every rule that moves at least one row */
export function presetsOfDef(def: AssemblyDef): Preset[] {
  const structure = defStructure(def);
  const order = defRowOrder(def);
  const rows: Row[] = order.map((i) => {
    const r = def.params[i];
    const m = def.modules.find((x) => x.id === r.module)!;
    const pd = DEFS[m.type]?.params.find((d) => d.name === r.param);
    return { type: m.type, param: r.param, value: m.params[r.param] ?? pd?.default ?? 0 };
  });
  const clamp = (r: Row, v: number): number => {
    const pd = DEFS[r.type]?.params.find((d) => d.name === r.param);
    return pd ? Math.min(pd.max, Math.max(pd.min, v)) : v;
  };
  const out: Preset[] = [{ structure, name: 'Init', values: rows.map((r) => r.value), factory: true }];
  for (const { name, rule } of RULES) {
    const values = rows.map((r) => { const v = rule(r); return v === undefined ? r.value : clamp(r, v); });
    if (values.some((v, i) => Math.abs(v - rows[i].value) > 1e-9)) out.push({ structure, name, values, factory: true });
  }
  return out;
}

/** every factory engine's presets */
export const FACTORY_PRESETS: Preset[] = FACTORY.filter((d) => defIsEngine(d)).flatMap(presetsOfDef);

setFactoryPresets(FACTORY_PRESETS);
