// SPDX-License-Identifier: GPL-3.0-only
// Refresh released-set name membership for bank_add (not saved-patch replacement).
// Run when recording a new release: npx vite-node scripts/legacy-factory.ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const git = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 });

// The factory sets the released firmwares wrote (presets.h at each release tag): web/scripts/released-factory.json, which
// export-defs turns into presets.h's RELEASED_SETS. After an update, the FM-1 adds a factory patch the bank's set did not
// have by name into a free slot (main.c bank_add, #630). A release from before the set id (1.6.0 and older) keeps set 0, its
// names those of every such release. The list as it stands is kept: a tag missing here (a shallow clone) drops nothing.
type Released = { set: string; tags: string[]; names: string[] };
const REL = new URL('./released-factory.json', import.meta.url);
const sets = new Map<string, Released>();
if (existsSync(REL)) for (const e of (JSON.parse(readFileSync(REL, 'utf8')) as { sets: Released[] }).sets) sets.set(e.set, e);
const tags = git('tag', '-l', 'v*', '--sort=v:refname').split('\n').filter(Boolean);
for (const t of tags) {
  let src: string;
  try {
    src = git('show', `${t}:firmware/src/presets.h`);
  } catch {
    continue;
  }
  const set = src.match(/#define FACTORY_SET_ID 0x([0-9a-f]+)u/)?.[1]?.padStart(6, '0') ?? '000000';
  const e = sets.get(set) ?? { set, tags: [], names: [] };
  if (!e.tags.includes(t)) e.tags.push(t);
  for (const m of src.matchAll(/\{"([^"]*)", PRESET_\d+,/g)) if (!e.names.includes(m[1])) e.names.push(m[1]);
  sets.set(set, e);
}
const released = [...sets.values()].sort((a, b) => a.set.localeCompare(b.set));
writeFileSync(REL, JSON.stringify({ note: 'web/scripts/legacy-factory.ts: the factory sets released firmwares wrote (set id, 000000 = before the id; the release tags; the names)', sets: released }, null, 1) + '\n');
console.log(`${released.length} released factory sets from ${tags.length} release tags`);
