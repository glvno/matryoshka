// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { harmButton, harmButtonOf, harmChord, harmInit, harmIntervals, harmKey, harmName, harmRetrig, HARM_BUTTONS, HARM_ZONE, type HarmParams, type HarmState } from './harmonizer';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { encodePatch, formatOf, FORMAT_1_11, FORMAT_1_12, FORMAT_1_28, FORMAT_1_28_1 } from './patchbin';
import { SandboxKeys } from './sandbox-keys';
import { deviceView, keySource } from './poly';
import { armable, armMask } from './arm';

const P = (p: Partial<HarmParams> = {}): HarmParams => ({ type: 0, sus: 0, ext: 0, voicing: 0, lock: 0, split: 60, invkeys: 0, retrig: 0, ...p });
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

describe('Harmonizer inversion keys (#1311)', () => {
  const INV = (n: 1 | 2 | 3): number => HARM_ZONE + n - 1;
  it('the owner\'s example: min + 7 + the 3rd inversion over C plays B♭ C E♭ G', () => {
    const s = harmInit(), p = P({ invkeys: 1 });
    press(s, p, 'min', '7');
    harmButton(s, INV(3), true, p);
    expect(harmChord(s, 60, p)).toEqual([70, 72, 75, 79]);
  });

  it('I2 / I7: the three keys at split + 17 (F5 F♯5 G5 over C4) are the inversion keys while the row is on, and follow the split', () => {
    expect([77, 78, 79].map((n) => harmButtonOf(n, P({ invkeys: 1 })))).toEqual([INV(1), INV(2), INV(3)]);
    expect([76, 80].map((n) => harmButtonOf(n, P({ invkeys: 1 })))).toEqual([-1, -1]);
    expect([77, 78, 79].map((n) => harmButtonOf(n, P()))).toEqual([-1, -1, -1]);
    expect(harmButtonOf(65, P({ invkeys: 1, split: 48 }))).toBe(INV(1));
  });

  it('I3 / I4: a held inversion key sets the inversion exactly, replacing voicing; inversion n takes the lowest n notes up an octave', () => {
    const s = harmInit(), p = P({ invkeys: 1, voicing: -2, type: 1 });
    expect(harmChord(s, 60, p)).toEqual([52, 55, 60]);
    harmButton(s, INV(2), true, p);
    expect(harmChord(s, 60, p)).toEqual([67, 72, 76]);
    harmButton(s, INV(2), false, p);
    harmButton(s, INV(3), true, p);
    expect(harmChord(s, 60, p)).toEqual([72, 76, 79]); // (a triad's 3rd: root position an octave up, as voicing +3)
    expect(harmChord(s, 60, p)).toEqual(harmChord(harmInit(), 60, P({ type: 1, voicing: 3 })));
    harmButton(s, INV(3), false, p);
    expect(harmChord(s, 60, p)).toEqual([52, 55, 60]);
    expect(harmName(s, p)).toBe('MAJ');
  });

  it('I5: between two held inversion keys the one pressed last wins', () => {
    const s = harmInit(), p = P({ invkeys: 1, type: 1 });
    harmButton(s, INV(1), true, p);
    harmButton(s, INV(3), true, p);
    expect(harmChord(s, 60, p)).toEqual([72, 76, 79]);
    harmButton(s, INV(3), false, p);
    expect(harmChord(s, 60, p)).toEqual([64, 67, 72]);
  });

  it('I6: latched with the chord buttons pressed together (Lock on); a press of chord buttons alone replaces only them', () => {
    const s = harmInit(), p = P({ invkeys: 1, lock: 1 });
    press(s, p, 'maj');
    harmButton(s, INV(2), true, p);
    lift(s, p, 'maj');
    harmButton(s, INV(2), false, p);
    expect(harmChord(s, 60, p)).toEqual([67, 72, 76]);
    press(s, p, 'min');
    lift(s, p, 'min');
    expect(harmChord(s, 60, p)).toEqual([67, 72, 75]); // (C minor, the 2nd inversion kept)
  });

  const tap = (s: HarmState, p: HarmParams, ...bs: number[]): void => {
    bs.forEach((b) => harmButton(s, b, true, p));
    bs.forEach((b) => harmButton(s, b, false, p));
  };
  it.each([0, 1])('Lock on, type %i (the owner\'s 1.28.0 check S2): an inversion key alone replaces the latched inversion, the latched chord buttons stay', (type) => {
    const s = harmInit(), p = P({ invkeys: 1, lock: 1, type });
    tap(s, p, B('min'), B('7'), INV(1));
    expect(harmChord(s, 60, p)).toEqual([63, 67, 70, 72]);
    tap(s, p, INV(2));
    expect(harmChord(s, 60, p)).toEqual([67, 70, 72, 75]); // (before: the card's chord, so with type none C4 alone)
    expect(harmName(s, p)).toBe('MIN7 INV2');
    harmButton(s, INV(3), true, p); // (held, the latched chord plays under it)
    expect(harmChord(s, 60, p)).toEqual([70, 72, 75, 79]);
    harmButton(s, INV(3), false, p);
    expect(harmChord(s, 60, p)).toEqual([70, 72, 75, 79]);
  });

  it.each([0, 1])('held, type %i: with min + 7 held, a new inversion key replaces the one let go', (type) => {
    const s = harmInit(), p = P({ invkeys: 1, type });
    press(s, p, 'min', '7');
    harmButton(s, INV(1), true, p);
    expect(harmChord(s, 60, p)).toEqual([63, 67, 70, 72]);
    harmButton(s, INV(1), false, p);
    harmButton(s, INV(2), true, p);
    expect(harmChord(s, 60, p)).toEqual([67, 70, 72, 75]);
  });

  it('Lock on: the latched inversion key pressed again alone lets it go (the voicing row again), the chord buttons stay', () => {
    const s = harmInit(), p = P({ invkeys: 1, lock: 1, voicing: -1 });
    tap(s, p, B('maj'), INV(2));
    expect(harmChord(s, 60, p)).toEqual([67, 72, 76]);
    harmButton(s, INV(2), true, p);
    expect(harmChord(s, 60, p)).toEqual([67, 72, 76]); // (held, still in effect: it lets go when let go)
    harmButton(s, INV(2), false, p);
    expect(harmChord(s, 60, p)).toEqual([55, 60, 64]); // (voicing -1)
    expect(harmName(s, p)).toBe('MAJ');
    tap(s, p, INV(1), INV(3)); // (two together: not the latched one alone, so the last pressed is latched)
    expect(harmChord(s, 60, p)).toEqual([72, 76, 79]);
    tap(s, p, INV(3)); // (the latch holds both; G5 is not the only one, so it stays, alone now)
    expect(harmChord(s, 60, p)).toEqual([72, 76, 79]);
    tap(s, p, INV(3));
    expect(harmChord(s, 60, p)).toEqual([55, 60, 64]);
    tap(s, p, B('maj'));
    expect(s.locked).toBe(0);
    expect(harmChord(s, 60, p)).toEqual([60]);
  });

  it('the chord\'s name ends with the inversion key in effect; the voicing row and a root alone show none', () => {
    const s = harmInit(), p = P({ invkeys: 1, voicing: 2 });
    press(s, p, 'min', '7');
    expect(harmName(s, p)).toBe('MIN7');
    harmButton(s, INV(3), true, p);
    expect(harmName(s, p)).toBe('MIN7 INV3');
    lift(s, p, 'min', '7');
    expect(harmName(s, p)).toBe(''); // (the root alone: no inversion moves it)
    press(s, p, 'maj', 'sus2', 'sus4', '9');
    expect(harmName(s, p)).toBe('MAJ ADD2 ADD4 ADD9 INV3'); // (the longest: 23 characters)
  });

  it('in the engine (six voices), Lock on, type none: MIDI F5 then F♯5 alone after min + 7 + F5 sound Cmin7 in the 2nd inversion', () => {
    const { p } = harmPatch({ invkeys: 1, lock: 1 });
    const e = new Engine(44100);
    e.load(p);
    for (const n of [56, 57, 77]) e.noteOn(n); // min, 7, F5: the 1st inversion
    for (const n of [77, 57, 56]) e.noteOff(n);
    e.noteOn(60);
    expect(sounding(e)).toEqual([63, 67, 70, 72]);
    e.noteOff(60);
    e.noteOn(78); // F♯5 alone: the 2nd inversion, min + 7 kept
    e.noteOff(78);
    e.noteOn(60);
    expect(sounding(e)).toEqual([67, 70, 72, 75]);
    e.noteOff(60);
    e.noteOn(78); // F♯5 alone again: root position
    e.noteOff(78);
    e.noteOn(60);
    expect(sounding(e)).toEqual([60, 63, 67, 70]);
  });

  it('the row off: an inversion key does nothing, a latched one stops counting', () => {
    const s = harmInit(), on = P({ invkeys: 1, type: 1 }), off = P({ type: 1 });
    harmButton(s, INV(1), true, off);
    expect(s.down).toBe(0);
    harmButton(s, INV(1), true, on);
    expect(harmChord(s, 60, on)).toEqual([64, 67, 72]);
    expect(harmChord(s, 60, off)).toEqual([60, 64, 67]);
  });

  it('I7: in the engine, MIDI F5..G5 are the inversion keys with the row on, roots with it off; FM-1 buttons 7..9 likewise', () => {
    const { p, harm } = harmPatch({ invkeys: 1 });
    const e = new Engine(44100);
    e.load(p);
    e.noteOn(56); // min
    e.noteOn(57); // 7
    e.noteOn(79); // G5: 3rd inversion
    e.noteOn(60);
    expect(sounding(e)).toEqual([70, 72, 75, 79]);
    for (const n of [60, 79, 57, 56]) e.noteOff(n);
    expect(sounding(e)).toEqual([]);
    e.chordButton(B('maj'), true);
    e.chordButton(INV(1), true);
    e.noteOn(60, 1, 1, true);
    expect(sounding(e)).toEqual([64, 67, 72]);
    e.noteOff(60, 1, true);
    e.chordButton(INV(1), false);
    e.chordButton(B('maj'), false);
    p.modules.find((m) => m.id === harm)!.params.invkeys = 0;
    e.load(p);
    e.noteOn(79);
    expect(sounding(e)).toEqual([79]);
  });

  it('is saved as format 68 only while on; off, the patch keeps its older format', () => {
    expect(formatOf(harmPatch().p)).toBe(FORMAT_1_12);
    expect(formatOf(harmPatch({ invkeys: 1 }).p)).toBe(FORMAT_1_28);
    expect(encodePatch(harmPatch({ invkeys: 1 }).p)[1]).toBe(FORMAT_1_28);
  });

  it('in sandbox mode the FM-1\'s three highest keys go to the editor as the inversion keys while the row is on', () => {
    const keys = new SandboxKeys();
    expect(keys.route({ t: 'on', note: 79, vel: 1 }, harmPatch({ invkeys: 1 }).p, [], 0)).toEqual([{ t: 'chord', button: INV(3), down: true }]);
    expect(keys.route({ t: 'off', note: 79 }, harmPatch({ invkeys: 1 }).p, [], 0)).toEqual([{ t: 'chord', button: INV(3), down: false }]);
    expect(keys.route({ t: 'on', note: 65, vel: 1 }, harmPatch({ invkeys: 1 }).p, [], -1)).toEqual([{ t: 'chord', button: INV(1), down: true }]); // (F4 at OCT -1: the top key F)
    expect(keys.route({ t: 'on', note: 79, vel: 1 }, harmPatch().p, [], 0)).toEqual([{ t: 'on', note: 79, vel: 1, root: true }]);
  });
});

