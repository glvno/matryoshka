// SPDX-License-Identifier: GPL-3.0-only
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
    const by = (n: string) => tiles.find((t) => t.name === n)!;
    expect(by('Hera 4').stereo).toBe(true);
    expect(by('Oracle V').stereo).toBe(false);
    expect(by('8 Lire').stereo).toBe(false); // mono, as the Lyra-8 (its two delay lines sum, #658)
    expect(by('Scrounge').stereo).toBe(true); // the A and B outputs
    expect(by('Meridian 8').stereo).toBe(true); // the odd and even outputs
    expect(by('Perun 4').stereo).toBe(false); // mono, as the original
    expect(by('Spokes 6').stereo).toBe(false); // mono on the FM-1 (the XL has the pan)
    expect(by('Verona Drum 1').stereo).toBe(true); // a PAN per channel, left and right outputs (#782, D-881)
    for (const t of tiles) {
      expect(t.line.length, t.name).toBeGreaterThan(0);
      if (t.cpu !== null) expect(t.cpu, t.name).toBeGreaterThan(0);
      if (t.cpu !== null) expect(t.cpu, t.name).toBeLessThanOrEqual(100);
    }
    expect(by('basic poly').cpu).not.toBeNull(); // the plainest fits
    expect(engineTiles()[0].cpu).toBe(tiles[0].cpu); // memoized
  });

  it('describes each engine in a line of its own: its blurb, or the module list for a user engine', () => {
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
});
