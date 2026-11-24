// SPDX-License-Identifier: GPL-3.0-only
// The candidates (#943, #1048; `Snapshot` in the code): versions of one patch, all alike (owner 2026-11-24). The one you hear
// is the current candidate, and it is the current patch: every edit goes into it at once. They are lettered A, B, C… in the
// order they are made (the opened patch is A), and a letter is never given twice in a set. Each keeps a hidden original,
// the patch as it was made, which only "revert" uses. The switch goes through them in the list's order, which the user
// sets by dragging (#1040), round again, both ways (#1028). This is the set, its rules and its keys; the editor (editor.ts)
// switches the patch on screen with ab.ts's in-place rules, and candidate-store.ts keeps the sets per patch.

import type { Patch } from './patch';

/** the most candidates a set holds (an open may go past it: nothing is thrown away) */
export const CANDIDATE_LIMIT = 32;

export interface Snapshot {
  /** A, B, … Z, AA, AB… given when it is made; never chosen by the user */
  letter: string;
  /** an optional name the user gives it */
  name?: string;
  /** the patch (JSON); for the current candidate as of the last sync (the editor's patch is newer) */
  patch: string;
  /** the patch as the candidate was made (JSON): what "revert" brings back, and what "tweaked" compares with */
  original: string;
  /** where it came from: `opened`; a candidate's letter (made from it by Generate); letters joined by + (bred from those);
   *  `copy:D` (Duplicate of D); from before 1.26.4: none (nominated by hand), `mutate` (kept before a Mutate), `use` (the
   *  current patch that Use replaced) */
  from?: string;
  /** a Generate round with a Mutate category (#1033): the category and whether it passed its test or only came nearest */
  aim?: { kind: string; fits: boolean };
}

/** a candidate deleted, with its place in the list then (Recently deleted, this session only) */
export interface Deleted { s: Snapshot; at: number }

/** the candidates of one patch, as candidate-store.ts keeps them */
export interface CandidateSet {
  id: string;
  /** the patch's name as the set was opened: the set's key */
  name: string;
  list: Snapshot[];
  /** the current candidate's letter */
  current: string;
  /** how many letters have been given (deleted ones count) */
  given: number;
  /** Date.now() at the last open (the 8 most recently opened sets are kept) */
  opened: number;
  /** Recently deleted, newest first: this session only, never written */
  deleted?: Deleted[];
}

/** what a candidate key does: go to the next candidate or the one before, Duplicate the current one, delete it */
export type SnapshotKey = 'next' | 'previous' | 'duplicate' | 'remove';

/** the candidate key a keydown is (D-984, #1028, #1040), null for any other: Alt+B or Alt+J the next, Alt+K the one
 *  before, Shift+Alt+B Duplicate, Alt+X delete the current one. Read by the key's place, as Option+letter types a symbol
 *  on a Mac (B by its letter too, as before) */
export function snapshotKey(e: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'code' | 'key'>): SnapshotKey | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.code === 'KeyB' || e.key.toLowerCase() === 'b') return e.shiftKey ? 'duplicate' : 'next';
  if (e.shiftKey) return null;
  return e.code === 'KeyJ' ? 'next' : e.code === 'KeyK' ? 'previous' : e.code === 'KeyX' ? 'remove' : null;
}

