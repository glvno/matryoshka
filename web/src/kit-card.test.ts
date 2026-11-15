// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { kitCard } from '../scripts/kit-card';
import { PRESETS } from './presets';
import { structureOf } from './structure';
import { devicesOf } from './pages';
import { DEFS } from './modules';
import { presetsOf } from './device-presets';
import { factoryPresets } from './factory-presets';
import { LEVEL_ROWS } from './levels';
factoryPresets();
it('<7PH wraps existing children without altering their graph, values or identity', () => {
  const p = PRESETS['<7PH'](), parent = p.assemblies!.find((a) => a.name === '909 kit')!;
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
it('<7PH keeps its lean 909 card, which ships no presets since the 909 Kit is the whole TR-909 (D-1055)', () => {
  const p = PRESETS['<7PH'](), kit = p.assemblies!.find((a) => a.name === '909 kit')!;
  const q = PRESETS['909 Kit'](), whole = q.assemblies!.find((a) => a.name === '909 kit')!;
  expect(structureOf(p, kit)).not.toBe(structureOf(q, whole));
  expect(presetsOf(p, kit).filter((x) => x.factory)).toEqual([]);
  expect(presetsOf(q, whole).filter((x) => x.factory).map((x) => x.name)).toEqual(['Init', 'Warehouse', 'Dry Jack', 'Dub Pressure']);
});

it('909 parent navigation exposes every child card\'s rows and each voice\'s level', () => {
  const p = PRESETS['909 Kit']();
  const parent = p.assemblies!.find((a) => a.name === '909 kit')!;
  const devices = devicesOf(p, DEFS), card = devices.find((d) => d.asm === parent.id)!;
  const rows = card.pages.flatMap((page) => page.rows);
  for (const child of p.assemblies!.filter((a) => parent.children!.includes(a.id))) {
    expect(devices.some((d) => d.asm === child.id)).toBe(false);
    for (const row of child.params) if (row.module >= 0)
      expect(rows.some((r) => r.module === row.module && r.param === row.param), `${child.name}: ${row.label}`).toBe(true);
  }
  let head = '';
  const keys = parent.params.map((r) => `${(head = r.head ?? head)} / ${r.label}`);
  for (const k of LEVEL_ROWS['909 kit']) expect(keys, k).toContain(k);
});
