// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, handOut, LINK_MAX, openShareLink, PAGES_URL, shareCodeOf, shareLink, storedIdOf, storedLink } from './share';
import { fetchCode, storeCode, type Kv } from './share-store';
import { DEFS } from './modules';
import { PRESETS, xlBase } from './presets';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { demoPatch } from './demo';
import { emptyPatch, addModule, validatePatch } from './patch';

const memoryKv = (): Kv & { size(): number } => {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), size: () => m.size };
};

describe('share links', () => {
  it('round-trips every factory patch through the fragment, well under the link limit', async () => {
    for (const make of Object.values(PRESETS)) {
      const p = make();
      const s = await encodeShare(p, { base: 'https://example.test/x/' });
      expect(s.length).toBe(s.link.length);
      expect(/^[A-Za-z0-9_-]+$/.test(s.code)).toBe(true);
      if (xlBase(p.name)) {
        // an XL may be over LINK_MAX: then it is handed out as a stored link (docs/ledger/editor.md D-586), whole, with
        // its layout
        expect(s.tooLong, p.name).toBe(false);
        const h = await handOut(s, { base: 'https://example.test/x/', store: async () => 'abcdefghijkl' });
        expect(h.layout, p.name).toBe(true);
        expect(await decodeShare(s.full, DEFS)).toEqual(p);
      } else {
        expect(s).toMatchObject({ layout: true, layoutFits: true, tooLong: false });
        expect(s.length).toBeLessThan(LINK_MAX * 0.75); // an FM-1 version (Briefcase 3, the VCS3's control columns: about 5800)
      }
      if (s.layout) expect(await decodeShare(s.code, DEFS)).toEqual(p);
      expect(shareCodeOf(s.link)).toBe(s.code);
      expect(s.link).toBe(shareLink(s.code, 'https://example.test/x/'));
    }
    expect(shareCodeOf('https://example.test/')).toBeNull();
    expect(storedIdOf(storedLink('abcdefghijkl', 'https://example.test/x/#p=zz'))).toBe('abcdefghijkl');
    expect(storedIdOf('https://example.test/#s=short')).toBeNull();
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
    // the positions go, the assemblies (which modules they hold) stay
    const back = await decodeShare(lean.code, DEFS);
    expect(back.modules.every((m) => m.x === 0 && m.y === 0)).toBe(true);
    expect(back.assemblies?.map((a) => [a.label, a.modules, a.children, !!a.poly])).toEqual(oracle.assemblies?.map((a) => [a.label, a.modules, a.children, !!a.poly]));
    expect(lean.link.startsWith(PAGES_URL)).toBe(true);
  });

  it('the Demo: too long for a plain link, so it is stored whole (layout and assemblies) and opens as it was', async () => {
    const demo = demoPatch();
    const s = await encodeShare(demo, { base: PAGES_URL });
    expect(s).toMatchObject({ layout: false, layoutFits: false, stores: true, tooLong: false });
    const kv = memoryKv();
    const store = async (code: string): Promise<string> => {
      const r = await storeCode(kv, code);
      if (!('id' in r)) throw new Error(r.error);
      return r.id;
    };
    const h = await handOut(s, { base: PAGES_URL, store });
    expect(h).toMatchObject({ stored: true, layout: true });
    expect(h.length).toBeLessThan(100);
    const fetchKv = (async (url: string) => {
      const code = await fetchCode(kv, String(url).split('/').pop()!);
      return new Response(code ?? 'no', { status: code === null ? 404 : 200 });
    }) as typeof fetch;
    const back = await openShareLink(h.link, DEFS, fetchKv);
    expect(back).toEqual(validatePatch(JSON.parse(JSON.stringify(demo)), DEFS));
    expect(back!.modules.map((m) => [m.x, m.y])).toEqual(demo.modules.map((m) => [m.x, m.y]));
    expect(back!.assemblies?.length).toBe(demo.assemblies?.length);
    // the same patch, the same id: nothing is stored twice
    expect((await handOut(s, { base: PAGES_URL, store })).link).toBe(h.link);
    expect(kv.size()).toBe(1);
  });

  it('the Demo when the site cannot store it: no link (its lean form keeps the assemblies and is over the limit too)', async () => {
    const s = await encodeShare(demoPatch(), { base: PAGES_URL });
    expect(s.fits).toBe(false);
    await expect(handOut(s, { store: async () => { throw new Error('offline'); } })).rejects.toThrow(/offline/);
  });

  it('a patch with the layout unticked that fits: the lean `#p=` link, nothing stored', async () => {
    const s = await encodeShare(PRESETS['Oracle V'](), { layout: false });
    const h = await handOut(s, { store: async () => { throw new Error('must not store'); } });
    expect(h).toMatchObject({ stored: false, layout: false });
    expect(h.link).toBe(s.link);
  });

  it('a patch too long for any plain link is stored', async () => {
    const p = emptyPatch('huge');
    addModule(p, DEFS.fm1, 0, 0);
    let seed = 1;
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 400; i++) {
      const m = addModule(p, DEFS.osc, i * 10, 0);
      for (const k of Object.keys(m.params)) m.params[k] = rnd();
    }
    const s = await encodeShare(p);
    expect(s).toMatchObject({ layout: false, layoutFits: false, fits: false, stores: true, tooLong: false });
    expect(s.length).toBeGreaterThan(LINK_MAX);
    expect((await handOut(s, { store: async () => 'abcdefghijkl' })).link.endsWith('#s=abcdefghijkl')).toBe(true);
  });

  it('carries the notes through a link and through Save .json / Load .json', async () => {
    const p = { ...PRESETS.Init(), notes: 'The clap retriggers the LFO. Play anything in C.' };
    for (const layout of [true, false]) expect((await decodeShare((await encodeShare(p, { layout })).code, DEFS)).notes).toBe(p.notes);
    expect(validatePatch(JSON.parse(JSON.stringify(p, null, 2)), DEFS).notes).toBe(p.notes);
  });
});
