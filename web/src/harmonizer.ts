// SPDX-License-Identifier: GPL-3.0-only
// The Harmonizer module's note logic (keys in -> keys out, #598), the same in the firmware (engine.c harm_*): one key
// plays a whole chord on that root, after the Telepathic Instruments Orchid. It takes Main's keys on their way to a
// Voicing. Seven of the keys are chord buttons (the Side layout, after CoralFlower's for the same FM-1): the seven notes
// just under `split` (F3..B3 below C4), on the FM-1 its seven lowest keys whatever the octave. Every other key is a root.
// The black keys among the seven pick the chord's quality (maj, min, dim), the white ones add to it (sus2, sus4, 7, 9);
// buttons held together combine. With no button held (and none latched) the card's own chord plays (type, sus, ext;
// all none: the root alone). Lock on: the buttons pressed together stay latched until the next press of their kind (the
// chord buttons and the inversion keys latch apart, #1311); the only latched button of a kind, pressed again alone, lets
// it go. A root's chord is fixed when it goes down (RETRIG off): a button pressed while a root is held changes the next root's chord.
// `voicing` moves the chord through its inversions (each step up takes the lowest note an octave up; each step down the
// highest an octave down; the root alone stays). `invkeys` on (#1311): the three keys at split + 17..19 (F5, F♯5, G5
// above C4; on the FM-1 its three highest keys whatever the octave) are three more buttons, the 1st, 2nd and 3rd
// inversion: one in effect sets the inversion exactly, in place of `voicing` (two in effect: the one pressed last wins).
// `retrig` (OFF as made): ALL or DIFF re-form the held roots' chords as soon as what is set changes (harmRetrig).
// Its notes go out at once, in the same call (not at the next block): a note two held roots share sounds once and ends
// with the last of them.

/** the buttons by their place among the seven keys under the split (F F# G G# A A# B under C) */
export const HARM_BUTTONS = ['sus2', 'maj', 'sus4', 'min', '7', 'dim', '9'];
/** how many keys under the split are buttons */
export const HARM_ZONE = 7;
/** the inversion keys (`invkeys` on): buttons HARM_ZONE..HARM_ZONE + 2 are the 1st, 2nd and 3rd inversion, the keys at
 * split + HARM_INV_AT and the two above it (F5, F♯5, G5 above C4: the FM-1's three highest keys at octave 0) */
export const HARM_INV_KEYS = 3;
export const HARM_INV_AT = 17;
/** every button: the chord buttons, then the inversion keys */
export const HARM_ALL = HARM_ZONE + HARM_INV_KEYS;
const CHORD_BITS = (1 << HARM_ZONE) - 1;
const INV_BITS = ((1 << HARM_ALL) - 1) & ~CHORD_BITS;
/** the card's chord: its quality, its suspended or added 2nd / 4th, its 7th / 9th */
export const HARM_TYPES = ['none', 'maj', 'min', 'dim'];
export const HARM_SUS = ['none', 'sus2', 'sus4', 'sus2+4'];
export const HARM_EXT = ['none', '7', '9', '7+9'];
/** the `retrig` row: OFF a root's chord stays as it went down; ALL / DIFF re-form the held chords at once (harmRetrig) */
export const HARM_RETRIG = ['off', 'all', 'diff'];
/** the voicing's reach: inversions up or down */
export const HARM_VOICING = 8;
/** roots held at once (a further one is not played) */
export const HARM_ROOTS = 10;
/** the quality buttons (maj, min, dim) as bits of a button mask, in HARM_TYPES order after none */
const TYPE_BITS = [1 << 1, 1 << 3, 1 << 5];
const BIT_SUS2 = 1 << 0, BIT_SUS4 = 1 << 2, BIT_7 = 1 << 4, BIT_9 = 1 << 6;

export interface HarmParams {
  type: number;
  sus: number;
  ext: number;
  voicing: number;
  lock: number;
  split: number;
  /** the inversion keys on (0 / 1) */
  invkeys: number;
  /** RETRIG: 0 off, 1 all, 2 diff */
  retrig: number;
}

