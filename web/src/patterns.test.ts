// SPDX-License-Identifier: GPL-3.0-only
// Pattern memory and songs (format 48): the model (track.ts), the binary (patchbin.ts patternRecord) and the playing
// (modules.ts steps, engine.ts setPattern / setSong). engine.c plays the same: golden kits steps-patterns, steps-song.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type ModuleInst, type Patch } from './patch';
import { deviceBudget, encodedSize, encodePatch, FLAG_NOTES, FLAG_PATTERNS, formatOf, patternRecord, VERSION } from './patchbin';
import { deviceView } from './poly';
import { FM1_PRESETS } from './presets';
import { fixPatterns, fixSeq, isShortNote, noteWord, patternOf, shortWord, wordShort, type StepNote } from './track';

const SR = 48000; // 120 bpm: a 1/16 step every 6000 samples
const STEP = 6000;
const note = (at: number, len: number, n: number, vel = 100, chance?: number): StepNote => ({ at, len, note: n, vel, ...(chance ? { chance } : {}) });

/** Main (120 bpm) -> Steps tracks; track k's pitch to the left output (k 0) or the right (k 1); trig unused */
function rig(lens: number[]): { p: Patch; tracks: ModuleInst[]; main: ModuleInst } {
  const p = emptyPatch('patterns');
  const main = addModule(p, DEFS.fm1, 0, 0);
  main.params.tempo = 120;
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  const tracks = lens.map((len, k) => {
    const st = addModule(p, DEFS.steps, 0, 0);
    Object.assign(st.params, { len, gate: 1 });
    connect(p, DEFS, { module: st.id, port: 'pitch' }, { module: out.id, port: k ? 'r' : 'l' });
    return st;
  });
  return { p, tracks, main };
}

/** the note each step plays on both sides (from the pitch outputs, sampled mid-step), `n` steps from now */
function both(e: Engine, n: number): { l: number[]; r: number[] } {
  const l = new Float32Array(n * STEP), r = new Float32Array(n * STEP);
  e.render(l, r);
  const at = (b: Float32Array): number[] => Array.from({ length: n }, (_, k) => Math.round(60 + 12 * b[k * STEP + STEP / 2]));
  return { l: at(l), r: at(r) };
}
const notes = (e: Engine, n: number): number[] => both(e, n).l;

describe('patterns and songs: the model', () => {
  it('a short note word holds a note of a 16-step pattern at the default or full velocity, chance 100 %', () => {
    for (const n of [note(0, 1, 0), note(15, 16, 127, 127), note(7, 3, 60)]) {
      expect(isShortNote(n)).toBe(true);
      expect(wordShort(shortWord(n))).toEqual(n);
      expect(shortWord(n)).toBeLessThan(65536);
    }
    for (const n of [note(16, 1, 60), note(0, 17, 60), note(0, 1, 60, 90), note(0, 1, 60, 100, 50)]) expect(isShortNote(n)).toBe(false);
  });

  it('patterns and songs come out valid: nulls where a track has none, trailing ones dropped, ranges held', () => {
    expect(fixPatterns([null, { notes: [note(1, 1, 60), note(0, 1, 62)], len: 99, rate: 3 }, null, 'x'])).toEqual([null, { notes: [note(0, 1, 62), note(1, 1, 60)], len: 64, rate: 3 }]);
    expect(fixPatterns([null, null])).toBeUndefined();
    expect(fixPatterns(Array.from({ length: 80 }, () => ({})))!.length).toBe(63);
    expect(fixSeq({ pattern: 70, song: 9, songs: [[{ pat: 3, shift: 20 }, { pat: -1, shift: -20 }], []] })).toEqual({ pattern: 63, song: 8, songs: [[{ pat: 3, shift: 12 }, { pat: 0, shift: -12 }]] });
    expect(fixSeq({ pattern: 0, song: 0, songs: [[]] })).toBeUndefined();
  });

  it('validatePatch keeps a track\'s patterns and Main\'s seq, and drops them elsewhere', () => {
    const { p, tracks, main } = rig([4]);
    tracks[0].patterns = [{ notes: [note(0, 1, 50)] }];
    main.seq = { pattern: 1, songs: [[{ pat: 1, shift: 2 }]] };
    const out = addModule(p, DEFS.osc, 0, 0) as ModuleInst & { seq?: unknown };
    Object.assign(out, { patterns: [{}], seq: { pattern: 2 } });
    const v = validatePatch(structuredClone(p), DEFS);
    expect(v.modules.find((m) => m.id === tracks[0].id)!.patterns).toEqual([{ notes: [note(0, 1, 50)] }]);
    expect(v.modules.find((m) => m.id === main.id)!.seq).toEqual({ pattern: 1, songs: [[{ pat: 1, shift: 2 }]] });
    expect(v.modules.find((m) => m.id === out.id)).not.toHaveProperty('patterns');
    expect(v.modules.find((m) => m.id === out.id)).not.toHaveProperty('seq');
  });

  it('a pattern a track has not got plays its first; a pattern without its own length or rate takes the track\'s', () => {
    const { tracks } = rig([6]);
    const t = tracks[0];
    t.notes = [note(0, 1, 60)];
    t.patterns = [null, { notes: [note(1, 1, 61)], len: 3 }, {}];
    expect(patternOf(t, 0)).toEqual({ notes: t.notes, len: 6, rate: 4, own: true });
    expect(patternOf(t, 1)).toEqual({ notes: t.notes, len: 6, rate: 4, own: false });
    expect(patternOf(t, 2)).toEqual({ notes: [note(1, 1, 61)], len: 3, rate: 4, own: true });
    expect(patternOf(t, 3)).toEqual({ notes: undefined, len: 6, rate: 4, own: true });
    expect(patternOf(t, 40).own).toBe(false);
  });
});

