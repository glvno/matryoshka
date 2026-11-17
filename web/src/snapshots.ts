// SPDX-License-Identifier: GPL-3.0-only
// The snapshots (#943): versions of the patch kept with the open patch in this browser, lettered A, B, C… in the order they are
// taken, to compare by ear with the current patch. The switch goes through them in the list's order, which the user sets by
// dragging (#1040), then to the current patch, then round again, both ways (#1028), so the current patch is always one of the
// stops. This is the list, its rules and its keys; the editor (editor.ts) switches the patch on screen with ab.ts's in-place rules.

import type { Patch } from './patch';

export interface Snapshot {
  /** A, B, … Z, AA, AB… given when it is taken; never chosen by the user */
  letter: string;
  /** an optional name the user gives it */
  name?: string;
  /** the patch as it was taken (JSON) */
  patch: string;
  /** kept in rank and cut (#996): Make candidates breeds from the snapshots marked keep; none: not marked */
  mark?: 'keep';
  /** what Make candidates mutated it from: a snapshot's letter, or `current` for the current patch; none: taken by hand */
  from?: string;
}

/** what a snapshot key does: go to the next stop or the one before, take a snapshot, remove the snapshot on screen, make
 *  the snapshot on screen the current patch */
export type SnapshotKey = 'next' | 'previous' | 'take' | 'remove' | 'current';

/** the snapshot key a keydown is (D-984, #1028, #1040), null for any other: Alt+B or Alt+J the next stop, Alt+K the one
 *  before, Shift+Alt+B take a snapshot, Alt+X remove the snapshot on screen at once, Alt+C make the snapshot on screen the
 *  current patch. Read by the key's place, as Option+letter types a symbol on a Mac (B by its letter too, as before) */
export function snapshotKey(e: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'code' | 'key'>): SnapshotKey | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.code === 'KeyB' || e.key.toLowerCase() === 'b') return e.shiftKey ? 'take' : 'next';
  if (e.shiftKey) return null;
  return e.code === 'KeyJ' ? 'next' : e.code === 'KeyK' ? 'previous' : e.code === 'KeyX' ? 'remove' : e.code === 'KeyC' ? 'current' : null;
}

/** the letter of the nth snapshot taken: A..Z, then AA, AB.. (spreadsheet columns) */
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

/** a short fingerprint of the remembered patch's text (FNV-1a), which ties stored snapshots to that patch */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** what the browser keeps beside the remembered patch (`patchText`, as written to storage) so the snapshots survive a
 *  reload (D-972); null when there are none */
export function snapshotRecord(patchText: string, list: readonly Snapshot[]): string | null {
  return list.length ? JSON.stringify({ patch: fingerprint(patchText), list }) : null;
}

/** the snapshots kept for the remembered patch `patchText`: none when the record belongs to another patch or is damaged */
export function storedSnapshots(record: string | null, patchText: string | null): Snapshot[] {
  if (!record || patchText === null) return [];
  try {
    const r = JSON.parse(record) as { patch?: unknown; list?: unknown };
    if (r.patch !== fingerprint(patchText) || !Array.isArray(r.list)) return [];
    return (r.list as Partial<Snapshot>[]).filter((s): s is Snapshot => typeof s?.letter === 'string' && /^[A-Z]+$/.test(s.letter) && typeof s.patch === 'string' && (s.name === undefined || typeof s.name === 'string'))
      .map((s) => ({ letter: s.letter, patch: s.patch, ...(s.name ? { name: s.name } : {}), ...(s.mark === 'keep' ? { mark: s.mark } : {}), ...(typeof s.from === 'string' ? { from: s.from } : {}) }));
  } catch {
    return [];
  }
}

export class Snapshots {
  readonly list: Snapshot[] = [];
  /** the letter of the snapshot on screen; null: the current patch is */
  shown: string | null = null;
  /** while a snapshot is on screen: the current patch (JSON), as it was left */
  current: string | null = null;
  /** how many letters have been given since the list was last cleared: a letter is never given twice, so an undo step
   *  that names a removed snapshot never finds another one under its letter */
  private given = 0;

  get(letter: string | null): Snapshot | undefined {
    return letter === null ? undefined : this.list.find((s) => s.letter === letter);
  }

  /** the letter after every letter given so far (A when there is none) */
  nextLetter(): string {
    return letterAt(Math.max(this.given, ...this.list.map((s) => indexOf(s.letter) + 1)));
  }

  /** keep `p` as a new snapshot at the end; `from`: what Make candidates mutated it from */
  take(p: Patch, name?: string, from?: string): Snapshot {
    const letter = this.nextLetter();
    this.given = indexOf(letter) + 1;
    const s: Snapshot = { letter, patch: JSON.stringify(p), ...(name ? { name } : {}), ...(from ? { from } : {}) };
    this.list.push(s);
    return s;
  }

  /** the snapshot holding this version already, if any */
  holding(p: Patch): Snapshot | undefined {
    return this.list.find((s) => sameVersion(JSON.parse(s.patch) as Patch, p));
  }

  /** the stop after the one on screen, in the order A, B, …, the current patch, A… (`step` -1: the one before). Undefined
   *  when there are no snapshots */
  next(step: 1 | -1 = 1): string | null | undefined {
    if (!this.list.length) return undefined;
    const stops: (string | null)[] = [...this.list.map((s) => s.letter), null];
    const at = stops.indexOf(this.shown);
    return stops[(at + step + stops.length) % stops.length];
  }

  remove(letter: string): void {
    const i = this.list.findIndex((s) => s.letter === letter);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** put a snapshot at place `to` of the list (#1040): its letter stays, the stops follow the new order */
  move(letter: string, to: number): void {
    const i = this.list.findIndex((s) => s.letter === letter);
    if (i >= 0) this.list.splice(Math.max(0, Math.min(this.list.length - 1, to)), 0, ...this.list.splice(i, 1));
  }

  clear(): void {
    this.list.length = 0;
    this.shown = this.current = null;
    this.given = 0;
  }
}
