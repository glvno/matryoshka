// SPDX-License-Identifier: GPL-3.0-only
// part 6 of 6 of the loudness test: levels-1.test.ts says what it checks
import { expect, it } from 'vitest';
import './factory-presets';
import { offRule } from './levels';
import { PRESETS } from './presets';

it('every factory patch and factory engine preset is on the loudness rule (part 6 of 6)', () => {
  expect(offRule(Object.entries(PRESETS).filter((_, i) => i % 6 === 5))).toEqual([]);
}, 960_000);
