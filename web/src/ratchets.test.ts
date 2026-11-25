// SPDX-License-Identifier: GPL-3.0-only
// Ratchets and micro timing (#675, #677, format 63): the timing word in the binary, the edits that keep it, and where
// the engine plays the hits.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch } from './patch';
import { encodePatch, FORMAT_1_20, SECTION_FORMATS, VERSION } from './patchbin';
import { parse, parseTrack, trackFrames } from './protocol';
import { decodePayload, encodePayload } from './pattern-store';
import {
  COND_FILL, fixNotes, hasTiming, isShortNote, MICRO_MAX, microName, noteWords, overdub, RATCHET_MAX, setChord, setTiming,
  stepView, timeWord, TRACK_NOTES_MAX, wordCount, wordsNotes, type StepNote,
} from './track';

const SR = 48000; // 120 bpm: a 1/16 step every 6000 samples
const note = (at: number, n = 60, extra: Partial<StepNote> = {}): StepNote => ({ at, len: 1, note: n, vel: 100, ...extra });

/** Main (120 bpm, 1/16 steps) and one Steps track of `len` steps, its trig into the output's left side */
function rig(notes: StepNote[], len: number, params: Record<string, number> = {}): Patch {
  const p = emptyPatch('ratchets');
  addModule(p, DEFS.fm1, 0, 0).params.tempo = 120;
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  const s = addModule(p, DEFS.steps, 0, 0);
  Object.assign(s.params, { len, gate: 0.25 }, params);
  s.notes = fixNotes(notes);
  connect(p, DEFS, { module: s.id, port: 'trig' }, { module: out.id, port: 'l' });
  return p;
}
/** the samples on which the trig rose in the `n` samples from the transport's start (its first step falls on sample 0,
 * step k after it on sample 6000 k - 1) */
function rises(p: Patch, n: number): number[] {
  const e = new Engine(SR);
  e.load(p);
  e.transport(true);
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  return [...l.keys()].filter((i) => l[i] > 0.5 && (!i || l[i - 1] <= 0.5));
}

