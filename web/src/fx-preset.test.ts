// SPDX-License-Identifier: GPL-3.0-only
// Presets of an instrument with its FX drawer (FXD1): round trips, rebuilding the drawer on load, the "no FX" presets,
// effect presets, old "+ FX" (FXP1) presets converted, and the factory ones regenerated for the converted factory drawers.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bypassAssembly, type AssemblyInst } from './assembly';
import { DeviceLink, PRESET_NEEDS_UPDATE } from './device';
import {
  addUserPreset, applyPreset, capturePreset, currentValues, exportPresets, importPresets, matchesPreset, migrateUserPresets,
  presetChoices, presetDiff, presetsOf, presetView, setFactoryPresets, storePreset, userPresets, type Preset, type PresetDiff,
} from './device-presets';
import { buildSelectedFactoryBank } from './factory-bank';
import { FACTORY_FX_MASKS } from './factory-fx-recipes';
import { allFactoryPresets, factoryRackPresets } from './factory-presets';
import { effectsOf, insertEffect, moveEffect, removeEffect } from './fx-drawer';
import { drawerScope, UNKNOWN_EFFECTS } from './fx-preset';
import { drawerPresetInfo, drawerPresetValues, FX_PRESET_CONTROLS, FX_PRESET_KINDS, fxPresetStructure } from './fx-preset-format';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import { patchPresets } from './patch-presets';
import { CMD, FEATURE5_FX_DRAWERS, parse, parseInfo, parsePresetData, presetPutFrame, PRESET_VALUES_MAX } from './protocol';
import { drawerPresetStructure, rowOrder, structureOf } from './structure';

const bank = buildSelectedFactoryBank();
const q16 = (values: number[]): number[] => values.map(value => Math.round(value * 65536));
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** a factory patch as the editor opens it (an old master FX bus becomes the instrument's drawer) and its instrument */
function instrument(name = 'Monolith D'): { patch: Patch; a: AssemblyInst } {
  const patch = validatePatch(copy(bank.find(entry => entry.name === name)!.patch), DEFS);
  return { patch, a: patch.assemblies!.find(x => !!drawerScope(patch, x))! };
}
const sound = (patch: Patch, a: AssemblyInst, name: string): Preset => presetsOf(patch, a).find(preset => preset.factory && preset.name === name)!;
const effect = (patch: Patch, a: AssemblyInst, label: string): AssemblyInst => drawerScope(patch, a)!.effects.find(e => e.label === label)!;
const param = (patch: Patch, id: number): Record<string, number> => patch.modules.find(m => m.id === id)!.params;

beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) });
  setFactoryPresets(allFactoryPresets());
});

