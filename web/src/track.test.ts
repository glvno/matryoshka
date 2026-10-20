// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { stepByte } from './patch';
import { fixNotes, migrateSteps, noteWord, overdub, patternNotes, setChord, setStep, setStepValue, stepView, TRACK_NOTES_MAX, wordNote, type StepNote } from './track';

const n = (at: number, len: number, note: number, vel = 100, chance?: number): StepNote => ({ at, len, note, vel, ...(chance ? { chance } : {}) });
const TIE = stepByte({ on: false, accent: false, chance: 100, tie: true });

describe('a Steps track\'s notes (#133)', () => {
  it('fixNotes: valid, sorted by step then note, one per step and key, capped', () => {
    expect(fixNotes([n(3, 1, 64), n(0, 99, 60, 0), { at: 70, len: 1, note: 1, vel: 1 }, n(3, 2, 64), n(3, 1, 50, 200, 33), 'x'])).toEqual([n(0, 64, 60, 1), n(3, 1, 50, 127, 35), n(3, 1, 64)]);
    expect(fixNotes([])).toBeUndefined();
    expect(fixNotes(Array.from({ length: 300 }, (_, k) => n(k % 64, 1, k)))).toHaveLength(TRACK_NOTES_MAX);
  });

  it('migrates step bytes: an on step a note, ties make it longer, an accent full velocity, the chance kept', () => {
    const steps = [stepByte({ on: true, accent: true, chance: 100 }), TIE, TIE, 0, TIE, stepByte({ on: true, accent: false, chance: 20 }), TIE | 1];
    expect(migrateSteps(steps, Array.from({ length: 64 }, (_, k) => 60 + k), Array.from({ length: 64 }, () => 80))).toEqual([n(0, 3, 60, 127), n(5, 2, 65, 80, 20)]);
    expect(migrateSteps([TIE, 1])).toEqual([n(1, 1, 60)]);
    expect(migrateSteps(undefined)).toBeUndefined();
  });

  it('packs a note into a word and back', () => {
    for (const x of [n(0, 1, 0, 1), n(63, 1, 127, 127, 5), n(10, 54, 60, 100, 50)]) expect(wordNote(noteWord(x))).toEqual(x);
    expect(noteWord(n(1, 2, 3, 4, 95))).toBe((1 | (1 << 6) | (3 << 12) | (4 << 19) | (1 << 26)) >>> 0);
  });

  it('the step view: on where notes start (the lowest one\'s values), tied where a note goes on through', () => {
    const t = [n(0, 3, 60, 127), n(0, 1, 67, 50), n(4, 1, 62, 90, 40)];
    expect(stepView(t, 0)).toEqual({ on: true, accent: true, chance: 100, tie: false, note: 60, vel: 127 });
    expect(stepView(t, 2).tie).toBe(true);
    expect(stepView(t, 3)).toEqual({ on: false, accent: false, chance: 100, tie: false, note: 60, vel: 100 });
    expect(stepView(t, 4)).toMatchObject({ on: true, chance: 40, note: 62, vel: 90 });
  });

  it('setStep: on adds C4, off removes the step\'s notes, accent / chance on all of them, tie / untie lengthen / shorten', () => {
    let t = setStep(undefined, 2, { on: true, accent: false, chance: 100 });
    expect(t).toEqual([n(2, 1, 60)]);
    t = setStep([n(2, 1, 60), n(2, 1, 64, 80)], 2, { on: true, accent: true, chance: 50 });
    expect(t).toEqual([n(2, 1, 60, 127, 50), n(2, 1, 64, 127, 50)]);
    t = setStep(t, 2, { on: true, accent: false, chance: 100 });
    expect(t).toEqual([n(2, 1, 60), n(2, 1, 64)]);
    t = setStep([n(2, 1, 60), n(3, 1, 64)], 3, { on: false, accent: false, chance: 100, tie: true });
    expect(t).toEqual([n(2, 2, 60)]); // the step's own note gives way
    expect(setStep(t, 3, { on: false, accent: false, chance: 100 })).toEqual([n(2, 1, 60)]); // untied
    expect(setStep([n(2, 1, 60)], 5, { on: false, accent: false, chance: 100, tie: true })).toEqual([n(2, 1, 60)]); // nothing sounding
    expect(setStep([n(2, 1, 60)], 2, { on: false, accent: false, chance: 100 })).toBeUndefined();
    // an edit of a step under a long note that starts there too leaves the long one alone
    expect(setStep([n(0, 4, 48), n(2, 1, 60)], 2, { on: true, accent: true, chance: 100 })).toEqual([n(0, 4, 48), n(2, 1, 60, 127)]);
  });

  it('setStepValue moves a chord as one and sets every velocity; an empty step gets a note', () => {
    expect(setStepValue([n(1, 1, 60), n(1, 1, 64), n(1, 1, 67)], 1, 62, 70)).toEqual([n(1, 1, 62, 70), n(1, 1, 66, 70), n(1, 1, 69, 70)]);
    expect(setStepValue(undefined, 5, 72, 0)).toEqual([n(5, 1, 72, 1)]);
  });

  it('setChord: the step holds exactly the keys (one step long), a tied step is untied, the chance stays', () => {
    expect(setChord([n(0, 4, 48), n(2, 2, 60, 90, 50)], 2, [{ note: 64, vel: 80 }, { note: 67, vel: 70 }])).toEqual([n(0, 4, 48), n(2, 1, 64, 80, 50), n(2, 1, 67, 70, 50)]);
    expect(setChord([n(0, 4, 48)], 2, [{ note: 64, vel: 80 }])).toEqual([n(0, 2, 48), n(2, 1, 64, 80)]); // tied: untied first
    expect(setChord(undefined, 3, [{ note: 60, vel: 100 }])).toEqual([n(3, 1, 60)]);
  });

  it('overdub: recorded notes join the track, one on the same step and key replaces it', () => {
    expect(overdub([n(0, 1, 60), n(4, 1, 62)], [n(4, 2, 62, 90), n(8, 1, 64)])).toEqual([n(0, 1, 60), n(4, 2, 62, 90), n(8, 1, 64)]);
  });

  it('patternNotes: x a note, X an accented one', () => {
    expect(patternNotes('X.x.')).toEqual([n(0, 1, 60, 127), n(2, 1, 60)]);
  });
});
