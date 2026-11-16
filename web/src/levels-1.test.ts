// SPDX-License-Identifier: GPL-3.0-only
// #448: every FM-1 factory patch and every factory preset of its engines lands on the loudness rule (levels.ts: one key
// at about -18 LUFS, a 4-key chord at most -15, the peak cap), within LOUDNESS_TOLERANCE, but the ones listed in SHORT,
// which land as far under it as listed. gen-presets (scripts/factory-build.ts loudness) sets them so. The cases are
// dealt over six files (levels-1..6.test.ts) by each patch's measured time (levelsPart, LEVELS_COST), so a heavy kit's
// presets spread over several files; the RC web run gives them parallel jobs (tools/ci_checks.py slow_part).
import { expect, it } from 'vitest';
import './factory-presets';
import { levelsPart, offRule } from './levels';
import { PRESETS } from './presets';

it('every factory patch and factory engine preset is on the loudness rule (part 1 of 6)', () => {
  const all = Object.entries(PRESETS);
  expect(offRule(all, levelsPart(all, 1, 6))).toEqual([]);
}, 960_000);
