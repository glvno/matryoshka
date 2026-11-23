// SPDX-License-Identifier: GPL-3.0-only
// A Steps track's notes (#133): every note a start step, a length in steps, a MIDI note, a velocity and a chance, several
// per step (chords), stored sparsely (ModuleInst.notes, sorted by start, then note). The engines play them (modules.ts
// steps, engine.c m_steps), the binary carries them packed (noteWord), and the step view below is what the card's lanes
// and the FM-1's SEQ page edit: a step is on when notes start there, tied when a note started before goes on through it.
// engine.c (eng_steps_get / set / value / value_set) does the same edits on the device.

import { ARP_RATE_TICKS, ARP_RATES } from './arpeggiator';

/** a pattern is at most STEPS_MAX steps (the `len` parameter plays the first ones) */
export const STEPS_MAX = 64;
/** a Steps track holds at most this many notes, a patch at most DEVICE.notes (patchbin.ts) on the FM-1 */
export const TRACK_NOTES_MAX = 128;
/** a note's values when nothing gives them: C4 and the velocity the FM-1's keys send; an accent is full velocity */
export const STEP_NOTE = 60;
export const STEP_VEL = 100;
export const ACCENT_VEL = 127;

/** a track's rates: the Arpeggiator's, then 1/2 (÷8 at 1/16) and 1/64 (x4) appended, so a stored rate keeps its meaning
 * (#351). Pins, macro ranges, the morph and MIDI CC knobs reach the first seven only (ParamDef.top) */
export const STEPS_RATES = [...ARP_RATES, '1/2', '1/64'];
/** half ticks of the 24 ppqn clock per step of each rate (1/64 is a tick and a half; engine.c RATE_HT) */
export const STEPS_RATE_HT = [...ARP_RATE_TICKS.map((t) => 2 * t), 96, 3];
/** the rate a pin or macro range reaches at most (1/32), and the swing (%) they reach and the most a track takes */
export const STEPS_RATE_PIN_MAX = ARP_RATES.length - 1;
export const SWING_PIN_MAX = 75;
export const SWING_MAX = 80;

export interface StepNote {
  /** the step it starts on (0..STEPS_MAX - 1) and how many visited steps it lasts (1..STEPS_MAX; cut at the end of a traversal) */
  at: number;
  len: number;
  /** MIDI note (60 = C4) and velocity (1..127) */
  note: number;
  vel: number;
  /** percent, 5..100 in steps of 5 (each time round the pattern a hash decides; modules.ts notePlays); absent = 100. A note
   * with a trig condition (`cond`) has none */
  chance?: number;
  /** its trig condition (#674, format 60, D-830; COND_*): when it plays, instead of every time; absent = every time */
  cond?: number;
  /** its ratchet (#675, format 63): it plays this many times inside its step, 2..RATCHET_MAX, evenly spaced; absent = once */
  ratchet?: number;
  /** its micro timing (#677, format 63): played this many MICRO_STEPS-ths of a step late (negative: early), -MICRO_MAX..
   * MICRO_MAX; absent = on the step. A drone ignores its ratchet and micro timing */
  micro?: number;
  /** tied across the loop point (#384, format 50): its length runs on past the end of the pass into the next pass's first
   * steps instead of being cut there. With the most length (STEPS_MAX) it is a drone: it ties back onto its own step and
   * never starts again while it plays (isDrone). Absent = cut at the end of the pass */
  wrap?: boolean;
}

/** a drone (#384): a note tied across the loop point with the most length, which ties back onto itself */
export const isDrone = (n: StepNote): boolean => !!n.wrap && n.len >= STEPS_MAX;

/** does note n sound on step k without starting there, in grid order on a pattern of `len` steps: after its start, or
 * (tied across the loop point) on the first steps of the pattern its length runs on into. Without `len`, no wrap */
export function noteThrough(n: StepNote, k: number, len?: number): boolean {
  if (n.at < k && k < n.at + n.len) return true;
  if (!n.wrap || len === undefined || n.at >= len || k >= n.at) return false;
  return isDrone(n) || k < n.at + n.len - len;
}

/** note n made to end on step k of a pattern of `len` steps (k its last step), tied across the loop point when k comes
 * before its start; k on its start is one step */
export function endOn(n: StepNote, k: number, len: number): StepNote {
  const out: StepNote = { ...n, len: k >= n.at ? k - n.at + 1 : len - n.at + k + 1 };
  if (k < n.at) out.wrap = true;
  else delete out.wrap;
  return out;
}

/** note n cut to end just before step k (a note through k), or undefined when nothing of it is left */
export function cutBefore(n: StepNote, k: number, len: number): StepNote | undefined {
  if (k === n.at) return undefined;
  if (k > n.at) {
    const out: StepNote = { ...n, len: k - n.at };
    delete out.wrap;
    return out;
  }
  if (k > 0) return endOn(n, k - 1, len);
  const out: StepNote = { ...n, len: len - n.at };
  delete out.wrap;
  return out;
}

