// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { PRESETS } from './presets';
import { isSaved, putBackSaved, removeSaved, renameSaved, restoreSaved, savedPatches, savePatch, unsavedChanges } from './saved';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

it('saves, replaces by name and removes', () => {
  const [a, b] = Object.values(PRESETS).map((make) => make());
  savePatch({ ...a, name: 'One' });
  expect(savePatch({ ...b, name: 'Two' }).msg).toMatch(/saved in/);
  expect(savePatch({ ...b, name: 'One' }).msg).toMatch(/replaced/);
  const list = savedPatches();
  expect(list.map((e) => e.name).sort()).toEqual(['One', 'Two']);
  expect(list.find((e) => e.name === 'One')!.patch.modules.length).toBe(b.modules.length);
  removeSaved('One');
  expect(isSaved('One')).toBe(false);
  expect(savedPatches().map((e) => e.name)).toEqual(['Two']);
});

it('keeps a copy, not the live patch', () => {
  const p = { ...Object.values(PRESETS)[0](), name: 'Copy' };
  savePatch(p);
  p.modules.length = 0;
  expect(savedPatches()[0].patch.modules.length).toBeGreaterThan(0);
});

it('a deletion stays gone (storage) and can be undone, but never over a newer save of that name', () => {
  const [a, b] = Object.values(PRESETS).map((make) => make());
  savePatch({ ...a, name: 'Gone' });
  const before = JSON.parse(mem.get('matryoshka.patches')!);
  const entry = removeSaved('Gone')!;
  expect(entry.name).toBe('Gone');
  expect(JSON.parse(mem.get('matryoshka.patches')!)).toEqual([]); // what a reload reads
  expect(removeSaved('Gone')).toBeNull();
  expect(restoreSaved(entry)).toBe(true);
  expect(JSON.parse(mem.get('matryoshka.patches')!)).toEqual(before);
  removeSaved('Gone');
  savePatch({ ...b, name: 'Gone' });
  expect(restoreSaved(entry)).toBe(false);
  expect(savedPatches()[0].patch.modules.length).toBe(b.modules.length);
});

it('a save over a name returns the entry it replaced, and its Undo puts that entry back (contents and date)', () => {
  const [a, b] = Object.values(PRESETS).map((make) => make());
  expect(savePatch({ ...a, name: 'init' }).replaced).toBeNull();
  const before = JSON.parse(mem.get('matryoshka.patches')!)[0];
  const { replaced } = savePatch({ ...b, name: 'init' });
  expect(replaced).toEqual(before);
  expect(savedPatches()[0].patch.modules.length).toBe(b.modules.length);
  expect(putBackSaved(replaced!)).toBe(true);
  expect(JSON.parse(mem.get('matryoshka.patches')!)).toEqual([before]); // one "init", the earlier one
});

it('unsaved changes: none when equal to the saved copy apart from view, octave and name; any other change or no copy counts', () => {
  const a = { ...Object.values(PRESETS)[0](), name: 'Mine' };
  expect(unsavedChanges(a, savedPatches())).toBe(true); // no saved copy
  savePatch(a);
  const saved = savedPatches();
  const same = JSON.parse(JSON.stringify(a)) as typeof a;
  same.view = { zoom: 2, x: 10, y: 20 };
  same.octave = 2;
  expect(unsavedChanges(same, saved)).toBe(false);
  expect(unsavedChanges({ ...same, name: 'Other' }, saved)).toBe(true); // another name: no copy of it
  const m = same.modules.find((x) => Object.keys(x.params ?? {}).length)!;
  const k = Object.keys(m.params)[0];
  m.params[k] += 1;
  expect(unsavedChanges(same, saved)).toBe(true);
});

it('renames a saved patch, keeping its date, never over another name', () => {
  const [a, b] = Object.values(PRESETS).map((make) => make());
  savePatch({ ...a, name: 'Old' });
  savePatch({ ...b, name: 'Taken' });
  const date = savedPatches().find((e) => e.name === 'Old')!.saved;
  expect(renameSaved('Old', 'Taken')).toBe(false);
  expect(renameSaved('Missing', 'New')).toBe(false);
  expect(renameSaved('Old', ' New ')).toBe(true);
  const e = savedPatches().find((x) => x.name === 'New')!;
  expect(e.patch.name).toBe('New');
  expect(e.saved).toBe(date);
  expect(isSaved('Old')).toBe(false);
});
