// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { allModules, insertAssembly, promote } from './assembly';
import { DeviceLink, PRESET_NEEDS_UPDATE } from './device';
import { applyPreset, capturePreset, currentValues, exportPresets, importPresets, matchesPreset, presetsOf, setFactoryPresets, storePreset, userPresets } from './device-presets';
import { buildSelectedFactoryBank } from './factory-bank';
import { allFactoryPresets } from './factory-presets';
import { fxBusOf } from './fx-bus';
import { currentFxValues, fxPresetScope } from './fx-preset';
import { fxPresetInfo, fxPresetStructure, fxPresetValues } from './fx-preset-format';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import { patchPresets } from './patch-presets';
import { CMD, FEATURE_FX_PRESETS, parse, parseInfo, parsePresetData, presetPutFrame, PRESET_VALUES_MAX } from './protocol';
import { rowOrder, structureOf } from './structure';

const bank = buildSelectedFactoryBank();
const q16 = (values: number[]): number[] => values.map(value => Math.round(value * 65536));
function instrument(name = 'Monolith D') {
  const patch = structuredClone(bank.find(entry => entry.name === name)!.patch);
  const assembly = patch.assemblies!.find(a => !!fxPresetScope(patch, a))!;
  return { patch, assembly };
}
function sound(patch: Patch, name: string) {
  const assembly = patch.assemblies!.find(a => !!fxPresetScope(patch, a))!;
  return presetsOf(patch, assembly).find(preset => preset.factory && preset.name === name)!;
}

beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) });
  setFactoryPresets(allFactoryPresets());
});

