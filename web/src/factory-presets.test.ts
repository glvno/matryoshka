// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { applyPreset, deletePreset, presetsOf, renamePreset, storePreset, userPresets } from './device-presets';
import { defIsEngine, instIsEngine } from './engines';
import { factoryPresets, factoryRackPresets, presetsOfDef } from './factory-presets';
import { DEFS } from './modules';
import { newPatch } from './patch';
import { relocatedPatches } from './community-factory';
import { defStructure, structureOf } from './structure';
import { devicesOf } from './pages';
import { FM1_PRESETS } from './presets';

const FACTORY_PRESETS = factoryPresets();

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

describe('factory presets (#193)', () => {
  it('every factory engine has Init and at least one more, each of its structure and row count', () => {
    for (const def of FACTORY.filter((d) => defIsEngine(d))) {
      const list = presetsOfDef(def);
      expect(list[0].name, def.name).toBe('Init');
      expect(list.length, def.name).toBeGreaterThanOrEqual(2);
      for (const p of list) {
        expect(p.structure).toBe(defStructure(def));
        expect(p.values.length).toBe(def.params.length);
        expect(p.factory).toBe(true);
      }
    }
    expect(new Set(FACTORY_PRESETS.map((p) => `${p.structure}/${p.name}`)).size).toBe(FACTORY_PRESETS.length);
  });

  it('load on an inserted engine; read-only; storing over one makes a new one', () => {
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Hera 4')!, 0, 0);
    const list = presetsOf(p, a);
    expect(list.map((x) => x.name).slice(0, 2)).toEqual(['Init', 'Brass']); // its card (presets/cards/hera-6.txt)
    expect(applyPreset(p, a, list[1])).toBe(true);
    expect(renamePreset(list[0].structure, 'Init', 'x')).toBe(false);
    expect(deletePreset(list[0].structure, 'Brass')).toBe(false);
    expect(storePreset(p, a, 'Brass')).toBe('Brass 2');
  });

  it('ships the melodic sounds through normal defaults and the ROM providers without user presets', () => {
    const rom = [...factoryPresets(), ...factoryRackPresets()];
    let total = 0;
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make();
      const sounds = devicesOf(p, DEFS).flatMap(device => {
        if (device.asm === undefined) return [];
        const assembly = p.assemblies!.find(a => a.id === device.asm)!;
        return presetsOf(p, assembly).map(preset => ({ assembly, preset }));
      });
      for (const { assembly, preset } of sounds) {
        expect(preset.factory, `${name}/${preset.name}`).toBe(true);
        // Card limits bound the listed copy (a three-voice Expander shows 3 of a stored 4); both recall the same sound.
        const record = rom.find(r => r.structure === preset.structure && r.name === preset.name);
        expect(record?.values.length, `${name}/${preset.name}`).toBe(preset.values.length);
        const [fromRom, listed] = [structuredClone(p), structuredClone(p)];
        const find = (q: typeof p) => q.assemblies!.find(a => a.id === assembly.id)!;
        expect(applyPreset(fromRom, find(fromRom), record!) && applyPreset(listed, find(listed), preset), `${name}/${preset.name}`).toBe(true);
        expect(fromRom, `${name}/${preset.name}`).toEqual(listed);
        expect(applyPreset(p, assembly, preset), `${name}/${preset.name}`).toBe(true);
        total++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(userPresets()).toEqual([]);
    expect(mem.size).toBe(0);
  });

  it('every relocated community engine keeps loadable presets for its original structure', () => {
    for (const [name, make] of Object.entries(relocatedPatches)) {
      const p = make();
      const engines = (p.assemblies ?? []).filter((a) => instIsEngine(p, a));
      for (const a of engines) {
        const list = presetsOf(p, a);
        expect(list[0]?.name, name).toBe('Init');
        expect(list.length, name).toBeGreaterThanOrEqual(1);
        expect(list.every((x) => x.structure === structureOf(p, a))).toBe(true);
        expect(applyPreset(p, a, list[list.length - 1]), name).toBe(true);
      }
    }
  }, 120000); // Whole-panel community instruments are heavy under coverage.
});
