// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FACTORY_LAYOUT, layoutCards } from './factory-layout';
import { PRESETS } from './presets';

const STALE = 'factory/layout.json is stale: run npx vite-node scripts/factory-layout.ts (its header says how), then the factory steps';
const sorted = (ids: Iterable<number | string>): number[] => [...ids].map(Number).sort((a, b) => a - b);

describe('the factory patches and examples open as Tidy lays them out (D-1446, D-1458)', () => {
  it('the layout places every top-level card of every factory patch and example, and nothing else', () => {
    expect(Object.keys(FACTORY_LAYOUT).sort(), STALE).toEqual(Object.keys(PRESETS).sort());
    for (const [name, make] of Object.entries(PRESETS)) {
      const cards = layoutCards(make()), l = FACTORY_LAYOUT[name];
      expect(sorted(Object.keys(l.m)), `${name}: ${STALE}`).toEqual(sorted(cards.m));
      expect(sorted(Object.keys(l.a)), `${name}: ${STALE}`).toEqual(sorted(cards.a));
    }
  });

  it('each opens with its cards where the layout has them, an assembly\'s members moved with it', () => {
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make(), l = FACTORY_LAYOUT[name];
      for (const [id, [x, y]] of Object.entries(l.m)) expect(p.modules.find((m) => m.id === Number(id))!, name).toMatchObject({ x, y });
      for (const [id, [x, y]] of Object.entries(l.a)) expect(p.assemblies!.find((a) => a.id === Number(id))!, name).toMatchObject({ x, y });
    }
  });
});