describe('complete synth + master FX presets', () => {
  it('restores synth, both stereo targets, second-page controls and bypass after library and FM-1 round trips', () => {
    const { patch, assembly } = instrument();
    const authored = structuredClone(sound(patch, 'Wheel Furnace'));
    const rows = fxPresetInfo(authored)!.rows;
    // Exercise all stages, including controls beyond the first four knobs.
    authored.values[rows + 5] = 1;
    authored.values[rows + 9] = 1;
    authored.values[rows + 13] = 1;
    authored.values[rows + 14] = 1;
    authored.values[rows + 15] = 3;
    authored.values[rows + 16] = 1;
    authored.values[rows + 20] = 37;
    authored.values[rows + 21] = 0.2;
    expect(applyPreset(patch, assembly, authored)).toBe(true);
    storePreset(patch, assembly, 'My Furnace');
    const exported = exportPresets();
    localStorage.setItem('matryoshka.presets', '[]');
    expect(importPresets(JSON.parse(JSON.stringify(exported)))).toBe(1);
    const stored = userPresets()[0];
    const frame = parse(presetPutFrame(stored.structure, stored.name, stored.values))!;
    const received = parsePresetData({ cmd: CMD.presetData, payload: frame.payload })!;
    const reopened = validatePatch(JSON.parse(JSON.stringify(patch)), DEFS);
    const other = reopened.assemblies!.find(a => a.id === assembly.id)!;
    expect(applyPreset(reopened, other, sound(reopened, 'Init'))).toBe(true);
    const fromDevice = { structure: stored.structure, name: received.name, values: received.values! };
    expect(applyPreset(reopened, other, fromDevice)).toBe(true);
    expect(q16(capturePreset(reopened, other, stored.name).values)).toEqual(q16(stored.values));
    expect(fxBusOf(reopened)!.stages.every(stage => stage.targets.every(id => !reopened.modules.find(m => m.id === id)!.bypass))).toBe(true);
    expect(patchPresets(reopened).map(preset => preset.name)).toEqual(['My Furnace']);
  });

  it('Init explicitly switches every added effect off and an FX edit marks a loaded sound edited', () => {
    const { patch, assembly } = instrument();
    expect(applyPreset(patch, assembly, sound(patch, 'Wheel Furnace'))).toBe(true);
    expect(matchesPreset(patch, assembly)).toBe(true);
    const drive = fxBusOf(patch)!.stages.find(stage => stage.kind === 'drive')!;
    for (const id of drive.targets) patch.modules.find(m => m.id === id)!.params.level = 0.15;
    expect(matchesPreset(patch, assembly)).toBe(false);
    expect(applyPreset(patch, assembly, sound(patch, 'Init'))).toBe(true);
    expect(fxBusOf(patch)!.stages.every(stage => stage.targets.every(id => !!patch.modules.find(m => m.id === id)!.bypass))).toBe(true);
    expect(matchesPreset(patch, assembly)).toBe(true);
  });

  it('legacy shortened presets change only their synth rows and preserve the current effects', () => {
    const { patch, assembly } = instrument('Cassia 1');
    expect(applyPreset(patch, assembly, sound(patch, 'Velvet Chords'))).toBe(true);
    const before = currentValues(patch, assembly), scope = fxPresetScope(patch, assembly)!;
    const effects = currentFxValues(patch, scope);
    const init = sound(patch, 'Init');
    const legacy = { structure: structureOf(patch, assembly), name: 'Old', values: init.values.slice(0, 88) };
    expect(applyPreset(patch, assembly, legacy)).toBe(true);
    expect(currentValues(patch, assembly).slice(0, 88)).toEqual(legacy.values);
    expect(currentValues(patch, assembly).slice(88)).toEqual(before.slice(88));
    expect(currentFxValues(patch, fxPresetScope(patch, assembly)!)).toEqual(effects);
  });

  it('recalls independently of FX labels, row ordering and page grouping', () => {
    const { patch, assembly } = instrument();
    const preset = sound(patch, 'Pink Wind');
    const bus = fxBusOf(patch)!;
    for (const id of [bus.assembly, ...bus.stages.map(stage => stage.assembly)]) {
      const group = patch.assemblies!.find(a => a.id === id)!;
      group.label = 'Renamed';
      group.params.reverse();
      for (const row of group.params) { row.label = 'Changed'; row.group = true; }
    }
    expect(applyPreset(patch, assembly, preset)).toBe(true);
    expect(q16(capturePreset(patch, assembly, preset.name).values)).toEqual(q16(preset.values));
  });

  it('does not attach a master rack to either instrument in a multi-assembly patch', () => {
    const { patch, assembly } = instrument();
    const preset = sound(patch, 'Wheel Furnace');
    insertAssembly(patch, DEFS, FACTORY.find(def => def.name === 'Silver Box')!, 2000, 2000);
    const before = structuredClone(patch);
    expect(fxPresetScope(patch, assembly)).toBeNull();
    expect(applyPreset(patch, assembly, preset)).toBe(false);
    expect(patch).toEqual(before);
    expect(capturePreset(patch, assembly, 'Plain').values).toEqual(currentValues(patch, assembly));
  });

  it('rejects malformed or incompatible rack records without partly changing the sound', () => {
    const { patch, assembly } = instrument();
    const preset = sound(patch, 'Wheel Furnace');
    const malformed = structuredClone(preset);
    malformed.values[fxPresetInfo(preset)!.rows] = 2;
    const wrongRack = { ...preset, structure: fxPresetStructure(structureOf(patch, assembly), 1) };
    const before = structuredClone(patch);
    for (const candidate of [malformed, wrongRack, { ...preset, values: preset.values.slice(0, -1) }]) {
      expect(applyPreset(patch, assembly, candidate)).toBe(false);
      expect(patch).toEqual(before);
    }
  });

  it('refuses a scoped sound above the 176-value preset capacity before storing or changing anything', () => {
    const { patch, assembly } = instrument();
    const promotable = allModules(patch, assembly).flatMap(id => {
      const m = patch.modules.find(m => m.id === id)!;
      return DEFS[m.type].params.filter(pd => pd.name in m.params).map(pd => [id, pd.name] as const);
    });
    // just past the scoped capacity: the card alone still fits a legacy preset
    for (const [id, param] of promotable) {
      if (capturePreset(patch, assembly, 'Too Big').values.length > PRESET_VALUES_MAX) break;
      promote(assembly, id, param, patch);
    }
    const snapshot = capturePreset(patch, assembly, 'Too Big');
    expect(rowOrder(patch, assembly).length).toBeLessThan(PRESET_VALUES_MAX);
    expect(snapshot.values.length).toBeGreaterThan(PRESET_VALUES_MAX);
    const before = structuredClone(patch);
    expect(() => storePreset(patch, assembly, 'Too Big')).toThrow(/176/);
    expect(userPresets()).toEqual([]);
    expect(applyPreset(patch, assembly, snapshot)).toBe(false);
    expect(patch).toEqual(before);
  });

  it('retains unsigned structure words through the signed Q16 wire representation', () => {
    const structure = fxPresetStructure('fedcba98', 1);
    const values = fxPresetValues('fedcba98', 1, [0.5], [1, 2, 0, 0.25, 0]);
    const frame = parse(presetPutFrame(structure, 'Signed', values))!;
    const received = parsePresetData({ cmd: CMD.presetData, payload: frame.payload })!;
    expect(fxPresetInfo({ structure, values: received.values! })).toEqual({ baseStructure: 'fedcba98', mask: 1, rows: 1 });
  });

  it('requires the new recall capability before sending scoped values, without changing old INFO parsing', async () => {
    const { patch } = instrument();
    const preset = sound(patch, 'Pink Wind');
    const payload = [1, 128, 255, 3, 255, 128, 0, 1, 55, 0, 0, 0, 2, 1];
    const link = new DeviceLink();
    link.info = parseInfo({ cmd: CMD.info, payload })!;
    expect(link.presetFits(preset.values.length, preset)).toBe(false);
    await expect(link.putPreset(preset.structure, preset.name, preset.values)).rejects.toThrow(PRESET_NEEDS_UPDATE);
    link.info = parseInfo({ cmd: CMD.info, payload: [...payload, 1] })!;
    expect(link.info.features & FEATURE_FX_PRESETS).toBe(FEATURE_FX_PRESETS);
    expect(link.info.bufferAllocation).toBe(1);
    expect(link.presetFits(preset.values.length, preset)).toBe(true);
    expect(link.presetFits(177, preset)).toBe(false);
  });
});
