// SPDX-License-Identifier: GPL-3.0-only
// The user's own patches, kept in the browser (localStorage), as many as they like, whatever the FM-1 budget.
// Saving under an existing name replaces that patch. Separate from the FM-1 bank (bank.ts), which is the list to upload.
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';

const STORE = 'matryoshka.patches';

export interface SavedPatch {
  name: string;
  patch: Patch;
  /** ms since the epoch, of the last save */
  saved: number;
}

const listeners = new Set<() => void>();
/** called after every save or removal (the Open picker and the Library list rebuild) */
export const onSavedChange = (fn: () => void): void => void listeners.add(fn);

function write(list: SavedPatch[]): boolean {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    return false;
  }
  for (const fn of listeners) fn();
  return true;
}

/** the saved patches, most recently saved first */
export function savedPatches(): SavedPatch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]') as SavedPatch[];
    if (!Array.isArray(raw)) return [];
    const out: SavedPatch[] = [];
    for (const e of raw) {
      if (typeof e?.name !== 'string' || !e.patch) continue;
      try {
        out.push({ name: e.name, patch: validatePatch(e.patch, DEFS), saved: Number(e.saved) || 0 });
      } catch {
        /* a patch this version cannot read: skipped, left in storage */
      }
    }
    return out.sort((a, b) => b.saved - a.saved);
  } catch {
    return [];
  }
}

function rawList(): SavedPatch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]') as SavedPatch[];
    return Array.isArray(raw) ? raw.filter((e) => typeof e?.name === 'string') : [];
  } catch {
    return [];
  }
}

/** keep a copy of `p` under its name (replacing one of that name); returns a status line, whether it was kept, and the
 *  entry it replaced as it was stored (for `putBackSaved`), or null */
export function savePatch(p: Patch): { msg: string; ok: boolean; replaced: SavedPatch | null } {
  const name = p.name.trim() || 'Untitled';
  const list = rawList();
  const i = list.findIndex((e) => e.name === name);
  const entry = { name, patch: JSON.parse(JSON.stringify({ ...p, name })) as Patch, saved: Date.now() };
  const replaced = i >= 0 ? list[i] : null;
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  if (!write(list)) return { msg: `"${name}" was not saved: the browser refused the storage`, ok: false, replaced: null };
  return { msg: `"${name}" ${i >= 0 ? 'saved (replaced the earlier copy)' : 'saved'} in Your patches`, ok: true, replaced };
}

/** undo of a save over a name: puts the replaced entry back as it was (its date too), over the copy of that name */
export function putBackSaved(entry: SavedPatch): boolean {
  const list = rawList().filter((e) => e.name !== entry.name);
  list.push(entry);
  return write(list);
}

/** the patch as compared for unsaved changes: without the view, the keyboard's octave and the name (as the editor's undo),
 *  keys sorted so a copy read back from storage compares equal to the live patch */
const content = (p: Patch): string => {
  const { view: _view, octave: _octave, name: _name, ...rest } = p;
  return JSON.stringify(rest, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v);
};

/** `p` has changes not kept in Your patches: it differs from the saved copy of its name, or there is none */
export function unsavedChanges(p: Patch, saved: SavedPatch[]): boolean {
  const copy = saved.find((e) => e.name === (p.name.trim() || 'Untitled'));
  return !copy || content(copy.patch) !== content(p);
}

/** delete the saved patch of that name; returns it as stored (for `restoreSaved`), or null when there was none */
export function removeSaved(name: string): SavedPatch | null {
  const list = rawList();
  const i = list.findIndex((e) => e.name === name);
  if (i < 0) return null;
  const [gone] = list.splice(i, 1);
  return write(list) ? gone : null;
}

/** undo of `removeSaved`: puts the entry back as it was (its date too), unless a patch of that name was saved since */
export function restoreSaved(entry: SavedPatch): boolean {
  const list = rawList();
  if (list.some((e) => e.name === entry.name)) return false;
  list.push(entry);
  return write(list);
}

export const isSaved = (name: string): boolean => rawList().some((e) => e.name === name);

/** rename a saved patch (its date stays); false when there is none of that name, or `to` is taken */
export function renameSaved(from: string, to: string): boolean {
  const name = to.trim();
  const list = rawList();
  const e = list.find((x) => x.name === from);
  if (!e || !name || list.some((x) => x.name === name)) return false;
  e.name = name;
  e.patch = { ...e.patch, name };
  return write(list);
}
