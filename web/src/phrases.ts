// SPDX-License-Identifier: GPL-3.0-only
// Test phrases (#945): fixed notes at a fixed tempo and velocity, so a sound is auditioned with the same input every time
// (a snapshot switch restarts the phrase), and "My take", the last run of notes the user played, kept as played. The browser
// engine plays them, scheduled in the audio thread (worklet.ts), and the WAV export renders them offline
// (phrase-render.ts, #946) through the same PhrasePlayer, so both hear the same blocks.
import { DRUM_MAP_DEFAULT } from './modules';
import type { Patch } from './patch';

export type BuiltinKind = 'held' | 'staccato' | 'chord' | 'sweep' | 'drums';
/** `take`: My take, the user's last take (TakeRecorder) */
export type PhraseKind = BuiltinKind | 'take';

/** one note of a phrase, in seconds from the phrase's start */
export interface PhraseNote {
  at: number;
  len: number;
  note: number;
  /** 0..1, as the keyboard sends it */
  vel: number;
}

export interface Phrase {
  kind: PhraseKind;
  notes: PhraseNote[];
  /** seconds from one pass's start to the next when it loops */
  length: number;
}

/** the phrases' tempo, whatever the patch's or the global tempo is */
export const PHRASE_BPM = 120;
/** every note's velocity (100 of 127) */
export const PHRASE_VEL = 100 / 127;
/** what a phrase played once (and its WAV) lets ring after its last pass, in seconds */
export const PHRASE_TAIL = 2;

export const PHRASES: readonly { kind: BuiltinKind; label: string; detail: string }[] = [
  { kind: 'held', label: 'Held note', detail: 'the root held for three seconds: attack, sustain and release' },
  { kind: 'staccato', label: 'Staccato hits', detail: 'eight short hits on the root, in eighths' },
  { kind: 'chord', label: 'Chord', detail: 'a major triad on the root, held for three seconds' },
  { kind: 'sweep', label: 'Across the range', detail: 'root and fifth up four octaves, from two below the root to two above' },
  { kind: 'drums', label: 'Drum pattern', detail: 'two bars on the first Drum map’s rows 1–8 (every row is heard)' },
];

/** the lowest and highest octave the root can be in (C1 = 24 .. C7 = 96; C4 = 60, middle C) */
export const ROOT_OCTAVES = [1, 2, 3, 4, 5, 6, 7] as const;
export const rootNote = (pitchClass: number, octave: number): number => (octave + 1) * 12 + pitchClass;

const beat = 60 / PHRASE_BPM;
const clampNote = (n: number): number => Math.max(0, Math.min(127, n));

/** the notes the first Drum map's rows 1..8 answer to (the Drum map the FM-1 names a track's rows after, D-634), else the
 *  default Drum map's */
export function drumNotes(p: Pick<Patch, 'modules'>): number[] {
  const map = p.modules.find((m) => m.type === 'drummap');
  return DRUM_MAP_DEFAULT.map((d, r) => clampNote(Math.round(map?.params[`n${r + 1}`] ?? d.note)));
}

/** a phrase on `root` (a MIDI note; the drum pattern ignores it and plays `drums`, the rows' notes) */
export function makePhrase(kind: BuiltinKind, root: number, drums: readonly number[] = drumNotes({ modules: [] })): Phrase {
  const n = (at: number, len: number, note: number): PhraseNote => ({ at, len, note: clampNote(note), vel: PHRASE_VEL });
  switch (kind) {
    case 'held': return { kind, notes: [n(0, 6 * beat, root)], length: 8 * beat };
    case 'staccato': return { kind, notes: Array.from({ length: 8 }, (_, i) => n(i * beat / 2, beat / 5, root)), length: 6 * beat };
    case 'chord': return { kind, notes: [0, 4, 7].map((d) => n(0, 6 * beat, root + d)), length: 8 * beat };
    case 'sweep': return { kind, notes: [-24, -17, -12, -5, 0, 7, 12, 19, 24].map((d, i) => n(i * beat / 2, beat * 0.4, root + d)), length: 6 * beat };
    case 'drums': {
      // 16ths over two bars: row 1 on the beats 1 and 3, row 2 on 2 and 4, row 3 on the eighths, row 4 on the last
      // eighth of bar 1; bar 2 ends with rows 5..8, one 16th each
      const step = beat / 4, out: PhraseNote[] = [];
      const hit = (s: number, row: number): void => { out.push(n(s * step, step / 2, drums[row])); };
      for (let bar = 0; bar < 2; bar++) {
        const s0 = bar * 16, last = bar === 1 ? 12 : 16;
        for (let s = 0; s < last; s++) {
          if (s % 8 === 0) hit(s0 + s, 0);
          if (s % 8 === 4) hit(s0 + s, 1);
          if (s % 2 === 0 && !(bar === 0 && s === 14)) hit(s0 + s, 2);
        }
        if (bar === 0) hit(14, 3);
        else for (let r = 4; r < 8; r++) hit(s0 + 8 + r, r);
      }
      return { kind, notes: out, length: 8 * beat };
    }
  }
}

