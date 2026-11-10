// SPDX-License-Identifier: GPL-3.0-only
// Explicit transfer of the user presets available to this patch's FM-1 devices (#829).
import { PRESET_NEEDS_UPDATE, type DeviceLink } from './device';
import { userPresets, type Preset } from './device-presets';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import type { Patch } from './patch';
import { devicePresetName } from './protocol';
import { structureOf } from './structure';

/** Only devices exposed on the FM-1; repeated copies share one preset list. */
export function patchPresets(patch: Patch): Preset[] {
  const structures = new Set(devicesOf(patch, DEFS).flatMap((d) => {
    const a = patch.assemblies?.find((a) => a.id === d.asm);
    return a ? [structureOf(patch, a)] : [];
  }));
  return userPresets().filter((p) => structures.has(p.structure));
}

type PresetPeer = Pick<DeviceLink, 'connected' | 'hasPresets' | 'presetFits' | 'listPresets' | 'putPreset'>;
const key = (p: { structure: string; name: string }): string => `${p.structure}/${devicePresetName(p.name).toLowerCase()}`;

/** Snapshot the selection before awaiting the FM-1. Preflight names, sizes and replacements before any write. */
export async function sendPatchPresets(patch: Patch, device: PresetPeer, confirm: (message: string) => boolean): Promise<string> {
  if (!device.connected) throw new Error('Connect the FM-1 first');
  if (!device.hasPresets) throw new Error('Update the FM-1 to transfer presets');
  const presets = patchPresets(patch);
  if (!presets.length) return 'This patch’s devices have no saved user presets to send. Factory presets are already on the FM-1.';
  const seen = new Set<string>();
  for (const p of presets) {
    if (!device.presetFits(p.values.length)) throw new Error(`${p.name}: ${PRESET_NEEDS_UPDATE}`);
    if (seen.has(key(p))) throw new Error(`Two presets become “${devicePresetName(p.name)}” on the FM-1. Rename one in Library > Presets before sending.`);
    seen.add(key(p));
  }
  const have = new Set((await device.listPresets()).map(key));
  const replaced = presets.filter((p) => have.has(key(p)));
  if (replaced.length && !confirm(`Replace ${replaced.length} preset${replaced.length === 1 ? '' : 's'} on the FM-1 (${replaced.map((p) => p.name).join(', ')}) with this browser’s saved presets?`)) return 'No presets sent.';
  let sent = 0;
  try {
    for (const p of presets) {
      await device.putPreset(p.structure, p.name, p.values);
      sent++;
    }
  } catch (e) {
    throw new Error(`${sent} of ${presets.length} presets sent. ${(e as Error).message}. Open Library > Presets to check the FM-1’s copies.`);
  }
  return `${sent} preset${sent === 1 ? '' : 's'} sent. PRESET on the FM-1 can now select them on this patch’s devices.`;
}
