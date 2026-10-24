// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import RAW from './community.json';
import {
  addCommunity, addedCommunity, addedTitles, ageOf, communityEntries, enginesOf, entryProblems, familiesOf, ISSUE_FORM, isAdded, loadCommunity, pairXl,
  removeCommunity, submitUrl, unlinkSaved, xlBase, type CommunityEntry,
} from './community';
import { chipOf } from './sandbox';
import { DEFS } from './modules';
import { PRESETS } from './presets';
import { decodeShare, encodeShare } from './share';

describe('the community list (#157)', () => {
  // the guard for every accepted submission: a broken code, a missing author or licence fails here
  it('every entry has its fields, its licence and a code that decodes to a valid patch', async () => {
    expect(Array.isArray(RAW)).toBe(true);
    for (const raw of RAW as unknown[]) {
      expect(entryProblems(raw), JSON.stringify(raw).slice(0, 120)).toEqual([]);
      await expect(decodeShare((raw as { code: string }).code, DEFS)).resolves.toBeTruthy();
    }
    expect(communityEntries()).toHaveLength((RAW as unknown[]).length);
    expect((await loadCommunity()).every((c) => c.patch)).toBe(true);
  });

  it('names what is wrong with an entry', async () => {
    const { code } = await encodeShare(Object.values(PRESETS)[0]());
    const good = { title: 'A patch', author: 'someone', licence: 'CC-BY-SA-4.0', source: 'https://www.reddit.com/r/MVaveFM1/comments/x', code, added: '2026-10-21' };
    expect(entryProblems(good)).toEqual([]);
    expect(entryProblems({ ...good, author: ' ' })).toEqual(['no author']);
    expect(entryProblems({ ...good, licence: 'CC-BY-4.0' })).toEqual(['the licence is not CC-BY-SA-4.0']);
    expect(entryProblems({ ...good, licence: undefined })).toEqual(['the licence is not CC-BY-SA-4.0']);
    expect(entryProblems({ ...good, source: 'javascript:alert(1)' })).toEqual(['the source is not an https URL']);
    expect(entryProblems({ ...good, added: '21.10.2026' })).toEqual(['added is not a YYYY-MM-DD date']);
    expect(entryProblems({ ...good, code: 'x' })).toEqual(['the code is not a share link value']);
    await expect(decodeShare(code.slice(0, -12) + 'AAAAAAAAAAAA', DEFS)).rejects.toThrow();
    // ill-formed entries are left out, the rest newest first
    const list = communityEntries([{ ...good, title: 'old', added: '2026-01-01' }, { ...good, author: '' }, { ...good, title: 'new', added: '2026-10-01' }]);
    expect(list.map((e) => e.title)).toEqual(['new', 'old']);
  });

  it('shows age, engines and the chip', () => {
    const now = Date.parse('2026-10-21');
    expect(ageOf('2026-10-21', now)).toBe('today');
    expect(ageOf('2026-10-18', now)).toBe('3 d');
    expect(ageOf('2026-09-30', now)).toBe('3 w');
    expect(ageOf('2026-05-01', now)).toBe('5 mo');
    expect(ageOf('2024-10-01', now)).toBe('2 y');
    for (const make of Object.values(PRESETS)) {
      const p = make();
      expect(chipOf(p).text).toMatch(/^(FM-1 · \d+ %|SANDBOX)$/);
      expect(enginesOf(p).every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    }
  });

  it('fills in the issue form from a patch and its link', () => {
    expect(submitUrl()).toBe(ISSUE_FORM);
    const u = new URL(submitUrl({ name: 'Acid & co' }, 'https://glvno.github.io/matryoshka/#p=abc'));
    expect(u.searchParams.get('template')).toBe('community-patch.yml');
    expect(u.searchParams.get('patch-title')).toBe('Acid & co');
    expect(u.searchParams.get('link')).toBe('https://glvno.github.io/matryoshka/#p=abc');
    // the ids the URL fills exist in the form, and the form states the licence and requires the checkbox
    const form = readFileSync(new URL('../../.github/ISSUE_TEMPLATE/community-patch.yml', import.meta.url), 'utf8');
    for (const id of ['patch-title', 'link', 'author']) expect(form).toContain(`id: ${id}`);
    expect(form).toContain('CC BY-SA 4.0');
    expect(form).toMatch(/required: true/);
    expect(form).toContain('community-patch');
  });
});

describe('families and XL pairing', () => {
  it('reads an XL name', () => {
    expect(xlBase('Sol 29N XL')).toBe('Sol 29N');
    expect(xlBase(' Algo Four XL ')).toBe('Algo Four');
    expect(xlBase('XL')).toBeNull();
    expect(xlBase('Sol 29NXL')).toBeNull();
    expect(xlBase('Sol 29N')).toBeNull();
  });

  it('moves each XL right under its FM-1 version, and leaves an XL without one where it is', () => {
    expect(pairXl(['A XL', 'B', 'A', 'C XL', 'B XL'])).toEqual([
      { name: 'B', xl: false }, { name: 'B XL', xl: true }, { name: 'A', xl: false }, { name: 'A XL', xl: true }, { name: 'C XL', xl: false },
    ]);
  });

  it('makes one family of an FM-1 version and its XL, the FM-1 version first', () => {
    const e = (title: string): { entry: CommunityEntry } => ({ entry: { title } as CommunityEntry });
    const fams = familiesOf([e('Sol 29N XL'), e('Lire + Elvira'), e('Sol 29N')]);
    expect(fams.map((f) => [f.name, f.members.map((m) => m.entry.title)])).toEqual([
      ['Sol 29N', ['Sol 29N', 'Sol 29N XL']],
      ['Lire + Elvira', ['Lire + Elvira']],
    ]);
  });
});

describe('adding community patches to Your patches', () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  });

  it('keeps the added titles in this browser, the latest first; removing un-adds', async () => {
    const [a, b] = (await loadCommunity()).map((c) => c.entry.title);
    expect(addedTitles()).toEqual([]);
    expect(addCommunity(a)).toBe(true);
    expect(addCommunity(b)).toBe(true);
    expect(addCommunity(a)).toBe(true); // already there: no second copy
    expect(addedTitles()).toEqual([b, a]);
    expect(JSON.parse(mem.get('matryoshka.community-added')!)).toEqual([b, a]);
    expect(addedCommunity().map((c) => c.entry.title)).toEqual([b, a]);
    expect(removeCommunity(b)).toBe(true);
    expect(isAdded(b)).toBe(false);
    expect(addedTitles()).toEqual([a]);
  });

  it('drops the link once the user saves a patch of that name, and leaves out titles no longer in the list', async () => {
    const [a, b] = (await loadCommunity()).map((c) => c.entry.title);
    mem.set('matryoshka.community-added', JSON.stringify([a, 'Gone from the list', b]));
    expect(addedCommunity().map((c) => c.entry.title)).toEqual([a, b]);
    unlinkSaved(['Mine', a]);
    expect(addedTitles()).toEqual(['Gone from the list', b]);
  });

  it('reads nothing when the storage holds garbage', () => {
    mem.set('matryoshka.community-added', '{"no": 1}');
    expect(addedTitles()).toEqual([]);
  });
});