const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
};

/**
 * Trig conditions (#674, D-830), a note's `cond` as a byte: bit 6 (COND_NOT) its inverse, bits 3..5 B - 1 and bits 0..2
 * A - 1 for A:B (B 2..COND_B_MAX, A 1..B: it plays on pass A of every B passes of the pattern, counted from 1); with
 * bits 3..5 zero, bits 0..2 one of the others: FILL (while the performer holds FILL), PRE (the last condition its track
 * judged held), NEI (the last condition the track before it judged held), 1ST (the first pass). Passes count from the
 * track's start (the transport's, or a reset edge) and start again when it plays another pattern. A chance and every
 * condition but PRE and NEI set what PRE and NEI read next. engine.c steps_cond reads the same byte.
 */
export const COND_NOT = 0x40;
export const COND_FILL = 1;
export const COND_PRE = 2;
export const COND_NEI = 3;
export const COND_FIRST = 4;
export const COND_B_MAX = 8;
/** A:B as a condition byte */
export const condAB = (a: number, b: number): number => ((b - 1) << 3) | (a - 1);
/** a valid condition byte (one COND_ORDER holds) */
export const isCond = (c: unknown): c is number => {
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 0x7f) return false;
  const b = (c >> 3) & 7, a = c & 7;
  return b ? a <= b : a >= COND_FILL && a <= COND_FIRST;
};
/** the conditions in the order a knob steps through them (the FM-1's K4 on a held step, the editor's menus): none, FILL,
 * NOT FILL, PRE, NOT PRE, NEI, NOT NEI, 1ST, NOT 1ST, then 1:2, 2:2, 1:3 .. 8:8, then NOT 1:2 .. NOT 8:8 (engine.c
 * cond_at, the same order) */
export const COND_ORDER: readonly number[] = [
  0,
  ...[COND_FILL, COND_PRE, COND_NEI, COND_FIRST].flatMap((k) => [k, k | COND_NOT]),
  ...[0, COND_NOT].flatMap((not) => Array.from({ length: COND_B_MAX - 1 }, (_, i) => i + 2).flatMap((b) => Array.from({ length: b }, (_, a) => not | condAB(a + 1, b)))),
];
/** a condition's name as the FM-1 and the editor write it: FILL, NOT 1ST, 3:4, NOT 1:2; '' for none */
export function condName(c: number | undefined): string {
  if (!c || !isCond(c)) return '';
  const b = (c >> 3) & 7, a = c & 7;
  return (c & COND_NOT ? 'NOT ' : '') + (b ? `${a + 1}:${b + 1}` : ['', 'FILL', 'PRE', 'NEI', '1ST'][a]);
}

/** a note's ratchet (#675) and micro timing (#677): the most times a note plays inside its step, and micro timing in
 * MICRO_STEPS-ths of a step either way, at most MICRO_MAX (the Elektron machines' range at 1/16: 23/384 of a bar) */
export const RATCHET_MAX = 5;
export const MICRO_STEPS = 24;
export const MICRO_MAX = 23;
/** a note plays off its step's start or more than once: it carries a timing word (noteWords) */
export const hasTiming = (n: StepNote): boolean => (n.ratchet ?? 1) > 1 || !!n.micro;
/** micro timing as the FM-1 and the editor write it: +5/24, -3/24; '' for none */
export const microName = (m: number | undefined): string => (m ? `${m > 0 ? '+' : ''}${m}/${MICRO_STEPS}` : '');

/** a chance as stored: 5..100 in steps of 5, undefined for 100 */
const fixChance = (v: unknown): number | undefined => {
  const c = v === undefined || v === null ? 100 : int(v, 5, 100);
  const r = c === null ? 100 : Math.max(5, Math.min(100, Math.round(c / 5) * 5));
  return r < 100 ? r : undefined;
};

/** notes in their stored order: by start step, then note */
const order = (a: StepNote, b: StepNote): number => a.at - b.at || a.note - b.note;

/** a track's notes from anything: valid, sorted, one note per start step and key (the first kept), at most
 * TRACK_NOTES_MAX; undefined when there are none */