/** the nth letter: A..Z, then AA, AB.. (spreadsheet columns) */
export function letterAt(n: number): string {
  let s = '';
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** the place of a letter (A 0, Z 25, AA 26) */
export function letterIndex(letter: string): number {
  let n = 0;
  for (const c of letter) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** what the second line of a candidate's row says it came from (#1048) */
export function originText(s: Pick<Snapshot, 'from'>): string {
  const f = s.from;
  if (!f) return 'taken by hand';
  if (f === 'opened') return 'as opened';
  if (f === 'mutate') return 'kept before a Mutate';
  if (f === 'use') return 'was the current patch';
  if (f.startsWith('copy:')) return `copy of ${f.slice(5)}`;
  const parts = f.split('+');
  return parts.length > 1 ? `bred from ${parts.join(' × ')}` : `from ${f}`;
}

/** what a candidate of an aimed round says of its category (#1033, #1048): "sounds like a pad" when it passed, "kind of
 *  sounds like a pad" when it only came nearest; null without an aim */
export function fitText(s: Pick<Snapshot, 'aim'>): string | null {
  if (!s.aim) return null;
  const what = s.aim.kind === 'keys' ? 'keys' : `a ${s.aim.kind}`;
  return `${s.aim.fits ? '' : 'kind of '}sounds like ${what}`;
}

/** what "tweaked" compares (D-1425): the body without the preset each card shows, which Store preset names without
 *  changing the sound */
export function tweakBody(p: Patch): string {
  const q = JSON.parse(body(p)) as Patch;
  for (const a of q.assemblies ?? []) delete a.preset;
  return JSON.stringify(q);
}

/** what two versions of the patch have in common when they sound and are wired the same: the patch without the canvas
 *  layout (positions, frame sizes, open or closed, the view, the octave), which a switch keeps as it is on screen, and
 *  without the name */
export function body(p: Patch): string {
  const q = JSON.parse(JSON.stringify(p)) as Record<string, unknown> & Patch;
  for (const k of ['view', 'octave', 'slackFrom', 'zoomFrom', 'name'] as const) delete q[k];
  for (const m of q.modules as unknown as Record<string, unknown>[]) delete m.x, delete m.y;
  for (const a of (q.assemblies ?? []) as unknown as Record<string, unknown>[]) for (const k of ['x', 'y', 'open', 'frameSize', 'size']) delete a[k];
  return JSON.stringify(q);
}

/** the same version: the same body and the same name */
export const sameVersion = (a: Patch, b: Patch): boolean => a.name === b.name && body(a) === body(b);

/** the name a candidate goes into the FM-1's palette under (D-1240): the patch's name and the candidate's own name, or its
 *  letter when the set has more than one; a lone candidate without a name adds under the patch's name alone */
export function paletteName(patchName: string, s: Pick<Snapshot, 'letter' | 'name'>, count: number): string {
  const base = patchName.trim() || 'Untitled';
  return s.name ? `${base} ${s.name}` : count > 1 ? `${base} ${s.letter}` : base;
}

/** a new set id */
export const newSetId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** the candidates of the open patch, in the list's order, and the one heard */
export class Snapshots {
  id = newSetId();
  /** the patch's name as the set was opened */
  name = '';
  readonly list: Snapshot[] = [];
  /** the current candidate's letter */
  current = 'A';
  /** Recently deleted, newest first (this session only) */
  deleted: Deleted[] = [];
  /** Date.now() at its last open (candidate-store.ts sets it as it stores an open) */
  opened = Date.now();
  /** how many letters have been given: a letter is never given twice */
  private given = 0;

  /** a fresh set whose only candidate, A, is `p` as opened */
  static fresh(p: Patch): Snapshots {
    const s = new Snapshots();
    s.name = p.name;
    const text = JSON.stringify(p);
    s.list.push({ letter: 'A', patch: text, original: text, from: 'opened' });
    s.given = 1;
    return s;
  }

  /** the set as candidate-store.ts keeps it (the list copied, the deleted ones by reference) */
  static of(set: CandidateSet): Snapshots {
    const s = new Snapshots();
    s.id = set.id;
    s.name = set.name;
    s.list.push(...set.list.map((x) => ({ ...x })));
    s.current = s.list.some((x) => x.letter === set.current) ? set.current : s.list[0].letter;
    s.given = Math.max(set.given, ...s.list.map((x) => letterIndex(x.letter) + 1));
    s.deleted = set.deleted ?? [];
    s.opened = set.opened;
    return s;
  }

  /** this set as candidate-store.ts keeps it */
  toSet(): CandidateSet {
    return { id: this.id, name: this.name, list: this.list.map((x) => ({ ...x })), current: this.current, given: this.given, opened: this.opened, deleted: this.deleted };
  }

  get(letter: string | null | undefined): Snapshot | undefined {
    return letter == null ? undefined : this.list.find((s) => s.letter === letter);
  }

  /** the current candidate (there is always one) */
  get shown(): Snapshot {
    return this.get(this.current) ?? this.list[0];
  }

  /** the letter after every letter given so far */
  nextLetter(): string {
    return letterAt(Math.max(this.given, ...this.list.map((s) => letterIndex(s.letter) + 1), ...this.deleted.map((d) => letterIndex(d.s.letter) + 1)));
  }

  /** a new candidate of `p`, made now (its original is `p`), at the end or at place `at`; `from`: where it came from */
  take(p: Patch, from?: string, at?: number): Snapshot {
    const letter = this.nextLetter();
    this.given = letterIndex(letter) + 1;
    const text = JSON.stringify(p);
    const s: Snapshot = { letter, patch: text, original: text, ...(from ? { from } : {}) };
    if (at === undefined) this.list.push(s);
    else this.list.splice(Math.max(0, Math.min(this.list.length, at)), 0, s);
    return s;
  }

  /** room for this many more before the limit */
  room(): number {
    return Math.max(0, CANDIDATE_LIMIT - this.list.length);
  }

  /** the candidate after the current one in the list's order, round again (`step` -1: the one before); undefined when it
   *  is the only one */
  next(step: 1 | -1 = 1): string | undefined {
    if (this.list.length < 2) return undefined;
    const at = this.list.indexOf(this.shown);
    return this.list[(at + step + this.list.length) % this.list.length].letter;
  }

  /** take candidate `letter` out of the list into Recently deleted (newest first, up to the limit); its place then */
  remove(letter: string): Deleted | undefined {
    const at = this.list.findIndex((s) => s.letter === letter);
    if (at < 0) return undefined;
    const d = { s: this.list.splice(at, 1)[0], at };
    this.deleted.unshift(d);
    this.deleted.length = Math.min(this.deleted.length, CANDIDATE_LIMIT);
    return d;
  }

  /** put Recently deleted's `i`th (0: the newest) back at its place; undefined when there is none or no room */
  putBack(i = 0): Snapshot | undefined {
    const d = this.deleted[i];
    if (!d || !this.room()) return undefined;
    this.deleted.splice(i, 1);
    this.list.splice(Math.min(d.at, this.list.length), 0, d.s);
    return d.s;
  }

  /** put a candidate at place `to` of the list (#1040): its letter stays, the switch follows the new order */
  move(letter: string, to: number): void {
    const i = this.list.findIndex((s) => s.letter === letter);
    if (i >= 0) this.list.splice(Math.max(0, Math.min(this.list.length - 1, to)), 0, ...this.list.splice(i, 1));
  }
}
