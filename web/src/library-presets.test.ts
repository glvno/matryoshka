// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly, parentOf, type AssemblyInst } from './assembly';
import type { DeviceLink } from './device';
import { applyPreset, capturePreset, currentValues, presetsOf, setFactoryPresets, storePreset, userPresets } from './device-presets';
import { defIsEngine } from './engines';
import { drawerScope } from './fx-preset';
import { drawerPresetInfo } from './fx-preset-format';
import { buildPresetsSection, engineOf } from './library-presets';
import { DEFS } from './modules';
import { newPatch, validatePatch, type Patch } from './patch';
import { bindPatchPresetTransfer } from './patch-presets';
import { FM1_PRESETS } from './presets';
import type { DevicePresetEntry } from './protocol';
import { defStructure, structureOf } from './structure';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => { localStorage.clear(); setFactoryPresets([]); vi.restoreAllMocks(); });

it('explicitly transfers a saved Supersaw Stack preset after reopening the patch (#829)', async () => {
  const patch = newPatch(DEFS);
  const assembly = insertAssembly(patch, DEFS, FACTORY.find((d) => d.name === 'supersaw stack')!, 0, 0);
  storePreset(patch, assembly, 'My Stack');
  const reopened = validatePatch(JSON.parse(JSON.stringify(patch)), DEFS);
  const copy = reopened.assemblies!.find((a) => a.id === assembly.id)!;
  const preset = userPresets()[0];
  expect(structureOf(reopened, copy)).toBe(preset.structure);
  expect(currentValues(reopened, copy)).toEqual(preset.values);
  const putPreset = vi.fn(async () => {});
  const device = { connected: true, hasPresets: true, presetFits: () => true,
    listPresets: async () => [], putPreset } as unknown as DeviceLink;
  const root = document.createElement('div');
  const section = buildPresetsSection(root, device, { changed() {} });
  section.enter();
  await flush();
  expect(putPreset).not.toHaveBeenCalled();
  const send = [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'send "My Stack" to the FM-1')!;
  send.click();
  await flush();
  expect(putPreset).toHaveBeenCalledWith(preset.structure, preset.name, preset.values);
});

it.each([
  { partial: true, sendAll: false },
  { partial: true, sendAll: true },
  { partial: false, sendAll: false },
  { partial: false, sendAll: true },
])('refreshes an open Library after patch transfer (partial=$partial) before replacement (all=$sendAll)', async ({ partial, sendAll }) => {
  const patch = newPatch(DEFS);
  const assembly = insertAssembly(patch, DEFS, FACTORY.find((d) => d.name === 'supersaw stack')!, 0, 0);
  storePreset(patch, assembly, 'My Stack');
  storePreset(patch, assembly, 'Second');
  const stored: DevicePresetEntry[] = [];
  const putPreset = vi.fn(async (structure: string, name: string, values: number[]) => {
    if (partial && name === 'Second') throw new Error('FM-1: full');
    stored.push({ structure, name, index: stored.length, count: 1, n: values.length });
  });
  const device = { connected: true, hasPresets: true, presetFits: () => true,
    listPresets: async () => [...stored], putPreset } as unknown as DeviceLink;
  const root = document.createElement('div');
  const section = buildPresetsSection(root, device, { changed() {} });
  section.enter();
  await flush();
  expect(root.querySelector('.lib-state')!.textContent).toBe('On the FM-1 · 0 presets');
  const button = document.createElement('button');
  const status = document.createElement('p');
  bindPatchPresetTransfer(button, () => patch, device, (message) => { status.textContent = message; }, () => section.deviceChanged(true));
  button.click();
  expect(button.disabled).toBe(true);
  await flush();

  expect(status.textContent).toContain(partial ? '1 of 2 presets sent. FM-1: full' : '2 presets sent');
  expect(button.disabled).toBe(false);
  expect(root.querySelector('.lib-state')!.textContent).toBe(partial ? 'On the FM-1 · 1 preset' : 'On the FM-1 · 2 presets');
  expect([...root.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'copy "My Stack" into this browser')).toBe(true);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  putPreset.mockClear();
  const send = [...root.querySelectorAll('button')].find((b) => sendAll
    ? b.textContent === 'Send all to FM-1'
    : b.getAttribute('aria-label') === 'send "My Stack" to the FM-1')!;
  expect(send.disabled).toBe(false);
  send.click();
  await flush();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('My Stack'));
  expect(putPreset).not.toHaveBeenCalled();
});

