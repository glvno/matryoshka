// SPDX-License-Identifier: GPL-3.0-only
// The per-module table of docs/ARCHITECTURE.md "Estimated CPU load", as Markdown: every module type at its defaults (run + cv +
// node cycles of src/cpu-costs.json, in us and % of the block, at the scale alone: a factory engine's factor is not in it).
// Model figures, calibrated on whole patches; nothing here is measured per module. The factory patches against the test rig:
// scripts/cpu-rig-fit.ts. Run from web/ after npm run cpu-costs:
//   npx vite-node scripts/cpu-table.ts
import { CPU } from '../src/cpu';
import { DEFS } from '../src/modules';

console.log('| module | type | cycles | us | % of the block |');
console.log('|---|---|---:|---:|---:|');
const rows = Object.entries(CPU.types).map(([type, t]) => ({ type, cycles: t.run + t.cv + CPU.node }));
rows.sort((a, b) => b.cycles - a.cycles || (a.type < b.type ? -1 : 1));
for (const { type, cycles } of rows) {
  const us = cycles / CPU.cyclesPerUs;
  console.log(`| ${DEFS[type].label} | \`${type}\` | ${cycles} | ${us.toFixed(0)} | ${((100 * us) / CPU.blockUs).toFixed(1)} |`);
}
