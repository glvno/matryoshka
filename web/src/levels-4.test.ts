// SPDX-License-Identifier: GPL-3.0-only
// part 4 of 4 of the loudness test: levels-1.test.ts says what it checks
import { expect, it } from 'vitest';
import './factory-presets';
import { offRule } from './levels';
import { PRESETS } from './presets';

it('every factory patch and factory engine preset is on the loudness rule (part 4 of 4)', () => {
  expect(offRule(Object.entries(PRESETS).filter((_, i) => i % 4 === 3))).toEqual([]);
}, 120_000);
