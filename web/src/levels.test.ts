// SPDX-License-Identifier: GPL-3.0-only
// #448: every factory engine names its level rows (levels.ts LEVEL_ROWS), and they are on its card.
import { expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { defIsEngine } from './engines';
import { LEVEL_ROWS } from './levels';
import { cardRows } from './preset-cards';

it('every factory engine has its level rows on its card', () => {
  const engines = FACTORY.filter((d) => defIsEngine(d));
  const missing = engines.flatMap((d) => {
    const keys = LEVEL_ROWS[d.name];
    if (!keys) return [`${d.name}: none listed`];
    const rows = cardRows(d);
    return keys.filter((k) => !rows.some((r) => r.key === k && r.pd)).map((k) => `${d.name}: ${k}`);
  });
  expect(missing).toEqual([]);
  expect(Object.keys(LEVEL_ROWS).filter((n) => !engines.some((d) => d.name === n))).toEqual([]);
});
