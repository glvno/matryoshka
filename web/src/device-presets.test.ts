// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly, promote, toDef, type AssemblyDef } from './assembly';
import { addUserPreset, applyPreset, currentValues, deletePreset, exportPresets, importPresets, matchesPreset, nextPresetName, presetsOf, renamePreset, setFactoryPresets, stepPreset, storePreset, userPresets } from './device-presets';
import { DEFS } from './modules';
import { connect, newPatch, validatePatch } from './patch';
import { defStructure, structureOf } from './structure';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  setFactoryPresets([]);
});

const named = (name: string): AssemblyDef => FACTORY.find((d) => d.name === name)!;

describe('structure (#192)', () => {
  it('is the same for every copy, whatever its label, position or values, and the same as its definition', () => {
    for (const def of FACTORY) {
      const p = newPatch(DEFS);
      const a = insertAssembly(p, DEFS, def, 0, 0);
      const b = insertAssembly(p, DEFS, def, 900, 400);
      b.label = 'another name';
      const m = p.modules.find((x) => x.id === b.params[0]?.module);
      if (m && b.params[0]) m.params[b.params[0].param] = (m.params[b.params[0].param] ?? 0) + 0.01;
      expect(structureOf(p, a), def.name).toBe(structureOf(p, b));
      expect(structureOf(p, a), def.name).toBe(defStructure(def));
    }
  });

  it('tells different assemblies apart, and changes with a card row or a cable', () => {
    const all = new Set(FACTORY.map(defStructure));
    expect(all.size).toBeGreaterThan(FACTORY.length * 0.9); // (some tiny factory parts may share one)
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, named('Oracle V'), 0, 0);
    const before = structureOf(p, a);
    const row = a.params[0];
    a.params.push(a.params.shift()!); // row order is not structure
    expect(structureOf(p, a)).toBe(before);
    a.params.unshift(a.params.pop()!);
    const m = p.modules.find((x) => x.id === row.module)!;
    const spare = Object.keys(m.params).find((k) => !a.params.some((r) => r.module === m.id && r.param === k));
    if (spare) {
      promote(a, m.id, spare);
      expect(structureOf(p, a)).not.toBe(before);
    }
    const p2 = newPatch(DEFS);
    const c = insertAssembly(p2, DEFS, named('Oracle V'), 0, 0);
    const [x, y] = c.modules;
    connect(p2, DEFS, { module: x, port: DEFS[p2.modules.find((q) => q.id === x)!.type].outputs[0]?.name ?? 'out' }, { module: y, port: DEFS[p2.modules.find((q) => q.id === y)!.type].inputs[0]?.name ?? 'in' });
    expect(structureOf(p2, c) === before).toBe(toDef(p2, c).cables.length === named('Oracle V').cables.length);
  });
});

