// SPDX-License-Identifier: GPL-3.0-only
// What the page no longer works out as it loads (1.5.1): the factory patches built when first opened, the picker's chips worked
// out when shown, the factory presets made per structure, the structure labels found in one pass. Each gives what the eager
// computation gave, for every factory patch and XL.
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { rowTargets, toDef, type AssemblyDef } from './assembly';
import { openableGroups } from './catalog';
import { presetsFor, type Preset } from './device-presets';
import { allFactoryPresets, factoryPresets, xlEnginePresets } from './factory-presets';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import { deviceBudget } from './patchbin';
import { factoryShape, FM1_PRESETS, PRESETS, shapeOf, withXls, XL_PRESETS } from './presets';
import { chipOf, chipOfBudget } from './sandbox';
import { defRowOrder, defStructure, defStructureAndOrder, fnv, rowOrder, structureAndRows, structureOf } from './structure';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

/** the factory patches as they were built before 1.5.1: every file checked as the page loaded */
const eager = (files: Record<string, unknown>): Patch[] =>
  Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, raw]) => validatePatch(structuredClone(raw), DEFS));
const FM1 = eager(import.meta.glob<unknown>('../presets/*.json', { eager: true, import: 'default' }));
const XL = eager(import.meta.glob<unknown>('../presets/xl/*.json', { eager: true, import: 'default' }));
const ALL = withXls(FM1, XL);

describe('factory patches built when first opened', () => {
  it('lists the same names in the same order, and builds each as the eager check did', () => {
    expect(Object.keys(FM1_PRESETS)).toEqual(FM1.map((p) => p.name));
    expect(Object.keys(XL_PRESETS)).toEqual(XL.map((p) => p.name));
    expect(Object.keys(PRESETS)).toEqual(ALL.map((p) => p.name));
    for (const p of ALL) expect(PRESETS[p.name](), p.name).toEqual(p);
  });

  it('gives a fresh copy each time', () => {
    const a = PRESETS.Init();
    a.modules[0].x += 1;
    expect(PRESETS.Init()).not.toEqual(a);
  });

  it('reads each shape from the file as the built patch has it (the morph picker builds only patches of the open shape)', () => {
    for (const p of ALL) expect(factoryShape(p.name), p.name).toBe(shapeOf(p));
  });
});

describe('the Open picker\'s chips', () => {
  it('are what the patch\'s budget says, for every factory patch and XL, asked once or again', () => {
    const items = openableGroups().find((g) => g.label === 'Factory patches')!.items;
    expect(items.map((o) => o.name)).toEqual(ALL.map((p) => p.name));
    for (const o of items) {
      const want = chipOfBudget(deviceBudget(ALL.find((p) => p.name === o.name)!));
      expect(o.chip(), o.name).toEqual(want);
      expect(o.chip(), o.name).toEqual(want);
      expect(chipOf(PRESETS[o.name]()), o.name).toEqual(want);
    }
  });

  it('follow a patch\'s content: an edited copy gets its own chip', () => {
    const p = PRESETS.Init();
    const before = chipOf(p);
    p.modules.push(...ALL.find((x) => !chipOf(x).fits)!.modules.map((m, i) => ({ ...m, id: 1000 + i })));
    expect(chipOf(p)).toEqual(chipOfBudget(deviceBudget(p)));
    expect(chipOf(PRESETS.Init())).toEqual(before);
  });
});

