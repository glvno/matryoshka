// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { applyPreset, deletePreset, presetsOf, renamePreset, storePreset } from './device-presets';
import { defIsEngine } from './engines';
import { FACTORY_PRESETS, presetsOfDef } from './factory-presets';
import { DEFS } from './modules';
import { newPatch } from './patch';
import { defStructure } from './structure';

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
});