describe('Harmonizer RETRIG (#1329)', () => {
  /** roots down at velocity 0.5, a change, then what RETRIG sends: 'on N V' (a re-attack: 'on N again V') and 'off N' */
  const run = (p: HarmParams, roots: number[], change: (s: HarmState) => void): { s: HarmState; heard: string[]; changed: boolean } => {
    const s = harmInit();
    roots.forEach((r) => harmKey(s, r, true, p, false, () => {}, () => {}, undefined, 0, 0.5));
    change(s);
    const heard: string[] = [];
    const changed = harmRetrig(s, p, (n, v, again) => heard.push(`on ${n}${again ? ' again' : ''} ${v}`), (n) => heard.push(`off ${n}`));
    return { s, heard, changed };
  };
  const toMin = (s: HarmState): void => harmButton(s, B('min'), true, P());

  it('OFF (as made) keeps a held root\'s chord as it went down (D-778)', () => {
    const r = run(P({ type: 1 }), [60], toMin);
    expect(r.changed).toBe(false);
    expect(r.heard).toEqual([]);
    expect(r.s.roots[0].notes).toEqual([60, 64, 67]);
  });

  it('ALL ends every note of the held chords and starts every note of the new ones, at the root\'s velocity', () => {
    const r = run(P({ type: 1, retrig: 1 }), [60], toMin);
    expect(r.changed).toBe(true);
    expect(r.heard).toEqual(['off 60', 'off 64', 'off 67', 'on 60 again 0.5', 'on 63 0.5', 'on 67 again 0.5']);
    expect(r.s.roots[0].notes).toEqual([60, 63, 67]);
    expect([60, 63, 64, 67].map((n) => r.s.count[n])).toEqual([1, 1, 0, 1]);
  });

  it('DIFF ends only the notes the new chord drops and starts only those it adds; shared notes keep sounding', () => {
    const r = run(P({ type: 1, retrig: 2 }), [60], toMin);
    expect(r.heard).toEqual(['off 64', 'on 63 0.5']);
    expect(r.s.roots[0].notes).toEqual([60, 63, 67]);
  });

  it('re-forms every held root, oldest first; a note two chords share still sounds once', () => {
    const r = run(P({ type: 1, retrig: 2 }), [60, 64], toMin); // C E G + E G# B -> C Eb G + E G B
    expect(r.heard).toEqual(['off 68', 'on 63 0.5']);
    expect(r.s.count[67]).toBe(2);
    expect(r.s.count[64]).toBe(1);
  });

  it('follows the card\'s rows and the inversion keys too, and does nothing without a change or a held root', () => {
    const p = P({ type: 1, retrig: 2 });
    expect(run(p, [60], () => {}).changed).toBe(false);
    expect(run(p, [], toMin).changed).toBe(false);
    const s = harmInit();
    harmKey(s, 60, true, p, false, () => {}, () => {});
    const heard: number[] = [];
    expect(harmRetrig(s, { ...p, ext: 1 }, (n) => heard.push(n), () => {})).toBe(true);
    expect(heard).toEqual([70]);
    const inv = { ...p, ext: 1, invkeys: 1 };
    harmButton(s, HARM_ZONE, true, inv); // the 1st inversion
    expect(harmRetrig(s, inv, () => {}, () => {})).toBe(true);
    expect(s.roots[0].notes).toEqual([64, 67, 70, 72]);
  });

  it('changes nothing when there is no room for the notes that would start', () => {
    const s = harmInit(), p = P({ type: 1, retrig: 1 });
    harmKey(s, 60, true, p, false, () => {}, () => {});
    toMin(s);
    expect(harmRetrig(s, p, () => {}, () => {}, () => false)).toBe(false);
    expect(s.roots[0].notes).toEqual([60, 64, 67]);
  });

  it('in the engine: a chord button or a card row changes the held chord at the next block with ALL or DIFF, not with OFF', () => {
    for (const [retrig, want] of [[0, [60, 64, 67]], [1, [60, 63, 67]], [2, [60, 63, 67]]] as const) {
      const { p, harm } = harmPatch({ type: 1, retrig });
      const e = new Engine(44100);
      e.load(p);
      e.noteOn(60);
      expect(sounding(e)).toEqual([60, 64, 67]);
      e.chordButton(B('min'), true);
      expect(sounding(e)).toEqual(want);
      e.chordButton(B('min'), false); // (let go: the card's chord again)
      expect(sounding(e)).toEqual([60, 64, 67]);
      e.setParam(harm, 'ext', 1);
      expect(sounding(e)).toEqual(retrig ? [60, 64, 67, 70] : [60, 64, 67]);
      e.noteOff(60);
      expect(sounding(e)).toEqual([]);
    }
  });

  it('an Arpeggiator after it holds the new chord at once, even latched: ALL as a new press, DIFF swapping the notes', () => {
    for (const [retrig, want] of [[0, [60, 64, 67]], [1, [60, 63, 67]], [2, [60, 67, 63]]] as const) {
      const { p, harm, alloc } = harmPatch({ type: 1, retrig });
      const arp = addModule(p, DEFS.arp, 450, 0);
      arp.params.latch = 1;
      p.cables = p.cables.filter((c) => !(c.from.module === harm && c.to.module === alloc));
      if (!connect(p, DEFS, { module: harm, port: 'keys' }, { module: arp.id, port: 'keys' })) throw new Error('harm -> arp');
      if (!connect(p, DEFS, { module: arp.id, port: 'keys' }, { module: alloc, port: 'keys' })) throw new Error('arp -> alloc');
      const e = new Engine(44100);
      e.load(p);
      e.noteOn(60);
      sounding(e);
      e.chordButton(B('min'), true);
      sounding(e);
      const held = e['arps'][0].st.held;
      expect(held.map((k) => k.note)).toEqual(want);
      expect(held.every((k) => k.down)).toBe(true);
    }
  });

  it('is saved as format 69 only when ALL or DIFF; OFF keeps the older format', () => {
    expect(formatOf(harmPatch({ retrig: 0 }).p)).toBe(FORMAT_1_12);
    expect(formatOf(harmPatch({ retrig: 1 }).p)).toBe(FORMAT_1_28_1);
    expect(encodePatch(harmPatch({ retrig: 2 }).p)[1]).toBe(FORMAT_1_28_1);
    expect(encodePatch(harmPatch({ invkeys: 1 }).p)[1]).toBe(FORMAT_1_28);
  });
});
