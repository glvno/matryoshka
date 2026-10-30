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
import { DEVICE, deviceBudget, deviceText, encodePatch } from './patchbin';
import { FM1_PRESETS } from './presets';
import type { Patch } from './patch';

const bytes = (p: Patch): number => deviceBudget(p).items.find((i) => i.key === 'bytes')!.used;
const holds = (bin: Uint8Array, name: string): boolean => new TextDecoder().decode(bin).includes(name);
/** the assembly devices of a patch, by their place in its assemblies list */
const asmDevices = (p: Patch): number[] => devicesOf(p, DEFS).flatMap((d) => (d.asm === undefined ? [] : [(p.assemblies ?? []).indexOf(assemblyById(p, d.asm)!)]));

describe('preset names and the FM-1 budget (#452)', () => {
  it('every FM-1 factory patch fits at every factory preset of its devices, the name included', () => {
    const bad: string[] = [];
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make();
      const before = bytes(p);
      for (const ai of asmDevices(p)) {
        for (const preset of presetsOf(p, p.assemblies![ai])) {
          const q = structuredClone(p);
          if (!applyPreset(q, q.assemblies![ai], preset)) continue;
          // (the CPU estimate is not this test's: a preset may make an engine work harder, the estimate's own checks)
          const over = deviceBudget(q).over.filter((i) => i.key !== 'cpu');
          if (over.length) bad.push(`${name} at ${preset.name}: ${over.map((i) => `${i.label} ${i.used} of ${i.max}`).join(', ')}`);
          else if (!holds(encodePatch(q, true), deviceText(preset.name))) bad.push(`${name} at ${preset.name}: the name is not in the binary`);
          // an engine's name was counted already: the budget's bytes stay as they were
          if (instIsEngine(q, q.assemblies![ai]) && bytes(q) !== before) bad.push(`${name} at ${preset.name}: patch bytes ${before} -> ${bytes(q)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('an engine keeps room for the longest name: a user preset name of any length leaves the budget as it was', () => {
    const p = FM1_PRESETS['Io 4']();
    const a = p.assemblies!.find((x) => instIsEngine(p, x))!;
    const before = bytes(p);
    a.preset = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    expect(bytes(p)).toBe(before);
    expect(deviceBudget(p).fits).toBe(true);
    expect(holds(encodePatch(p), 'ABCDEFGHIJKL')).toBe(true); // (NAME_MAX characters of it)
    expect(deviceText(a.preset)).toHaveLength(NAME_MAX);
  });

  it('another device\'s name goes along while it fits, else it is left out (as the FM-1 does)', () => {
    const p = FM1_PRESETS['<7PH']();
    const drum = p.assemblies!.find((x) => !instIsEngine(p, x) && devicesOf(p, DEFS).some((d) => d.asm === x.id))!;
    expect(bytes(p)).toBeGreaterThan(DEVICE.bytes - 'SNAPPY'.length);
    const before = encodePatch(p).length;
    drum.preset = 'SNAPPY';
    expect(deviceBudget(p).fits).toBe(true);
    const bin = encodePatch(p);
    expect(holds(bin, 'SNAPPY')).toBe(false);
    expect(bin.length).toBe(before);
    // with room: written
    const q = FM1_PRESETS['909 Kit']();
    const kick = q.assemblies!.find((x) => devicesOf(q, DEFS).some((d) => d.asm === x.id))!;
    kick.preset = 'SNAPPY';
    expect(holds(encodePatch(q), 'SNAPPY')).toBe(true);
  });
});
