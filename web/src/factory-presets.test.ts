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
import { fxPresetInfo } from './fx-preset-format';
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

  it('ships all 110 approved melodic sounds through normal defaults and the ROM providers without user presets', () => {
    const approved: Record<string, string[]> = {
      'Algo Four': ['Init', 'Solid Bass', 'Lately Bass', 'E Piano', 'Tubular Bell', 'Brass Stab', 'Amber EP', 'Porcelain Keys'],
      'Briefcase 3': ['Init', 'Space Drone', 'Ring Mod Clang', 'Resonant Ping', 'Sea Noise', 'Buzz Lead'],
      Canvas: ['Init', 'Sequencer Run', 'Complex Lead', 'Easel Bongos', 'Fold Drone', 'FM Chimes'],
      'Cassia 1': ['Init', 'PD Bass', 'PD Brass', 'Glass Bell', 'Reso Pad', 'Tine Piano', 'Velvet Chords'],
      'Expander S': ['Init', 'SEM Brass', 'SEM Bass', 'Notch Strings', 'Highpass Pluck', 'Unison Lead', 'Dusk Chord', 'Velvet Bloom'],
      'Hera 3': ['Init', 'Brass', 'Strings', 'Bass', 'Organ', 'Glass Pad', 'Faded Organ'],
      'Io 4': ['Init', 'Ensemble Pad', 'Arp Pluck', 'Unison Lead', 'S&H Filter', 'PWM Brass', 'Compu Piano', 'Compu Bass', 'Inverse Keys'],
      'Monolith D': ['Init', 'Fat Bass', 'Glide Lead', 'Square Lead', 'Pink Wind', 'Soft Flute', 'Muted Horn', 'Rhea Plucked Bass', 'Pocket Pulse', 'Fifth Signal', 'Copper Pluck', 'Hollow Reed', 'Register Organ', 'Wheel Furnace', 'Low Pillow', 'Velour Lead'],
      'Oracle V': ['Init', 'Sync Lead', 'Poly Brass', 'Vintage Strings', 'Poly-Mod Bell', 'Unison Bass'],
      'Sallen 20': ['Init', 'Acid Scream', 'Growl Bass', 'Ring Mod Bell', 'Noise Sweep', 'ESP Warble', 'Soft Reed', 'Pinch Pluck', 'Pitch Bloom'],
      'Silver Box': ['Init', 'Acid Squelch', 'Rubber Square', 'Deep Sub 303', 'Short Zap', 'Long Sweep', 'Dry Square', 'Accent Ladder', 'Open Saw'],
      'Vernon 100': ['Init', 'Fat Duo Lead', 'Wobble Bass', 'Stepped Pulse', 'Metal Clang', 'Slow Sweep Pad', 'Triangle Duo', 'Notch Loom', 'HP Clav'],
      Wanderer: ['Init', 'Sync Lead', 'S/H Bleeps', 'Ring Bell', 'Punch Bass', 'PWM Lead', 'Two Finger Reed', 'Keyed Color', 'Pink Breath', 'Paper Rain'],
    };
    const rom = [...factoryPresets(), ...factoryRackPresets()];
    let total = 0, scoped = 0;
    for (const [name, names] of Object.entries(approved)) {
      const p = FM1_PRESETS[name]();
      const sounds = devicesOf(p, DEFS).flatMap(device => {
        if (device.asm === undefined) return [];
        const assembly = p.assemblies!.find(a => a.id === device.asm)!;
        return presetsOf(p, assembly).map(preset => ({ assembly, preset }));
      });
      expect(sounds.map(({ preset }) => preset.name), name).toEqual(names);
      for (const { assembly, preset } of sounds) {
        expect(preset.factory, `${name}/${preset.name}`).toBe(true);
        // Card limits bound the listed copy (a three-voice Expander shows 3 of a stored 4); both recall the same sound.
        const record = rom.find(r => r.structure === preset.structure && r.name === preset.name);
        expect(record?.values.length, `${name}/${preset.name}`).toBe(preset.values.length);
        const [fromRom, listed] = [structuredClone(p), structuredClone(p)];
        const find = (q: typeof p) => q.assemblies!.find(a => a.id === assembly.id)!;
        expect(applyPreset(fromRom, find(fromRom), record!) && applyPreset(listed, find(listed), preset), `${name}/${preset.name}`).toBe(true);
        expect(fromRom, `${name}/${preset.name}`).toEqual(listed);
        expect(!!fxPresetInfo(preset), `${name}/${preset.name}`).toBe(name !== 'Hera 3');
        expect(applyPreset(p, assembly, preset), `${name}/${preset.name}`).toBe(true);
        if (fxPresetInfo(preset)) scoped++;
        total++;
      }
    }
    expect(total).toBe(110);
    expect(scoped).toBe(103);
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
