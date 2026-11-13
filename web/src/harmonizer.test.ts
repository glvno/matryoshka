// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { harmButton, harmChord, harmInit, harmIntervals, harmKey, harmName, HARM_BUTTONS, type HarmParams, type HarmState } from './harmonizer';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { encodePatch, formatOf, FORMAT_1_11, FORMAT_1_12 } from './patchbin';
import { deviceView, keySource } from './poly';
import { armable, armMask } from './arm';

const P = (p: Partial<HarmParams> = {}): HarmParams => ({ type: 0, sus: 0, ext: 0, voicing: 0, lock: 0, split: 60, ...p });
const B = (name: string): number => HARM_BUTTONS.indexOf(name);
const press = (s: HarmState, p: HarmParams, ...names: string[]): void => names.forEach((n) => harmButton(s, B(n), true, p));
const lift = (s: HarmState, p: HarmParams, ...names: string[]): void => names.forEach((n) => harmButton(s, B(n), false, p));

/** Main keys -> Harmonizer -> Voicing (six voices) -> saw -> VCA <- ADSR -> output */
function harmPatch(params: Partial<HarmParams> = {}): { p: Patch; harm: number; alloc: number } {
  const p = emptyPatch('harm');
  const main = addModule(p, DEFS.fm1, 0, 0);
  const harm = addModule(p, DEFS.harm, 300, 0);
  const alloc = addModule(p, DEFS.alloc, 600, 0);
  const osc = addModule(p, DEFS.osc, 900, 0);
  const env = addModule(p, DEFS.adsr, 900, 300);
  const vca = addModule(p, DEFS.vca, 1200, 0);
  const out = addModule(p, DEFS.output, 1500, 0);
  Object.assign(harm.params, params);
  alloc.params.voices = 6;
  const w = (a: number, ap: string, b: number, bp: string): void => {
    if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`${ap} -> ${bp}`);
  };
  w(main.id, 'keys', harm.id, 'keys');
  w(harm.id, 'keys', alloc.id, 'keys');
  w(alloc.id, 'pitch', osc.id, 'pitch');
  w(alloc.id, 'gate', env.id, 'gate');
  w(osc.id, 'out', vca.id, 'in');
  w(env.id, 'env', vca.id, 'cv');
  w(vca.id, 'out', out.id, 'l');
  return { p, harm: harm.id, alloc: alloc.id };
}
const sounding = (e: Engine): number[] => {
  e.render(new Float32Array(128), new Float32Array(128));
  return e.voiceNotes().filter((v) => v.on).map((v) => v.note).sort((a, b) => a - b);
};