describe('patterns and songs: the binary (format 48)', () => {
  it('a patch without patterns or songs is written exactly as before: no section, its old format', () => {
    for (const name of Object.keys(FM1_PRESETS)) {
      const p = FM1_PRESETS[name]();
      if (p.modules.some((m) => m.patterns?.length || m.seq)) continue;
      expect(patternRecord(p, deviceView(p, true).patch), name).toEqual([]);
      const b = encodePatch(p, true);
      expect(b[1], name).toBeLessThan(VERSION);
      expect(b[7] & (FLAG_PATTERNS >> 8), name).toBe(0);
    }
  });

  it('patterns raise the format to 48 and add the section after the notes; its bytes as the top of patchbin.ts says', () => {
    const { p, tracks, main } = rig([8, 4]);
    tracks[0].notes = [note(0, 1, 60)];
    tracks[0].patterns = [{ notes: [note(0, 2, 62, 127), note(3, 1, 64)] }, null, { notes: [note(20, 1, 40, 90, 50)], len: 24, rate: 6 }];
    const before = encodePatch(p).length;
    main.seq = { pattern: 2, song: 1, songs: [[{ pat: 0, shift: 0 }, { pat: 3, shift: -5 }]] };
    expect(formatOf(p)).toBe(VERSION);
    const b = encodePatch(p);
    expect(b[1]).toBe(48);
    expect(new DataView(b.buffer).getUint16(6, true) & (FLAG_PATTERNS | FLAG_NOTES)).toBe(FLAG_PATTERNS | FLAG_NOTES);
    expect(b.length).toBe(encodedSize(p));
    const st = deviceView(p, true).patch.modules.indexOf(tracks[0]);
    const rec = patternRecord(p, deviceView(p, true).patch);
    expect(rec).toEqual([
      2, 1, 1, // the selected pattern, the song, one track
      st, 3, // its module, patterns 2..4
      2, 0x80, 0xff, ...[shortWord(note(0, 2, 62, 127)), shortWord(note(3, 1, 64))].flatMap((w) => [w & 0xff, w >> 8]), // short words
      0xff, // pattern 3: none (plays the first)
      1, 24, 6, ...[0, 8, 16, 24].map((s) => (noteWord(note(20, 1, 40, 90, 50)) >>> s) & 0xff), // long words, its own length and rate
      1, 2, 0, 0, 3, 0xfb, // one song, two entries
    ]);
    expect(Array.from(b).join(',').includes(rec.join(','))).toBe(true);
    expect(b.length - before).toBe(5); // (a song: its entry count, two entries)
  });

  it('the budget counts every pattern\'s notes', () => {
    const { p, tracks } = rig([8]);
    tracks[0].notes = [note(0, 1, 60), note(1, 1, 60)];
    tracks[0].patterns = [{ notes: [note(0, 1, 60)] }, null, { notes: [note(0, 1, 60), note(2, 1, 60), note(3, 1, 60)] }];
    expect(deviceBudget(p).items.find((i) => i.key === 'notes')!.used).toBe(6);
  });

  it('a selected pattern alone is a four-byte section; selecting pattern 1 again takes it away', () => {
    const { p, main } = rig([8]);
    const plain = encodePatch(p);
    main.seq = { pattern: 1 };
    const b = encodePatch(p);
    expect(formatOf(p)).toBe(48);
    expect(b.length).toBe(plain.length + 4);
    main.seq = fixSeq({ pattern: 0 });
    expect(encodePatch(p)).toEqual(plain);
  });
});

