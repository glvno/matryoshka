// SPDX-License-Identifier: GPL-3.0-only
// The tables of docs/ARCHITECTURE.md "Estimated CPU load", as Markdown: the factory patches (estimate against the device
// survey) and every module type at its defaults (run + cv + node cycles of src/cpu-costs.json, in us and % of the block).
// Model figures, calibrated on whole patches; nothing here is measured per module. Run from web/ after npm run cpu-costs:
//   npx vite-node scripts/cpu-table.ts
import { readFileSync } from 'node:fs';
import { CPU, cpuEstimate } from '../src/cpu';
import { DEFS } from '../src/modules';
import { FM1_PRESETS } from '../src/presets';

type Reading = { name: string; idle_us: number; n1_us: number; n4_us: number; n8_us: number; budget_us: number };
const survey = JSON.parse(readFileSync(new URL('../../docs/measurements/cpu-survey-2026-10-20.json', import.meta.url), 'utf8')) as Reading[];
const pct = (x: number): string => x.toFixed(1);

console.log('| patch | device peak % | estimate % | difference |');
console.log('|---|---:|---:|---:|');
for (const r of survey) {
  const name = Object.keys(FM1_PRESETS).find((n) => n.toLowerCase() === r.name.toLowerCase());
  if (!name) throw new Error(`the survey's ${r.name} is not a factory patch`);
  const device = (100 * Math.max(r.idle_us, r.n1_us, r.n4_us, r.n8_us)) / r.budget_us;
  const est = 100 * cpuEstimate(FM1_PRESETS[name]()).use;
  console.log(`| ${name} | ${pct(device)} | ${pct(est)} | ${est >= device ? '+' : ''}${pct(est - device)} |`);
}

console.log('\n| module | type | cycles | us | % of the block |');
console.log('|---|---|---:|---:|---:|');
const rows = Object.entries(CPU.types).map(([type, t]) => ({ type, cycles: t.run + t.cv + CPU.node }));
rows.sort((a, b) => b.cycles - a.cycles || (a.type < b.type ? -1 : 1));
for (const { type, cycles } of rows) {
  const us = cycles / CPU.cyclesPerUs;
  console.log(`| ${DEFS[type].label} | \`${type}\` | ${cycles} | ${us.toFixed(0)} | ${((100 * us) / CPU.blockUs).toFixed(1)} |`);
}