export function fixNotes(raw: unknown): StepNote[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StepNote[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const at = int(o.at, 0, STEPS_MAX - 1), note = int(o.note, 0, 127);
    if (at === null || note === null || Number(o.at) < 0 || Number(o.at) >= STEPS_MAX) continue;
    const n: StepNote = { at, len: int(o.len, 1, STEPS_MAX) ?? 1, note, vel: int(o.vel, 1, 127) ?? STEP_VEL };
    const cond = isCond(o.cond) && o.cond ? o.cond : undefined;
    const chance = cond ? undefined : fixChance(o.chance);
    if (chance !== undefined) n.chance = chance;
    if (cond) n.cond = cond;
    const ratchet = int(o.ratchet, 1, RATCHET_MAX), micro = int(o.micro, -MICRO_MAX, MICRO_MAX);
    if (ratchet !== null && ratchet > 1) n.ratchet = ratchet;
    if (micro) n.micro = micro;
    if (o.wrap === true) n.wrap = true;
    out.push(n);
  }
  out.sort(order);
  const kept: StepNote[] = [];
  let words = 0;
  for (const [i, n] of out.entries()) {
    if (i > 0 && n.at === out[i - 1].at && n.note === out[i - 1].note) continue;
    if ((words += noteSize(n)) > TRACK_NOTES_MAX) break;
    kept.push(n);
  }
  return kept.length ? kept : undefined;
}

/** the words one note takes in the binary (noteWords): the note, its condition word, its timing word */
const noteSize = (n: StepNote): number => 1 + (n.cond ? 1 : 0) + (hasTiming(n) ? 1 : 0);
/** the words a track's notes take in the binary (noteWords: a note with a condition or a timing word takes more than one),
 * what TRACK_NOTES_MAX and DEVICE.notes count */
export const wordCount = (notes: readonly StepNote[] | undefined): number => (notes ?? []).reduce((k, n) => k + noteSize(n), 0);

/**
 * The notes of a pattern saved before #133 (patch format 30 and older): a step byte per step (bit 0 on, bit 1 accent,
 * bits 2..6 the chance code c = (100 - chance) / 5, bit 7 tie) and the per-step note / velocity lanes. An on step is a
 * note at its stored note and velocity (accented: full velocity) with its chance; a run of tied steps after it makes that
 * note longer; a tie after an off step (or on the first step) is dropped (it played nothing).
 */
export function migrateSteps(steps: unknown, notes?: unknown, vels?: unknown): StepNote[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  const lane = (l: unknown, k: number, dflt: number, lo: number): number => (Array.isArray(l) ? int(l[k], lo, 127) ?? dflt : dflt);
  const out: StepNote[] = [];
  let cur: StepNote | null = null;
  for (let k = 0; k < STEPS_MAX; k++) {
    const b = Number.isFinite(Number(steps[k])) ? Number(steps[k]) & 0xff : 0;
    if (b & 0x80) {
      if (cur) cur.len = k - cur.at + 1;
    } else if (b & 1) {
      cur = { at: k, len: 1, note: lane(notes, k, STEP_NOTE, 0), vel: b & 2 ? ACCENT_VEL : lane(vels, k, STEP_VEL, 1) };
      const code = Math.min(19, (b >> 2) & 31);
      if (code) cur.chance = 100 - 5 * code;
      out.push(cur);
    } else cur = null;
  }
  return fixNotes(out);
}

/** a note in the binary (patchbin.ts, engine.c): u32 LE, bits 0..5 the start, 6..11 the length - 1, 12..18 the note,
 * 19..25 the velocity, 26..30 the chance code (100 - chance) / 5, bit 31 tied across the loop point (NOTE_WRAP, format 50).
 * A note with a trig condition (format 60, #674) has chance code NOTE_COND, and its condition word follows it: a word of
 * velocity 0 with the note's start and note, the condition in bits 6..11 (its low six bits) and 26 (bit 6). A note with
 * a ratchet or micro timing (format 63, #675, #677) is followed by its timing word, after the condition word if it has
 * one: velocity 0, the note's start and note, bit 31 set, micro timing + 32 in bits 6..11, the ratchet - 1 in bits 26..28.
 * engine.c keeps the words as they are (ENG_NOTE_COND, ENG_TIME_WORD) */
export const NOTE_WRAP = 0x80000000;
export const NOTE_COND = 31;
export const noteWord = (n: StepNote): number =>
  ((n.at | ((n.len - 1) << 6) | (n.note << 12) | (n.vel << 19) | ((n.cond ? NOTE_COND : (100 - (n.chance ?? 100)) / 5) << 26)) >>> 0) + (n.wrap ? NOTE_WRAP : 0);
/** a note's condition word (its note's start and note, velocity 0) */
export const condWord = (n: StepNote): number => (n.at | ((n.cond! & 63) << 6) | (n.note << 12) | (((n.cond! >> 6) & 1) << 26)) >>> 0;
/** a note's timing word (its note's start and note, velocity 0, bit 31) */
export const timeWord = (n: StepNote): number => ((n.at | (((n.micro ?? 0) + 32) << 6) | (n.note << 12) | (((n.ratchet ?? 1) - 1) << 26)) >>> 0) + NOTE_WRAP;
/** a track's notes as words: each note, after a note with a condition its condition word, then its timing word */
export const noteWords = (notes: readonly StepNote[] | undefined): number[] =>
  (notes ?? []).flatMap((n) => [noteWord(n), ...(n.cond ? [condWord(n)] : []), ...(hasTiming(n) ? [timeWord(n)] : [])]);
