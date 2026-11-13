// SPDX-License-Identifier: GPL-3.0-only
// #452: a preset load never makes a patch unsendable. The FM-1 budget keeps NAME_MAX bytes for every engine device's
// preset name (patchbin.ts presetNames), so every FM-1 factory patch fits at every factory preset of its engines, the
// name included; another device's name goes along only when it fits, as the FM-1 skips one that does not.
import { describe, expect, it } from 'vitest';
import './factory-presets';
import { assemblyById } from './assembly';
import { applyPreset, presetsOf } from './device-presets';
import { instIsEngine } from './engines';
import { DEFS } from './modules';
import { devicesOf, NAME_MAX } from './pages';
import { DEVICE, deviceBudget, deviceText, encodePatch, layout, presetNames } from './patchbin';
import { PRESETS } from './presets';
import { relocatedPatches } from './community-factory';
import type { Patch } from './patch';

const bytes = (p: Patch): number => deviceBudget(p).items.find((i) => i.key === 'bytes')!.used;
const holds = (bin: Uint8Array, name: string): boolean => new TextDecoder().decode(bin).includes(name);
/** the assembly devices of a patch, by their place in its assemblies list */
const asmDevices = (p: Patch): number[] => devicesOf(p, DEFS).flatMap((d) => (d.asm === undefined ? [] : [(p.assemblies ?? []).indexOf(assemblyById(p, d.asm)!)]));

describe('preset names and the FM-1 budget (#452)', () => {
  it('every FM-1 factory patch fits at every factory preset of its devices, the name included', () => {
    const bad: string[] = [];
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      for (const ai of asmDevices(p)) {
        for (const preset of presetsOf(p, p.assemblies![ai])) {
          const q = structuredClone(p);
          if (!applyPreset(q, q.assemblies![ai], preset)) continue;
          // (the CPU estimate is not this test's: a preset may make an engine work harder, the estimate's own checks)
          const over = deviceBudget(q).over.filter((i) => i.key !== 'cpu');
          if (over.length) bad.push(`${name} at ${preset.name}: ${over.map((i) => `${i.label} ${i.used} of ${i.max}`).join(', ')}`);
          else if (!holds(encodePatch(q, true), deviceText(preset.name))) bad.push(`${name} at ${preset.name}: the name is not in the binary`);
          // The sound may switch an untouched pattern of another length. Name reservation itself stays constant.
          if (instIsEngine(q, q.assemblies![ai])) {
            const withoutName = structuredClone(q);
            delete withoutName.assemblies![ai].preset;
            if (bytes(q) !== bytes(withoutName)) bad.push(`${name} at ${preset.name}: name exceeded its reservation`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('an engine keeps room for the longest name: a user preset name of any length leaves the budget as it was', () => {
    const p = relocatedPatches['Io 4']();
    const a = p.assemblies!.find((x) => instIsEngine(p, x))!;
    const before = bytes(p);
    a.preset = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    expect(bytes(p)).toBe(before);
    expect(deviceBudget(p).fits).toBe(true);
    expect(holds(encodePatch(p), 'ABCDEFGHIJKL')).toBe(true); // (NAME_MAX characters of it)
    expect(deviceText(a.preset)).toHaveLength(NAME_MAX);
  });

  it('another device\'s name goes along while it fits, else it is left out (as the FM-1 does)', () => {
    const p = PRESETS['<7PH']();
    const devs = devicesOf(p, DEFS);
    const drum = p.assemblies!.find((x) => !instIsEngine(p, x) && devs.some((d) => d.asm === x.id))!;
    for (const a of p.assemblies!) if (!instIsEngine(p, a)) delete a.preset;
    const view = layout(p), index = view.devs.findIndex((d) => d.asm === drum.id);
    drum.preset = 'SNAPPY';
    // Reserve a synthetic tail to isolate the exact boundary from evolving factory structures and formats.
    const namesWithRoom = (room: number) => presetNames(p, view.p, view.groups, view.devs,
      view.kinds.length + DEVICE.bytes - view.need - room, view.v, view.keep).names;
    expect(namesWithRoom(5)[index]).toBe('');
    expect(namesWithRoom(6)[index]).toBe('SNAPPY');
    // with room: written
    const q = PRESETS['909 Kit']();
    const kick = q.assemblies!.find((x) => devicesOf(q, DEFS).some((d) => d.asm === x.id))!;
    kick.preset = 'SNAPPY';
    expect(holds(encodePatch(q), 'SNAPPY')).toBe(true);
  });
});
