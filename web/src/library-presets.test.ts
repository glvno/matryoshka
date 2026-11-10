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