describe('ratchets and micro timing: the timing word (#675, #677, format 63)', () => {
  it('a note with a ratchet or micro timing takes a timing word after it (after its condition word), and comes back', () => {
    const ns = [note(0, 60, { ratchet: 3 }), note(1, 62, { micro: -5 }), note(2, 64, { cond: COND_FILL, ratchet: 5, micro: 23 }), note(3)];
    const w = noteWords(ns);
    expect(w).toHaveLength(8);
    expect(wordCount(ns)).toBe(8);
    expect(timeWord(ns[0]) >>> 0).toBe((0 | (32 << 6) | (60 << 12) | (2 << 26) | 0x80000000) >>> 0);
    expect((w[1] >>> 19) & 127).toBe(0);
    expect(w[1] >>> 31).toBe(1);
    expect(w[5] >>> 31).toBe(0);                                      // (note 3: its condition word, then its timing word)
    expect(w[6] >>> 31).toBe(1);
    expect(wordsNotes(w)).toEqual(ns);
  });

  it('fixNotes keeps a ratchet 2..5 and micro timing within ±23, drops x1 and 0, counts timing words against the 128', () => {
    expect(fixNotes([note(0, 60, { ratchet: 9, micro: -40 })])).toEqual([note(0, 60, { ratchet: RATCHET_MAX, micro: -MICRO_MAX })]);
    expect(fixNotes([note(0, 60, { ratchet: 1, micro: 0 })])).toEqual([note(0)]);
    const many = Array.from({ length: 70 }, (_, k) => note(k % 64, 40 + Math.floor(k / 64), { ratchet: 2 }));
    expect(wordCount(fixNotes(many))).toBeLessThanOrEqual(TRACK_NOTES_MAX);
    expect(fixNotes(many)).toHaveLength(TRACK_NOTES_MAX / 2);
    expect(isShortNote(note(0, 60, { micro: 1 }))).toBe(false);
    expect(hasTiming(note(0))).toBe(false);
    expect(microName(-3)).toBe('-3/24');
  });

  it('only a patch that uses one is written as format 63; it passes validatePatch', () => {
    expect(VERSION).toBeGreaterThanOrEqual(FORMAT_1_20);
    expect(SECTION_FORMATS[FORMAT_1_20]).toBe('the 1.20 features');
    expect(encodePatch(rig([note(0)], 4), true)[1]).toBeLessThan(FORMAT_1_20);
    const p = rig([note(0, 60, { ratchet: 2 })], 4);
    expect(encodePatch(p, true)[1]).toBe(FORMAT_1_20);
    expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules.find((m) => m.type === 'steps')!.notes).toEqual([note(0, 60, { ratchet: 2 })]);
  });

  it('the editor link and the pattern store carry the words as they are', () => {
    const ns = [note(0, 60, { micro: 7 }), note(0, 64, { ratchet: 4 })];
    const f = parse(trackFrames(3, ns, 2)[0]);
    expect(parseTrack(f!.payload)).toEqual({ module: 3, notes: ns, pat: 2, more: false });
    const p = rig(ns, 4);
    expect(decodePayload(encodePayload(p, 0)).tracks[0]?.notes).toEqual(ns);
  });

  it('the edits keep a step\'s ratchet and micro timing: a chord entered, a note recorded over it, setTiming', () => {
    const t = [note(2, 60, { ratchet: 3, micro: -2 })];
    expect(setChord(t, 2, [{ note: 62, vel: 90 }, { note: 65, vel: 90 }])).toEqual([note(2, 62, { vel: 90, ratchet: 3, micro: -2 }), note(2, 65, { vel: 90, ratchet: 3, micro: -2 })]);
    expect(overdub(t, [note(2, 60, { vel: 127 })])).toEqual([note(2, 60, { vel: 127, ratchet: 3, micro: -2 })]);
    expect(stepView(t, 2)).toMatchObject({ ratchet: 3, micro: -2 });
    expect(setTiming(t, () => true, { ratchet: 1 })).toEqual([note(2, 60, { micro: -2 })]);
    expect(setTiming(t, () => true, { ratchet: 1, micro: 0 })).toEqual([note(2)]);
  });
});

describe('ratchets and micro timing: where the engine plays them', () => {
  it('a ratchet plays its hits a step\'s 1 / ratchet apart', () => {
    expect(rises(rig([note(0, 60, { ratchet: 3 })], 2), 23999)).toEqual([0, 2000, 4000, 11999, 13999, 15999]);
  });

  it('micro timing late plays the note that many 24ths of a step after its step; with a ratchet, every hit', () => {
    expect(rises(rig([note(0), note(1, 60, { micro: 6 })], 2), 11999)).toEqual([0, 5999 + 1500]);
    expect(rises(rig([note(0), note(1, 60, { micro: 6, ratchet: 2 })], 2), 11999)).toEqual([0, 5999 + 1500, 5999 + 4500]);
  });

  it('micro timing early plays the note before its step: within the pass, and from the pass before into the next one', () => {
    // (queued at the step before, a step's length ahead of it: from the transport's first step, a sample earlier)
    expect(rises(rig([note(0), note(1, 60, { micro: -6 })], 2), 11999)).toEqual([0, 6000 - 1500]);
    // (the pass's first step: on the step at the start, early from the end of the pass before after that)
    expect(rises(rig([note(0, 60, { micro: -3 })], 2), 30000)).toEqual([0, 11999 - 750, 23999 - 750]);
  });

  it('an early note queued at the step before keeps its chance: judged once, not again on its own step', () => {
    const a = rises(rig([note(1, 60, { micro: -4, chance: 50 })], 2), 12000 * 16);
    const b = rises(rig([note(1, 60, { chance: 50 })], 2), 12000 * 16);
    expect(b.length).toBeGreaterThan(2);
    expect(b.length).toBeLessThan(14);
    expect(a.map((x) => x + 1000).slice(1)).toEqual(b.slice(1));
  });

  it('a drone ignores its ratchet and micro timing', () => {
    expect(rises(rig([note(0, 60, { len: 64, wrap: true, ratchet: 4, micro: 5 })], 2), 24000)).toEqual([0]);
  });
});