describe('patterns and songs: playing', () => {
  /** two tracks, 4 and 3 steps: track A's patterns are notes 60.., 64.., B's 52.., 56.. (the output holds the pitch
   * within an octave of C4) */
  function two(): { e: Engine; p: Patch; tracks: ModuleInst[]; main: ModuleInst } {
    const r = rig([4, 3]);
    const [a, b] = r.tracks;
    a.notes = [0, 1, 2, 3].map((k) => note(k, 1, 60 + k));
    a.patterns = [{ notes: [0, 1, 2, 3].map((k) => note(k, 1, 64 + k)) }];
    b.notes = [0, 1, 2].map((k) => note(k, 1, 52 + k));
    b.patterns = [{ notes: [0, 1, 2].map((k) => note(k, 1, 56 + k)) }];
    const e = new Engine(SR);
    e.load(r.p);
    return { e, ...r };
  }

  it('running, a chosen pattern plays on each track from the end of its own pass', () => {
    const { e } = two();
    e.transport(true);
    expect(notes(e, 1)).toEqual([60]);
    e.setPattern(1);
    expect(e.patternView().tracks.map((t) => [t.pat, t.queued])).toEqual([[0, 1], [0, 1]]);
    const x = both(e, 5);
    expect(x.l).toEqual([61, 62, 63, 64, 65]); // A: steps 2..4, then pattern 2
    expect(x.r).toEqual([53, 54, 56, 57, 58]); // B (3 steps): its pass ends sooner
    expect(e.patternView().tracks.map((t) => [t.pat, t.queued])).toEqual([[1, -1], [1, -1]]);
  });

  it('stopped, a chosen pattern plays at once; PLAY starts it from its first step', () => {
    const { e } = two();
    e.setPattern(1);
    notes(e, 1);
    expect(e.patternView().tracks.map((t) => t.pat)).toEqual([1, 1]);
    e.transport(true);
    expect(notes(e, 5)).toEqual([64, 65, 66, 67, 64]);
  });

  it('a pattern a track has not got plays its first; a pattern\'s own length and rate', () => {
    const { e, tracks, p } = two();
    tracks[0].patterns!.push({ notes: [note(0, 1, 68), note(1, 1, 69)], len: 2, rate: 3 }); // pattern 3: two steps of 8 ticks
    e.load(p);
    e.setPattern(2);
    e.transport(true);
    const l = new Float32Array(4 * STEP), r = new Float32Array(4 * STEP);
    e.render(l, r);
    const at = (b: Float32Array, i: number): number => Math.round(60 + 12 * b[i]);
    expect([3000, 9000, 15000].map((i) => at(r, i))).toEqual([52, 53, 54]); // B has no pattern 3: its first
    expect([4000, 7000, 12000, 20000].map((i) => at(l, i))).toEqual([68, 68, 69, 68]); // A: 8000 samples a step, two steps
  });

  it('a song plays its entries a pass each with their shift, then its first again; stop and PLAY start it over', () => {
    const { e, main, p } = two();
    main.seq = { song: 1, songs: [[{ pat: 0, shift: 0 }, { pat: 1, shift: 2 }, { pat: 0, shift: -7 }]] };
    e.load(p);
    e.transport(true);
    expect(notes(e, 16)).toEqual([60, 61, 62, 63, 66, 67, 68, 69, 53, 54, 55, 56, 60, 61, 62, 63]);
    e.transport(false);
    notes(e, 1);
    e.transport(true);
    expect(notes(e, 5)).toEqual([60, 61, 62, 63, 66]);
    expect(e.patternView().tracks[0].entry).toBe(1);
  });

  it('song 0 again: the selected pattern from the end of the pass, unshifted', () => {
    const { e, main, p } = two();
    main.seq = { song: 1, songs: [[{ pat: 1, shift: 3 }]] };
    e.load(p);
    e.transport(true);
    expect(notes(e, 2)).toEqual([67, 68]);
    e.setSong(0);
    expect(notes(e, 4)).toEqual([69, 70, 60, 61]);
  });

  it('a track that plays a Drum map is never shifted', () => {
    const { e, p, tracks, main } = two();
    const dm = addModule(p, DEFS.drummap, 0, 0);
    connect(p, DEFS, { module: tracks[1].id, port: 'keys' }, { module: dm.id, port: 'keys' });
    main.seq = { song: 1, songs: [[{ pat: 1, shift: 4 }]] };
    e.load(p);
    e.transport(true);
    expect(both(e, 3)).toEqual({ l: [68, 69, 70], r: [56, 57, 58] });
  });

  it('an edit of a pattern goes into that pattern; the one playing plays it at once', () => {
    const { e, tracks } = two();
    e.transport(true);
    e.setTrack(tracks[0].id, [note(0, 1, 66), note(1, 1, 67), note(2, 1, 68), note(3, 1, 69)], 1);
    expect(notes(e, 4)).toEqual([60, 61, 62, 63]);
    // (the next pass began on the last sample: its first step played 60)
    e.setTrack(tracks[0].id, [note(0, 1, 50), note(1, 1, 51), note(2, 1, 52), note(3, 1, 53)], 0);
    e.setPattern(1);
    expect(notes(e, 5)).toEqual([60, 51, 52, 53, 66]);
  });
});