/** the structure labels as worked out before 1.5.1 (every cable scanned for every module, every round) */
function oldLabels(def: AssemblyDef): Map<number, string> {
  const depth = new Map<number, number>();
  const nested = def.assemblies ?? [];
  const parent = new Map<number, number>();
  for (const n of nested) for (const c of n.children ?? []) parent.set(c, n.id);
  const levels = (id: number): number => { let k = 1; for (let x = parent.get(id); x !== undefined; x = parent.get(x)) k++; return k; };
  for (const n of nested) for (const m of n.modules) depth.set(m, levels(n.id));
  const rows = new Map<number, string[]>();
  for (const r of def.params) for (const t of rowTargets(r)) rows.set(t.module, [...(rows.get(t.module) ?? []), t.param]);
  let lab = new Map(def.modules.map((m) => [m.id, `${m.type}|${depth.get(m.id) ?? 0}|${[...(rows.get(m.id) ?? [])].sort().join(',')}`]));
  for (let k = 0; k < 4; k++) {
    const next = new Map<number, string>();
    for (const m of def.modules) {
      const outs = def.cables.filter((c) => c.from.module === m.id).map((c) => `>${c.from.port}:${c.to.port}:${lab.get(c.to.module)}`);
      const ins = def.cables.filter((c) => c.to.module === m.id).map((c) => `<${c.to.port}:${c.from.port}:${lab.get(c.from.module)}`);
      next.set(m.id, fnv([lab.get(m.id), ...outs.sort(), ...ins.sort()].join(';')));
    }
    lab = next;
  }
  return lab;
}
function oldStructure(def: AssemblyDef): string {
  const lab = oldLabels(def);
  const mods = def.modules.map((m) => `${m.type}:${lab.get(m.id)}`).sort();
  const cables = def.cables.map((c) => `${lab.get(c.from.module)}.${c.from.port}>${lab.get(c.to.module)}.${c.to.port}`).sort();
  const nests = (def.assemblies ?? []).map((n) => n.modules.map((id) => lab.get(id)).sort().join(',')).sort();
  const rows = def.params.map((r) => rowTargets(r).map((t) => `${lab.get(t.module)}.${t.param}`).join('+')).sort();
  return fnv([mods.join(' '), cables.join(' '), nests.join(' / '), rows.join(' ')].join('#'));
}
function oldRowOrder(def: AssemblyDef): number[] {
  const lab = oldLabels(def);
  const pos = new Map(def.modules.map((m, i) => [m.id, i]));
  return def.params.map((_, i) => i).sort((i, j) => {
    const a = def.params[i], b = def.params[j];
    const la = `${lab.get(a.module)}.${a.param}`, lb = `${lab.get(b.module)}.${b.param}`;
    return la < lb ? -1 : la > lb ? 1 : (pos.get(a.module)! - pos.get(b.module)!);
  });
}

describe('structure fingerprints and row orders', () => {
  it('are the same as before for every factory assembly and every assembly of a factory patch or XL', () => {
    const defs = [...FACTORY, ...ALL.flatMap((p) => (p.assemblies ?? []).map((a) => toDef(p, a)))];
    expect(defs.length).toBeGreaterThan(100);
    for (const d of defs) {
      const want = { structure: oldStructure(d), order: oldRowOrder(d) };
      expect(defStructureAndOrder(d), d.name).toEqual(want);
      expect(defStructure(d), d.name).toBe(want.structure);
      expect(defRowOrder(d), d.name).toEqual(want.order);
    }
    for (const p of ALL) for (const a of p.assemblies ?? []) expect(structureAndRows(p, a)).toEqual({ structure: structureOf(p, a), rows: rowOrder(p, a) });
  });
});

describe('factory presets made per structure', () => {
  it('give each structure what the one eager list gave it', () => {
    // the list as it was set before 1.5.1: the FM-1's, then the XLs' own (once per structure and name)
    const fm1 = factoryPresets();
    const seen = new Set(fm1.map((p) => p.structure));
    const xlOnly = Object.values(xlEnginePresets()).flat().filter((p) => !seen.has(p.structure));
    const old: Preset[] = [...fm1, ...xlOnly.filter((p, i) => xlOnly.findIndex((q) => q.structure === p.structure && q.name === p.name) === i)];
    expect(allFactoryPresets()).toEqual(old);
    const structures = new Set(old.map((p) => p.structure));
    expect(structures.size).toBeGreaterThan(10);
    for (const s of [...structures, '00000000']) expect(presetsFor(s), s).toEqual(old.filter((p) => p.structure === s).map((p) => ({ ...p, factory: true })));
  });
});

describe('patch check', () => {
  it('drops a repeated cable and keeps the first', () => {
    const p = PRESETS.Init();
    const n = p.cables.length;
    expect(n).toBeGreaterThan(0);
    const again = validatePatch(JSON.parse(JSON.stringify({ ...p, cables: [...p.cables, ...p.cables.map((c) => structuredClone(c))] })), DEFS);
    expect(again.cables.length).toBe(n);
    expect(again.cables).toEqual(p.cables);
  });
});
