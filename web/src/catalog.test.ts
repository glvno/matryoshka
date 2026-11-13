// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { addableModules, assemblyShelves, openableByValue, openableGroups, SHELVES } from './catalog';
import { DEFS } from './modules';
import { validatePatch } from './patch';
import { addCommunity, loadCommunity } from './community';
import { EXAMPLE_PRESETS, FM1_PRESETS, PRESETS } from './presets';
import { savePatch } from './saved';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

describe('what the editor offers (#84)', () => {
  it('never offers Main or Part as a module', () => {
    const types = addableModules(DEFS).map((m) => m.type);
    expect(types).not.toContain('fm1');
    expect(types).not.toContain('part');
    expect(types).toContain('alloc');
    expect(new Set(addableModules(DEFS).map((m) => m.name)).size).toBe(types.length); // no two entries read the same
  });

  it('shelves every assembly on a shelf the browser shows', () => {
    const shelves = assemblyShelves();
    expect(new Set(shelves.map((a) => a.def.name))).toEqual(new Set(FACTORY.map((d) => d.name))); // empty user library: the factory set
    expect(shelves.length).toBe(FACTORY.length + 6); // the drum kit, Scrounge, Meridian 8, Perun 4, Spokes 6 and Verona Drum 1 are on Engines and Drums (#159)
    for (const a of shelves) expect(SHELVES).toContain(a.shelf);
  });

  it('opens exactly the Open picker\'s entries, each to a loadable patch', () => {
    savePatch({ ...Object.values(PRESETS)[0](), name: 'Mine' });
    const groups = openableGroups();
    expect(groups[0].items.map((o) => o.name)).toEqual(['Mine']);
    expect(groups[0].items[0].from).toBe('Mine');
    expect(groups.flatMap(g => g.items).filter(o => !o.from).map(o => o.name)).toEqual(Object.keys(PRESETS));
    for (const o of groups.flatMap((g) => g.items)) {
      expect(openableByValue(o.value)).toBeDefined();
      expect(() => validatePatch(o.load(), DEFS)).not.toThrow();
      expect(o.chip().text).toMatch(/^(FM-1 · \d+ %|SANDBOX)$/);
    }
  });

  it('keeps relocated patches out of the default picker until explicitly added from Community', async () => {
    const entries = await loadCommunity();
    const original = entries.find(c => c.entry.title === 'Oracle V XL')!;
    const defaults = openableGroups().find(g => g.label === 'Factory patches')!.items;
    expect(defaults.map(o => o.name)).toEqual(Object.keys(FM1_PRESETS));
    expect(defaults.some(o => o.name === original.entry.title)).toBe(false);
    addCommunity(original.entry.title);
    const added = openableByValue(`community:${original.entry.title}`)!;
    expect(added.author).toBe(original.entry.author);
    expect(added.load()).toEqual(original.patch);
  });

  it('opens every editor example without adding it from Community or offering it as a hardware default', () => {
    const factory = openableGroups().find(g => g.label === 'Factory patches')!.items;
    const examples = openableGroups().find(g => g.label === 'Examples')!.items;
    expect(examples.map(o => o.name)).toEqual(Object.keys(EXAMPLE_PRESETS));
    for (const example of examples) {
      expect(openableByValue(example.value)!.load().name).toBe(example.name);
      expect(factory.some(o => o.name === example.name)).toBe(false);
    }
  });

  it('lists an added community patch in Your patches with its author, and nothing community otherwise', async () => {
    const all = await loadCommunity();
    expect(openableGroups().flatMap((g) => g.items).some((o) => o.value.startsWith('community:'))).toBe(false);
    const [c] = all;
    addCommunity(c.entry.title);
    const mine = openableGroups()[0].items;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: c.entry.title, author: c.entry.author, value: `community:${c.entry.title}` });
    expect(mine[0].from).toBeUndefined();
    expect(mine[0].load().name).toBe(c.patch!.name.trim() ? c.patch!.name : c.entry.title);
    // saved under its name it is the user's own copy, listed once
    savePatch({ ...c.patch!, name: c.entry.title });
    expect(openableGroups()[0].items.map((o) => o.value)).toEqual([`saved:${c.entry.title}`]);
  });

});