describe('Harmonizer note logic (#598)', () => {
  it('builds the chord from the buttons held: a quality, sus / add, 7 and 9 combined', () => {
    const p = P();
    const s = harmInit();
    expect(harmIntervals(s, p)).toEqual([0]); // (nothing: the root alone)
    press(s, p, 'maj');
    expect(harmIntervals(s, p)).toEqual([0, 4, 7]);
    press(s, p, '7');
    expect(harmIntervals(s, p)).toEqual([0, 4, 7, 10]);
    expect(harmName(s, p)).toBe('7');
    lift(s, p, 'maj', '7');
    press(s, p, 'min', '7', '9');
    expect(harmIntervals(s, p)).toEqual([0, 3, 7, 10, 14]);
    expect(harmName(s, p)).toBe('MIN9');
    lift(s, p, 'min', '7', '9');
    press(s, p, 'dim', '7');
    expect(harmIntervals(s, p)).toEqual([0, 3, 6, 10]);
    expect(harmName(s, p)).toBe('MIN7B5');
    lift(s, p, 'dim', '7');
    press(s, p, 'sus4');
    expect(harmIntervals(s, p)).toEqual([0, 5, 7]); // (sus alone: no third)
    expect(harmName(s, p)).toBe('SUS4');
    press(s, p, 'maj');
    expect(harmIntervals(s, p)).toEqual([0, 4, 5, 7]); // (with a quality: an added 4th, the third kept)
    expect(harmName(s, p)).toBe('MAJ ADD4');
    lift(s, p, 'sus4', 'maj');
    press(s, p, '9');
    expect(harmIntervals(s, p)).toEqual([0, 4, 7, 14]); // (an extension alone: over a major chord)
    expect(harmName(s, p)).toBe('MAJ ADD9');
    lift(s, p, '9');
    press(s, p, 'sus2', 'sus4', '7');
    expect(harmIntervals(s, p)).toEqual([0, 2, 5, 7, 10]);
    expect(harmName(s, p)).toBe('7 SUS2 SUS4');
  });

  it('lets the quality pressed last win over another held', () => {
    const p = P();
    const s = harmInit();
    press(s, p, 'min', 'maj');
    expect(harmIntervals(s, p)).toEqual([0, 4, 7]);
    lift(s, p, 'maj');
    expect(harmIntervals(s, p)).toEqual([0, 3, 7]);
    press(s, p, 'dim');
    expect(harmIntervals(s, p)).toEqual([0, 3, 6]);
  });

  it('plays the card\'s chord while no button is in effect', () => {
    const p = P({ type: 2, sus: 1, ext: 3 });
    const s = harmInit();
    expect(harmIntervals(s, p)).toEqual([0, 2, 3, 7, 10, 14]);
    press(s, p, 'maj');
    expect(harmIntervals(s, p)).toEqual([0, 4, 7]); // (a button replaces the card's chord)
  });

  it('latches the buttons of one press with Lock on; the only latched button alone unlatches', () => {
    const p = P({ lock: 1 });
    const s = harmInit();
    press(s, p, 'min', '7');
    lift(s, p, 'min');
    expect(harmIntervals(s, p)).toEqual([0, 3, 7, 10]); // (the press under way: both still count)
    lift(s, p, '7');
    expect(harmIntervals(s, p)).toEqual([0, 3, 7, 10]);
    press(s, p, 'maj');
    lift(s, p, 'maj');
    expect(harmIntervals(s, p)).toEqual([0, 4, 7]); // (a new press replaces the latch)
    press(s, p, 'maj');
    lift(s, p, 'maj');
    expect(harmIntervals(s, p)).toEqual([0]); // (again: unlatched)
  });

  it('moves the chord through its inversions, and leaves the root alone where it is', () => {
    const s = harmInit();
    const up = P({ voicing: 1 }), down = P({ voicing: -2 });
    press(s, up, 'maj');
    expect(harmChord(s, 60, P())).toEqual([60, 64, 67]);
    expect(harmChord(s, 60, up)).toEqual([64, 67, 72]);
    expect(harmChord(s, 60, down)).toEqual([52, 55, 60]);
    expect(harmChord(harmInit(), 60, up)).toEqual([60]);
    press(s, up, '9');
    expect(harmChord(s, 60, P({ voicing: -1 }))).toEqual([60, 62, 64, 67]); // (the 9th down an octave: over the root)
    expect(harmChord(s, 125, P())).toEqual([125]); // (the notes past 127 are left out)
  });

  it.each<[number, number[]]>([
    [-8, [38, 40, 43, 48]], [-7, [40, 43, 48, 50]], [-6, [43, 48, 50, 52]],
    [-5, [48, 50, 52, 55]], [-4, [50, 52, 55, 60]], [-3, [52, 55, 60, 62]],
    [-2, [55, 60, 62, 64]], [-1, [60, 62, 64, 67]], [0, [60, 64, 67, 74]],
    [1, [64, 67, 72, 74]], [2, [67, 72, 74, 76]], [3, [72, 74, 76, 79]],
    [4, [74, 76, 79, 84]], [5, [76, 79, 84, 86]], [6, [79, 84, 86, 88]],
    [7, [84, 86, 88, 91]], [8, [86, 88, 91, 96]],
  ])('moves the current lowest or highest note at every add9 inversion (%i)', (voicing, notes) => {
    expect(harmChord(harmInit(), 60, P({ type: 1, ext: 2, voicing }))).toEqual(notes);
  });

  it('releases a held root after the split moves over it', () => {
    const s = harmInit(), on: number[] = [], off: number[] = [];
    const p = P({ type: 1 });
    harmKey(s, 60, true, p, true, (n) => on.push(n), (n) => off.push(n));
    p.split = 67;
    harmKey(s, 60, false, p, true, (n) => on.push(n), (n) => off.push(n));
    expect(on).toEqual([60, 64, 67]);
    expect(off).toEqual(on);
    expect(s.roots).toEqual([]);
    expect(s.down).toBe(0);
  });

  it.each([61, 72])('releases the original chord button after the split moves to %i', (split) => {
    const s = harmInit(), p = P(), notes: number[] = [];
    const heard = (n: number): void => { notes.push(n); };
    harmKey(s, 54, true, p, true, heard, heard);
    expect(s.down).toBe(1 << B('maj'));
    p.split = split;
    harmKey(s, 54, false, p, true, heard, heard);
    expect(s.down).toBe(0);
    expect(notes).toEqual([]);
  });

  it('keeps a chord button held until both keys mapped to it have been released', () => {
    const s = harmInit(), p = P(), notes: number[] = [];
    const heard = (n: number): void => { notes.push(n); };
    harmKey(s, 54, true, p, true, heard, heard);
    p.split = 61;
    harmKey(s, 55, true, p, true, heard, heard);
    harmKey(s, 54, false, p, true, heard, heard);
    expect(s.down).toBe(1 << B('maj'));
    harmKey(s, 55, false, p, true, heard, heard);
    expect(s.down).toBe(0);
    expect(notes).toEqual([]);
  });

  it('sounds a note two held roots share once and ends it with the last of them', () => {
    const p = P({ type: 1, ext: 1 });
    const s = harmInit();
    const on: number[] = [], off: number[] = [];
    harmKey(s, 67, true, p, true, (n) => on.push(n), (n) => off.push(n)); // G7: G B D F
    harmKey(s, 65, true, p, true, (n) => on.push(n), (n) => off.push(n)); // F7: F A C Eb
    expect(on).toEqual([67, 71, 74, 77, 65, 69, 72, 75]);
    harmKey(s, 62, true, p, true, (n) => on.push(n), (n) => off.push(n)); // D7: D F# A C: A and C already sound
    expect(on.slice(8)).toEqual([62, 66]);
    harmKey(s, 65, false, p, true, (n) => on.push(n), (n) => off.push(n));
    expect(off).toEqual([65, 75]); // (A and C stay: D7 holds them)
  });

  it('takes the seven keys under the split as buttons, every other key as a root (the zone off: all roots)', () => {
    const p = P({ split: 60 });
    const s = harmInit();
    const on: number[] = [];
    harmKey(s, 54, true, p, true, (n) => on.push(n), () => {}); // F#3: maj
    expect(s.down).toBe(1 << B('maj'));
    harmKey(s, 52, true, p, true, (n) => on.push(n), () => {}); // E3: under the buttons, a root
    harmKey(s, 57, true, p, false, (n) => on.push(n), () => {}); // A3 from the FM-1's keys: a root
    expect(on).toEqual([52, 56, 59, 57, 61, 64]);
    expect(HARM_BUTTONS).toEqual(['sus2', 'maj', 'sus4', 'min', '7', 'dim', '9']); // (F F# G G# A A# B: black maj min dim, white sus2 sus4 7 9)
  });
});