/** seconds with no note held that end a take: the next note starts a new one */
export const TAKE_GAP = 2;
/** the notes a take keeps, the newest (a run longer than this keeps its end) */
export const TAKE_MAX_NOTES = 256;

/**
 * The notes the user plays (the computer keyboard, the on-screen keys, MIDI in), with their times and velocities, as the
 * latest take: a run of playing that a pause of TAKE_GAP with no note held ends. `now` is in seconds on any one clock.
 */
export class TakeRecorder {
  private notes: PhraseNote[] = [];
  private open = new Map<number, PhraseNote>();
  private freeSince = -Infinity;

  on(note: number, vel: number, now: number): void {
    if (!this.open.size && now - this.freeSince >= TAKE_GAP) this.notes = [];
    this.off(note, now);
    const n = { at: now, len: 0, note, vel };
    this.notes.push(n);
    this.open.set(note, n);
    if (this.notes.length > TAKE_MAX_NOTES) this.notes.shift();
  }

  off(note: number, now: number): void {
    const n = this.open.get(note);
    if (!n) return;
    n.len = now - n.at;
    this.open.delete(note);
    if (!this.open.size) this.freeSince = now;
  }

  /** the latest take from its first note (a note still held lasts until `now`); null: nothing played yet */
  take(now: number): PhraseNote[] | null {
    if (!this.notes.length) return null;
    const t0 = this.notes[0].at;
    return this.notes.map((n) => ({ at: n.at - t0, len: this.open.get(n.note) === n ? now - n.at : n.len, note: n.note, vel: n.vel }));
  }
}

/** My take as a phrase: the notes as played; it loops at its end rounded up to the next beat at PHRASE_BPM */
export function takePhrase(notes: readonly PhraseNote[]): Phrase {
  const end = Math.max(...notes.map((n) => n.at + n.len));
  return { kind: 'take', notes: notes.map((n) => ({ ...n })), length: Math.max(1, Math.ceil(end / beat - 1e-9)) * beat };
}

type Event = { frame: number; note: number; on: boolean; vel: number };

/**
 * Plays a phrase block by block: before each block, every note on or off that falls inside it. The worklet and the offline
 * render share it, so a WAV holds what the live phrase plays. A note already sounding is let go before it starts again
 * (two Drum map rows on one key), and a pass that loops starts again exactly `length` after the last.
 */
export class PhrasePlayer {
  private events: Event[];
  private len: number;
  /** frames since the start, the current pass's first frame, the next event of the pass */
  private pos = 0;
  private base = 0;
  private next = 0;
  private held = new Set<number>();
  done = false;

  constructor(phrase: Phrase, readonly loop: boolean, sr: number) {
    this.len = Math.max(1, Math.round(phrase.length * sr));
    this.events = phrase.notes.flatMap((x) => {
      const on = Math.round(x.at * sr);
      const off = Math.max(on + 1, Math.round((x.at + x.len) * sr));
      return [{ frame: on, note: x.note, on: true, vel: x.vel }, { frame: off, note: x.note, on: false, vel: 0 }];
    }).filter((e) => e.frame < this.len || !e.on).sort((a, b) => a.frame - b.frame || Number(a.on) - Number(b.on));
  }

  /** the frames a pass played once lasts, with the tail it rings on for */
  static frames(phrase: Phrase, sr: number): number {
    return Math.round((phrase.length + PHRASE_TAIL) * sr);
  }

  /** the notes due in the next `n` frames; false once a phrase that does not loop has played its pass */
  block(n: number, on: (note: number, vel: number) => void, off: (note: number) => void): boolean {
    if (this.done) return false;
    const end = this.pos + n;
    for (;;) {
      while (this.next < this.events.length && this.base + this.events[this.next].frame < end) {
        const e = this.events[this.next++];
        if (e.on) {
          if (this.held.has(e.note)) off(e.note);
          this.held.add(e.note);
          on(e.note, e.vel);
        } else if (this.held.delete(e.note)) off(e.note);
      }
      if (!this.loop || this.base + this.len >= end) break;
      // the next pass: the notes still held from this one end where it starts
      this.release(off);
      this.base += this.len;
      this.next = 0;
    }
    this.pos = end;
    if (!this.loop && this.next >= this.events.length && end >= this.base + this.len) {
      this.release(off);
      this.done = true;
    }
    return !this.done;
  }

  /** let go of every note it holds */
  release(off: (note: number) => void): void {
    for (const note of this.held) off(note);
    this.held.clear();
  }
}
