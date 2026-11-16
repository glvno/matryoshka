// SPDX-License-Identifier: GPL-3.0-only
// The CPU cost table (src/cpu-costs.json, scripts/cpu-costs.ts) against the test rig: each factory patch's estimate beside
// the rig's steady peak (the median of a phase's 500 ms peaks after the first, the most over the phases it played without
// shedding), with the error in points of the block and in percent, and the steady peak's own term (cpu-costs.ts PEAK) that
// fits the rig best: the mean of the rig less the estimate without it. Two sets:
//   - the 1.14 bank's graphs (src/cpu-survey-factory-1.14.json) on the rig's survey of them
//     (docs/measurements/cpu-survey-2026-11-14-rig-modctl*.json, the survey cpu.test.ts holds the estimate to);
//   - today's factory patches on the newest rig survey that played each one (RECENT below; those builds differ from one
//     another and from the release a little: each row names its survey).
// Run from web/: npx vite-node scripts/cpu-rig-check.ts [--md]   (--md: the tables as Markdown)
import { readFileSync } from 'node:fs';
import { CPU, cpuEstimate } from '../src/cpu';
import { DEFS } from '../src/modules';
import { validatePatch, type Patch } from '../src/patch';
import { FM1_PRESETS } from '../src/presets';

type Reading = { name: string } & Record<string, number[] | number>;
const read = (f: string): Reading[] => JSON.parse(readFileSync(new URL(`../../docs/measurements/${f}`, import.meta.url), 'utf8'));
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[(v.length - 1) >> 1];
/** a patch's steady peak (us) over its phases without shedding, or undefined */
function steady(rows: Reading[]): number | undefined {
  let best: number | undefined;
  for (const r of rows)
    for (const ph of ['n0', 'n1', 'n4', 'n8']) {
      const samples = r[`${ph}_samples`] as number[] | undefined;
      if (!samples || r[`${ph}_ovl`] || samples.length < 2 || Number(r[`${ph}_shed`])) continue;
      best = Math.max(best ?? 0, median(samples.slice(1)));
    }
  return best;
}
/** the newest rig surveys of factory patches (newest first), stopped and running */
const RECENT = [
  'cpu-survey-2026-11-15-rig-osc-phase', 'cpu-survey-2026-11-15-rig-rack-priority', 'cpu-survey-2026-11-15-rig-expander-s-ads',
  'cpu-survey-2026-11-15-rig-meridian-full', 'cpu-survey-2026-11-15-rig-scrounge-full', 'cpu-survey-2026-11-15-rig-verona-full',
  'cpu-survey-2026-11-15-rig-808-full', 'cpu-survey-2026-11-15-rig-909-full', 'cpu-survey-2026-11-15-rig-briefcase-board',
  'cpu-survey-2026-11-14-rig-modctl',
];

interface Row { name: string; survey: string; rig: number; est: number; bare: number }
const peakUs = CPU.fixedUs + (CPU.cores?.idleUs ?? 0);
const row = (name: string, survey: string, rig: number, p: Patch): Row => {
  const est = cpuEstimate(p).us;
  return { name, survey, rig, est, bare: est - peakUs };
};

const old = JSON.parse(readFileSync(new URL('../src/cpu-survey-factory-1.14.json', import.meta.url), 'utf8')) as { patches: Record<string, Patch> };
const modctl = [...read('cpu-survey-2026-11-14-rig-modctl.json'), ...read('cpu-survey-2026-11-14-rig-modctl-run.json')];
const setA: Row[] = [];
for (const [name, p] of Object.entries(old.patches)) {
  const rig = steady(modctl.filter((r) => r.name === name));
  if (rig !== undefined) setA.push(row(name, 'cpu-survey-2026-11-14-rig-modctl', rig, validatePatch(structuredClone(p), DEFS)));
}
const setB: Row[] = [];
for (const [name, make] of Object.entries(FM1_PRESETS)) {
  for (const f of RECENT) {
    const rows = [...read(`${f}.json`), ...read(`${f}-run.json`)].filter((r) => r.name.toLowerCase() === name.toLowerCase());
    const rig = steady(rows);
    if (rig === undefined) continue;
    setB.push(row(name, f, rig, make()));
    break;
  }
}

const pts = (us: number): number => (100 * us) / CPU.blockUs;
const all = [...setA, ...setB];
const fit = all.reduce((s, r) => s + r.rig - r.bare, 0) / all.length;
const md = process.argv.includes('--md');
function show(title: string, rows: Row[]): void {
  const errs = rows.map((r) => pts(r.est - r.rig));
  const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  const pct = Math.sqrt(rows.reduce((s, r) => s + (r.est / r.rig - 1) ** 2, 0) / rows.length);
  if (md) {
    console.log(`\n${title}\n\n| patch | rig % | estimate % | error (points) | error % | survey |\n|---|---:|---:|---:|---:|---|`);
    for (const r of rows) console.log(`| ${r.name} | ${pts(r.rig).toFixed(1)} | ${pts(r.est).toFixed(1)} | ${pts(r.est - r.rig).toFixed(1)} | ${(100 * (r.est / r.rig - 1)).toFixed(1)} | ${r.survey.replace('cpu-survey-', '')} |`);
    console.log(`\n${rows.length} patches: rms ${rms.toFixed(1)} points (${(100 * pct).toFixed(1)} %), from ${Math.min(...errs).toFixed(1)} to +${Math.max(...errs).toFixed(1)} points`);
    return;
  }
  console.log(`\n${title}`);
  for (const r of rows) console.log(`${r.name.padEnd(16)} rig ${pts(r.rig).toFixed(1).padStart(5)} %  estimate ${pts(r.est).toFixed(1).padStart(5)} %  ${pts(r.est - r.rig).toFixed(1).padStart(6)} points ${(100 * (r.est / r.rig - 1)).toFixed(1).padStart(6)} %  ${r.survey}`);
  console.log(`${rows.length} patches: rms ${rms.toFixed(1)} points (${(100 * pct).toFixed(1)} %), from ${Math.min(...errs).toFixed(1)} to +${Math.max(...errs).toFixed(1)} points`);
}
show('The 1.14 bank on its rig survey (cpu-survey-2026-11-14-rig-modctl*.json)', setA);
show('Today\'s factory patches on the newest rig survey of each', setB);
console.log(`\nthe steady peak's term that fits both sets: ${fit.toFixed(0)} us a block (the table has ${peakUs.toFixed(0)})`);
