// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's keys in sandbox mode play a Drum map's rows on black keys 1..8, as on the FM-1 (D-520, the 1.10 early check),
// and a Harmonizer's Side layout: the seven lowest keys its chord buttons at any octave, the rest roots (D-781, #1053)
import { describe, expect, it } from 'vitest';
import { blackKey, drumKeyNote, keysDrumMap, keysDrumRows, keysHarm, SandboxKeys } from './sandbox-keys';
import { Engine } from './engine';
import { FM1_PRESETS, PRESETS } from './presets';
import { relocatedPatches } from './community-factory';
import type { HostMsg } from './worklet';

describe('sandbox keys (D-520 in sandbox mode)', () => {
  it('counts the black keys from F#3', () => {
    expect([1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25].map(blackKey)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([0, 2, 4, 6, 7, 26, 27, -1].map(blackKey)).toEqual([-1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it('Verona Drum 1 XL: its keys reach the PATTERN track\'s Drum map, black keys 1..8 its rows, the white keys nothing', () => {
    const p = relocatedPatches['Verona Drum 1 XL']();
    const map = keysDrumMap(p)!;
    const list = keysDrumRows(p);
    expect(map?.names?.[0]).toBe('KICK');
    const rows = Array.from({ length: 8 }, (_, r) => map.params[`n${r + 1}`]);
    expect([54, 56, 58, 61, 63, 66, 68, 70].map((n) => drumKeyNote(map, list, n, 0))).toEqual(rows);
    expect(drumKeyNote(map, list, 53, 0)).toBeNull();
    // at another octave the same black keys play the same rows
    expect(drumKeyNote(map, list, 54 + 12, 1)).toBe(rows[0]);
    // the 9th black key and up play nothing
    expect(drumKeyNote(map, list, 73, 0)).toBeNull();
  });

  it('the 909 Kit: the keys reach all three Drum maps, as one list of 17 rows; sandbox mode plays the first 8', () => {
    const p = FM1_PRESETS['909 Kit']();
    const list = keysDrumRows(p);
    expect(list.map((r) => r.name)).toEqual(['KICK', 'SNARE', 'CLAP', 'CL HAT', 'OP HAT', 'LOW TOM', 'RIM', 'HI TOM',
      'MID TOM', 'CRASH', 'RIDE', 'ACCENT', 'BD FLAM', 'SD FLAM', 'LT FLAM', 'MT FLAM', 'HT FLAM']);
    const map = keysDrumMap(p)!;
    expect([54, 56, 58, 61, 63, 66, 68, 70].map((n) => drumKeyNote(map, list, n, 0))).toEqual(list.slice(0, 8).map((r) => r.note));
  });

  it('a melodic patch plays the plain notes', () => {
    expect(keysDrumMap(PRESETS['Basic Poly']())).toBeNull();
    expect(keysDrumMap(PRESETS.Init())).toBeNull();
  });

  it('a note-off ends what its note-on played, a silent key stays silent', () => {
    const p = relocatedPatches['Verona Drum 1 XL']();
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

describe('sandbox keys on a Harmonizer (D-781, #1053)', () => {
  /** Monolith D (Main -> Steps -> Harmonizer -> Arpeggiator -> Voicing) with its Harmonizer on and four voices */
  const monolith = (on = true) => {
    const p = PRESETS['Monolith D']();
    const h = p.modules.find((m) => m.type === 'harm')!;
    if (on) delete h.bypass;
    p.modules.find((m) => m.type === 'alloc')!.params.voices = 4;
    return p;
  };
  /** the note FM-1 key k (0 = F3 at octave 0) sends at `octave` */
  const key = (k: number, octave: number): number => 53 + k + 12 * octave;

  it('finds the Harmonizer the keys reach through the track, none while it is bypassed', () => {
    expect(keysHarm(monolith())?.type).toBe('harm');
    expect(keysHarm(monolith(false))).toBeNull();
    expect(keysHarm(PRESETS['Basic Poly']())).toBeNull();
  });

  it('takes the seven lowest keys as the chord buttons at every octave, every other key as a root', () => {
    const p = monolith();
    for (const octave of [-2, -1, 0, 1, 2]) {
      const k = new SandboxKeys();
      for (let b = 0; b < 7; b++) {
        expect(k.route({ t: 'on', note: key(b, octave), vel: 0.8 }, p, [], octave)).toEqual([{ t: 'chord', button: b, down: true }]);
        expect(k.route({ t: 'off', note: key(b, octave) }, p, [], octave)).toEqual([{ t: 'chord', button: b, down: false }]);
      }
      for (const r of [7, 12, 13, 26]) {   // (at octave -1 keys 12 and 13 send 53 and 54, under the split: still roots)
        expect(k.route({ t: 'on', note: key(r, octave), vel: 0.8 }, p, [], octave)).toEqual([{ t: 'on', note: key(r, octave), vel: 0.8, root: true }]);
        expect(k.route({ t: 'off', note: key(r, octave) }, p, [], octave)).toEqual([{ t: 'off', note: key(r, octave), root: true }]);
      }
      expect(k.holds(key(0, octave))).toBe(false);
    }
  });

  it('the browser engine plays the chord the FM-1\'s buttons pick, at another octave and under the split', () => {
    const p = monolith();
    const e = new Engine(44100);
    e.load(p);
    const k = new SandboxKeys();
    const play = (msg: HostMsg, octave: number): void => {
      for (const m of k.route(msg, p, [], octave)) {
        if (m.t === 'chord') e.chordButton(m.button, m.down);
        else if (m.t === 'on') e.noteOn(m.note, m.vel, m.ch, m.root);
        else if (m.t === 'off') e.noteOff(m.note, m.ch, m.root);
      }
    };
    const sounding = (): number[] => {
      for (let i = 0; i < 4; i++) e.render(new Float32Array(128), new Float32Array(128));   // (through the track: a block later)
      return e.voiceNotes().filter((v) => v.on).map((v) => v.note).sort((a, b) => a - b);
    };
    // octave 1: key 4 (G#) is min, key 8 (C) the root C5
    play({ t: 'on', note: key(3, 1), vel: 1 }, 1);
    play({ t: 'on', note: key(7, 1), vel: 1 }, 1);
    expect(sounding()).toEqual([72, 75, 79]);
    play({ t: 'off', note: key(7, 1) }, 1);
    play({ t: 'off', note: key(3, 1) }, 1);
    expect(sounding()).toEqual([]);
    // octave -1: key 2 (F#) is maj, key 14 (G) sends 55, under the split, and is the root G3
    play({ t: 'on', note: key(1, -1), vel: 1 }, -1);
    play({ t: 'on', note: key(14, -1), vel: 1 }, -1);
    expect(sounding()).toEqual([55, 59, 62]);
  });
});
