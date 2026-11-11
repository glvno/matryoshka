// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import type { DeviceLink } from './device';
import { currentValues, setFactoryPresets, storePreset, userPresets } from './device-presets';
import { buildPresetsSection } from './library-presets';
import { DEFS } from './modules';
import { newPatch, validatePatch } from './patch';
import { bindPatchPresetTransfer } from './patch-presets';
import type { DevicePresetEntry } from './protocol';
import { structureOf } from './structure';

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
