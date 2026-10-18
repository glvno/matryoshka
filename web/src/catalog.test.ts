// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { addableModules, assemblyShelves, openableByValue, openableGroups, SHELVES } from './catalog';
import { DEFS } from './modules';
import { validatePatch } from './patch';
import { PRESETS } from './presets';
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
    expect(shelves.map((a) => a.def.name)).toEqual(FACTORY.map((d) => d.name)); // empty user library: the factory set
    for (const a of shelves) expect(SHELVES).toContain(a.shelf);
  });

  it('opens exactly the Open picker\'s entries, each to a loadable patch', () => {
    savePatch({ ...Object.values(PRESETS)[0](), name: 'Mine' });
    const groups = openableGroups();
    expect(groups.map((g) => g.label)).toEqual(['Your patches', 'Examples', 'Tutorial']);
    expect(groups[0].items.map((o) => o.name)).toEqual(['Mine']);
    expect(groups[1].items.map((o) => o.name)).toEqual(Object.keys(PRESETS)); // no retired factory patches
    for (const o of groups.flatMap((g) => g.items)) {
      expect(openableByValue(o.value)).toBeDefined();
      expect(() => validatePatch(o.load(), DEFS)).not.toThrow();
    }
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
