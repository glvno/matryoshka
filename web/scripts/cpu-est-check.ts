// SPDX-License-Identifier: GPL-3.0-only
// One check of cpu-checks.ts, the CPU model's view: per module its estimated cycles (compare npm run cpu-hot -- --nodes NAME,
// the counted ones), then the device form's modules and cables. Run from web/: npx vite-node scripts/cpu-est-check.ts NAME
import { cpuEstimate } from '../src/cpu';
import { cpuChecks } from '../src/cpu-checks';
import { deviceView } from '../src/poly';

const name = process.argv[2];
const c = cpuChecks(72).find((x) => x.name === name);
if (!c) throw new Error(`no check ${name}`);
const e = cpuEstimate(c.patch);
const dv = deviceView(c.patch, true);
for (const m of e.modules) console.log(`${m.type}#${m.id} x${m.copies} ${Math.round(m.cycles)}`);
console.log('total', Math.round(e.cycles));
for (const m of dv.patch.modules) console.log(m.id, m.type, JSON.stringify(m.params));
console.log(dv.patch.cables.map((x) => `${x.from.module}.${x.from.port}->${x.to.module}.${x.to.port}`).join('  '));
console.log('groups', dv.groups.map((g) => [...g.modules].join(',')).join(' | '));
