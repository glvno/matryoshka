// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, LINK_MAX, PAGES_URL, shareCodeOf, shareLink } from './share';
import { DEFS } from './modules';
import { PRESETS } from './presets';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { demoPatch } from './demo';
import { emptyPatch, addModule, validatePatch } from './patch';

describe('share links', () => {
  it('round-trips every factory patch through the fragment, well under the link limit', async () => {
    for (const make of Object.values(PRESETS)) {
      const p = make();
      const s = await encodeShare(p, { base: 'https://example.test/x/' });
      expect(s).toMatchObject({ layout: true, layoutFits: true, tooLong: false });
      expect(s.length).toBe(s.link.length);
      expect(s.length).toBeLessThan(LINK_MAX / 2);
      expect(/^[A-Za-z0-9_-]+$/.test(s.code)).toBe(true);
      expect(await decodeShare(s.code, DEFS)).toEqual(p);
      expect(shareCodeOf(s.link)).toBe(s.code);
      expect(s.link).toBe(shareLink(s.code, 'https://example.test/x/'));
    }
    expect(shareCodeOf('https://example.test/')).toBeNull();
  });

  it('keeps assemblies and layout, and drops them only when the link would be too long', async () => {
    const p = emptyPatch('big');
    addModule(p, DEFS.fm1, 0, 0);
    const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'voice')!, 300, 100);
    const { code } = await encodeShare(p);
    const q = await decodeShare(code, DEFS);
    expect(q.assemblies?.[0].label).toBe(a.label);
    expect(q.modules[1].x).toBe(p.modules[1].x);
  });

  it('drops the layout when asked to, or when it does not fit (the Demo); the slim form is still checked', async () => {
    const oracle = PRESETS['Oracle V']();
    const lean = await encodeShare(oracle, { layout: false });
    expect(lean).toMatchObject({ layout: false, layoutFits: true, tooLong: false });
    expect((await decodeShare(lean.code, DEFS)).assemblies).toBeUndefined();
    expect(lean.link.startsWith(PAGES_URL)).toBe(true);
    const demo = await encodeShare(demoPatch());
    expect(demo).toMatchObject({ layout: false, layoutFits: false, tooLong: false });
    expect(demo.length).toBeLessThanOrEqual(LINK_MAX);
  });

  it('flags a patch too big for a link even without its layout', async () => {
    const p = emptyPatch('huge');
    addModule(p, DEFS.fm1, 0, 0);
    let seed = 1;
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 400; i++) {
      const m = addModule(p, DEFS.osc, i * 10, 0);
      for (const k of Object.keys(m.params)) m.params[k] = rnd();
    }
    const s = await encodeShare(p);
    expect(s).toMatchObject({ layout: false, layoutFits: false, tooLong: true });
    expect(s.length).toBeGreaterThan(LINK_MAX);
  });

  it('carries the notes through a link and through Save .json / Load .json', async () => {
    const p = { ...PRESETS.Init(), notes: 'The clap retriggers the LFO. Play anything in C.' };
    for (const layout of [true, false]) expect((await decodeShare((await encodeShare(p, { layout })).code, DEFS)).notes).toBe(p.notes);
    expect(validatePatch(JSON.parse(JSON.stringify(p, null, 2)), DEFS).notes).toBe(p.notes);
  });
});
