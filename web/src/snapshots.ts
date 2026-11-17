// SPDX-License-Identifier: GPL-3.0-only
// The candidates (#943, #1048; `Snapshot` in the code): versions of the patch kept with the open patch in this browser, to
// compare by ear with the current patch. The current patch is candidate A, always the first stop; the others are lettered
// B, C… in the order they are made, and a letter is never given twice. The switch goes from A through them in the list's
// order, which the user sets by dragging (#1040), then round to A again, both ways (#1028). This is the list, its rules and
// its keys; the editor (editor.ts) switches the patch on screen with ab.ts's in-place rules.

import type { Patch } from './patch';

/** the current patch's letter: never given to a stored candidate */
export const CURRENT_LETTER = 'A';

export interface Snapshot {
  /** B, C, … Z, AA, AB… given when it is made; never chosen by the user, never A (the current patch's) */
  letter: string;
  /** an optional name the user gives it */
  name?: string;
  /** the patch as it was taken (JSON) */
  patch: string;
  /** kept in rank and cut (#996): Generate breeds from the candidates marked keep; none: not marked */
  mark?: 'keep';
  /** where it came from: a candidate's letter (A: the current patch), or letters joined by + (bred from those keeps), as
   *  Generate made it; `mutate`: the copy the first Mutate of a run keeps; `use`: the current patch that Use replaced;
   *  none: nominated by hand */
  from?: string;
  /** a Generate round with a Mutate category (#1033): the category and whether it passed its test or only came nearest */
  aim?: { kind: string; fits: boolean };
}

/** what a candidate key does: go to the next stop or the one before, nominate the patch heard, remove the candidate on
 *  screen, make the candidate on screen the current patch (Use) */
export type SnapshotKey = 'next' | 'previous' | 'take' | 'remove' | 'current';

/** the candidate key a keydown is (D-984, #1028, #1040), null for any other: Alt+B or Alt+J the next stop, Alt+K the one
 *  before, Shift+Alt+B Nominate, Alt+X remove the candidate on screen at once, Alt+C Use. Read by the key's place, as
 *  Option+letter types a symbol on a Mac (B by its letter too, as before) */
export function snapshotKey(e: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'code' | 'key'>): SnapshotKey | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.code === 'KeyB' || e.key.toLowerCase() === 'b') return e.shiftKey ? 'take' : 'next';
  if (e.shiftKey) return null;
  return e.code === 'KeyJ' ? 'next' : e.code === 'KeyK' ? 'previous' : e.code === 'KeyX' ? 'remove' : e.code === 'KeyC' ? 'current' : null;
}

