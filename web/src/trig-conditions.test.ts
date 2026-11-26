// SPDX-License-Identifier: GPL-3.0-only
// Trig conditions (#674, format 60, D-830): the condition byte, its words in the binary, and how the engine plays them.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type ModuleInst, type Patch } from './patch';
import { encodePatch, FORMAT_CONDS, SECTION_FORMATS, VERSION } from './patchbin';
import { parse, parseTrack, trackFrames } from './protocol';
import { decodePayload, encodePayload } from './pattern-store';
import {
  COND_FILL, COND_FIRST, COND_NEI, COND_NOT, COND_ORDER, COND_PRE, condAB, condName, fixNotes, isCond, noteWords, setCond, setStep,
  stepView, TRACK_NOTES_MAX, wordCount, wordsNotes, type StepNote,
} from './track';

const SR = 48000; // 120 bpm: a 1/16 step every 6000 samples
const note = (at: number, n = 60, extra: Partial<StepNote> = {}): StepNote => ({ at, len: 1, note: n, vel: 100, ...extra });

/** Main (120 bpm) and Steps tracks of one step each (a pass a step), each one's trig into an output side */
function rig(tracks: StepNote[][]): { p: Patch; st: ModuleInst[] } {
  const p = emptyPatch('conds');
  addModule(p, DEFS.fm1, 0, 0).params.tempo = 120;
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  const st = tracks.map((notes, i) => {
    const s = addModule(p, DEFS.steps, 0, 0);
    s.params.len = 1;
    s.notes = fixNotes(notes);
    connect(p, DEFS, { module: s.id, port: 'trig' }, { module: out.id, port: i ? 'r' : 'l' });
    return s;
  });
  return { p, st };
}
/** where each engine is: samples rendered, the sample its transport last started on, each side's last sample */
const clock = new Map<Engine, { o: number; t0: number; last: [number, number] }>();
const at = (e: Engine): { o: number; t0: number; last: [number, number] } => clock.get(e) ?? { o: 0, t0: 0, last: [0, 0] };
function start(e: Engine): void {
  const c = at(e);
  c.t0 = c.o;
  clock.set(e, c);
  e.transport(true);
}
/** `n` passes (steps: one a pass) more rendered: the steps (counted from the transport's start; the start is step 0, step
 * k falls on sample 6000 k - 1) on which each side's trig rose */
function passes(e: Engine, n: number): [number[], number[]] {
  const c = at(e);
  const l = new Float32Array(6000 * n), r = new Float32Array(6000 * n);
  e.render(l, r);
  const rise = (b: Float32Array, s: 0 | 1): number[] => [...b.keys()].filter((i) => b[i] > 0.5 && (i ? b[i - 1] : c.last[s]) <= 0.5).map((i) => Math.round((c.o + i - c.t0 + 1) / 6000));
  const out: [number[], number[]] = [rise(l, 0), rise(r, 1)];
  c.o += 6000 * n;
  c.last = [l[l.length - 1], r[r.length - 1]];
  clock.set(e, c);
  return out;
}
const play = (tracks: StepNote[][]): Engine => {
  const e = new Engine(SR);
  e.load(rig(tracks).p);
  start(e);
  return e;
};

describe('trig conditions: the byte (#674)', () => {
  it('names and orders every condition the FM-1 offers', () => {
    expect(COND_ORDER.length).toBe(1 + 8 + 2 * 35);
    expect(new Set(COND_ORDER).size).toBe(COND_ORDER.length);
    expect(COND_ORDER.slice(1).every(isCond)).toBe(true);
    expect(COND_ORDER.slice(0, 9).map(condName)).toEqual(['', 'FILL', 'NOT FILL', 'PRE', 'NOT PRE', 'NEI', 'NOT NEI', '1ST', 'NOT 1ST']);
    expect(condName(condAB(3, 4))).toBe('3:4');
    expect(condName(condAB(1, 2) | COND_NOT)).toBe('NOT 1:2');
    expect(COND_ORDER.at(-1)).toBe(condAB(8, 8) | COND_NOT);
    expect([0, condAB(3, 2), 5, 0x80, 1.5].some(isCond)).toBe(false);
  });

  it('a condition takes the chance\'s place; a chance set on the step takes it away, 100 % keeps it', () => {
    expect(fixNotes([note(0, 60, { chance: 50, cond: COND_FILL })])).toEqual([note(0, 60, { cond: COND_FILL })]);
    expect(fixNotes([note(0, 60, { chance: 50, cond: condAB(3, 2) })])).toEqual([note(0, 60, { chance: 50 })]);
    const t = setCond([note(0, 60, { chance: 40 }), note(1)], (n) => n.at === 0, condAB(2, 4));
    expect(t).toEqual([note(0, 60, { cond: condAB(2, 4) }), note(1)]);
    expect(stepView(t, 0)).toMatchObject({ on: true, chance: 100, cond: condAB(2, 4) });
    expect(setStep(t, 0, { on: true, accent: true, chance: 100 })?.[0].cond).toBe(condAB(2, 4));
    expect(setStep(t, 0, { on: true, accent: false, chance: 30 })?.[0]).toEqual(note(0, 60, { chance: 30 }));
  });

  it('a conditioned note takes two words, and a track holds TRACK_NOTES_MAX words', () => {
    const many = Array.from({ length: 128 }, (_, k) => note(k >> 1, 60 + 2 * (k & 1), { cond: COND_FIRST }));
    const kept = fixNotes([...many, ...Array.from({ length: 10 }, (_, k) => note(k, 70))])!;
    expect(wordCount(kept)).toBe(TRACK_NOTES_MAX);
    expect(kept.filter((n) => n.cond).length).toBe(123);   // (steps 0..9: two of them and a plain note, 5 words each; then 4)
  });
});

