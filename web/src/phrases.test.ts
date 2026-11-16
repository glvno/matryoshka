// SPDX-License-Identifier: GPL-3.0-only
// Test phrases (#945): fixed notes, tempo and velocity; the block player the worklet and the WAV render share.
import { describe, expect, it } from 'vitest';
import { DRUM_MAP_DEFAULT } from './modules';
import { PHRASES, PHRASE_TAIL, PHRASE_VEL, PhrasePlayer, TAKE_GAP, TAKE_MAX_NOTES, TakeRecorder, drumNotes, makePhrase, rootNote, takePhrase, type Phrase } from './phrases';
import { PRESETS } from './presets';

type Ev = [frame: number, kind: 'on' | 'off', note: number];
/** every note on and off the player gives, by the first frame of the block it came before */
function play(phrase: Phrase, loop: boolean, sr: number, frames: number, block = 128): { events: Ev[]; ended: number } {
  const p = new PhrasePlayer(phrase, loop, sr);
  const events: Ev[] = [];
  let ended = -1;
  for (let at = 0; at < frames; at += block) {
    const going = p.block(block, (note) => events.push([at, 'on', note]), (note) => events.push([at, 'off', note]));
    if (!going && ended < 0) ended = at;
  }
  return { events, ended };
}

describe('the phrases', () => {
  it('every phrase is offered and plays at velocity 100', () => {
    for (const { kind } of PHRASES) {
      const p = makePhrase(kind, 60);
      expect(p.notes.length).toBeGreaterThan(0);
      expect(p.notes.every((n) => n.vel === PHRASE_VEL && n.at + n.len <= p.length)).toBe(true);
    }
  });

  it('the root is a note and an octave, C4 = 60', () => {
    expect(rootNote(0, 4)).toBe(60);
    expect(rootNote(9, 3)).toBe(57);
    expect(makePhrase('held', rootNote(2, 5)).notes.map((n) => n.note)).toEqual([74]);
    expect(makePhrase('chord', 60).notes.map((n) => n.note)).toEqual([60, 64, 67]);
  });

  it('the sweep crosses four octaves around the root and stays within MIDI', () => {
    const notes = makePhrase('sweep', 60).notes.map((n) => n.note);
    expect(Math.min(...notes)).toBe(36);
    expect(Math.max(...notes)).toBe(84);
    const low = makePhrase('sweep', 12).notes.map((n) => n.note);
    expect(Math.min(...low)).toBe(0);
  });

  it('the drum pattern plays every row of the first Drum map, and ignores the root', () => {
    const kit = PRESETS['808 Kit']();
    const rows = drumNotes(kit);
    const map = kit.modules.find((m) => m.type === 'drummap')!;
    expect(rows).toEqual(DRUM_MAP_DEFAULT.map((d, r) => map.params[`n${r + 1}`] ?? d.note));
    const notes = new Set(makePhrase('drums', 60, rows).notes.map((n) => n.note));
    expect([...notes].sort()).toEqual([...new Set(rows)].sort());
    expect(makePhrase('drums', 30, rows)).toEqual(makePhrase('drums', 90, rows));
  });

  it('without a Drum map the drum pattern plays the default rows', () => {
    expect(drumNotes({ modules: [] })).toEqual(DRUM_MAP_DEFAULT.map((d) => d.note));
  });
});