describe('Silver Box: demo patterns and a song (#375)', () => {
  it('holds four TB-303-style patterns in short words and a song, named as on the TB-303, within the FM-1 budget', () => {
    const p = FM1_PRESETS['Silver Box']();
    const t = p.modules.find((m) => m.type === 'steps')!;
    const main = p.modules.find((m) => m.type === 'fm1')!;
    expect(t.notes).toBeUndefined(); // (pattern 1 stays empty: the keys play it as a synth)
    expect(t.patterns!.length).toBe(4);
    expect(t.patterns!.every((x) => x!.notes!.every(isShortNote))).toBe(true);
    expect(t.patterns![3]).toMatchObject({ len: 12, rate: 5 }); // (the TB-303's triplet mode)
    expect(main.seq).toMatchObject({ names: '303' });
    expect(main.seq!.songs![0].length).toBe(8);
    expect(main.seq!.pattern ?? 0).toBe(0);
    expect(main.seq!.song ?? 0).toBe(0);
    expect(encodePatch(p).length).toBeLessThanOrEqual(3840);
    expect(deviceBudget(p).fits).toBe(true);
  });
  it('its song plays: the voice sounds once song 1 is chosen and the transport runs', () => {
    const p = FM1_PRESETS['Silver Box']();
    const e = new Engine(SR);
    e.load(p);
    e.setSong(1);
    e.transport(true);
    const l = new Float32Array(SR), r = new Float32Array(SR);
    e.render(l, r);
    expect(Math.max(...l.map(Math.abs))).toBeGreaterThan(0.01);
    expect(e.patternView().tracks[0].pat).toBe(1);
  });
});
