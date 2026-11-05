// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's keys in sandbox mode play a Drum map's rows on black keys 1..8, as on the FM-1 (D-520, the 1.10 early check)
import { describe, expect, it } from 'vitest';
import { blackKey, drumKeyNote, keysDrumMap, SandboxKeys } from './sandbox-keys';
import { FM1_PRESETS, XL_PRESETS } from './presets';

describe('sandbox keys (D-520 in sandbox mode)', () => {
  it('counts the black keys from F#3', () => {
    expect([1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25].map(blackKey)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([0, 2, 4, 6, 7, 26, 27, -1].map(blackKey)).toEqual([-1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it('Verona Drum 1 XL: its keys reach the PATTERN track\'s Drum map, black keys 1..8 its rows, the white keys nothing', () => {
    const p = XL_PRESETS['Verona Drum 1 XL']();
    const map = keysDrumMap(p)!;
    expect(map?.names?.[0]).toBe('KICK');
    const rows = Array.from({ length: 8 }, (_, r) => map.params[`n${r + 1}`]);
    expect([54, 56, 58, 61, 63, 66, 68, 70].map((n) => drumKeyNote(map, n, 0))).toEqual(rows);
    expect(drumKeyNote(map, 53, 0)).toBeNull();
    // at another octave the same black keys play the same rows
    expect(drumKeyNote(map, 54 + 12, 1)).toBe(rows[0]);
    // the 9th black key and up play nothing
    expect(drumKeyNote(map, 73, 0)).toBeNull();
  });

  it('a melodic patch plays the plain notes', () => {
    expect(keysDrumMap(FM1_PRESETS['Basic Poly']())).toBeNull();
    expect(keysDrumMap(FM1_PRESETS.Init())).toBeNull();
  });

  it('a note-off ends what its note-on played, a silent key stays silent', () => {
    const p = XL_PRESETS['Verona Drum 1 XL']();
    const k = new SandboxKeys();
    const row1 = keysDrumMap(p)!.params.n1;
    expect(k.route({ t: 'on', note: 54, vel: 0.8 }, p, [], 0)).toEqual([{ t: 'on', note: row1, vel: 0.8 }]);
    expect(k.holds(54)).toBe(true);
    expect(k.route({ t: 'on', note: 53, vel: 0.8 }, p, [], 0)).toEqual([]);
    expect(k.route({ t: 'off', note: 54 }, p, [], 0)).toEqual([{ t: 'off', note: row1 }]);
    expect(k.route({ t: 'off', note: 53 }, p, [], 0)).toEqual([]);
    expect(k.holds(54)).toBe(false);
  });
});
