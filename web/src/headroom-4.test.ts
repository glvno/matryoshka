// SPDX-License-Identifier: GPL-3.0-only
// part 4 of 4 of the headroom test: headroom-1.test.ts says what it checks
import { expect, it } from 'vitest';
import './factory-presets';
import { overHeadroom } from './headroom';
import { MEASURED_PRESETS } from './measured-presets';

it('no factory patch or factory engine preset clips (part 4 of 4)', () => {
  expect(overHeadroom(MEASURED_PRESETS.filter((_, i) => i % 4 === 3), 1, 0.95)).toEqual([]);
}, 960_000);
