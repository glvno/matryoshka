// SPDX-License-Identifier: GPL-3.0-only
// A CPU cost table (src/cpu-costs.json, or another given by --table, such as scripts/cpu-costs-emu.ts's) against the test
// rig: each factory patch's estimate beside the rig's steady peak (the median of a phase's 500 ms peaks after the first, the
// most over the phases it played without shedding), with the error in points of the block and in percent, for the table
// alone and with its engine factors (CpuTable.rig), and the time per block (fixedUs plus the second core's idle cost: the
// emulator table's PEAK) that fits the rig best: the mean of the rig less the estimate of the table alone without it. Two sets:
//   - the 1.14 bank's graphs (src/cpu-survey-factory-1.14.json) on the rig's survey of them
//     (docs/measurements/cpu-survey-2026-11-14-rig-modctl*.json, the survey cpu.test.ts holds the estimate to);
//   - today's factory patches on the newest rig survey that played each one (RECENT below; those builds differ from one
//     another and from the release a little: each row names its survey).
// Run from web/: npx vite-node scripts/cpu-rig-check.ts [--md] [--table PATH]   (--md: the tables as Markdown)
import { readFileSync } from 'node:fs';
import { CPU, cpuEstimate, type CpuTable } from '../src/cpu';
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

const at = process.argv.indexOf('--table');
const TABLE: CpuTable = at > 0 ? JSON.parse(readFileSync(process.argv[at + 1], 'utf8')) : CPU;
/** the table without its engine factors */
const alone: CpuTable = { ...TABLE, rig: undefined };
interface Row { name: string; survey: string; rig: number; est: number; bare: number }
const peakUs = TABLE.fixedUs + (TABLE.cores?.idleUs ?? 0);
const row = (name: string, survey: string, rig: number, p: Patch): Row => ({ name, survey, rig, est: cpuEstimate(p, TABLE).us, bare: cpuEstimate(p, alone).us });

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
const fit = all.reduce((s, r) => s + r.rig - (r.bare - peakUs), 0) / all.length;
const md = process.argv.includes('--md');
/** rms in points and in percent, and the range in points, of `est` against the rig */
function summary(rows: Row[], est: (r: Row) => number): string {
  const errs = rows.map((r) => pts(est(r) - r.rig));
  const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  const pct = Math.sqrt(rows.reduce((s, r) => s + (est(r) / r.rig - 1) ** 2, 0) / rows.length);
  const inside = errs.filter((e) => e >= -3 && e <= 5).length;
  return `rms ${rms.toFixed(1)} points (${(100 * pct).toFixed(1)} %), from ${Math.min(...errs).toFixed(1)} to +${Math.max(...errs).toFixed(1)} points, ${inside} of ${rows.length} within -3 / +5`;
}
function show(title: string, rows: Row[]): void {
  const f = (us: number): string => pts(us).toFixed(1);
  if (md) {
    console.log(`\n${title}\n\n| patch | rig % | table alone % | error (points) | with factors % | error (points) | survey |\n|---|---:|---:|---:|---:|---:|---|`);
    for (const r of rows) console.log(`| ${r.name} | ${f(r.rig)} | ${f(r.bare)} | ${f(r.bare - r.rig)} | ${f(r.est)} | ${f(r.est - r.rig)} | ${r.survey.replace('cpu-survey-', '')} |`);
    console.log(`\n${rows.length} patches. Table alone: ${summary(rows, (r) => r.bare)}. With factors: ${summary(rows, (r) => r.est)}.`);
    return;
  }
  console.log(`\n${title}`);
  for (const r of rows) console.log(`${r.name.padEnd(16)} rig ${f(r.rig).padStart(5)} %  alone ${f(r.bare).padStart(5)} % ${f(r.bare - r.rig).padStart(6)}  factors ${f(r.est).padStart(5)} % ${f(r.est - r.rig).padStart(6)}  ${r.survey}`);
  console.log(`table alone:  ${summary(rows, (r) => r.bare)}\nwith factors: ${summary(rows, (r) => r.est)}`);
}
show('The 1.14 bank on its rig survey (cpu-survey-2026-11-14-rig-modctl*.json)', setA);
show('Today\'s factory patches on the newest rig survey of each', setB);
console.log(`\nthe steady peak's term that fits both sets with the table alone: ${fit.toFixed(0)} us a block (the table has ${peakUs.toFixed(0)})`);
