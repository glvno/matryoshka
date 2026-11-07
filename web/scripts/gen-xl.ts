// SPDX-License-Identifier: GPL-3.0-only
// Writes the XLs (web/presets/xl/<slug>.json) from scripts/xl/index.ts: the full browser versions of factory patches cut
// down to fit the FM-1 (scripts/xl/xl.ts). Run gen-presets.ts first (an XL starts from its FM-1 version's file). The FM-1's
// budget does not bind an XL: the log says whether it fits or is a sandbox patch, and why. Nothing here reaches the FM-1:
// export-defs.ts and the bank read only web/presets/*.json (src/presets.ts FM1_PRESETS).
// Run from web/:  npx vite-node scripts/gen-xl.ts
// `--shard i/n` builds and writes only every n-th XL from the i-th (0-based) and deletes nothing: n of them at once, one per
// core, make every file in a fraction of the time (to check quickly that the committed XLs are current).
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { FM1_PRESETS } from '../src/presets';
import { browserOnly } from '../src/patchbin';
import { XLS } from './xl/index';
import { buildXls, xlFile } from './xl/xl';
import { headroom, loudnessOutput } from './factory-build';

const DIR = new URL('../presets/xl/', import.meta.url);
const shardArg = process.argv.indexOf('--shard');
const shard = shardArg < 0 ? undefined : (/^(\d+)\/(\d+)$/.exec(process.argv[shardArg + 1] ?? '') ?? undefined)?.slice(1).map(Number);
if (shardArg >= 0 && !(shard && shard[0] < shard[1])) throw new Error('--shard takes i/n, 0 <= i < n');
// (build and check them all before a file is touched; then the Output by the loudness rule, #448; last, headroom: the Output so that no way of playing an XL clips,
// its engines' presets too, #440)
const built = buildXls(shard ? XLS.filter((_, i) => i % shard[1] === shard[0]) : XLS, FM1_PRESETS).map((b) => ({ ...b, patch: headroom(loudnessOutput(b.patch)) }));
mkdirSync(DIR, { recursive: true });
if (!shard) for (const f of readdirSync(DIR)) if (f.endsWith('.json')) unlinkSync(new URL(f, DIR));
for (const { patch, budget: b } of built) {
  writeFileSync(new URL(xlFile(patch.name), DIR), JSON.stringify(patch, null, 1) + '\n');
  const why = [...browserOnly(patch), ...b.over.filter((i) => i.key !== 'browser').map((i) => (i.key === 'cpu' ? `CPU ${i.used} %` : `${i.used} ${i.label} of ${i.max}`))];
  console.log(`${patch.name.padEnd(20)} cpu ${(b.cpu.use * 100).toFixed(0)} %  memory ${(b.memory * 100).toFixed(0)} %  ${b.fits ? 'fits the FM-1' : `SANDBOX: ${why.join(', ')}`}`);
}
if (!built.length && !shard) console.log('no XLs (scripts/xl/index.ts lists none)');
