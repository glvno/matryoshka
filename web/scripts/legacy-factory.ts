// SPDX-License-Identifier: GPL-3.0-only
// The factory patches every earlier firmware wrote into the bank (firmware/src/presets.h in each commit of the git
// history, every branch), as fingerprints: web/scripts/legacy-factory.json, which export-defs turns into presets.h's
// LEGACY_FACTORY. After an update that changed the factory set (FACTORY_SET_ID) or the format, the FM-1 rewrites a slot
// that is byte for byte one of them (untouched since the factory bank or FACTORY RESET wrote it) with today's patch of
// that name (main.c bank_upgrade). Every format counts: a factory patch changed within one format is an earlier one too.
// export-defs leaves out the ones that are byte for byte one of today's patches. Run after any change to a factory patch
// (firmware/src/presets.h), before export-defs:  npx vite-node scripts/legacy-factory.ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const git = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 });

/** FNV-1a, 32 bits (main.c fnv32 computes the same) */
function fnv32(b: Uint8Array | number[]): number {
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h;
}

const seen = new Map<string, { name: string; len: number; fnv: string; version: number }>();
// the list as it stands first: a commit whose branch was deleted since is gone from the history, not from the FM-1s it
// reached (#515: a run here dropped two such fingerprints)
const OUT = new URL('./legacy-factory.json', import.meta.url);
if (existsSync(OUT)) for (const e of (JSON.parse(readFileSync(OUT, 'utf8')) as { patches: { name: string; len: number; fnv: string; version: number }[] }).patches) seen.set(`${e.fnv}/${e.len}`, e);
const commits = git('log', '--all', '--format=%H', '--', 'firmware/src/presets.h').split('\n').filter(Boolean);
for (const c of commits) {
  let src: string;
  try {
    src = git('show', `${c}:firmware/src/presets.h`);
  } catch {
    continue; // (deleted in that commit)
  }
  const data = new Map<string, number[]>();
  for (const m of src.matchAll(/static const uint8_t (PRESET_\d+)\[\d+\] = \{([^}]*)\}/g)) data.set(m[1], m[2].split(',').map(Number));
  for (const m of src.matchAll(/\{"([^"]*)", (PRESET_\d+),/g)) {
    const bytes = data.get(m[2]);
    if (!bytes || bytes.length < 8 || bytes[0] !== 0xa1) continue;
    const fnv = fnv32(bytes).toString(16).padStart(8, '0');
    const key = `${fnv}/${bytes.length}`;
    if (!seen.has(key)) seen.set(key, { name: m[1], len: bytes.length, fnv, version: bytes[1] });
  }
}
const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.fnv.localeCompare(b.fnv));
writeFileSync(OUT, JSON.stringify({ note: 'web/scripts/legacy-factory.ts: the factory patches earlier firmwares wrote (name, length, FNV-1a of the bytes, format)', patches: list }, null, 1) + '\n');
console.log(`${list.length} earlier factory patches from ${commits.length} versions of presets.h`);

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
