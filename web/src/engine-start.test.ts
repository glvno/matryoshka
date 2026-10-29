// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describe as describeDef, FACTORY, summary } from './assemblies';
import { enginePatch, engineTiles } from './engine-start';
import { defIsEngine, feedsOutput } from './engines';
import { DEFS } from './modules';
import { validatePatch } from './patch';

describe('"Start with an engine" (#160)', () => {
  const tiles = engineTiles();

  it('has a tile per factory engine, with mono / stereo and a CPU figure', () => {
    expect(tiles.map((t) => t.name)).toEqual(FACTORY.filter((d) => defIsEngine(d)).map((d) => d.name));
    expect(tiles).toHaveLength(24);
    const by = (n: string) => tiles.find((t) => t.name === n)!;
    expect(by('Hera 6').stereo).toBe(true);
    expect(by('Oracle V').stereo).toBe(false);
    expect(by('8 Lire').stereo).toBe(true); // the delay's ping-pong taps
    expect(by('Scrounge').stereo).toBe(true); // the A and B outputs
    expect(by('Meridian 8').stereo).toBe(true); // the odd and even outputs
    expect(by('Perun 4').stereo).toBe(false); // mono, as the original
    expect(by('Spokes 6').stereo).toBe(false); // mono on the FM-1 (the XL has the pan)
    for (const t of tiles) {
      expect(t.line.length, t.name).toBeGreaterThan(0);
      if (t.cpu !== null) expect(t.cpu, t.name).toBeGreaterThan(0);
      if (t.cpu !== null) expect(t.cpu, t.name).toBeLessThanOrEqual(100);
    }
    expect(by('basic poly').cpu).not.toBeNull(); // the plainest fits
    expect(engineTiles()[0].cpu).toBe(tiles[0].cpu); // memoized
  });

  it('describes each engine in a line of its own, the owner’s wording for the emulations (2026-10-21)', () => {
    const by = (n: string) => tiles.find((t) => t.name === n)!.line;
    expect(by('Oracle V')).toBe('Prophet-5 type shit');
    expect(by('Monolith D')).toBe('Minimoog Model D type shit');
    expect(by('Silver Box')).toBe('TB-303 type shit');
    expect(by('Hera 6')).toBe('Juno-106 type shit');
    expect(by('Sallen 20')).toBe('MS-20 type shit');
    expect(by('Expander S')).toBe('Oberheim SEM type shit');
    expect(by('Algo Four')).toBe('DX100 type shit');
    expect(by('Canvas')).toBe('Music Easel type shit');
    expect(by('Wanderer')).toBe('ARP Odyssey type shit');
    expect(by('Briefcase 3')).toBe('EMS VCS3 type shit');
    expect(by('Io 4')).toBe('Jupiter-4 type shit');
    expect(by('8 Lire')).toBe('Lyra-8 type shit');
    expect(by('Elvira 2')).toBe('Elmyra 2 type shit');
    expect(by('Scrounge')).toBe('Scrooge type shit');
    expect(by('Meridian 8')).toBe('NOON type shit');
    expect(by('Perun 4')).toBe('Perkons HD-01 type shit');
    expect(by('Spokes 6')).toBe('Model:Cycles type shit');
    expect(by('Cassia 1')).toBe('CZ-1 type shit');
    expect(by('Vernon 100')).toBe('ElectroComp 100 type shit');
    for (const t of tiles) {
      expect(t.def.blurb, t.name).toBeTruthy();
      expect(t.line, t.name).toBe(t.def.blurb);
    }
    // the user's own engine has no blurb: the module list stands in
    const own = { ...tiles[0].def, name: 'mine', blurb: undefined };
    expect(describeDef(own)).toBe(summary(own));
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