export interface HarmState {
  /** the buttons down (bit b: HARM_BUTTONS[b], then the inversion keys) */
  down: number;
  /** Lock: the buttons of the press under way (from the first button down to the last up), the latched set, and whether
   * the press is one button alone, the only latched one of its kind (let go, it unlatches) */
  gesture: number;
  locked: number;
  toggle: boolean;
  /** press order of the buttons (the quality pressed last wins over another held), and the counter */
  stamp: number[];
  clock: number;
  /** the roots held, oldest first: the key, the notes its chord started and its velocity */
  roots: { key: number; notes: number[]; vel: number }[];
  /** per note, how many held roots sound it */
  count: number[];
  /** MIDI note -> button at press time plus one, or zero (the split can move while a key is held) */
  buttonKeys: number[];
}

export const harmInit = (): HarmState => ({ down: 0, gesture: 0, locked: 0, toggle: false, stamp: Array(HARM_ALL).fill(0), clock: 0, roots: [], count: Array(128).fill(0), buttonKeys: Array(128).fill(0) });

const int = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));
const locks = (p: HarmParams): boolean => int(p.lock, 0, 1) === 1;

/** the button a note is (0..6 a chord button; with the inversion keys on, 7..9 an inversion key), -1 a root */
export function harmButtonOf(note: number, p: HarmParams): number {
  const split = int(p.split, 0, 127), b = note - (split - HARM_ZONE), i = note - (split + HARM_INV_AT);
  return b >= 0 && b < HARM_ZONE ? b : int(p.invkeys, 0, 1) === 1 && i >= 0 && i < HARM_INV_KEYS ? HARM_ZONE + i : -1;
}

/** the kinds of button among `bits`: CHORD_BITS if a chord button, INV_BITS if an inversion key */
const kinds = (bits: number): number => (bits & CHORD_BITS ? CHORD_BITS : 0) | (bits & INV_BITS ? INV_BITS : 0);

/** the buttons in effect: those held (Lock: of the press under way, and the latched ones of a kind it has none of),
 * else the latched ones (Lock on) */
export const harmButtons = (s: HarmState, p: HarmParams): number =>
  locks(p) ? (s.down ? s.gesture | (s.locked & ~kinds(s.gesture)) : s.locked) : s.down;

/** a chord button or an inversion key pressed or let go (an inversion key goes down only while `invkeys` is on) */
export function harmButton(s: HarmState, b: number, down: boolean, p: HarmParams): void {
  if (b < 0 || b >= HARM_ALL) return;
  const bit = 1 << b;
  if (down) {
    if (s.down & bit || (b >= HARM_ZONE && int(p.invkeys, 0, 1) !== 1)) return;
    s.stamp[b] = ++s.clock;
    if (!s.down) {
      s.gesture = bit;
      s.toggle = (s.locked & kinds(bit)) === bit;
    } else {
      s.gesture |= bit;
      s.toggle = false;
    }
    s.down |= bit;
  } else {
    if (!(s.down & bit)) return;
    s.down &= ~bit;
    if (!s.down && locks(p)) s.locked = s.toggle ? s.locked & ~s.gesture : s.gesture | (s.locked & ~kinds(s.gesture));
    if (!s.down) {
      s.gesture = 0;
      s.toggle = false;
    }
  }
}

/** the chord as intervals over the root, low to high, before the voicing: from the chord buttons in effect, else the card */
export function harmIntervals(s: HarmState, p: HarmParams): number[] {
  const bits = harmButtons(s, p) & CHORD_BITS;
  let type: number, sus2: boolean, sus4: boolean, sev: boolean, nine: boolean;
  if (bits) {
    type = 0;
    let at = -1;
    TYPE_BITS.forEach((t, i) => {
      const b = 2 * i + 1;
      if (bits & t && s.stamp[b] > at) {
        at = s.stamp[b];
        type = i + 1;
      }
    });
    sus2 = !!(bits & BIT_SUS2);
    sus4 = !!(bits & BIT_SUS4);
    sev = !!(bits & BIT_7);
    nine = !!(bits & BIT_9);
  } else {
    type = int(p.type, 0, 3);
    const su = int(p.sus, 0, 3), ex = int(p.ext, 0, 3);
    sus2 = !!(su & 1);
    sus4 = !!(su & 2);
    sev = !!(ex & 1);
    nine = !!(ex & 2);
  }
  if (!type && !sus2 && !sus4 && !sev && !nine) return [0];
  // the quality's third and fifth; without one, a sus chord (no third) or else a major one under the 7th / 9th
  const tones = type === 2 ? [0, 3, 7] : type === 3 ? [0, 3, 6] : type === 1 || !(sus2 || sus4) ? [0, 4, 7] : [0, 7];
  if (sus2) tones.push(2);
  if (sus4) tones.push(5);
  if (sev) tones.push(10);
  if (nine) tones.push(14);
  return tones.sort((a, b) => a - b);
}

