// SPDX-License-Identifier: GPL-3.0-only
// The links section's place in a binary (bin-links.ts, as engine.c eng_links_at finds it), cross-checked on binaries
// patchbin.ts writes with links: kits with their 1.24.1 patterns (P-locks, songs, origins), a patch with a morph B set,
// several tracks, every counted format.
import { describe, expect, it } from 'vitest';
import { linksAt, linksOf, withLinkIds } from './bin-links';
import { COUNTED, encodePatch, linkPlan, SLIM } from './patchbin';
import { payloadHash } from './pattern-store';
import { deviceView } from './poly';
import { factoryWithPatterns, FM1_PRESETS } from './presets';
import { oracleMorph } from './test-morph';
import type { Patch } from './patch';

/** `p` with each pattern of `ps` (0-based) linked to store id 100 + its index */
function linked(p: Patch, ps: number[]): Patch {
  const main = p.modules.find((m) => m.type === 'fm1')!;
  main.seq = { ...(main.seq ?? {}), links: Object.fromEntries(ps.map((k) => [k, { id: 100 + k, hash: payloadHash(p, k) }])) };
  return p;
}
/** Oracle V with a B set (morph), two patterns on its track */
function morphWithPatterns(): Patch {
  const p = oracleMorph(), t = p.modules.find((m) => m.type === 'steps');
  if (!t) throw new Error('oracleMorph has no Steps track');
  t.patterns = [{ notes: [{ at: 0, len: 1, note: 60, vel: 100 }] }, { notes: [{ at: 2, len: 1, note: 62, vel: 90 }] }];
  return linked(p, [1, 2]);
}

const cases: [string, () => Patch][] = [
  ['808 Kit with its patterns', () => factoryWithPatterns('808 Kit')],
  ['909 Kit with its patterns', () => factoryWithPatterns('909 Kit')],
  ['Scrounge with its grooves, some linked', () => linked(factoryWithPatterns('Scrounge'), [1, 3, 5])],
  ['Silver Box with its patterns linked', () => linked(factoryWithPatterns('Silver Box'), [1, 2, 3, 4])],
  ['a patch with a morph B set', morphWithPatterns],
];

describe('the links section in a binary (#1202 G8)', () => {
  for (const [name, make] of cases)
    for (const force of [0, COUNTED, SLIM])
      it(`${name}, ${force ? `format ${force}` : 'its own format'}: found where patchbin wrote it`, () => {
        const p = make(), bin = encodePatch(p, true, force, 0, 'assume');
        const want = linkPlan(p, deviceView(p, true).patch, 'assume').entries;
        expect(want.length).toBeGreaterThan(0);
        expect(linksAt(bin)).toBeGreaterThan(0);
        expect(linksOf(bin)).toEqual(want);
        const ids = new Map(want.map(([, id], k) => [id, 7 + k]));
        const moved = withLinkIds(bin, ids);
        expect(linksOf(moved)).toEqual(want.map(([q], k) => [q, 7 + k]));
        expect(moved.length).toBe(bin.length);
        expect([...moved].filter((b, i) => b !== bin[i]).length).toBeLessThanOrEqual(2 * want.length);
      });

  it('a binary without links, or cut short, has none', () => {
    const plain = encodePatch(FM1_PRESETS['Monolith D']());
    expect(linksAt(plain)).toBe(0);
    expect(linksOf(plain)).toEqual([]);
    expect(withLinkIds(plain, new Map([[1, 2]]))).toEqual(plain);
    const bin = encodePatch(factoryWithPatterns('808 Kit'), true, 0, 0, 'assume');
    expect(linksAt(bin.subarray(0, linksAt(bin)))).toBe(0);
  });
});
