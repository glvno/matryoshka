// SPDX-License-Identifier: GPL-3.0-only
import type { AssemblyDef } from './assembly';
import type { Preset } from './device-presets';
import { FACTORY_FX_MASKS, FACTORY_FX_RECIPES, type FxRecipe } from './factory-fx-recipes';
import { FX_PRESET_CONTROLS, FX_PRESET_KINDS, fxPresetStructure, fxPresetValues } from './fx-preset-format';
import { DEFS } from './modules';
import { LOFI_PRESET_DESIGNS } from './factory-lofi-presets';

/** Authored rack sounds are distinct from legacy card-only factory presets. */
export function factoryFxPresets(def: AssemblyDef, presets: Preset[]): Preset[] {
  const mask = FACTORY_FX_MASKS[def.name];
  if (mask === undefined) return [];
  return presets.map(preset => {
    const recipe: FxRecipe | undefined = preset.name === 'Init' ? { reason: 'Dry starting point.' }
      : FACTORY_FX_RECIPES[def.name]?.[preset.name] ?? LOFI_PRESET_DESIGNS[def.name]?.find(design => design.name === preset.name)?.fx;
    if (!recipe) throw new Error(`Missing FX design: ${def.name}/${preset.name}`);
    const effects = FX_PRESET_KINDS.flatMap((kind, i) => {
      const authored = recipe[kind];
      if (!(mask & (1 << i))) {
        if (authored) throw new Error(`${def.name}/${preset.name}: ${kind} is not in the selected rack`);
        return [];
      }
      const settings: Record<string, number> | undefined = authored;
      const type = kind === 'drive' ? 'shape' : kind;
      return [Number(!!authored), ...FX_PRESET_CONTROLS[kind].map(param => {
        const pd = DEFS[type].params.find(pd => pd.name === param)!;
        const value = settings?.[param] ?? (kind === 'drive' && (param === 'drive' || param === 'level') ? 1 : pd.default);
        if (!Number.isFinite(value) || value < pd.min || value > (pd.top ?? pd.max))
          throw new Error(`${def.name}/${preset.name}: invalid ${kind}.${param}=${value}`);
        return value;
      })];
    });
    return { ...preset, structure: fxPresetStructure(preset.structure, mask), values: fxPresetValues(preset.structure, mask, preset.values, effects) };
  });
}