export function wordNote(w: number): StepNote {
  const n: StepNote = { at: w & 63, len: ((w >>> 6) & 63) + 1, note: (w >>> 12) & 127, vel: (w >>> 19) & 127 };
  const code = Math.min(19, (w >>> 26) & 31);
  if (code && ((w >>> 26) & 31) !== NOTE_COND) n.chance = 100 - 5 * code;
  if (w & NOTE_WRAP) n.wrap = true;
  return n;
}
/** words back into notes: a condition word gives the note before it (the same start and note, chance code NOTE_COND) its
 * condition, a timing word after the note (or after its condition word) its ratchet and micro timing; one anywhere else
 * is dropped */
export function wordsNotes(words: readonly number[]): StepNote[] {
  const out: StepNote[] = [];
  const extra = (w: number, i: number): number | undefined => {
    const c = words[i] >>> 0;
    return i < words.length && !((c >>> 19) & 127) && (c & 0x7f03f) === (w & 0x7f03f) ? c : undefined;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] >>> 0;
    if (!((w >>> 19) & 127)) continue;
    const n = wordNote(w);
    let c = extra(w, i + 1);
    if (((w >>> 26) & 31) === NOTE_COND && c !== undefined && !(c & NOTE_WRAP)) {
      const cond = ((c >>> 6) & 63) | (((c >>> 26) & 1) << 6);
      if (isCond(cond) && cond) n.cond = cond;
      c = extra(w, ++i + 1);
    }
    if (c !== undefined && c & NOTE_WRAP) {
      const ratchet = Math.min(RATCHET_MAX, ((c >>> 26) & 7) + 1), micro = Math.max(-MICRO_MAX, Math.min(MICRO_MAX, ((c >>> 6) & 63) - 32));
      if (ratchet > 1) n.ratchet = ratchet;
      if (micro) n.micro = micro;
      i++;
    }
    out.push(n);
  }
  return out;
}

/** a step as the card's lanes and the SEQ page show it: on (notes start there; accent, chance, condition, note and velocity
 * are its lowest note's), or tied (a note started before goes on through it) */
export interface StepView {
  on: boolean;
  accent: boolean;
  chance: number;
  /** its trig condition (0: none) */
  cond: number;
  /** its ratchet (1: once) and micro timing (0: on the step) */
  ratchet: number;
  micro: number;
  tie: boolean;
  note: number;
  vel: number;
}

export function stepView(notes: readonly StepNote[] | undefined, k: number, len?: number): StepView {
  const first = notes?.find((n) => n.at === k);
  return {
    on: !!first,
    accent: first?.vel === ACCENT_VEL,
    chance: first?.chance ?? 100,
    cond: first?.cond ?? 0,
    ratchet: first?.ratchet ?? 1,
    micro: first?.micro ?? 0,
    tie: !first && !!notes?.some((n) => noteThrough(n, k, len)),
    note: first?.note ?? STEP_NOTE,
    vel: first?.vel ?? STEP_VEL,
  };
}

/** the notes `which` picks take condition `cond` (0: none; it takes their chance away) */
export function setCond(notes: readonly StepNote[] | undefined, which: (n: StepNote) => boolean, cond: number): StepNote[] | undefined {
  return fixNotes((notes ?? []).map((n) => {
    if (!which(n)) return n;
    const out: StepNote = { ...n };
    delete out.chance;
    if (cond && isCond(cond)) out.cond = cond;
    else delete out.cond;
    return out;
  }));
}

/** the notes `which` picks take a ratchet (1..RATCHET_MAX) and / or micro timing (-MICRO_MAX..MICRO_MAX); a value left out
 * stays as it is */
export function setTiming(notes: readonly StepNote[] | undefined, which: (n: StepNote) => boolean, t: { ratchet?: number; micro?: number }): StepNote[] | undefined {
  return fixNotes((notes ?? []).map((n) => {
    if (!which(n)) return n;
    const out: StepNote = { ...n };
    if (t.ratchet !== undefined) out.ratchet = t.ratchet;
    if (t.micro !== undefined) out.micro = t.micro;
    if ((out.ratchet ?? 1) <= 1) delete out.ratchet;
    if (!out.micro) delete out.micro;
    return out;
  }));
}

/** the notes starting on step k */
export const notesAt = (notes: readonly StepNote[] | undefined, k: number): StepNote[] => notes?.filter((n) => n.at === k) ?? [];

/**
 * The row drone (#384, D-819; LFO + FX on the FM-1's SEQ page, Shift+L in the piano roll): the row's first note (the
 * notes of pitch `note`, the earliest start) becomes a drone and the row's other notes go. A row that is one drone
 * already becomes an ordinary one-step note on that step again (the notes taken away come back only through undo).
 * undefined: the row has no notes (the FM-1 says NOTHING TO DRONE)
 */
