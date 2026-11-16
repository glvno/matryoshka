// SPDX-License-Identifier: GPL-3.0-only
// part 3 of 6 of the loudness test: levels-1.test.ts says what it checks
import { expect, it } from 'vitest';
import './factory-presets';
import { offRule } from './levels';
import { PRESETS } from './presets';

it('every factory patch and factory engine preset is on the loudness rule (part 3 of 6)', () => {
  expect(offRule(Object.entries(PRESETS).filter((_, i) => i % 6 === 2))).toEqual([]);
}, 960_000);   // (a drum kit runs each of its patterns per preset: over 13 min on CI, #923)
