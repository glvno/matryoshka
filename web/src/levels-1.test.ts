// SPDX-License-Identifier: GPL-3.0-only
// #448: every FM-1 factory patch and every factory preset of its engines lands on the loudness rule (levels.ts: one key
// at about -18 LUFS, a 4-key chord at most -15, the peak cap), within LOUDNESS_TOLERANCE, but the ones listed in SHORT,
// which land as far under it as listed. gen-presets (scripts/factory-build.ts loudness) sets them so. The patches are
// dealt over six files (levels-1..6.test.ts), which the test workers run side by side. Part 1 took 710 s of its 960 s on
// a CI runner with the drum kits' pattern sets (#923) and timed out on slower runners (PR #961), so six parts, not four.
import { expect, it } from 'vitest';
import './factory-presets';
import { offRule } from './levels';
import { PRESETS } from './presets';

it('every factory patch and factory engine preset is on the loudness rule (part 1 of 6)', () => {
  expect(offRule(Object.entries(PRESETS).filter((_, i) => i % 6 === 0))).toEqual([]);
}, 960_000);
