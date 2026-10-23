// SPDX-License-Identifier: GPL-3.0-only
// The factory patches every earlier firmware wrote into the bank (firmware/src/presets.h in each commit of the git
// history, every branch), as fingerprints: web/scripts/legacy-factory.json, which export-defs turns into presets.h's
// LEGACY_FACTORY. After an update the FM-1 rewrites a slot that is byte for byte one of them (untouched since the factory
// bank or FACTORY RESET wrote it) with today's patch of that name, in today's format (main.c bank_upgrade). Run after a
// patch format bump, before export-defs:  npx vite-node scripts/legacy-factory.ts
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { VERSION } from '../src/patchbin';

const ROOT = new URL('../../', import.meta.url).pathname;
const git = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 });

/** FNV-1a, 32 bits (main.c fnv32 computes the same) */
function fnv32(b: Uint8Array | number[]): number {
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h;
}

const seen = new Map<string, { name: string; len: number; fnv: string; version: number }>();
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
    if (!bytes || bytes.length < 8 || bytes[0] !== 0xa1 || bytes[1] >= VERSION) continue; // (today's format needs no rewrite)
    const fnv = fnv32(bytes).toString(16).padStart(8, '0');
    const key = `${fnv}/${bytes.length}`;
    if (!seen.has(key)) seen.set(key, { name: m[1], len: bytes.length, fnv, version: bytes[1] });
  }
}
const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.fnv.localeCompare(b.fnv));
writeFileSync(new URL('./legacy-factory.json', import.meta.url), JSON.stringify({ note: 'web/scripts/legacy-factory.ts: the factory patches earlier firmwares wrote (name, length, FNV-1a of the bytes, format)', patches: list }, null, 1) + '\n');
console.log(`${list.length} earlier factory patches from ${commits.length} versions of presets.h`);
