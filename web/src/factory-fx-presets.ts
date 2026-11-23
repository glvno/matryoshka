// SPDX-License-Identifier: GPL-3.0-only
import type { AssemblyDef } from './assembly';
import type { Preset } from './device-presets';
import { FACTORY_FX_MASKS, FACTORY_FX_RECIPES, type FxRecipe } from './factory-fx-recipes';
import { legacyEffects, legacyRows } from './fx-preset';
import { drawerPresetValues, FX_PRESET_CONTROLS, FX_PRESET_KINDS } from './fx-preset-format';
import { DEFS } from './modules';
import { LOFI_PRESET_DESIGNS } from './factory-lofi-presets';
import { drawerPresetStructure } from './structure';

/** The factory instrument's sounds with its FX drawer (FXD1): the drawer the factory patch has, its master FX bus
 *  converted (convertLegacyBus: one effect per stage, in the bus's order), each effect on and set as the recipe says, or
 *  off at its defaults. Distinct from the instrument-only factory presets. */
export function factoryFxPresets(def: AssemblyDef, presets: Preset[]): Preset[] {
  const mask = FACTORY_FX_MASKS[def.name];
  if (mask === undefined) return [];
  const kinds = FX_PRESET_KINDS.filter((_, i) => mask & (1 << i));
  const fx = legacyEffects(kinds);
  return presets.map(preset => {
    const recipe: FxRecipe | undefined = preset.name === 'Init' ? { reason: 'Dry starting point.' }
      : FACTORY_FX_RECIPES[def.name]?.[preset.name] ?? LOFI_PRESET_DESIGNS[def.name]?.find(design => design.name === preset.name)?.fx;
    if (!recipe) throw new Error(`Missing FX design: ${def.name}/${preset.name}`);
    for (const kind of FX_PRESET_KINDS) if (recipe[kind] && !kinds.includes(kind))
      throw new Error(`${def.name}/${preset.name}: ${kind} is not in the factory drawer`);
    const effects = kinds.map(kind => {
      const settings: Record<string, number> | undefined = recipe[kind];
      const type = kind === 'drive' ? 'shape' : kind;
      const controls = FX_PRESET_CONTROLS[kind].map(param => {
        const pd = DEFS[type].params.find(pd => pd.name === param)!;
        const value = settings?.[param] ?? (kind === 'drive' && (param === 'drive' || param === 'level') ? 1 : pd.default);
        if (!Number.isFinite(value) || value < pd.min || value > (pd.top ?? pd.max))
          throw new Error(`${def.name}/${preset.name}: invalid ${kind}.${param}=${value}`);
        return value;
      });
      return { on: !!settings, values: legacyRows(kind, controls) };
    });
    return { ...preset, structure: drawerPresetStructure(preset.structure, fx.map(f => f.structure)), values: drawerPresetValues(preset.structure, preset.values, effects), fx };
  });
}