describe('PhrasePlayer', () => {
  const sr = 1000; // (one frame a millisecond: easy arithmetic)

  it('gives each note in the block it falls in, and the same every time', () => {
    const phrase: Phrase = { kind: 'held', notes: [{ at: 0.3, len: 0.5, note: 60, vel: 1 }], length: 1 };
    const a = play(phrase, false, sr, 2000, 100);
    expect(a.events).toEqual([[300, 'on', 60], [800, 'off', 60]]);
    expect(play(phrase, false, sr, 2000, 100)).toEqual(a);
  });

  it('played once, it ends after its length and says so once', () => {
    const phrase: Phrase = { kind: 'held', notes: [{ at: 0, len: 0.2, note: 60, vel: 1 }], length: 1 };
    const { events, ended } = play(phrase, false, sr, 3000, 100);
    expect(ended).toBe(900);   // (the block holding frame 1000's start: 900..999 is the last of the pass)
    expect(events.filter((e) => e[1] === 'on')).toHaveLength(1);
    expect(PhrasePlayer.frames(phrase, 44100)).toBe((1 + PHRASE_TAIL) * 44100);
  });

  it('looped, each pass starts exactly a length after the last, across block edges', () => {
    const phrase: Phrase = { kind: 'staccato', notes: [{ at: 0, len: 0.1, note: 60, vel: 1 }], length: 0.25 };
    const { events, ended } = play(phrase, true, sr, 1000, 128);
    expect(ended).toBe(-1);
    // passes at 0, 250, 500, 750, 1000 land in the blocks starting 0, 128, 384, 640, 896
    expect(events.filter((e) => e[1] === 'on').map((e) => e[0])).toEqual([0, 128, 384, 640, 896]);
  });

  it('a pass that starts while a note still sounds lets it go first', () => {
    const phrase: Phrase = { kind: 'held', notes: [{ at: 0, len: 2, note: 60, vel: 1 }], length: 1 };
    const { events } = play(phrase, true, sr, 1500, 100);
    expect(events).toEqual([[0, 'on', 60], [1000, 'off', 60], [1000, 'on', 60]]);
  });

  it('two rows on one key: the second hit lets the first go, then sounds', () => {
    const phrase: Phrase = { kind: 'drums', notes: [{ at: 0, len: 0.5, note: 36, vel: 1 }, { at: 0.1, len: 0.1, note: 36, vel: 1 }], length: 1 };
    const { events } = play(phrase, false, sr, 1000, 50);
    expect(events).toEqual([[0, 'on', 36], [100, 'off', 36], [100, 'on', 36], [200, 'off', 36]]);
  });

  it('release lets go of what it holds', () => {
    const p = new PhrasePlayer(makePhrase('chord', 60), true, sr);
    p.block(10, () => {}, () => {});
    const off: number[] = [];
    p.release((n) => off.push(n));
    expect(off.sort()).toEqual([60, 64, 67]);
  });
});

describe('TakeRecorder', () => {
  it('a pause of TAKE_GAP with no note held starts a new take; a shorter one does not', () => {
    const t = new TakeRecorder();
    t.on(60, 1, 0); t.off(60, 1);
    t.on(62, 1, 1 + TAKE_GAP - 0.1); t.off(62, 4);
    expect(t.take(10)!.map((n) => n.note)).toEqual([60, 62]);
    t.on(64, 1, 4 + TAKE_GAP); t.off(64, 7);
    expect(t.take(10)!.map((n) => n.note)).toEqual([64]);
  });

  it('a note still held lasts until the take is taken; a note played again ends the one before', () => {
    const t = new TakeRecorder();
    t.on(60, 0.5, 10);
    t.on(60, 0.6, 10.5);
    expect(t.take(11)).toEqual([{ at: 0, len: 0.5, note: 60, vel: 0.5 }, { at: 0.5, len: 0.5, note: 60, vel: 0.6 }]);
  });

  it('keeps the newest notes of a long run', () => {
    const t = new TakeRecorder();
    for (let i = 0; i < TAKE_MAX_NOTES + 10; i++) (t.on(60, 1, i * 0.1), t.off(60, i * 0.1 + 0.05));
    expect(t.take(1000)).toHaveLength(TAKE_MAX_NOTES);
    expect(new TakeRecorder().take(0)).toBeNull();
  });

  it('My take loops at its end rounded up to the beat', () => {
    expect(takePhrase([{ at: 0, len: 1.1, note: 60, vel: 1 }]).length).toBe(1.5);
    expect(takePhrase([{ at: 0, len: 1, note: 60, vel: 1 }]).length).toBe(1);
    expect(takePhrase([{ at: 0, len: 0, note: 60, vel: 1 }]).length).toBe(0.5);
  });
});