export function droneRow(notes: readonly StepNote[] | undefined, note: number): { notes: StepNote[] | undefined; say: 'DRONE' | 'DRONE OFF' } | undefined {
  const row = (notes ?? []).filter((n) => n.note === note);
  if (!row.length) return undefined;
  const first = row.reduce((a, n) => (n.at < a.at ? n : a));
  const rest = (notes ?? []).filter((n) => n.note !== note);
  if (row.length === 1 && isDrone(first)) return { notes: fixNotes([...rest, one(first)]), say: 'DRONE OFF' };
  return { notes: fixNotes([...rest, { ...first, len: STEPS_MAX, wrap: true }]), say: 'DRONE' };
}

/** a note one step long, not tied across the loop point */
const one = (n: StepNote): StepNote => {
  const out: StepNote = { ...n, len: 1 };
  delete out.wrap;
  return out;
};

/**
 * Step k edited as a step (the card's steps lane): tie = the notes sounding on the step before (for the first step, on the
 * pattern's last: across the loop point, #384) go on through it, the step's own notes give way; a note that would tie
 * onto its own start becomes a drone, and a drone tied there again is one step (nothing sounding: no change). Otherwise a tied step is untied (the notes through it end before it); on = a note there if it has none
 * (C4, the default velocity), its notes get the chance and the accent (full velocity; taking the accent away: the default
 * velocity); off = its notes go. `len`: the pattern's length (ties across the loop point; without it, none). Returns the
 * new list (undefined: none left).
 */
export function setStep(notes: readonly StepNote[] | undefined, k: number, s: { on: boolean; accent: boolean; chance: number; tie?: boolean }, len = STEPS_MAX): StepNote[] | undefined {
  let out = (notes ?? []).map((n) => ({ ...n }));
  if (s.tie) {
    const j = k > 0 ? k - 1 : len - 1;
    const prev = out.filter((n) => (n.at === j || noteThrough(n, j, len)) && !noteThrough(n, k, len));
    if (!prev.length) return fixNotes(out);
    const drone = prev.every((n) => n.at === k && isDrone(n));
    out = out.filter((n) => n.at !== k || prev.includes(n)).map((n) => {
      if (!prev.includes(n)) return n;
      if (n.at === k) return drone ? one(n) : { ...n, len: STEPS_MAX, wrap: true };
      return k > n.at ? { ...n, len: Math.max(n.len, k - n.at + 1) } : endOn(n, k, len);
    });
    return fixNotes(out);
  }
  if (stepView(out, k, len).tie) out = out.flatMap((n) => (noteThrough(n, k, len) ? cutBefore(n, k, len) ?? [] : [n]));
  if (!s.on) return fixNotes(out.filter((n) => n.at !== k));
  const chance = fixChance(s.chance);
  const mine = out.filter((n) => n.at === k);
  if (!mine.length && out.length < TRACK_NOTES_MAX) out.push({ at: k, len: 1, note: STEP_NOTE, vel: s.accent ? ACCENT_VEL : STEP_VEL, ...(chance ? { chance } : {}) });
  for (const n of mine) {
    if (chance) {
      n.chance = chance;
      delete n.cond;
    } else delete n.chance;
    if (s.accent) n.vel = ACCENT_VEL;
    else if (n.vel === ACCENT_VEL) n.vel = STEP_VEL;
  }
  return fixNotes(out);
}

/** step k's note and velocity (the card's note / vel lanes, a held step + K1 / K2 on the FM-1): its notes move together so
 * the lowest is `note` (a chord keeps its shape) and all get `vel`; a step without notes gets one (one step long) */
export function setStepValue(notes: readonly StepNote[] | undefined, k: number, note: number, vel: number): StepNote[] | undefined {
  const out = (notes ?? []).map((n) => ({ ...n }));
  note = Math.max(0, Math.min(127, Math.round(note)));
  vel = Math.max(1, Math.min(127, Math.round(vel)));
  const mine = out.filter((n) => n.at === k);
  if (!mine.length) {
    if (out.length < TRACK_NOTES_MAX && k >= 0 && k < STEPS_MAX) out.push({ at: k, len: 1, note, vel });
    return fixNotes(out);
  }
  const d = note - mine[0].note;
  for (const n of mine) {
    n.note = Math.max(0, Math.min(127, n.note + d));
    n.vel = vel;
  }
  return fixNotes(out);
}

/** step k holds exactly these notes (cursor entry of a chord, #135): its own notes go (a note tied through it ends before it),
 * each key a note one step long at its velocity (1..127), the step's chance, condition, ratchet and micro timing kept */