describe('trig conditions: the words (format 60)', () => {
  const notes = [note(0, 48, { cond: COND_FILL | COND_NOT }), note(0, 60), note(3, 62, { chance: 25 }), note(5, 64, { cond: condAB(8, 8), wrap: true, len: 4 })];

  it('a note with a condition is followed by its condition word, and they read back', () => {
    const w = noteWords(notes);
    expect(w.length).toBe(6);
    expect((w[0] >>> 26) & 31).toBe(31);
    expect((w[1] >>> 19) & 127).toBe(0);
    expect(w[1] & 0x7f03f).toBe(w[0] & 0x7f03f);
    expect(wordsNotes(w)).toEqual(notes);
    expect(wordsNotes([w[1], w[2]])).toEqual([note(0, 60)]);   // (a condition word with no note before it: dropped)
  });

  it('the binary: format 60 only for a patch with a condition, a word more for each', () => {
    expect(VERSION).toBeGreaterThanOrEqual(FORMAT_CONDS);
    expect(SECTION_FORMATS[60]).toBe('trig conditions');
    const plain = rig([notes.map((n) => ({ ...n, cond: undefined }))]).p, cond = rig([notes]).p, one = rig([[notes[0], ...notes.slice(1).map((n) => ({ ...n, cond: undefined }))]]).p;
    expect(encodePatch(plain)[1]).toBeLessThan(60);
    expect(encodePatch(cond)[1]).toBe(60);
    expect(encodePatch(cond).length - encodePatch(one).length).toBe(4);
    expect(validatePatch(JSON.parse(JSON.stringify(cond)), DEFS).modules.find((m) => m.type === 'steps')!.notes).toEqual(notes);
  });

  it('the editor link and the pattern store carry them', () => {
    expect(parseTrack(parse(trackFrames(4, notes, 2)[0])!.payload)).toEqual({ module: 4, notes, pat: 2, more: false });
    const { p } = rig([notes]);
    expect(decodePayload(encodePayload(p, 0)).tracks[0]?.notes).toEqual(notes);
  });
});

describe('trig conditions: the engine (#674)', () => {
  it('A:B plays on pass A of every B, NOT A:B on the others, counted from the start', () => {
    const [l, r] = passes(play([[note(0, 60, { cond: condAB(2, 3) })], [note(0, 60, { cond: condAB(1, 2) | COND_NOT })]]), 9);
    expect(l).toEqual([1, 4, 7]);
    expect(r).toEqual([1, 3, 5, 7, 9]);
  });

  it('1ST plays on the first pass only, again after a restart; NOT 1ST on every other', () => {
    const e = play([[note(0, 60, { cond: COND_FIRST })], [note(0, 60, { cond: COND_FIRST | COND_NOT })]]);
    expect(passes(e, 4)).toEqual([[0], [1, 2, 3, 4]]);
    e.transport(false);
    passes(e, 1);
    start(e);
    expect(passes(e, 3)).toEqual([[0], [1, 2, 3]]);
  });

  it('FILL plays while FILL is held, NOT FILL while it is not', () => {
    const e = play([[note(0, 60, { cond: COND_FILL })], [note(0, 60, { cond: COND_FILL | COND_NOT })]]);
    expect(passes(e, 2)).toEqual([[], [0, 1, 2]]);
    e.setFill(true);
    expect(passes(e, 2)).toEqual([[3, 4], []]);
    e.setFill(false);
    expect(passes(e, 1)).toEqual([[], [5]]);
  });

  it('PRE follows the last condition its track judged (a chance too), NEI the track before it', () => {
    const chance: StepNote[] = [note(0, 48, { chance: 50 }), note(0, 60, { cond: COND_PRE }), note(0, 62, { cond: COND_PRE | COND_NOT })];
    const e = play([[note(0, 48, { chance: 50 })], [note(0, 60, { cond: COND_NEI })]]);
    const [l, r] = passes(e, 40);
    expect(l.length).toBeGreaterThan(5);
    expect(l.length).toBeLessThan(35);
    expect(r).toEqual(l);
    const [both] = passes(play([chance]), 20);
    expect(both).toEqual(Array.from({ length: 21 }, (_, k) => k));   // (every pass: PRE or NOT PRE)
    expect(passes(play([[note(0, 60, { cond: COND_NEI })]]), 3)).toEqual([[], []]);   // (the first track has none before it)
  });

  it('the passes count again when the track plays another pattern', () => {
    const { p, st } = rig([[note(0, 60, { cond: condAB(1, 2) })]]);
    st[0].patterns = [{ notes: [note(0, 60, { cond: condAB(1, 2) })] }];
    const e = new Engine(SR);
    e.load(p);
    start(e);
    expect(passes(e, 3)[0]).toEqual([0, 2]);
    e.setPattern(1);   // (step 3 played: from the end of that pass, pass 4 is the new pattern's first)
    expect(passes(e, 3)[0]).toEqual([4, 6]);
  });
});
