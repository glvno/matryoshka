// SPDX-License-Identifier: GPL-3.0-only
// part 3 of 6 of the loudness test: levels-1.test.ts says what it checks
import { expect, it } from 'vitest';
import './factory-presets';
import { levelsPart, offRule } from './levels';
import { PRESETS } from './presets';

it('every factory patch and factory engine preset is on the loudness rule (part 3 of 6)', () => {
  const all = Object.entries(PRESETS);
  expect(offRule(all, levelsPart(all, 3, 6))).toEqual([]);
}, 960_000);
