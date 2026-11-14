// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import MANIFEST from '../community/factory.json';
import FINGERPRINTS from '../community/fingerprints.json';
import SUBMISSIONS from '../community/submissions.json';
import RAW from './community.json';
import { communityEntries, familiesOf, loadCommunity, xlBase } from './community';
import { relocatedPatches } from './community-factory';
import { inflate } from './share';

const originals = import.meta.glob<{ name: string }>('../community/factory/*.json', { eager: true, import: 'default' });

describe('preserved factory patches in Community', () => {
  it('bundles and exposes every original unchanged, including earlier versions of same-name defaults', async () => {
    const entries = communityEntries();
    for (const { file, ...meta } of MANIFEST) {
      const original = originals[`../community/factory/${file}`];
      const entry = RAW.find(e => e.title === meta.title);
      expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe(FINGERPRINTS[meta.title as keyof typeof FINGERPRINTS]);
      expect(relocatedPatches[meta.title]().name).toBe(meta.title);
      expect(entry).toMatchObject(meta);
      expect(entry!.licence).toBe('GPL-3.0-only');
      expect(JSON.parse(await inflate(entry!.code))).toEqual(original);
      expect(entries.find(e => e.title === meta.title)).toEqual(entry);
    }
  });

  it('keeps existing CC submissions exactly as submitted, and publishes no duplicate titles', () => {
    const entries = communityEntries();
    expect(RAW).toHaveLength(SUBMISSIONS.length + MANIFEST.length);
    expect(entries).toHaveLength(SUBMISSIONS.length + MANIFEST.length);
    expect(RAW.slice(0, SUBMISSIONS.length)).toEqual(SUBMISSIONS);
    expect(new Set(RAW.map(e => e.title)).size).toBe(RAW.length);
    for (const submission of SUBMISSIONS) expect(entries.find(e => e.title === submission.title)).toEqual(submission);
    expect(new Set(entries.map(e => e.title)).size).toBe(entries.length);
  });

  it('keeps Hera 4 attributed and visible beside its XL without renaming it to the selected Hera 3', async () => {
    const families = familiesOf(await loadCommunity());
    expect(xlBase('Hera 6 XL')).toBe('Hera 3');
    const hera = families.find(f => f.name === 'Hera 4')!;
    expect(hera.members.map(m => m.entry.title)).toEqual(['Hera 4', 'Hera 6 XL']);
    expect(hera.members.map(m => m.patch?.name)).toEqual(['Hera 4', 'Hera 6 XL']);
    for (const member of hera.members) {
      expect(member.entry).toMatchObject({ author: 'michael glaviano', licence: 'GPL-3.0-only', source: 'https://github.com/glvno/matryoshka' });
    }
    expect(families.flatMap(f => f.members.map(m => m.entry.title))).not.toContain('Hera 3');
  });

  it('returns independent copies without changing a saved or shared original', () => {
    for (const make of Object.values(relocatedPatches)) {
      const first = make(), second = make();
      first.modules[0].params.tempo = 91;
      expect(make()).toEqual(second);
    }
  });
});