/** the nth letter: A..Z, then AA, AB.. (spreadsheet columns) */
export function letterAt(n: number): string {
  let s = '';
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function indexOf(letter: string): number {
  let n = 0;
  for (const c of letter) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** what the second line of a candidate's row says it came from (#1048) */
export function originText(s: Pick<Snapshot, 'from'>): string {
  const f = s.from;
  if (!f) return 'taken by hand';
  if (f === 'mutate') return 'kept for you before the first Mutate';
  if (f === 'use') return 'was A, the current patch';
  const parts = f.split('+');
  return `from ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : f}`;
}

/** what a candidate of an aimed round says of its category (#1033, #1048): "sounds like a pad" when it passed, "kind of
 *  sounds like a pad" when it only came nearest; null without an aim */
export function fitText(s: Pick<Snapshot, 'aim'>): string | null {
  if (!s.aim) return null;
  const what = s.aim.kind === 'keys' ? 'keys' : `a ${s.aim.kind}`;
  return `${s.aim.fits ? '' : 'kind of '}sounds like ${what}`;
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

/** a short fingerprint of the remembered patch's text (FNV-1a), which ties stored candidates to that patch */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** the record's lettering: 2 since A is the current patch (#1048); a record without it lettered its first candidate A */
const LETTERING = 2;

/** what the browser keeps beside the remembered patch (`patchText`, as written to storage) so the candidates survive a
 *  reload (D-972); null when there are none */
export function snapshotRecord(patchText: string, list: readonly Snapshot[]): string | null {
  return list.length ? JSON.stringify({ patch: fingerprint(patchText), v: LETTERING, list }) : null;
}

/** a candidate of a record from before A was the current patch, lettered once more (#1048): each letter moves on by one (A
 *  to B, Z to AA), its origin with it (the current patch's `current` becomes A), and the old "before mutate" copy gets its
 *  origin. So no stored candidate is ever A beside the current patch */
function reletter(s: Snapshot): Snapshot {
  const next = (l: string): string => letterAt(indexOf(l) + 1);
  const from = s.from === 'current' ? CURRENT_LETTER : s.from?.split('+').map((l) => (/^[A-Z]+$/.test(l) ? next(l) : l)).join('+');
  const before = s.name === 'before mutate' && !s.from;
  return { ...s, letter: next(s.letter), ...(from ? { from } : {}), ...(before ? { from: 'mutate' } : {}) };
}

/** the candidates kept for the remembered patch `patchText`: none when the record belongs to another patch or is damaged.
 *  A record from before A was the current patch is lettered once more (reletter) */
export function storedSnapshots(record: string | null, patchText: string | null): Snapshot[] {
  if (!record || patchText === null) return [];
  try {
    const r = JSON.parse(record) as { patch?: unknown; v?: unknown; list?: unknown };
    if (r.patch !== fingerprint(patchText) || !Array.isArray(r.list)) return [];
    const list = (r.list as Partial<Snapshot>[]).filter((s): s is Snapshot => typeof s?.letter === 'string' && /^[A-Z]+$/.test(s.letter) && typeof s.patch === 'string' && (s.name === undefined || typeof s.name === 'string'))
      .map((s): Snapshot => ({
        letter: s.letter, patch: s.patch, ...(s.name ? { name: s.name } : {}), ...(s.mark === 'keep' ? { mark: s.mark } : {}), ...(typeof s.from === 'string' ? { from: s.from } : {}),
        ...(typeof s.aim?.kind === 'string' && typeof s.aim.fits === 'boolean' ? { aim: { kind: s.aim.kind, fits: s.aim.fits } } : {}),
      }));
    return r.v === LETTERING && !list.some((s) => s.letter === CURRENT_LETTER) ? list : list.map(reletter);
  } catch {
    return [];
  }
}

export class Snapshots {
  readonly list: Snapshot[] = [];
  /** the letter of the candidate on screen; null: the current patch (A) is */
  shown: string | null = null;
  /** while a candidate is on screen: the current patch (JSON), as it was left */
  current: string | null = null;
  /** how many letters have been given since the list was last cleared (A counts: it is the current patch's): a letter is
   *  never given twice, so an undo step that names a removed candidate never finds another one under its letter */
  private given = 1;

  get(letter: string | null): Snapshot | undefined {
    return letter === null ? undefined : this.list.find((s) => s.letter === letter);
  }

  /** the letter after every letter given so far (B when there is none: A is the current patch) */
  nextLetter(): string {
    return letterAt(Math.max(this.given, ...this.list.map((s) => indexOf(s.letter) + 1)));
  }

  /** keep `p` as a new candidate at the end; `from`: where it came from (Snapshot.from) */
  take(p: Patch, name?: string, from?: string): Snapshot {
    const letter = this.nextLetter();
    this.given = indexOf(letter) + 1;
    const s: Snapshot = { letter, patch: JSON.stringify(p), ...(name ? { name } : {}), ...(from ? { from } : {}) };
    this.list.push(s);
    return s;
  }

  /** the candidate holding this version already, if any */
  holding(p: Patch): Snapshot | undefined {
    return this.list.find((s) => sameVersion(JSON.parse(s.patch) as Patch, p));
  }

  /** the stops in order: the current patch (null, A) first, then the list */
  stops(): (string | null)[] {
    return [null, ...this.list.map((s) => s.letter)];
  }

  /** the stop after the one on screen, in the order A (the current patch), B, …, A… (`step` -1: the one before).
   *  Undefined when there are no candidates */
  next(step: 1 | -1 = 1): string | null | undefined {
    if (!this.list.length) return undefined;
    const stops = this.stops();
    const at = stops.indexOf(this.shown);
    return stops[(at + step + stops.length) % stops.length];
  }

  remove(letter: string): void {
    const i = this.list.findIndex((s) => s.letter === letter);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** put a candidate at place `to` of the list (#1040): its letter stays, the stops follow the new order, A stays first */
  move(letter: string, to: number): void {
    const i = this.list.findIndex((s) => s.letter === letter);
    if (i >= 0) this.list.splice(Math.max(0, Math.min(this.list.length - 1, to)), 0, ...this.list.splice(i, 1));
  }

  clear(): void {
    this.list.length = 0;
    this.shown = this.current = null;
    this.given = 1;
  }
}