/** the voicing applied: v steps up take the lowest note an octave up, v steps down the highest an octave down (a chord
 * only: the root alone stays where it is) */
export function harmVoice(tones: number[], voicing: number): number[] {
  const t = [...tones];
  if (t.length < 2) return t;
  const v = int(voicing, -HARM_VOICING, HARM_VOICING);
  for (let i = 0; i < v; i++) { t[0] += 12; t.sort((a, b) => a - b); }
  for (let i = 0; i < -v; i++) { t[t.length - 1] -= 12; t.sort((a, b) => a - b); }
  return t;
}

/** the inversion key in effect pressed last (1..3) while `invkeys` is on, 0 none */
export function harmInversion(s: HarmState, p: HarmParams): number {
  const bits = int(p.invkeys, 0, 1) === 1 ? harmButtons(s, p) : 0;
  let v = 0, at = 0;
  for (let i = 0; i < HARM_INV_KEYS; i++)
    if (bits & (1 << (HARM_ZONE + i)) && s.stamp[HARM_ZONE + i] > at) {
      at = s.stamp[HARM_ZONE + i];
      v = i + 1;
    }
  return v;
}

/** the inversion in effect: the inversion key's (harmInversion), else the `voicing` row */
export const harmVoicing = (s: HarmState, p: HarmParams): number => harmInversion(s, p) || int(p.voicing, -HARM_VOICING, HARM_VOICING);

/** the notes a root plays now, low to high, inside 0..127 */
export const harmChord = (s: HarmState, root: number, p: HarmParams): number[] =>
  harmVoice(harmIntervals(s, p), harmVoicing(s, p)).sort((a, b) => a - b).map((x) => root + x).filter((n) => n >= 0 && n <= 127);

const SNAP_INTERVALS = [0, 2, 3, 4, 5, 6, 7, 10, 14];
/** Transient live-input chord choice carried through Steps' block delay; never stored in a patch. */
export function harmSnapshot(s: HarmState, p: HarmParams): number {
  return 0x8000 | ((harmVoicing(s, p) + 8) << 9) | harmIntervals(s, p).reduce((bits, t) => bits | (1 << SNAP_INTERVALS.indexOf(t)), 0);
}
export function harmSnapshotChord(snapshot: number, root: number): number[] {
  return harmVoice(SNAP_INTERVALS.filter((_, i) => snapshot & (1 << i)), ((snapshot >> 9) & 31) - 8).map(n => root + n).filter(n => n >= 0 && n <= 127);
}

/** a root let go: the notes no other held root sounds end (`off`) */
export function harmRootOff(s: HarmState, key: number, off: (note: number) => void): void {
  const i = s.roots.findIndex((r) => r.key === key);
  if (i < 0) return;
  const [r] = s.roots.splice(i, 1);
  for (const n of r.notes) if (--s.count[n] === 0) off(n);
}

/** a root pressed (at velocity `vel`, which RETRIG's re-formed notes take too): its chord's notes that no held root
 * sounds yet start (`on`); one already held plays again */
export function harmRootOn(s: HarmState, key: number, p: HarmParams, on: (note: number) => void, off: (note: number) => void, room: (notes: number[]) => boolean = () => true, snapshot = 0, vel = 1): void {
  harmRootOff(s, key, off);
  if (s.roots.length >= HARM_ROOTS) return;
  const notes = snapshot ? harmSnapshotChord(snapshot, key) : harmChord(s, key, p);
  if (!room(notes)) return;
  s.roots.push({ key, notes, vel });
  for (const n of notes) if (s.count[n]++ === 0) on(n);
}

/**
 * RETRIG (`retrig` ALL or DIFF; OFF: nothing, a root's chord stays as it went down): when the chord a held root would
 * get now differs from the one it sounds for any of them (a chord button, an inversion key, the type, sus, ext, voicing or
 * lock row changed), every held root takes its new chord. ALL ends every note they sounded (`off`, oldest root first, in
 * chord order) and then starts every note of the new chords (`on`, oldest root first, at its root's velocity; `again`:
 * the note sounded before, a re-attack). DIFF ends only the notes no new chord has and starts only those no old chord
 * had; the shared ones keep sounding. Nothing changes when `room` refuses the notes that would start. The engines run it
 * at the start of every block, before the Arpeggiators (engine.c harm_retrig). Whether anything changed.
 */
