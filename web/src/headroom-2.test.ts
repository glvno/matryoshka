// SPDX-License-Identifier: GPL-3.0-only
// part 2 of 4 of the headroom test: headroom-1.test.ts says what it checks
import { expect, it } from 'vitest';
import './factory-presets';
import { overHeadroom } from './headroom';
import { FM1_PRESETS } from './presets';

it('no factory patch or factory engine preset clips (part 2 of 4)', () => {
  expect(overHeadroom(Object.entries(FM1_PRESETS).filter((_, i) => i % 4 === 1), 1, 0.95)).toEqual([]);
}, 60_000);
