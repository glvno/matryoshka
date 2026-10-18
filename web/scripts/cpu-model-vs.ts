// SPDX-License-Identifier: GPL-3.0-only
// The CPU model against counted peaks saved by npm run cpu-hot -- --save F.json (any SKIP), per check: the model's error.
// Run from web/: npx vite-node scripts/cpu-model-vs.ts F.json
import { readFileSync } from 'node:fs';
import { cpuEstimate } from '../src/cpu';
import { cpuChecks } from '../src/cpu-checks';

const counted: Record<string, number> = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let lo = 0, hi = 0;
for (const c of cpuChecks(72)) {
  const n = counted[c.name];
  if (!n) continue;
  const e = cpuEstimate(c.patch).cycles;
  const err = (e - n) / n;
  lo = Math.min(lo, err);
  hi = Math.max(hi, err);
  if (err < -0.05 || err > 0.15) console.log(`${c.name.padEnd(28)} counted ${String(n).padStart(7)} model ${String(Math.round(e)).padStart(7)} ${(100 * err).toFixed(1).padStart(6)} %`);
}
console.log(`errors ${(100 * lo).toFixed(1)} % .. ${(100 * hi).toFixed(1)} %`);
