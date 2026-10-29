// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { addableModules, assemblyShelves, openableByValue, openableGroups, SHELVES } from './catalog';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import { addCommunity, loadCommunity } from './community';
import { PRESETS, xlBase } from './presets';
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
    expect(shelves.length).toBe(FACTORY.length + 5); // the drum kit, Scrounge, Meridian 8, Perun 4 and Spokes 6 are on Engines and Drums (#159)
    for (const a of shelves) expect(SHELVES).toContain(a.shelf);
  });

  it('opens exactly the Open picker\'s entries, each to a loadable patch', () => {
    savePatch({ ...Object.values(PRESETS)[0](), name: 'Mine' });
    const groups = openableGroups();
    expect(groups.map((g) => g.label)).toEqual(['Your patches', 'Factory patches']); // no Tutorial, no Community
    expect(groups[0].items.map((o) => o.name)).toEqual(['Mine']);
    expect(groups[0].items[0].from).toBe('Mine');
    expect(groups[1].items.map((o) => o.name)).toEqual(Object.keys(PRESETS)); // no retired factory patches
    for (const o of groups.flatMap((g) => g.items)) {
      expect(openableByValue(o.value)).toBeDefined();
      expect(() => validatePatch(o.load(), DEFS)).not.toThrow();
      expect(o.chip().text).toMatch(/^(FM-1 · \d+ %|SANDBOX)$/);
    }
    expect(groups[1].items.filter((o) => !xlBase(o.name)).every((o) => o.chip().fits)).toBe(true); // every factory FM-1 version fits (an XL need not)
  });

  it('lists a factory XL right under its FM-1 version, and its chip comes from the patch, not the name', () => {
    const base = 'Oracle V';
    const big = (): Patch => {
      const p = PRESETS[base]();
      p.modules = [...p.modules, ...Array.from({ length: 400 }, (_, i) => ({ ...p.modules.find((m) => m.type === 'output')!, id: 1000 + i }))];
      return p;
    };
    PRESETS[`${base} XL`] = big;
    PRESETS['Init XL'] = PRESETS.Init; // an XL trimmed to fit shows FM-1
    try {
      const items = openableGroups().find((g) => g.label === 'Factory patches')!.items;
      const i = items.findIndex((o) => o.name === base);
      expect(items[i + 1]).toMatchObject({ name: `${base} XL`, xl: true });
      expect(items[i + 1].chip()).toEqual({ fits: false, text: 'SANDBOX' });
      expect(items[i].xl).toBe(false);
      const init = items.findIndex((o) => o.name === 'Init');
      expect(items[init + 1]).toMatchObject({ name: 'Init XL', xl: true });
      expect(items[init + 1].chip().fits).toBe(true);
      expect(items.length).toBe(Object.keys(PRESETS).length);
    } finally {
      delete PRESETS[`${base} XL`];
      delete PRESETS['Init XL'];
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

  it('the palette, the browser and the Open picker read these lists, not their own', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const palette = main.slice(main.indexOf('const commands = ('), main.indexOf('const loadNamed'));
    for (const own of ['Object.values(DEFS)', 'FACTORY', 'loadLibrary()', 'patchCandidates', 'PRESETS', 'savedPatches']) expect(palette).not.toContain(own);
    expect(palette).toContain('addableModules(DEFS)');
    expect(palette).toContain('assemblyShelves()');
    expect(palette).toContain('openableGroups()');
    const browser = readFileSync(new URL('./browser.ts', import.meta.url), 'utf8');
    expect(browser).toContain('assemblyShelves()');
    expect(browser).not.toContain('FACTORY');
  });
});