export function chordFits(notes: readonly StepNote[] | undefined, k: number, keys: readonly { note: number }[], len = STEPS_MAX): boolean {
  const kept = setStep(notes, k, { on: false, accent: false, chance: 100 }, len) ?? [];
  return kept.length + new Set(keys.map(x => x.note)).size <= TRACK_NOTES_MAX;
}
export function setChord(notes: readonly StepNote[] | undefined, k: number, keys: readonly { note: number; vel: number }[], len = STEPS_MAX): StepNote[] | undefined {
  const v = stepView(notes, k), chance = v.on ? v.chance : 100, cond = v.on ? v.cond : 0, ratchet = v.on ? v.ratchet : 1, micro = v.on ? v.micro : 0;
  const out = setStep(notes, k, { on: false, accent: false, chance: 100 }, len) ?? [];
  for (const x of keys)
    if (out.length < TRACK_NOTES_MAX && k >= 0 && k < STEPS_MAX)
      out.push({ at: k, len: 1, note: Math.max(0, Math.min(127, Math.round(x.note))), vel: Math.max(1, Math.min(127, Math.round(x.vel))), ...(chance < 100 ? { chance } : {}), ...(cond ? { cond } : {}), ...(ratchet > 1 ? { ratchet } : {}), ...(micro ? { micro } : {}) });
  return fixNotes(out);
}

/** live-recorded notes laid over a track (#135, overdub): a recorded note replaces one on the same step and key, keeping
 * its ratchet and micro timing (#675, #677; engine.c eng_steps_overdub, the same) */
export function overdub(notes: readonly StepNote[] | undefined, add: readonly StepNote[]): StepNote[] | undefined {
  const same = (a: StepNote, n: StepNote): boolean => a.at === n.at && a.note === n.note;
  const kept = (notes ?? []).filter((n) => !add.some((a) => same(a, n)));
  const timed = add.map((a) => {
    const o = notes?.find((n) => same(a, n));
    return o && hasTiming(o) ? { ...a, ...(o.ratchet ? { ratchet: o.ratchet } : {}), ...(o.micro ? { micro: o.micro } : {}) } : a;
  });
  return fixNotes([...timed, ...kept]);
}

/** a drum pattern from a string, a step per character: x a note (C4, the default velocity), X an accented one (full
 * velocity), anything else a rest (the factory kits, tests) */
export const patternNotes = (s: string): StepNote[] | undefined =>
  fixNotes([...s].flatMap((c, at) => (c === 'x' || c === 'X' ? [{ at, len: 1, note: STEP_NOTE, vel: c === 'X' ? ACCENT_VEL : STEP_VEL }] : [])));

/** the patterns a Steps track holds (pattern 1 is ModuleInst.notes, patterns 2.. are ModuleInst.patterns) and the songs a
 * patch holds (Main's `seq`): engine.c ENG_PATTERNS, ENG_SONGS, ENG_SONG_LEN */
export const PATTERNS_MAX = 64;
export const SONGS_MAX = 8;
export const SONG_LEN_MAX = 64;
/** a song entry's shift, in semitones either way */
export const SHIFT_MAX = 12;

/** a track's pattern 2..PATTERNS_MAX: its notes and, when set, its own length (1..STEPS_MAX) and rate (an index of
 * STEPS_RATES) instead of the track's `len` / `rate` */
export interface Pattern {
  notes?: StepNote[];
  len?: number;
  rate?: number;
  /** its P-locks (#524; pattern 1's are ModuleInst.locks) */
  locks?: StepLock[];
}
/** a song entry: the pattern it plays (0-based) and its shift in semitones (never applied to a track that plays a Drum map) */
export interface SongEntry { pat: number; shift: number }
/** the patch's pattern and songs (Main's `seq`): the selected pattern (0-based, saved), the song playing (0: none, the
 * selected pattern plays; 1..SONGS_MAX), the songs */
export interface SeqState {
  pattern?: number;
  song?: number;
  songs?: SongEntry[][];
  /** the editor names the patterns as the TB-303 does (I-A1 .. IV-B8: patternName), not P01 .. P64; editor only, never in
   * the binary (the FM-1 shows P01 ..) */
  names?: '303';
  /** patterns 2..64 linked to the FM-1's pattern store (#901, format 59), by pattern index (1..63): the stored pattern's id
   * and its payload hash as the store holds it (pattern-store.ts). The pattern's notes stay in the patch too; while its
   * payload hash equals `hash` the binary carries only the reference (patchbin.ts linkPlan). A link belongs to one FM-1's
   * store, so what leaves the editor (share links, files, Community) carries every pattern inside and no link
   * (pattern-store.ts portablePatch, G2 of #1202); the browser's own copy keeps them */
  links?: Record<number, PatternLink>;
}
/** a pattern's link to a stored pattern: its id (1..LINK_ID_MAX) and payload hash (u32) */
export interface PatternLink { id: number; hash: number }
/** the first id above the store's user ids (patstore.c PT_ID_MAX): the legacy factory patterns' ids start here (the 808
 * Kit's and 909 Kit's patterns, read-only entries up to 1.25; pattern-store.ts resolves an old link to one from
 * factory-store.json, a 1.26 FM-1 copies them into its store, #1202 G8) */
