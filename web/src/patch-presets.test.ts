// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly, makeAssembly, promote } from './assembly';
import { setFactoryPresets, storePreset, userPresets } from './device-presets';
import { DEFS } from './modules';
import { addModule, newPatch, validatePatch } from './patch';
import { patchPresets, sendPatchPresets } from './patch-presets';
import type { DevicePresetEntry } from './protocol';

beforeEach(() => { localStorage.clear(); setFactoryPresets([]); });
const fixture = () => {
  const patch = newPatch(DEFS);
  const def = FACTORY.find((d) => d.name === 'supersaw stack')!;
  const a = insertAssembly(patch, DEFS, def, 0, 0);
  insertAssembly(patch, DEFS, def, 900, 0);
  storePreset(patch, a, 'My Stack');
  const other = newPatch(DEFS);
  storePreset(other, insertAssembly(other, DEFS, FACTORY.find((d) => d.name === 'Hera 4')!, 0, 0), 'Other');
  const device = { connected: true, hasPresets: true, presetFits: () => true,
    listPresets: vi.fn(async () => [] as DevicePresetEntry[]), putPreset: vi.fn(async () => {}) };
  return { patch: validatePatch(JSON.parse(JSON.stringify(patch)), DEFS), device };
};

it('sends only user presets for this patch’s devices, once per structure, after save/load (#829)', async () => {
  const { patch, device } = fixture();
  const confirm = vi.fn(() => true);
  expect(patchPresets(patch).map((p) => p.name)).toEqual(['My Stack']);
  const result = await sendPatchPresets(patch, device, confirm);
  expect(result).toContain('1 preset sent');
  expect(device.putPreset).toHaveBeenCalledExactlyOnceWith(userPresets()[0].structure, 'My Stack', userPresets()[0].values);
  expect(confirm).not.toHaveBeenCalled();
});

it('transfers distinct parent and nested child presets once each after save/load', async () => {
  const { patch, device } = fixture();
  const child = patch.assemblies![0];
  const parent = makeAssembly(patch, [], 'Two stacks', patch.assemblies!.map((a) => a.id));
  promote(parent, child.params[0].module, child.params[0].param, patch);
  storePreset(patch, parent, 'Whole Stack');
  const saved = validatePatch(JSON.parse(JSON.stringify(patch)), DEFS);
  const selected = patchPresets(saved);
  expect(selected.map((p) => p.name)).toEqual(['My Stack', 'Whole Stack']);
  expect(new Set(selected.map((p) => p.structure)).size).toBe(2);
  expect(parent.children).toContain(child.id);
  expect(await sendPatchPresets(saved, device, () => true)).toBe('2 presets sent to the FM-1’s preset store. PRESET selects presets for matching device pages. Nested assemblies have no separate device page in this patch.');
  expect(device.putPreset.mock.calls).toEqual(selected.map((p) => [p.structure, p.name, p.values]));
});

it.each([
  { type: 'delay', param: 'time', value: 375 },
  { type: 'vca', param: 'gain', value: 0.4 },
])('transfers a $type assembly preset without a generator or keys input', async ({ type, param, value }) => {
  const { device } = fixture();
  const patch = newPatch(DEFS);
  const module = addModule(patch, DEFS[type], 0, 0);
  const assembly = makeAssembly(patch, [module.id], 'My processor');
  promote(assembly, module.id, param, patch);
  module.params[param] = value;
  storePreset(patch, assembly, 'My setting');
  const saved = validatePatch(JSON.parse(JSON.stringify(patch)), DEFS);

  expect(patchPresets(saved).map((p) => [p.name, p.values])).toEqual([['My setting', [value]]]);
  expect(await sendPatchPresets(saved, device, () => true)).toContain('1 preset sent');
  expect(device.putPreset).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'My setting', [value]);

  // Adding another card row changes the structure, even though the assembly keeps its name.
  const copy = saved.assemblies![0];
  const added = addModule(saved, DEFS.delay, 300, 0);
  copy.modules.push(added.id);
  promote(copy, added.id, 'fb', saved);
  device.putPreset.mockClear();
  expect(await sendPatchPresets(saved, device, () => true)).toContain('no saved user presets');
  expect(device.putPreset).not.toHaveBeenCalled();
});

it('leaves factory-only preset lists on the FM-1 without reading or writing its store', async () => {
  const { patch, device } = fixture();
  setFactoryPresets([userPresets()[0]]);
  localStorage.clear();

  expect(await sendPatchPresets(patch, device, () => true)).toContain('Factory presets are already on the FM-1');
  expect(device.listPresets).not.toHaveBeenCalled();
  expect(device.putPreset).not.toHaveBeenCalled();
});

it('confirms case-insensitive FM-1 name collisions before sending anything; cancel preserves both stores', async () => {
  const { patch, device } = fixture();
  device.listPresets.mockResolvedValue([{ ...userPresets()[0], name: 'MY STACK', index: 0, count: 1, n: userPresets()[0].values.length }]);
  const before = JSON.stringify(userPresets());
  const confirm = vi.fn(() => false);
  expect(await sendPatchPresets(patch, device, confirm)).toBe('No presets sent.');
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('My Stack'));
  expect(device.putPreset).not.toHaveBeenCalled();
  expect(JSON.stringify(userPresets())).toBe(before);
  await sendPatchPresets(patch, device, () => true);
  expect(device.putPreset).toHaveBeenCalledTimes(1);
});

it('refuses ambiguous wire names and presets too long for old firmware before writing', async () => {
  const { patch, device } = fixture();
  const a = patch.assemblies![0];
  storePreset(patch, a, '1234567890123456 first');
  storePreset(patch, a, '1234567890123456 second');
  await expect(sendPatchPresets(patch, device, () => true)).rejects.toThrow('Rename one');
  expect(device.putPreset).not.toHaveBeenCalled();
  device.presetFits = () => false;
  await expect(sendPatchPresets(patch, device, () => true)).rejects.toThrow('Update the FM-1');
  expect(device.putPreset).not.toHaveBeenCalled();
});

it('reports partial transfer on full store instead of claiming success', async () => {
  const { patch, device } = fixture();
  storePreset(patch, patch.assemblies![0], 'Second');
  device.putPreset.mockResolvedValueOnce().mockRejectedValueOnce(new Error('FM-1: full'));
  await expect(sendPatchPresets(patch, device, () => true)).rejects.toThrow('1 of 2 presets sent. FM-1: full');
});

it('rejects an empty FM-1 name before sending any of the surrounding valid presets', async () => {
  const { patch, device } = fixture();
  storePreset(patch, patch.assemblies![0], '日本語');
  storePreset(patch, patch.assemblies![0], 'Second');
  const before = JSON.stringify(userPresets());

  await expect(sendPatchPresets(patch, device, () => true)).rejects.toThrow(/日本語.*Rename/);
  expect(device.listPresets).not.toHaveBeenCalled();
  expect(device.putPreset).not.toHaveBeenCalled();
  expect(JSON.stringify(userPresets())).toBe(before);
});

it('does not silently transfer on an unsupported or disconnected FM-1', async () => {
  const { patch, device } = fixture();
  device.connected = false;
  await expect(sendPatchPresets(patch, device, () => true)).rejects.toThrow('Connect');
  device.connected = true;
  device.hasPresets = false;
  await expect(sendPatchPresets(patch, device, () => true)).rejects.toThrow('Update');
  expect(device.listPresets).not.toHaveBeenCalled();
  expect(device.putPreset).not.toHaveBeenCalled();
});
