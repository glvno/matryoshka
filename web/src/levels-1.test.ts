// SPDX-License-Identifier: GPL-3.0-only
// #448: every FM-1 factory patch and every factory preset of its engines lands on the loudness rule (levels.ts: one key
// at about -18 LUFS, a 4-key chord at most -15, the peak cap), within LOUDNESS_TOLERANCE, but the ones listed in SHORT,
// which land as far under it as listed. gen-presets (scripts/factory-build.ts loudness) sets them so. The patches are
// dealt over four files (levels-1..4.test.ts), which the test workers run side by side. With the 110 FX-authored sounds a
// part takes up to about 230 s on a 4-vCPU CI runner, so each allows 480 s.
import { expect, it } from 'vitest';
import './factory-presets';
import { offRule } from './levels';
import { PRESETS } from './presets';

it('every factory patch and factory engine preset is on the loudness rule (part 1 of 4)', () => {
  expect(offRule(Object.entries(PRESETS).filter((_, i) => i % 4 === 0))).toEqual([]);
}, 480_000);