export const READ_ONLY_ID = 0xe000;
/** the highest id a link takes (engine.h ENG_LINK_ID_MAX): the store's user ids and the legacy factory patterns */
export const LINK_ID_MAX = 0xefff;

/** pattern p (0-based) as the editor names it: P01 .. P64, or the TB-303's I-A1 .. IV-B8 (four groups of two sections of
 * eight) */
export function patternName(p: number, names?: '303'): string {
  if (names !== '303') return `P${String(p + 1).padStart(2, '0')}`;
  return `${['I', 'II', 'III', 'IV'][Math.floor(p / 16) % 4]}-${Math.floor((p % 16) / 8) ? 'B' : 'A'}${(p % 8) + 1}`;
}

/** a track's patterns 2.. from anything: null where the track has none (that pattern number plays its pattern 1), trailing
 * nulls dropped; undefined when it has none */
export function fixPatterns(raw: unknown): (Pattern | null)[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: (Pattern | null)[] = raw.slice(0, PATTERNS_MAX - 1).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const o = r as Record<string, unknown>;
    const p: Pattern = {};
    const notes = fixNotes(o.notes);
    if (notes) p.notes = notes;
    const len = o.len === undefined ? null : int(o.len, 1, STEPS_MAX);
    if (len !== null) p.len = len;
    const rate = o.rate === undefined ? null : int(o.rate, 0, STEPS_RATES.length - 1);
    if (rate !== null) p.rate = rate;
    const locks = fixLocks(o.locks);
    if (locks) p.locks = locks;
    return p;
  });
  while (out.length && out[out.length - 1] === null) out.pop();
  return out.length ? out : undefined;
}

/** the patch's pattern and songs from anything; undefined when they hold nothing (pattern 1, no song, no entries) */
export function fixSeq(raw: unknown): SeqState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: SeqState = {};
  const pattern = int(o.pattern, 0, PATTERNS_MAX - 1);
  if (pattern) out.pattern = pattern;
  const song = int(o.song, 0, SONGS_MAX);
  if (song) out.song = song;
  if (Array.isArray(o.songs)) {
    const songs = o.songs.slice(0, SONGS_MAX).map((s) => (Array.isArray(s) ? s : []).slice(0, SONG_LEN_MAX).flatMap((e): SongEntry[] => {
      if (!e || typeof e !== 'object') return [];
      const x = e as Record<string, unknown>;
      return [{ pat: int(x.pat, 0, PATTERNS_MAX - 1) ?? 0, shift: int(x.shift, -SHIFT_MAX, SHIFT_MAX) ?? 0 }];
    }));
    while (songs.length && !songs[songs.length - 1].length) songs.pop();
    if (songs.length) out.songs = songs;
  }
  if (o.names === '303') out.names = '303';
  const links = fixLinks(o.links);
  if (links) out.links = links;
  return Object.keys(out).length ? out : undefined;
}

/** a patch's pattern links from anything: index 1..63, id 1..LINK_ID_MAX, hash u32; undefined when none is left */
export function fixLinks(raw: unknown): Record<number, PatternLink> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<number, PatternLink> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = Number(k);
    if (!Number.isInteger(p) || p < 1 || p >= PATTERNS_MAX || !v || typeof v !== 'object') continue;
    const { id, hash } = v as Record<string, unknown>;
    if (!Number.isInteger(id) || (id as number) < 1 || (id as number) > LINK_ID_MAX) continue;
    if (!Number.isInteger(hash) || (hash as number) < 0 || (hash as number) > 0xffffffff) continue;
    out[p] = { id: id as number, hash: hash as number };
  }
  return Object.keys(out).length ? out : undefined;
}

/** a patch without its links to a pattern store (pattern-store.ts portablePatch: what leaves the editor carries its patterns
 * inside, #1202); the patch itself when it has none */
export function withoutLinks<P extends { modules: { type: string; seq?: SeqState }[] }>(p: P): P {
  if (!p.modules.some((m) => m.seq?.links)) return p;
  return { ...p, modules: p.modules.map((m) => {
    if (!m.seq?.links) return m;
    const { links: _l, ...seq } = m.seq;
    const { seq: _s, ...rest } = m;
    return Object.keys(seq).length ? { ...rest, seq } : rest;
  }) } as P;
}

/** pattern p (0-based) of a track as it plays: its notes, length and rate. A pattern the track has not got plays its
 * pattern 1 (`own` false); pattern 1 and a pattern without its own length / rate take the track's parameters */