describe('presets (#192)', () => {
  it('store on one copy, load on another (one structure), and the patch remembers the name', () => {
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, named('Hera 6'), 0, 0);
    const b = insertAssembly(p, DEFS, named('Hera 6'), 900, 0);
    const r = a.params.find((x) => DEFS[p.modules.find((m) => m.id === x.module)!.type].params.find((d) => d.name === x.param)?.max)!;
    const m = p.modules.find((x) => x.id === r.module)!;
    const pd = DEFS[m.type].params.find((d) => d.name === r.param)!;
    m.params[r.param] = pd.max;
    expect(storePreset(p, a, 'Bright')).toBe('Bright');
    expect(a.preset).toBe('Bright');
    expect(presetsOf(p, b).map((x) => x.name)).toEqual(['Bright']);
    expect(matchesPreset(p, b)).toBe(false);
    expect(applyPreset(p, b, presetsOf(p, b)[0])).toBe(true);
    expect(currentValues(p, b)).toEqual(currentValues(p, a));
    expect(b.preset).toBe('Bright');
    expect(matchesPreset(p, b)).toBe(true);
    // the remembered name survives a save and load
    const back = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(back.assemblies!.find((x) => x.id === b.id)!.preset).toBe('Bright');
    // an edit: the name stays, the match goes
    const mb = p.modules.find((x) => x.id === b.params[0].module)!;
    mb.params[b.params[0].param] = (mb.params[b.params[0].param] ?? 0) === 0 ? 0.5 : 0;
    expect(matchesPreset(p, b)).toBe(false);
  });

  it('does not load into another structure', () => {
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, named('Hera 6'), 0, 0);
    const o = insertAssembly(p, DEFS, named('Oracle V'), 900, 0);
    storePreset(p, a, 'x');
    expect(presetsOf(p, o)).toEqual([]);
    expect(applyPreset(p, o, userPresets()[0])).toBe(false);
  });

  it('overwrite, rename, delete, step; factory ones are read-only and storing over one makes a new one', () => {
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, named('Hera 6'), 0, 0);
    const s = structureOf(p, a);
    setFactoryPresets([{ structure: s, name: 'Init', values: currentValues(p, a) }]);
    expect(storePreset(p, a, 'Init')).toBe('Init 2');
    storePreset(p, a, 'Pad');
    storePreset(p, a, 'Pad'); // overwrite: still one
    expect(presetsOf(p, a).map((x) => x.name)).toEqual(['Init', 'Init 2', 'Pad']);
    expect(renamePreset(s, 'Init', 'Mine')).toBe(false); // factory
    expect(renamePreset(s, 'Pad', 'Init 2')).toBe(false); // taken
    expect(renamePreset(s, 'Pad', 'Strings')).toBe(true);
    expect(deletePreset(s, 'Init')).toBe(false);
    expect(deletePreset(s, 'Init 2')).toBe(true);
    a.preset = 'Init';
    expect(stepPreset(p, a, 1)!.name).toBe('Strings');
    expect(stepPreset(p, a, -1)!.name).toBe('Strings');
    a.preset = undefined;
    expect(stepPreset(p, a, 1)!.name).toBe('Init');
  });

  it('a new preset\'s default name: the one it is based on and the next free number, as the FM-1 names it', () => {
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, named('Hera 6'), 0, 0);
    setFactoryPresets([{ structure: structureOf(p, a), name: 'Init', values: currentValues(p, a) }, { structure: structureOf(p, a), name: 'Bright', values: currentValues(p, a) }]);
    expect(nextPresetName(p, a)).toBe('Init 2');                 // none remembered: the first of its list
    a.preset = 'Bright';
    expect(nextPresetName(p, a)).toBe('Bright 2');
    storePreset(p, a, 'Bright 2');
    expect(nextPresetName(p, a)).toBe('Bright 3');               // based on Bright 2: its number is replaced
    expect(a.preset).toBe('Bright 2');
  });

  it('names are one name in any case: the FM-1\'s capitals meet the editor\'s spelling', () => {
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, named('Hera 6'), 0, 0);
    const s = structureOf(p, a);
    setFactoryPresets([{ structure: s, name: 'Init', values: currentValues(p, a) }]);
    expect(addUserPreset(s, 'INIT 2', currentValues(p, a))).toBe('Init 2');        // a new one from the FM-1: the editor's style
    storePreset(p, a, 'Bright 2');
    const v = currentValues(p, a).map((x, i) => (i === 0 ? x + 1 : x));
    expect(addUserPreset(s, 'BRIGHT 2', v)).toBe('Bright 2');                       // over the one you have, its spelling kept
    expect(presetsOf(p, a).map((x) => x.name)).toEqual(['Init', 'Bright 2', 'Init 2']);
    expect(addUserPreset(s, 'INIT', v)).toBe(false);                                // a factory one's name
    a.preset = 'BRIGHT 2';                                                          // as a patch from the FM-1 remembers it
    expect(stepPreset(p, a, 1)!.name).toBe('Init 2');
    expect(storePreset(p, a, 'bright 2')).toBe('bright 2');
    expect(presetsOf(p, a).filter((x) => x.name.toLowerCase() === 'bright 2')).toHaveLength(1);
  });

  it('export and import the library', () => {
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, named('Hera 6'), 0, 0);
    storePreset(p, a, 'One');
    const file = JSON.parse(JSON.stringify(exportPresets()));
    mem.clear();
    expect(importPresets({ format: 'something else' })).toBeNull();
    expect(importPresets(file)).toBe(1);
    expect(presetsOf(p, a).map((x) => x.name)).toEqual(['One']);
  });
});