export function harmRetrig(s: HarmState, p: HarmParams, on: (note: number, vel: number, again: boolean) => void, off: (note: number) => void, room: (notes: number[]) => boolean = () => true): boolean {
  const mode = int(p.retrig, 0, 2);
  if (!mode || !s.roots.length) return false;
  const fresh = s.roots.map((r) => harmChord(s, r.key, p));
  if (fresh.every((c, i) => c.length === s.roots[i].notes.length && c.every((n, j) => n === s.roots[i].notes[j]))) return false;
  const was = s.count.map((c) => c > 0);
  const next = Array<number>(128).fill(0);
  for (const c of fresh) for (const n of c) next[n]++;
  const starts: number[] = [];
  const seen = Array<boolean>(128).fill(false);
  for (const c of fresh) for (const n of c) if (!seen[n]) { seen[n] = true; if (mode === 1 || !was[n]) starts.push(n); }
  if (!room(starts)) return false;
  for (const r of s.roots) for (const n of r.notes) if (s.count[n] && (mode === 1 || !next[n])) { s.count[n] = 0; off(n); }
  for (const r of s.roots) for (const n of r.notes) s.count[n] = 0;
  s.roots.forEach((r, i) => {
    r.notes = fresh[i];
    for (const n of r.notes) if (s.count[n]++ === 0 && (mode === 1 || !was[n])) on(n, r.vel, was[n]);
  });
  return true;
}

/** a key from Main (`zone`: the keys under the split are buttons, and with the inversion keys on the three at split + 17;
 * the FM-1's keys come without it: its seven lowest and three highest keys are the buttons, engine.c eng_chord_button);
 * `vel`: a root's velocity (harmRootOn) */
export function harmKey(s: HarmState, note: number, down: boolean, p: HarmParams, zone: boolean, on: (note: number) => void, off: (note: number) => void, room: (notes: number[]) => boolean = () => true, snapshot = 0, vel = 1): void {
  if (zone && s.buttonKeys[note]) {
    const held = s.buttonKeys[note];
    if (!down) {
      s.buttonKeys[note] = 0;
      if (!s.buttonKeys.includes(held)) harmButton(s, held - 1, false, p);
    }
    return;
  }
  if (!down) { harmRootOff(s, note, off); return; }
  const b = zone ? harmButtonOf(note, p) : -1;
  if (b >= 0) {
    harmRootOff(s, note, off);
    s.buttonKeys[note] = b + 1;
    harmButton(s, b, true, p);
  } else harmRootOn(s, note, p, on, off, room, snapshot, vel);
}

/** every root and button let go, the latch cleared (what sounded is the caller's to end) */
export function harmClear(s: HarmState): void {
  Object.assign(s, harmInit());
}

/** the chord's name as the FM-1's bar shows it (engine.c harm_name), from the buttons in effect, else the card's; '' for
 * the root alone. The 7 button's seventh is the minor one: with maj it reads 7 (a dominant seventh), with dim MIN7B5;
 * 9 with 7 is a ninth chord (9, MIN9), without it ADD9; a 2nd or 4th beside a third is ADD2 / ADD4, without one SUS2 / SUS4;
 * an inversion key in effect ends it INV1..INV3 (the `voicing` row does not show) */
export function harmName(s: HarmState, p: HarmParams): string {
  const t = harmIntervals(s, p), inv = harmInversion(s, p);
  if (t.length === 1) return '';
  const has = (x: number): boolean => t.includes(x);
  const q = has(3) && has(6) ? 'DIM' : has(3) ? 'MIN' : has(4) ? 'MAJ' : '';
  const ext = has(10) ? (has(14) ? '9' : '7') : '';
  const head = ext ? (q === 'MIN' ? `MIN${ext}` : q === 'DIM' ? `MIN${ext}B5` : ext) : q;
  const sus = (x: number, n: string): string => (has(x) ? (q ? `ADD${n}` : `SUS${n}`) : '');
  return [head, sus(2, '2'), sus(5, '4'), has(14) && !has(10) ? 'ADD9' : '', inv ? `INV${inv}` : ''].filter(Boolean).join(' ');
}
