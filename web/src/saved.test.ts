// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { PRESETS } from './presets';
import { isSaved, removeSaved, restoreSaved, savedPatches, savePatch } from './saved';

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
  expect(savePatch({ ...b, name: 'Two' })).toMatch(/saved in/);
  expect(savePatch({ ...b, name: 'One' })).toMatch(/replaced/);
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
