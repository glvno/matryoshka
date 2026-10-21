// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import RAW from './community.json';
import { ageOf, communityEntries, enginesOf, entryProblems, fitOf, ISSUE_FORM, loadCommunity, submitUrl } from './community';
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

  it('shows age, engines and the FM-1 fit', () => {
    const now = Date.parse('2026-10-21');
    expect(ageOf('2026-10-21', now)).toBe('today');
    expect(ageOf('2026-10-18', now)).toBe('3 d');
    expect(ageOf('2026-09-30', now)).toBe('3 w');
    expect(ageOf('2026-05-01', now)).toBe('5 mo');
    expect(ageOf('2024-10-01', now)).toBe('2 y');
    for (const make of Object.values(PRESETS)) {
      const p = make();
      expect(fitOf(p).text).toMatch(/^(plays on FM-1 · \d+ %|browser only)$/);
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
