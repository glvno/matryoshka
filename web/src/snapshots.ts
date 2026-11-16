// SPDX-License-Identifier: GPL-3.0-only
// The snapshots (#943): versions of the patch kept with the open patch in this browser, lettered A, B, C… in the order they are
// taken, to compare by ear with the current patch. The switch goes through them in order and then back to the current
// patch, so the current patch is always one of the stops. This is the list and its rules; the editor (editor.ts) switches
// the patch on screen with ab.ts's in-place rules.

import type { Patch } from './patch';

export interface Snapshot {
  /** A, B, … Z, AA, AB… given when it is taken; never chosen by the user */
  letter: string;
  /** an optional name the user gives it */
  name?: string;
  /** the patch as it was taken (JSON) */
  patch: string;
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
      .map((s) => ({ letter: s.letter, patch: s.patch, ...(s.name ? { name: s.name } : {}) }));
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

  get(letter: string | null): Snapshot | undefined {
    return letter === null ? undefined : this.list.find((s) => s.letter === letter);
  }

  /** the letter after the newest snapshot's (A when there is none) */
  nextLetter(): string {
    const last = this.list.at(-1);
    return letterAt(last ? indexOf(last.letter) + 1 : 0);
  }

  /** keep `p` as a new snapshot at the end */
  take(p: Patch, name?: string): Snapshot {
    const s: Snapshot = { letter: this.nextLetter(), patch: JSON.stringify(p), ...(name ? { name } : {}) };
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

  clear(): void {
    this.list.length = 0;
    this.shown = this.current = null;
  }
}
