import { describe, expect, it } from 'vitest';
import { BUTTONS, ENCODERS } from './fm1-ui';
import { PROFILES, firmwareOf, relClicks } from './fm1-profiles';

describe('FM-1 MIDI profiles (#120)', () => {
  it('tells the firmware by its identity', () => {
    expect(['FM-1_015', 'FM-1_800', 'FM-1_812', 'FM-1_901', 'FM-1_700', 'FM-1_710', 'ota-FM-1_700', 'X'].map(firmwareOf))
      .toEqual(['mvave', 'mvave', 'mvave', 'felucca', 'matryoshka', 'matryoshka', null, null]);
  });

  it('reads Matryoshka\'s map: raw buttons, relative encoders, K1..K4, MASTER, keys', () => {
    const t = (...d: number[]) => PROFILES.matryoshka.translate(d);
    expect(t(0xb0, 80, 127)).toEqual([{ t: 'button', id: BUTTONS.fx, down: true }]);
    expect(t(0xb0, 86, 0)).toEqual([{ t: 'button', id: BUTTONS.arp, down: false }]);
    expect(t(0xb0, 87, 127)).toEqual([{ t: 'button', id: BUTTONS.home, down: true }]);
    expect(t(0xb0, 91, 127)).toEqual([{ t: 'button', id: BUTTONS.play, down: true }]);
    expect(t(0xb0, 92, 127)).toEqual([{ t: 'button', id: BUTTONS.octDown, down: true }]);
    expect(t(0xb0, 20, 1)).toEqual([{ t: 'enc', n: ENCODERS.select, clicks: 1 }]);
    expect(t(0xb0, 21, 127)).toEqual([{ t: 'enc', n: ENCODERS.algo, clicks: -1 }]);
    expect(t(0xb0, 23, 3)).toEqual([{ t: 'enc', n: ENCODERS.preset, clicks: 3 }]);
    expect(t(0xb0, 17, 127)).toEqual([{ t: 'knob', k: 1, u: 1 }]);
    expect(t(0xb0, 7, 0)).toEqual([{ t: 'master', v: 0 }]);
    expect(t(0x90, 60, 100)).toEqual([{ t: 'note', note: 60, vel: 100 / 127, on: true }]);
    expect(t(0x90, 60, 0)).toEqual([{ t: 'note', note: 60, vel: 0, on: false }]);
    expect(t(0xfa)).toEqual([]);                            // PLAY's own CC says it
    expect(relClicks(65)).toBe(-63);
  });

  it('the other firmwares: what each sends', () => {
    expect(PROFILES.mvave.translate([0xb0, 80, 127])).toEqual([]);
    expect(PROFILES.mvave.translate([0x80, 62, 0])).toEqual([{ t: 'note', note: 62, vel: 0, on: false }]);
    expect(PROFILES.felucca.translate([0xb0, 1, 127])).toEqual([{ t: 'mod', v: 1 }]);
    expect(PROFILES.felucca.translate([0xfc])).toEqual([{ t: 'transport', run: false }]);
    expect(PROFILES.baudgirl.translate([0xb0, 73, 0])).toEqual([{ t: 'knob', k: 2, u: 0 }]);
    expect([...PROFILES.baudgirl.reports]).toEqual(['keys', 'k1', 'k2', 'k3', 'k4']);
  });
});