describe('Harmonizer module (#598)', () => {
  it('is appended after the Matrix, in format 52, between Main and a Voicing', () => {
    const { p, harm, alloc } = harmPatch();
    expect(keySource(p, p.modules.find((m) => m.id === alloc)!)?.id).toBe(harm);
    const view = deviceView(p, true);
    expect(view.groups.find((g) => g.src === harm)).toBeTruthy();
    expect(view.patch.modules.some((m) => m.id === harm)).toBe(true); // (the compile pass keeps it: a group plays it)
    expect(formatOf(p)).toBe(FORMAT_1_12);
    p.modules = p.modules.filter((m) => m.type !== 'harm');
    p.cables = p.cables.filter((c) => c.from.module !== harm && c.to.module !== harm);
    expect(formatOf(p)).toBeLessThanOrEqual(FORMAT_1_11); // (without one: an older format)
    expect(encodePatch(harmPatch().p)[1]).toBe(FORMAT_1_12);
  });

  it('plays a chord from one key, the buttons under the split, and the card\'s chord', () => {
    const { p } = harmPatch({ type: 2 });
    const e = new Engine(44100);
    e.load(p);
    e.noteOn(62);
    expect(sounding(e)).toEqual([62, 65, 69]); // (the card: D minor)
    e.noteOff(62);
    e.noteOn(54); // maj
    e.noteOn(57); // 7
    e.noteOn(67);
    expect(sounding(e)).toEqual([67, 71, 74, 77]);
    e.noteOff(67);
    expect(sounding(e)).toEqual([]);
    e.noteOn(57, 1, 1, true); // (the FM-1's key A3: a root, under the split as it is)
    expect(sounding(e)).toEqual([57, 61, 64, 67]);
    e.noteOff(57, 1, true);
    e.noteOff(54);
    e.noteOff(57);
    e.chordButton(B('min'), true);
    e.noteOn(60);
    expect(sounding(e)).toEqual([60, 63, 67]);
  });

  it('hands the keys straight on while bypassed, and lets go of what it played when switched', () => {
    const { p, harm } = harmPatch({ type: 1 });
    const e = new Engine(44100);
    e.load(p);
    e.noteOn(60);
    expect(sounding(e)).toEqual([60, 64, 67]);
    e.setBypass(harm, true);
    expect(sounding(e)).toEqual([]);
    e.noteOn(62);
    expect(sounding(e)).toEqual([62]);
    e.noteOff(62);
    e.setBypass(harm, false);
    e.noteOn(62);
    expect(sounding(e)).toEqual([62, 66, 69]);
  });

  it('is armed with the instrument it plays, never alone', () => {
    const { p, harm } = harmPatch({ type: 1 });
    expect(armable(p, `m${harm}`)).toBe(false);
    const alloc = p.modules.find((m) => m.type === 'alloc')!;
    const idx = deviceView(p, true).patch.modules.findIndex((m) => m.id === harm);
    expect(armMask(p, [`m${alloc.id}`])[0] & (1 << idx)).not.toBe(0);
    const e = new Engine(44100);
    e.load(p);
    e.arm([`m${alloc.id}`]);
    e.noteOn(60);
    expect(sounding(e)).toEqual([60, 64, 67]);
  });
});
