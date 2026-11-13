// SPDX-License-Identifier: GPL-3.0-only
// Run from web/: npx vite-node scripts/gen-community.ts
// Pack preserved originals as normal share codes. Never rebuild or relicense a relocated patch.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import type { CommunityEntry } from '../src/community';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const submissions = read('../community/submissions.json') as CommunityEntry[];
const originals = read('../community/factory.json') as (Omit<CommunityEntry, 'code'> & { file: string })[];
const titles = new Set(submissions.map(e => e.title));
// Every archived original remains discoverable, including earlier versions of same-name defaults.
const entries = originals.map(({ file, ...entry }): CommunityEntry => {
  if (titles.has(entry.title)) throw new Error(`Duplicate Community title: ${entry.title}`);
  titles.add(entry.title);
  const patch = read(`../community/factory/${file}`) as { name: string };
  if (patch.name !== entry.title || entry.licence !== 'GPL-3.0-only') throw new Error(`Lost original identity/licence: ${file}`);
  return { ...entry, code: deflateRawSync(JSON.stringify(patch), { level: 9 }).toString('base64url') };
});
writeFileSync(new URL('../src/community.json', import.meta.url), JSON.stringify([...submissions, ...entries], null, 1) + '\n');
console.log(`${submissions.length} unchanged submissions, ${entries.length} preserved factory patches`);
