// SPDX-License-Identifier: GPL-3.0-only
// The loudness test's six parts (levels-1..6.test.ts, levelsPart): every case of every factory patch in exactly one part,
// and no part with much more than its share of the measured time
import { expect, it } from 'vitest';
import './factory-presets';
import { LEVELS_COST, cases, levelsPart } from './levels';
import { PRESETS } from './presets';

it('deals every loudness case into exactly one of six parts, evenly by measured cost', () => {
  const all = Object.entries(PRESETS);
  const parts = Array.from({ length: 6 }, (_, k) => [...levelsPart(all, k + 1, 6)]);
  const ids = all.flatMap(([name, make]) => cases(make()).map((_, i) => `${name}#${i}`));
  expect(parts.flat().sort()).toEqual([...ids].sort());
  const cost = (id: string) => {
    const name = id.slice(0, id.lastIndexOf('#'));
    return (LEVELS_COST[name] ?? 0) / ids.filter((x) => x.startsWith(`${name}#`)).length;
  };
  const loads = parts.map((p) => p.reduce((s, id) => s + cost(id), 0));
  const total = loads.reduce((a, b) => a + b, 0);
  expect(Math.max(...loads)).toBeLessThan(total / 6 * 1.25);
}, 120_000);
