// SPDX-License-Identifier: GPL-3.0-only
// #612: the FM-1's OUTPUT setting at MONO sends (L + R) / 2 to the analog output's left side (the tip) and silences the
// right. That sum never peaks above the louder side, so no factory patch that keeps its stereo headroom (#440, headroom-1..4.test.ts) clips in mono. Every
// factory patch played as the headroom checks play it first (its own values, as many keys as its voices); the figures
// (the stereo peak, the mono sum's, and the change in dB) are printed for the changelog's numbers.
import { expect, it } from 'vitest';
import './factory-presets';
import { HEADROOM, monoOf, peaksOfPlay, plays } from './headroom';
import { FM1_PRESETS } from './presets';

it('the mono sum (L + R) / 2 never peaks above the stereo output (#612)', () => {
  for (let i = 0; i < 2000; i++) {
    const l = Math.random() * 2 - 1, r = Math.random() * 2 - 1;
    expect(Math.abs(monoOf(l, r))).toBeLessThanOrEqual(Math.max(Math.abs(l), Math.abs(r)));
  }
  // the firmware's fold of two I2S words (24 bits in the low bits, a -6 dBFS ceiling): (a + b) >> 1 stays in range
  const top = (1 << 23) - 1;
  expect((top + top) >> 1).toBe(top);
  expect((-top - top) >> 1).toBe(-top);
});

it('every factory patch keeps its headroom in mono (#612)', () => {
  const rows: string[] = [];
  for (const [name, make] of Object.entries(FM1_PRESETS)) {
    const w = plays(make())[0];
    const { stereo, mono } = peaksOfPlay(w, 1);
    expect(mono, name).toBeLessThanOrEqual(stereo + 1e-9);
    expect(mono, name).toBeLessThan(HEADROOM + 0.07);
    rows.push(`${name}: stereo ${stereo.toFixed(3)}, mono ${mono.toFixed(3)} (${stereo > 0 && mono > 0 ? (20 * Math.log10(mono / stereo)).toFixed(1) : '-'} dB)`);
  }
  console.log(`mono sum (#612), ${w(rows)}`);
}, 120_000);
const w = (rows: string[]): string => `${rows.length} factory patches, ${rows[0] ? 'first second, keys held:' : ''}\n${rows.join('\n')}`;
