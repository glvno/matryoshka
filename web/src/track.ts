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
  /** the step it starts on (0..STEPS_MAX - 1) and how many steps it lasts (1..STEPS_MAX - at; cut at the track's len) */
  at: number;
  len: number;
  /** MIDI note (60 = C4) and velocity (1..127) */
  note: number;
  vel: number;
  /** percent, 5..100 in steps of 5 (each time round the pattern a hash decides; modules.ts notePlays); absent = 100 */
  chance?: number;
}

const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
};

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
    const n: StepNote = { at, len: int(o.len, 1, STEPS_MAX - at) ?? 1, note, vel: int(o.vel, 1, 127) ?? STEP_VEL };
    const chance = fixChance(o.chance);
    if (chance !== undefined) n.chance = chance;
    out.push(n);
  }
  out.sort(order);
  const kept = out.filter((n, i) => i === 0 || n.at !== out[i - 1].at || n.note !== out[i - 1].note).slice(0, TRACK_NOTES_MAX);
  return kept.length ? kept : undefined;
}

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
 * 19..25 the velocity, 26..30 the chance code (100 - chance) / 5 */
export const noteWord = (n: StepNote): number =>
  (n.at | ((n.len - 1) << 6) | (n.note << 12) | (n.vel << 19) | (((100 - (n.chance ?? 100)) / 5) << 26)) >>> 0;
export function wordNote(w: number): StepNote {
  const n: StepNote = { at: w & 63, len: ((w >>> 6) & 63) + 1, note: (w >>> 12) & 127, vel: (w >>> 19) & 127 };
  const code = Math.min(19, (w >>> 26) & 31);
  if (code) n.chance = 100 - 5 * code;
  return n;
}

/** a step as the card's lanes and the SEQ page show it: on (notes start there; accent, chance, note and velocity are its
 * lowest note's), or tied (a note started before goes on through it) */
export interface StepView {
  on: boolean;
  accent: boolean;
  chance: number;
  tie: boolean;
  note: number;
  vel: number;
}

const covers = (n: StepNote, k: number): boolean => n.at < k && k < n.at + n.len;

export function stepView(notes: readonly StepNote[] | undefined, k: number): StepView {
  const first = notes?.find((n) => n.at === k);
  return {
    on: !!first,
    accent: first?.vel === ACCENT_VEL,
    chance: first?.chance ?? 100,
    tie: !first && !!notes?.some((n) => covers(n, k)),
    note: first?.note ?? STEP_NOTE,
    vel: first?.vel ?? STEP_VEL,
  };
}

/** the notes starting on step k */
export const notesAt = (notes: readonly StepNote[] | undefined, k: number): StepNote[] => notes?.filter((n) => n.at === k) ?? [];

/**
 * Step k edited as a step (the card's steps lane, the SEQ page): tie = the notes sounding on the step before go on through
 * it (the step's own notes give way; nothing sounding: no change). Otherwise a tied step is untied (the notes through it
 * end before it); on = a note there if it has none (C4, the default velocity), its notes get the chance and the accent
 * (full velocity; taking the accent away: the default velocity); off = its notes go. Returns the new list (undefined:
 * none left).
 */
export function setStep(notes: readonly StepNote[] | undefined, k: number, s: { on: boolean; accent: boolean; chance: number; tie?: boolean }): StepNote[] | undefined {
  let out = (notes ?? []).map((n) => ({ ...n }));
  if (s.tie) {
    const prev = out.filter((n) => n.at < k && n.at + n.len >= k);
    if (!prev.length) return fixNotes(out);
    out = out.filter((n) => n.at !== k);
    for (const n of prev) n.len = Math.max(n.len, k - n.at + 1);
    return fixNotes(out);
  }
  if (stepView(out, k).tie) for (const n of out) if (covers(n, k)) n.len = k - n.at;
  if (!s.on) return fixNotes(out.filter((n) => n.at !== k));
  const chance = fixChance(s.chance);
  const mine = out.filter((n) => n.at === k);
  if (!mine.length && out.length < TRACK_NOTES_MAX) out.push({ at: k, len: 1, note: STEP_NOTE, vel: s.accent ? ACCENT_VEL : STEP_VEL, ...(chance ? { chance } : {}) });
  for (const n of mine) {
    if (chance) n.chance = chance;
    else delete n.chance;
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

/** step k holds exactly these notes (step entry of a chord, #135): its own notes go (a note tied through it ends before it),
 * each key a note one step long at its velocity (1..127), the step's chance kept */
export function setChord(notes: readonly StepNote[] | undefined, k: number, keys: readonly { note: number; vel: number }[]): StepNote[] | undefined {
  const chance = stepView(notes, k).on ? stepView(notes, k).chance : 100;
  const out = setStep(notes, k, { on: false, accent: false, chance: 100 }) ?? [];
  for (const x of keys)
    if (out.length < TRACK_NOTES_MAX && k >= 0 && k < STEPS_MAX)
      out.push({ at: k, len: 1, note: Math.max(0, Math.min(127, Math.round(x.note))), vel: Math.max(1, Math.min(127, Math.round(x.vel))), ...(chance < 100 ? { chance } : {}) });
  return fixNotes(out);
}

/** live-recorded notes laid over a track (#135, overdub): a recorded note replaces one on the same step and key */
export function overdub(notes: readonly StepNote[] | undefined, add: readonly StepNote[]): StepNote[] | undefined {
  const kept = (notes ?? []).filter((n) => !add.some((a) => a.at === n.at && a.note === n.note));
  return fixNotes([...add, ...kept]);
}

/** a drum pattern from a string, a step per character: x a note (C4, the default velocity), X an accented one (full
 * velocity), anything else a rest (the factory kits, tests) */
export const patternNotes = (s: string): StepNote[] | undefined =>
  fixNotes([...s].flatMap((c, at) => (c === 'x' || c === 'X' ? [{ at, len: 1, note: STEP_NOTE, vel: c === 'X' ? ACCENT_VEL : STEP_VEL }] : [])));