export function patternOf(m: { notes?: StepNote[]; patterns?: (Pattern | null)[]; params: Record<string, number> }, p: number): { notes: StepNote[] | undefined; len: number; rate: number; own: boolean } {
  const x = p > 0 ? m.patterns?.[p - 1] ?? null : null;
  const len = Math.min(STEPS_MAX, Math.max(1, Math.round(m.params.len ?? 16)));
  const rate = Math.round(m.params.rate ?? 4);
  if (!x) return { notes: m.notes, len, rate, own: p === 0 };
  return { notes: x.notes, len: x.len ?? len, rate: x.rate ?? rate, own: true };
}

/** a short note word (format 48's patterns section, 16 bits): bits 0..3 the start, 4..7 the length - 1, 8..14 the note,
 * 15 the accent (full velocity, else the default velocity); for a pattern whose every note fits it (isShortNote) */
export const isShortNote = (n: StepNote): boolean => !n.wrap && n.at < 16 && n.len <= 16 && (n.vel === STEP_VEL || n.vel === ACCENT_VEL) && (n.chance ?? 100) === 100 && !n.cond && !hasTiming(n);
export const shortWord = (n: StepNote): number => n.at | ((n.len - 1) << 4) | (n.note << 8) | (n.vel === ACCENT_VEL ? 0x8000 : 0);
export const wordShort = (w: number): StepNote => ({ at: w & 15, len: ((w >> 4) & 15) + 1, note: (w >> 8) & 127, vel: w & 0x8000 ? ACCENT_VEL : STEP_VEL });
/** a pattern's words as the binary and the pattern store write them: short ones (u16) when every note fits one, else
 * noteWords (u32) */
export function patternWords(notes: readonly StepNote[] | undefined): { short: boolean; words: number[] } {
  const ns = notes ?? [];
  const short = ns.every(isShortNote);
  return { short, words: short ? ns.map(shortWord) : noteWords(ns) };
}

/**
 * A P-lock (#524, #519 Q1..Q5): on step `at` of a pattern, a row of the device the track plays (pages.ts Device.track: a
 * module's parameter, `module` its id, `param` its name) plays `value` (in the parameter's own units, as ModuleInst.params)
 * instead of its normal value. A step without a lock on that row plays the normal value: the device page's, or what a knob
 * set last. On a poly device a lock moves the whole device, every voice. Both engines apply a lock while the playhead is
 * on its step (engine.ts applyLocks, engine.c locks_step); the binary carries them in the locks section (patchbin.ts
 * lockRecord, format 49).
 */
export interface StepLock {
  at: number;
  module: number;
  param: string;
  value: number;
}
/** the most locks a pattern holds (#519 Q1: the FM-1's patch bytes); engine.c ENG_PAT_LOCKS */
export const LOCKS_MAX = 64;
/** the most rows one track locks, over all its patterns (engine.c ENG_LOCK_TARGETS counts them for the whole patch) */
export const LOCK_ROWS_MAX = 32;

const lockOrder = (a: StepLock, b: StepLock): number => a.at - b.at || a.module - b.module || (a.param < b.param ? -1 : a.param > b.param ? 1 : 0);

/** a pattern's locks from anything: valid, sorted by step, then row, one per step and row (the last kept), at most
 * LOCKS_MAX; undefined when there are none */
export function fixLocks(raw: unknown): StepLock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const by = new Map<string, StepLock>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const at = Number(o.at), module = Number(o.module), value = Number(o.value);
    if (!Number.isInteger(at) || at < 0 || at >= STEPS_MAX || !Number.isInteger(module) || module < 0 || typeof o.param !== 'string' || !o.param || !Number.isFinite(value)) continue;
    by.set(`${at}/${module}/${o.param}`, { at, module, param: o.param, value });
  }
  const out = [...by.values()].sort(lockOrder).slice(0, LOCKS_MAX);
  return out.length ? out : undefined;
}

/** the locks on step k */
export const locksAt = (locks: readonly StepLock[] | undefined, k: number): StepLock[] => locks?.filter((l) => l.at === k) ?? [];

/** step k's lock on a row set (value) or removed (null); undefined when none are left. A new lock past LOCKS_MAX is not
 * added (the list comes back unchanged) */
export function setLock(locks: readonly StepLock[] | undefined, k: number, module: number, param: string, value: number | null): StepLock[] | undefined {
  const out = (locks ?? []).filter((l) => !(l.at === k && l.module === module && l.param === param));
  if (value !== null) {
    if (out.length >= LOCKS_MAX) return fixLocks([...(locks ?? [])]);
    out.push({ at: k, module, param, value });
  }
  return fixLocks(out);
}

/** a track's locks of pattern p (0-based: pattern 1's are the module's own) */
export function patternLocks(m: { locks?: StepLock[]; patterns?: (Pattern | null)[] }, p: number): StepLock[] | undefined {
  return p > 0 ? m.patterns?.[p - 1]?.locks : m.locks;
}