describe('an instrument with its FX drawer, as one sound (FXD1)', () => {
  it('restores the instrument, every effect’s rows and on/off after library and FM-1 round trips', () => {
    const { patch, a } = instrument();
    const authored = sound(patch, a, 'Wheel Furnace');
    expect(drawerPresetInfo(authored)).toEqual({ baseStructure: structureOf(patch, a), count: 4 });
    expect(applyPreset(patch, a, authored)).toBe(true);
    const delay = effect(patch, a, 'Delay');
    for (const id of delay.modules.filter(id => patch.modules.find(m => m.id === id)!.type === 'delay')) param(patch, id).time = 37;
    storePreset(patch, a, 'My Furnace');
    const exported = exportPresets();
    localStorage.setItem('matryoshka.presets', '[]');
    expect(importPresets(copy(exported))).toBe(1);
    const stored = userPresets()[0];
    expect(stored.fx?.map(f => f.name)).toEqual(drawerScope(patch, a)!.effects.map(e => e.label));
    const frame = parse(presetPutFrame(stored.structure, stored.name, stored.values))!;
    const received = parsePresetData({ cmd: CMD.presetData, payload: frame.payload })!;
    const reopened = validatePatch(copy(patch), DEFS);
    const other = reopened.assemblies!.find(x => x.id === a.id)!;
    expect(applyPreset(reopened, other, sound(reopened, other, 'Init'))).toBe(true);
    // (from the FM-1: values only, the effects found by structure)
    expect(applyPreset(reopened, other, { structure: stored.structure, name: received.name, values: received.values! })).toBe(true);
    expect(q16(capturePreset(reopened, other, stored.name).values)).toEqual(q16(stored.values));
    expect(patchPresets(reopened).map(preset => preset.name)).toEqual(['My Furnace']);
  });

  it('Init switches every effect off; an effect edit marks the loaded preset edited', () => {
    const { patch, a } = instrument();
    expect(applyPreset(patch, a, sound(patch, a, 'Wheel Furnace'))).toBe(true);
    expect(matchesPreset(patch, a)).toBe(true);
    const drive = effect(patch, a, 'Drive');
    for (const id of drive.modules) if (patch.modules.find(m => m.id === id)!.type === 'shape') param(patch, id).level = 0.15;
    expect(matchesPreset(patch, a)).toBe(false);
    expect(applyPreset(patch, a, sound(patch, a, 'Init'))).toBe(true);
    expect(drawerScope(patch, a)!.effects.every(e => e.bypass)).toBe(true);
    expect(matchesPreset(patch, a)).toBe(true);
  });

  it('keeps a drawer that is off off, its effects coming back as the preset has them', () => {
    const { patch, a } = instrument();
    const scope = drawerScope(patch, a)!;
    expect(applyPreset(patch, a, sound(patch, a, 'Wheel Furnace'))).toBe(true);
    const want = scope.effects.map(e => !e.bypass);
    expect(applyPreset(patch, a, sound(patch, a, 'Init'))).toBe(true);
    scope.drawer.bypass = true;
    expect(applyPreset(patch, a, sound(patch, a, 'Wheel Furnace'))).toBe(true);
    expect(scope.drawer.bypass).toBe(true);
    expect(drawerScope(patch, a)!.effects.map(e => !e.bypass)).toEqual(want);
  });

  it('rejects malformed or foreign records without changing anything', () => {
    const { patch, a } = instrument();
    const preset = sound(patch, a, 'Wheel Furnace');
    const rows = rowOrder(patch, a).length;
    const badOn = copy(preset);
    badOn.values[rows] = 2;
    const outOfRange = copy(preset);
    outOfRange.values[rows + 1] = 1e9;
    const before = copy(patch);
    for (const candidate of [badOn, outOfRange, { ...preset, values: preset.values.slice(0, -2).concat(preset.values.slice(-1)) }, { ...preset, structure: 'deadbeef', fx: undefined }]) {
      expect(applyPreset(patch, a, candidate, true)).toBe(false);
      expect(patch).toEqual(before);
    }
  });

  it('refuses to store a sound above 176 values, saying so, and never loads one', () => {
    const { patch, a } = instrument('Cassia 1');
    insertEffect(patch, drawerScope(patch, a)!.drawer, { type: 'reverb' });
    const snapshot = capturePreset(patch, a, 'Too Big');
    expect(snapshot.values.length).toBeGreaterThan(PRESET_VALUES_MAX);
    const before = copy(patch);
    expect(() => storePreset(patch, a, 'Too Big')).toThrow(/176/);
    expect(userPresets()).toEqual([]);
    expect(applyPreset(patch, a, snapshot, true)).toBe(false);
    expect(patch).toEqual(before);
  });

  it('keeps unsigned structure words through the signed Q16 wire form', () => {
    const values = drawerPresetValues('fedcba98', [0.5], [{ on: true, values: [2, 0.25] }]);
    const structure = drawerPresetStructure('fedcba98', ['01234567']);
    const received = parsePresetData({ cmd: CMD.presetData, payload: parse(presetPutFrame(structure, 'Signed', values))!.payload })!;
    expect(drawerPresetInfo({ values: received.values! })).toEqual({ baseStructure: 'fedcba98', count: 1 });
  });

  it('is sent only to firmware that reads FX drawers (INFO byte 25 bit 3)', async () => {
    const { patch, a } = instrument();
    const preset = sound(patch, a, 'Pink Wind');
    const payload = [1, 128, 255, 3, 255, 128, 0, 1, 55, 0, 0, 0, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const link = new DeviceLink();
    link.info = parseInfo({ cmd: CMD.info, payload: [...payload, 0] })!;
    expect(link.presetFits(preset.values.length, preset)).toBe(false);
    await expect(link.putPreset(preset.structure, preset.name, preset.values)).rejects.toThrow(PRESET_NEEDS_UPDATE);
    link.info = parseInfo({ cmd: CMD.info, payload: [...payload, FEATURE5_FX_DRAWERS] })!;
    expect(link.presetFits(preset.values.length, preset)).toBe(true);
    expect(link.presetFits(177, preset)).toBe(false);
  });
});

describe('loading rebuilds the drawer (one undo step in the editor)', () => {
  it('adds, removes and reorders effects to match, and the menu row says so beforehand', () => {
    const { patch, a } = instrument();
    expect(applyPreset(patch, a, sound(patch, a, 'Wheel Furnace'))).toBe(true);
    storePreset(patch, a, 'Full');
    const full = userPresets()[0];
    const scope = drawerScope(patch, a)!;
    removeEffect(patch, effect(patch, a, 'Chorus').id);
    const reverb = effect(patch, a, 'Reverb');
    moveEffect(patch, scope.drawer, reverb.id, 0);
    const view = presetView(patch, a, presetsOf(patch, a).find(p => p.name === 'Full')!)!;
    expect(view).toEqual({ noFx: false, chain: ['Drive', 'Chorus', 'Delay', 'Reverb'], on: [true, true, true, true].map((_, i) => full.values[rowOrder(patch, a).length + [0, 5, 9, 16][i]] === 1), adds: ['Chorus'], removes: [] });
    expect(applyPreset(patch, a, full)).toBe(false);   // (as the FM-1: never a partial load)
    expect(applyPreset(patch, a, full, true)).toBe(true);
    expect(drawerScope(patch, a)!.structure).toBe(full.structure);
    expect(effectsOf(patch, scope.drawer).map(e => e.label)).toEqual(['Drive', 'Chorus', 'Delay', 'Reverb']);
    expect(q16(capturePreset(patch, a, 'Full').values)).toEqual(q16(full.values));
  });

  it('takes out effects the preset has not got, and finds the ones it lacks in the Library when the preset carries none', () => {
    const { patch, a } = instrument();
    for (const label of ['Drive', 'Chorus']) removeEffect(patch, effect(patch, a, label).id);
    storePreset(patch, a, 'Two');
    const two = { ...userPresets()[0], fx: undefined };
    const other = instrument();
    const view = presetView(other.patch, other.a, two)!;
    expect(view.adds).toEqual([]);
    expect(view.removes).toEqual(['Drive', 'Chorus']);
    expect(applyPreset(other.patch, other.a, two, true)).toBe(true);
    expect(effectsOf(other.patch, drawerScope(other.patch, other.a)!.drawer).map(e => e.label)).toEqual(['Delay', 'Reverb']);
    // and back: the four-effect factory preset, without copies of its effects, adds Drive and Chorus from the Library
    expect(applyPreset(other.patch, other.a, { ...sound(other.patch, other.a, 'Wheel Furnace'), fx: undefined }, true)).toBe(true);
    expect(drawerScope(other.patch, other.a)!.effects.map(e => e.label)).toEqual(['Drive', 'Chorus', 'Delay', 'Reverb']);
  });

  it('does not offer a preset whose effects are in neither the patch nor the Library, and says why', () => {
    const { patch, a } = instrument();
    const base = structureOf(patch, a);
    const odd: Preset = { structure: drawerPresetStructure(base, ['0badf00d']), name: 'Odd', values: drawerPresetValues(base, currentValues(patch, a), [{ on: true, values: [0.5] }]) };
    importPresets({ format: 'matryoshka-presets', presets: [odd] });
    const { list, unloadable } = presetChoices(patch, a);
    expect(list.some(p => p.name === 'Odd')).toBe(false);
    expect(unloadable).toEqual([{ preset: expect.objectContaining({ name: 'Odd' }), reason: UNKNOWN_EFFECTS }]);
  });

  it('presetDiff names each effect’s change in the chain’s order after the load, the removed ones where they stand', () => {
    const { patch, a } = instrument();
    expect(applyPreset(patch, a, sound(patch, a, 'Wheel Furnace'))).toBe(true);
    storePreset(patch, a, 'Full');
    const full = userPresets()[0];
    for (const label of ['Drive', 'Chorus']) removeEffect(patch, effect(patch, a, label).id);
    storePreset(patch, a, 'Two');
    const two = userPresets().find(p => p.name === 'Two')!;
    // Full into Delay, Reverb with Delay off and one of Reverb's rows moved: Drive and Chorus come back
    const delay = effect(patch, a, 'Delay'), reverb = effect(patch, a, 'Reverb');
    bypassAssembly(patch, delay, true);
    const row = rowOrder(patch, reverb)[0];
    param(patch, row.module)[row.param] += 0.01;
    const kinds = (d: PresetDiff | null) => d!.fx.map(c => `${c.name} ${c.kind}${c.values ? ` ${c.values}` : ''}${c.effect ? '' : ' (new)'}`);
    expect(kinds(presetDiff(patch, a, full))).toEqual(['Drive add (new)', 'Chorus add (new)', 'Delay on', 'Reverb values 1']);
    expect(presetDiff(patch, a, full)!.rows).toBe(0);
    // Two into Full: Drive and Chorus go, shown before Delay where they stand
    expect(applyPreset(patch, a, full, true)).toBe(true);
    expect(kinds(presetDiff(patch, a, two))).toEqual(['Drive gone', 'Chorus gone', 'Delay same', 'Reverb same']);
    // an instrument-only preset leaves the drawer: only its rows count
    const plain = { structure: structureOf(patch, a), name: 'Plain', values: currentValues(patch, a).map((v, i) => (i ? v : v + 0.01)) };
    expect(presetDiff(patch, a, plain)).toMatchObject({ rows: 1, noFx: true });
    expect(presetDiff(patch, a, plain)!.fx.every(c => c.kind === 'same')).toBe(true);
  });
});

describe('instrument-only presets ("no FX")', () => {
  it('load the instrument and leave its drawer as it is, shortened ones too', () => {
    const { patch, a } = instrument('Cassia 1');
    expect(applyPreset(patch, a, sound(patch, a, 'Velvet Chords'))).toBe(true);
    const fx = capturePreset(patch, a, 'x').values.slice(rowOrder(patch, a).length);
    const before = currentValues(patch, a);
    const init = sound(patch, a, 'Init').values.slice(0, rowOrder(patch, a).length);
    const legacy = { structure: structureOf(patch, a), name: 'Old', values: init.slice(0, 88) };
    expect(presetView(patch, a, legacy)).toEqual({ noFx: true, chain: [], on: [], adds: [], removes: [] });
    expect(applyPreset(patch, a, legacy, true)).toBe(true);
    expect(currentValues(patch, a).slice(0, 88)).toEqual(legacy.values);
    expect(currentValues(patch, a).slice(88)).toEqual(before.slice(88));
    expect(capturePreset(patch, a, 'x').values.slice(rowOrder(patch, a).length)).toEqual(fx);
  });

  it('are listed after the drawer presets for an instrument with a drawer', () => {
    const { patch, a } = instrument();
    importPresets({ format: 'matryoshka-presets', presets: [{ structure: structureOf(patch, a), name: 'Plain', values: currentValues(patch, a) }] });
    const list = presetsOf(patch, a);
    expect(list.find(p => p.name === 'Plain') && presetView(patch, a, list.find(p => p.name === 'Plain')!)!.noFx).toBe(true);
    expect(list.filter(p => p.factory).every(p => drawerPresetInfo(p))).toBe(true);
  });
});

describe('effect presets', () => {
  it('store an effect’s own controls and load onto any copy of it', () => {
    const { patch, a } = instrument();
    const reverb = effect(patch, a, 'Reverb');
    const kernel = reverb.modules.find(id => patch.modules.find(m => m.id === id)!.type === 'reverb')!;
    param(patch, kernel).size = 0.91;
    storePreset(patch, reverb, 'Big hall');
    const stored = userPresets()[0];
    expect(stored.structure).toBe(structureOf(patch, reverb));
    expect(drawerPresetInfo(stored)).toBeNull();
    const other = instrument('Sallen 20');
    const there = effect(other.patch, other.a, 'Reverb');
    expect(presetsOf(other.patch, there).map(p => p.name)).toContain('Big hall');
    expect(applyPreset(other.patch, there, stored)).toBe(true);
    const k2 = there.modules.find(id => other.patch.modules.find(m => m.id === id)!.type === 'reverb')!;
    expect(param(other.patch, k2).size).toBeCloseTo(0.91);
  });
});

describe('old "+ FX" presets (FXP1) become FX drawer presets wherever they are read', () => {
  /** an FXP1 record of the Monolith D: Init rows, every stage on, each control a value of its own */
  function fxp1(patch: Patch, a: AssemblyInst): { structure: string; name: string; values: number[]; controls: Record<string, number[]> } {
    const base = structureOf(patch, a);
    const controls: Record<string, number[]> = {
      drive: [2, 1, 0.5, 0], chorus: [0.4, 0.3, 0.2], delay: [123, 0.25, 0.3, 0, 1, 0], reverb: [0.6, 0.4, 0.22, 12, 0, 0],
    };
    const payload = FX_PRESET_KINDS.flatMap(kind => [1, ...controls[kind]]);
    const rows = sound(patch, a, 'Init').values.slice(0, rowOrder(patch, a).length);
    return { structure: fxPresetStructure(base, 15), name: 'OLD', values: [...rows, ...payload, (parseInt(base, 16) << 16) >> 16, parseInt(base, 16) >> 16, 15, 23118], controls };
  }
  function expectLoaded(patch: Patch, a: AssemblyInst, controls: Record<string, number[]>): void {
    const of = (label: string, type: string): Record<string, number>[] => effect(patch, a, label).modules.map(id => patch.modules.find(m => m.id === id)!).filter(m => m.type === type).map(m => m.params);
    for (const [kind, label] of [['drive', 'Drive'], ['chorus', 'Chorus'], ['delay', 'Delay']] as const)
      for (const params of of(label, kind === 'drive' ? 'shape' : kind)) FX_PRESET_CONTROLS[kind].forEach((c, i) => expect(params[c], `${kind}.${c}`).toBeCloseTo(controls[kind][i]));
    expect(of('Reverb', 'reverb')[0].size).toBeCloseTo(controls.reverb[0]);
    expect(of('Reverb', 'macro')[0].value).toBeCloseTo(controls.reverb[2]);
    expect(drawerScope(patch, a)!.effects.every(e => !e.bypass)).toBe(true);
  }

  it('from the FM-1 (PRESET_DATA pulls): the stage controls land on the converted effects’ rows', () => {
    const { patch, a } = instrument();
    const old = fxp1(patch, a);
    expect(addUserPreset(old.structure, old.name, old.values)).toBe('Old');
    const got = userPresets()[0];
    expect(got.structure).toBe(drawerScope(patch, a)!.structure);
    expect(got.values).toHaveLength(old.values.length);
    expect(applyPreset(patch, a, got)).toBe(true);
    expectLoaded(patch, a, old.controls);
  });

  it('from this browser’s store, rewritten once as the app starts, and from a library file', () => {
    const { patch, a } = instrument();
    const old = fxp1(patch, a);
    localStorage.setItem('matryoshka.presets', JSON.stringify([old]));
    expect(migrateUserPresets()).toBe(1);
    const stored = JSON.parse(localStorage.getItem('matryoshka.presets')!) as Preset[];
    expect(stored[0].structure).toBe(drawerScope(patch, a)!.structure);
    expect(applyPreset(patch, a, userPresets()[0])).toBe(true);
    expectLoaded(patch, a, old.controls);
    localStorage.setItem('matryoshka.presets', '[]');
    expect(importPresets({ format: 'matryoshka-presets', presets: [old] })).toBe(1);
    expect(userPresets()[0].structure).toBe(drawerScope(patch, a)!.structure);
  });
});

describe('factory presets of the converted factory drawers', () => {
  it('are 130 FX drawer presets of at most 176 values, each loading on its factory patch as it is', () => {
    const fx = factoryRackPresets().filter(p => drawerPresetInfo(p));
    expect(fx).toHaveLength(130);
    expect(Math.max(...fx.map(p => p.values.length))).toBeLessThanOrEqual(PRESET_VALUES_MAX);
    const scopes = bank.flatMap(entry => {
      const patch = validatePatch(copy(entry.patch), DEFS);
      return (patch.assemblies ?? []).flatMap(a => { const s = drawerScope(patch, a); return s ? [{ patch, a, s }] : []; });
    });
    for (const preset of fx) {
      const at = scopes.find(x => x.s.structure === preset.structure);
      expect(at, preset.name).toBeDefined();
      expect(applyPreset(at!.patch, at!.a, preset), preset.name).toBe(true);
    }
    expect(Object.keys(FACTORY_FX_MASKS)).toHaveLength(13);
  });

  it('keep their sounds: each effect’s on/off and controls as the old + FX preset had them', () => {
    const { patch, a } = instrument();
    const preset = sound(patch, a, 'Glide Lead');
    expect(applyPreset(patch, a, preset)).toBe(true);
    const shape = effect(patch, a, 'Drive').modules.map(id => patch.modules.find(m => m.id === id)!).find(m => m.type === 'shape')!;
    expect(shape.params.drive).toBeCloseTo(2.1);
    expect(shape.params.level).toBeCloseTo(0.4);
    expect(effect(patch, a, 'Chorus').bypass).toBe(true);
    const delay = effect(patch, a, 'Delay').modules.map(id => patch.modules.find(m => m.id === id)!).find(m => m.type === 'delay')!;
    expect(delay.params.time).toBeCloseTo(330);
  });
});
