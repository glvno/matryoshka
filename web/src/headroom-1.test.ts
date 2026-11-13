// SPDX-License-Identifier: GPL-3.0-only
// #440: no FM-1 factory patch clips, nor any factory preset of its engines, played every way headroom.ts lists (as many
// keys as the engine's voices, at most 8; a Drum map's keys; its patterns running). gen-presets sets each Output so the
// loudest peaks at HEADROOM (0.88) over 3 s; the test renders the first second of each (the suite stays fast) and allows
// up to 0.95, the margin the FM-1's fixed point engine may run hotter by. The XLs (browser only) get the same Output rule
// from gen-xl. The patches are dealt over four files (headroom-1..4.test.ts), which the test workers run side by side. With
// the 110 FX-authored sounds a part takes up to about 80 s on a 4-vCPU CI runner, and up to about 480 s under the
// release candidate's coverage instrumentation (D-147), so each allows 960 s.
import { expect, it } from 'vitest';
import './factory-presets';
import { overHeadroom } from './headroom';
import { PRESETS } from './presets';

it('no factory patch or factory engine preset clips (part 1 of 4)', () => {
  expect(overHeadroom(Object.entries(PRESETS).filter((_, i) => i % 4 === 0), 1, 0.95)).toEqual([]);
}, 960_000);
