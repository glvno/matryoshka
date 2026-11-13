// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { kitCard } from '../scripts/kit-card';
import { PRESETS } from './presets';
import { structureOf } from './structure';
import { allModules } from './assembly';
import { devicesOf } from './pages';
import { DEFS } from './modules';
import { applyPreset, presetsOf } from './device-presets';
import { factoryPresets } from './factory-presets';
factoryPresets();
it.each(['909 Kit', '<7PH'])('%s wraps existing children without altering their graph, values or identity', (name) => {
  const p = PRESETS[name](), parent = p.assemblies!.find((a) => a.name === '909 kit')!;
  p.assemblies = p.assemblies!.filter((a) => a !== parent);
  const modules = structuredClone(p.modules), cables = structuredClone(p.cables);
  const children = p.assemblies.map((a) => ({ a: structuredClone(a), structure: structureOf(p, a) }));
  kitCard(p);
  expect(p.modules).toEqual(modules); expect(p.cables).toEqual(cables);
  for (const child of children) {
    const now = p.assemblies.find((a) => a.id === child.a.id)!;
    expect(now).toEqual(child.a); expect(structureOf(p, now)).toBe(child.structure);
  }
});
it('hybrid kit selection preserves every bass value and child structure', () => {
  const p = PRESETS['<7PH'](), kit = p.assemblies!.find((a) => a.name === '909 kit')!;
  const bass = p.assemblies!.find((a) => a.name === 'Silver Box')!;
  const ids = new Set(allModules(p, bass)), values = structuredClone(p.modules.filter((m) => ids.has(m.id)));
  const structures = p.assemblies!.map((a) => structureOf(p, a));
  applyPreset(p, kit, presetsOf(p, kit)[1]);
  expect(p.modules.filter((m) => ids.has(m.id))).toEqual(values);
  expect(p.assemblies!.map((a) => structureOf(p, a))).toEqual(structures);
});

it('909 parent navigation exposes every existing child control and the three kit mix levels', () => {
  const p = PRESETS['909 Kit']();
  const parent = p.assemblies!.find((a) => a.name === '909 kit')!;
  const devices = devicesOf(p, DEFS), card = devices.find((d) => d.asm === parent.id)!;
  const rows = card.pages.flatMap((page) => page.rows);
  for (const child of p.assemblies!.filter((a) => parent.children!.includes(a.id))) {
    expect(devices.some((d) => d.asm === child.id)).toBe(false);
    for (const row of child.params) if (row.module >= 0)
      expect(rows.some((r) => r.module === row.module && r.param === row.param), `${child.name}: ${row.label}`).toBe(true);
  }
  for (const level of ['l1', 'l2', 'l3']) expect(rows.some((r) => r.param === level)).toBe(true);
});
