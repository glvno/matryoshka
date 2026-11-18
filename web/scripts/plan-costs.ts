// SPDX-License-Identifier: GPL-3.0-only
// The two-core plan's costs from the FM-1 itself (#802, #1073; Proposed, decider: michael glaviano): each module type's
// time per copy on the test rig, from `tools/m1_link.py --rig modtime 3 --notes 8 --patch NAME` on every factory patch
// and on the poly benchmark (scripts/poly-bench.ts), into src/plan-costs.json. export-defs makes engine.c's DEF_COST from
// it and cpu.ts planCosts reads it, so the firmware and the editor plan alike.
//   npx vite-node scripts/plan-costs.ts -- MODTIME.json [BENCH_DIR]
// MODTIME.json: {"what": ..., "patches": {NAME: {"modules_ns": [[core 0 ns, core 1 ns], ..]}}}, each module by its index in
// the device patch; NAME a factory patch, else BENCH_DIR/NAME.json. A type's cost is the median, over the modules of that
// type that ran (not bypassed when the patch loads), of its time per copy, in the plan's units (64 cycles at the CPU
// table's scale); an oscillator's per voice of its wave (schedule.ts oscVoices: the plan counts it times its voices). A
// type no measured patch uses takes the CPU table's cost times the median ratio of rig to table over the types they do use.
import { readFileSync, writeFileSync } from 'node:fs';
import { CPU } from '../src/cpu';
import { oscVoices } from '../src/schedule';
import { deviceView } from '../src/poly';
import { FM1_PRESETS } from '../src/presets';
import { DEFS } from '../src/modules';
import type { Patch } from '../src/patch';

type Survey = { what: string; patches: Record<string, { modules_ns: [number, number][] }> };
const [file, bench] = process.argv.slice(2);
if (!file) throw new Error('usage: plan-costs.ts MODTIME.json [BENCH_DIR]');
const survey = JSON.parse(readFileSync(file, 'utf8')) as Survey;
const presets = FM1_PRESETS as Record<string, () => Patch>;
const unitNs = (64 / CPU.cyclesPerUs) * 1000;
const tableUnits = (t: string): number => Math.max(1, Math.round(((CPU.types[t]?.run ?? 0) + (CPU.types[t]?.cv ?? 0)) / 64));
const per = new Map<string, number[]>();
for (const [name, rec] of Object.entries(survey.patches)) {
  const source = presets[name]?.() ?? (bench ? JSON.parse(readFileSync(`${bench}/${name}.json`, 'utf8')) as Patch : undefined);
  if (!source) throw new Error(`no patch ${name}`);
  const { patch: p, groups } = deviceView(source, true);
  p.modules.forEach((m, i) => {
    const r = rec.modules_ns[i];
    if (!r || m.bypass) return;
    const g = groups.find((x) => x.modules.has(m.id));
    const ns = (r[0] + r[1]) / (g ? g.cfg.parts : 1) / (m.type === 'osc' ? oscVoices(m) : 1);   /* (schedule.ts copies) */
    if (ns > 0) (per.get(m.type) ?? per.set(m.type, []).get(m.type)!).push(ns);
  });
}
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[(v.length - 1) >> 1];
const measured = Object.fromEntries([...per].sort(([a], [b]) => a.localeCompare(b)).map(([t, v]) => [t, Math.max(1, Math.round(median(v) / unitNs))]));
const ratio = median(Object.entries(measured).map(([t, u]) => u / tableUnits(t)));
const types: Record<string, number> = {};
for (const t of Object.keys(DEFS)) types[t] = measured[t] ?? Math.max(1, Math.round(tableUnits(t) * ratio));
const out = {
  source: `${file.replace(/^.*\/docs\//, 'docs/')}: ${survey.what}`,
  note: 'the two-core plan\'s cost of one copy of each type, in 64 cycles at the CPU table\'s scale (scripts/plan-costs.ts); measured: the types the measured patches use, the rest the table\'s cost times ratio',
  ratio: Math.round(ratio * 1000) / 1000,
  bypass: Math.max(1, Math.round((CPU.bypass / 64) * ratio)),
  measured: Object.keys(measured),
  types,
};
writeFileSync(new URL('../src/plan-costs.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`${Object.keys(measured).length} types measured, the rest at ${out.ratio} x the table; bypass ${out.bypass}`);
for (const t of Object.keys(measured)) console.log(`  ${t.padEnd(10)} ${String(types[t]).padStart(5)}  (table ${tableUnits(t)}, ${per.get(t)!.length} modules)`);
