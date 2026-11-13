// SPDX-License-Identifier: GPL-3.0-only
import type { AssemblyDef } from './assembly';
import type { Preset } from './device-presets';
import { LOFI_PRESET_DESIGNS } from './factory-lofi-presets';
import { cardRows, parseValue } from './preset-cards';
import { defRowOrder } from './structure';

/** Extend existing sounds through the same card controls and numeric rules as handwritten cards. */
export function lofiPresets(def: AssemblyDef, presets: Preset[]): Preset[] {
  const designs = LOFI_PRESET_DESIGNS[def.name];
  if (!designs?.length) return [];
  const rows = cardRows(def), order = defRowOrder(def);
  return designs.map(design => {
    const base = presets.find(preset => preset.name === design.basedOn);
    if (!base) throw new Error(`${def.name}/${design.name}: missing source sound ${design.basedOn}`);
    if (presets.some(preset => preset.name.toLowerCase() === design.name.toLowerCase()))
      throw new Error(`${def.name}/${design.name}: duplicate preset name`);
    const values = [...base.values];
    for (const [key, value] of Object.entries(design.moves)) {
      const exact = rows.filter(row => row.key.toLowerCase() === key.toLowerCase());
      const found = exact.length ? exact : rows.filter(row => row.label.toLowerCase() === key.toLowerCase());
      if (found.length !== 1) throw new Error(`${def.name}/${design.name}: unknown or ambiguous row ${key}`);
      const row = found[0], position = order.indexOf(row.i);
      if (!row.pd || position < 0) throw new Error(`${def.name}/${design.name}: ${key} is not a preset value`);
      // Data uses parameter indices, never numeric-looking choice labels (FM ratios in particular).
      const text = row.names?.[value - row.pd.min] ?? row.pd.choices?.[value] ?? String(value);
      const parsed = parseValue(row, text);
      if ('error' in parsed) throw new Error(`${def.name}/${design.name}: ${parsed.error}`);
      values[position] = parsed.value;
    }
    if (values.every((value, i) => value === base.values[i])) throw new Error(`${def.name}/${design.name}: no distinct synth setting`);
    return { ...base, name: design.name, values };
  });
}
