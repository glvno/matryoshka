// SPDX-License-Identifier: GPL-3.0-only
// A step's riff: a loop of notes once read from a MIDI file by the lesson editor for the Riff button, which is gone (D-663).
// A course that stores one still loads: the course loader checks its shape (riffProblem) and the editor saves it as it is;
// nothing plays it.

/** [start beat, length in beats, MIDI note, velocity 1..127] */
export type RiffNote = [number, number, number, number];

export interface Riff {
  /** the file it came from, for the editor */
  name: string;
  bpm: number;
  /** the loop length in beats: whole bars, at least the last note's end */
  beats: number;
  notes: RiffNote[];
}

export const RIFF_MAX_NOTES = 1024;
export const RIFF_MAX_BEATS = 256;
const BPM_MIN = 20, BPM_MAX = 400;

/** the shape check the course loader uses; returns what is wrong, or '' */
export function riffProblem(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected a riff object';
  const r = v as Record<string, unknown>;
  if (typeof r.name !== 'string') return 'expected a name';
  if (typeof r.bpm !== 'number' || !(r.bpm >= BPM_MIN && r.bpm <= BPM_MAX)) return `expected a tempo of ${BPM_MIN}..${BPM_MAX} bpm`;
  if (typeof r.beats !== 'number' || !(r.beats > 0 && r.beats <= RIFF_MAX_BEATS)) return `expected a length of 1..${RIFF_MAX_BEATS} beats`;
  if (!Array.isArray(r.notes) || !r.notes.length || r.notes.length > RIFF_MAX_NOTES) return `expected 1..${RIFF_MAX_NOTES} notes`;
  for (const n of r.notes) {
    if (!Array.isArray(n) || n.length !== 4 || !n.every((x) => typeof x === 'number' && Number.isFinite(x))) return 'expected notes as [start, length, note, velocity]';
    const [t, d, note, vel] = n as number[];
    if (t < 0 || t >= r.beats || d <= 0 || note < 0 || note > 127 || vel < 1 || vel > 127) return 'a note is outside the loop or the MIDI range';
  }
  return '';
}