/** a factory patch as the editor opens it and its one instrument (the drawer's effects are not instruments) */
function factoryInstrument(name: string): { patch: Patch; instrument: AssemblyInst } {
  const patch = validatePatch(JSON.parse(JSON.stringify(FM1_PRESETS[name]())), DEFS);
  const found = (patch.assemblies ?? []).filter((a) => !parentOf(patch, a.id) && !a.chain && !a.drawer && a.modules.length);
  return { patch, instrument: found.length === 1 ? found[0] : undefined! };
}

it('labels a preset stored from the factory Hera 6 with its drawer "Hera 6 with FX", not its library engine "Hera 4" (owner 2026-11-23)', () => {
  const { patch, instrument } = factoryInstrument('Hera 6');
  storePreset(patch, instrument, 'gauze');
  const root = document.createElement('div');
  buildPresetsSection(root, { connected: false, hasPresets: false } as unknown as DeviceLink, { changed() {} });
  const row = root.querySelector('.bank-row')!;
  expect(row.querySelector('.grow')!.textContent).toBe('gauze');
  expect(row.querySelector('.muted')!.textContent).toBe('Hera 6 with FX');
});

it('names every factory instrument as its patch shows it, with "with FX" for its drawer; library engines in no patch keep their own names', () => {
  const bankStructures = new Set<string>();
  for (const name of Object.keys(FM1_PRESETS)) {
    const { patch, instrument } = factoryInstrument(name);
    expect(instrument, `${name}: one instrument`).toBeDefined();
    const base = structureOf(patch, instrument);
    bankStructures.add(base);
    expect(engineOf(base), name).toBe(name);
    const scope = drawerScope(patch, instrument);
    if (scope) expect(engineOf(scope.structure, capturePreset(patch, instrument, 'x').values), name).toBe(`${name} with FX`);
  }
  for (const def of FACTORY.filter((d) => defIsEngine(d) && !bankStructures.has(defStructure(d)))) expect(engineOf(defStructure(def))).toBe(def.name);
  // the library's Hera 4 is the Hera 6 patch's instrument at four voices (D-873): one structure, so one preset list
  expect(engineOf(defStructure(FACTORY.find((d) => d.name === 'Hera 4')!))).toBe('Hera 6');
});

it('loads a Hera 6 preset with its drawer only where a drawer is; its instrument-only presets fit the library Hera 4 as well', () => {
  const { patch, instrument } = factoryInstrument('Hera 6');
  storePreset(patch, instrument, 'gauze');
  const gauze = userPresets()[0];
  expect(drawerPresetInfo(gauze)).not.toBeNull();
  const other = factoryInstrument('Hera 6');
  expect(presetsOf(other.patch, other.instrument).some((p) => p.name === 'gauze')).toBe(true);
  expect(applyPreset(other.patch, other.instrument, gauze)).toBe(true);
  const lib = newPatch(DEFS);
  const hera4 = insertAssembly(lib, DEFS, FACTORY.find((d) => d.name === 'Hera 4')!, 0, 0);
  expect(structureOf(lib, hera4)).toBe(structureOf(patch, instrument));
  expect(presetsOf(lib, hera4).some((p) => p.name === 'gauze')).toBe(false);
  expect(applyPreset(lib, hera4, gauze, true)).toBe(false);
  storePreset(lib, hera4, 'plain');
  const plain = userPresets().find((p) => p.name === 'plain')!;
  expect(drawerPresetInfo(plain)).toBeNull();
  expect(applyPreset(other.patch, other.instrument, plain)).toBe(true);
  expect(currentValues(other.patch, other.instrument)).toEqual(plain.values);
});
