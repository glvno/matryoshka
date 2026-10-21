// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { enginePatch, engineTiles } from './engine-start';
import { defIsEngine, feedsOutput } from './engines';
import { DEFS } from './modules';
import { validatePatch } from './patch';

describe('"Start with an engine" (#160)', () => {
  const tiles = engineTiles();

  it('has a tile per factory engine, with mono / stereo and a CPU figure', () => {
    expect(tiles.map((t) => t.name)).toEqual(FACTORY.filter((d) => defIsEngine(d)).map((d) => d.name));
    expect(tiles).toHaveLength(17);
    const by = (n: string) => tiles.find((t) => t.name === n)!;
    expect(by('Hera 6').stereo).toBe(true);
    expect(by('Oracle V').stereo).toBe(false);
    for (const t of tiles) {
      expect(t.line.length, t.name).toBeGreaterThan(0);
      if (t.cpu !== null) expect(t.cpu, t.name).toBeGreaterThan(0);
      if (t.cpu !== null) expect(t.cpu, t.name).toBeLessThanOrEqual(100);
    }
    expect(by('basic poly').cpu).not.toBeNull(); // the plainest fits
    expect(engineTiles()[0].cpu).toBe(tiles[0].cpu); // memoized
  });

  it('a pick is a valid new patch that plays from the keys', () => {
    for (const t of tiles) {
      const p = enginePatch(t.def);
      expect(() => validatePatch(JSON.parse(JSON.stringify(p)), DEFS), t.name).not.toThrow();
      expect(feedsOutput(p), t.name).toBe(true);
      const main = p.modules.find((m) => m.type === 'fm1')!;
      expect(p.cables.some((c) => c.from.module === main.id && c.from.port === 'keys'), t.name).toBe(true);
    }
  });

  it('is skipped while the tutorial runs, from the button and the palette', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toContain("const startNew = (): void => (tutorial.active ? emptyNew() : engineStart.open());");
    expect(main).toContain("label: 'New patch', keywords: 'engine start empty', run: () => startNew()");
    expect(main).toMatch(/\$\('new-patch-btn'\)\.onclick = \(\) => \{ closeSidebar\(\); startNew\(\); \};/);
    expect(readFileSync(new URL('../index.html', import.meta.url), 'utf8')).toContain('<dialog id="engine-start" class="help engine-start" aria-labelledby="engine-start-title">');
  });
});
