// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { applyPreset, deletePreset, presetsOf, renamePreset, storePreset } from './device-presets';
import { defIsEngine, instIsEngine } from './engines';
import { factoryPresets, presetsOfDef, xlEnginePresets } from './factory-presets';
import { DEFS } from './modules';
import { newPatch } from './patch';
import { FM1_PRESETS, XL_PRESETS, xlBase } from './presets';
import { defStructure, structureOf } from './structure';

const FACTORY_PRESETS = factoryPresets();
const XL_ENGINE_PRESETS = xlEnginePresets();

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
    const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Hera 6')!, 0, 0);
    const list = presetsOf(p, a);
    expect(list.map((x) => x.name).slice(0, 2)).toEqual(['Init', 'Bright']);
    expect(applyPreset(p, a, list[1])).toBe(true);
    expect(renamePreset(list[0].structure, 'Init', 'x')).toBe(false);
    expect(deletePreset(list[0].structure, 'Bright')).toBe(false);
    expect(storePreset(p, a, 'Bright')).toBe('Bright 2');
  });

  it('every XL engine has at least as many presets as its FM-1 version, loadable on the XL as it opens', () => {
    expect(Object.keys(XL_ENGINE_PRESETS).length).toBe(Object.keys(XL_PRESETS).length);
    for (const [name, make] of Object.entries(XL_PRESETS)) {
      const fm1 = FM1_PRESETS[xlBase(name)!]();
      const fm1Count = (fm1.assemblies ?? []).filter((a) => instIsEngine(fm1, a)).flatMap((a) => presetsOf(fm1, a)).length;
      const p = make();
      const engines = (p.assemblies ?? []).filter((a) => instIsEngine(p, a));
      // a drum kit has no engine, so neither version has presets
      expect(engines.length > 0, name).toBe(fm1Count > 0);
      for (const a of engines) {
        const list = presetsOf(p, a);
        expect(list[0]?.name, name).toBe('Init');
        expect(list.length, name).toBeGreaterThanOrEqual(fm1Count);
        expect(list.every((x) => x.structure === structureOf(p, a))).toBe(true);
        expect(applyPreset(p, a, list[list.length - 1]), name).toBe(true);
      }
    }
  }, 120000); // (the XLs with their originals' whole panels are heavy: about 5 s on CI, longer under coverage)
});
