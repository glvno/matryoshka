// SPDX-License-Identifier: GPL-3.0-only
// The two-core plan (schedule.ts schedule, engine.c sched_build) against the plans before it, timed with the test rig's own
// module times (#1073): each patch's block, as the lanes would render it, with every module copy at its measured time.
//   npx vite-node scripts/plan-eval.ts -- BENCH_DIR DIR.. [--fix "NAME=BASE" ..] [--json OUT]
// DIR: `tools/m1_link.py --rig modtime 3 --notes 8 --patch NAME --json DIR/modtime-NAME-8.json` files (spaces as `_`), the
// first file of a name wins; a factory patch by name, else BENCH_DIR/NAME.json. --fix: a patch that shed voices while it was
// measured takes, module by module, the larger of its time and BASE's where both have the same type at the same index (its
// voices from BASE, its effects from itself). Plans:
//   main    each copy where it ends first, at the CPU table's costs (the FM-1 before #1073)
//   median  the same at the rig's median costs alone (PR #1079's first version)
//   plan    schedule(): the rig's plan where it ends sooner by 1 / SCH_GAIN, else main's
// The timing model, fitted to the rig's block times (blocktime: core 0's voices span) on the benchmark patches that shed
// nothing: each item costs its module's time per copy plus ITEM_CYCLES (rendering it beyond the module's own timed span); a
// wait across the cores SCH_SYNC x 64 cycles, the hand-over SCH_FORK x 64. Points: of the 2,902 us half.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { deviceView, type DeviceGroup } from '../src/poly';
import { FM1_PRESETS } from '../src/presets';
import { schedule, scheduleTime, scheduleWork, SCH_FORK, SCH_RV_MIX, SCH_SYNC, type PlanCosts, type Schedule } from '../src/schedule';
import { CPU, planCosts } from '../src/cpu';
import { fxHelperIds } from '../src/fx-bus';
import type { Patch } from '../src/patch';

const args = process.argv.slice(2);
const opt = (name: string): string[] => args.flatMap((a, i) => (args[i - 1] === name ? [a] : []));
const [bench, ...dirs] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const fixes = new Map(opt('--fix').map((f) => f.split('=') as [string, string]));
const out = opt('--json')[0];
const presets = FM1_PRESETS as Record<string, () => Patch>;
const CYCLES_PER_NS = 0.36;                 // the FM-1 at 360 MHz
const ITEM_CYCLES = 400;
const HALF_US = 2902;

type Row = { name: string; p: Patch; groups: DeviceGroup[]; helpers: Set<number>; ns: number[] };
function load(name: string): Row | undefined {
  for (const dir of dirs) {
    const f = readdirSync(dir).find((x) => x === `modtime-${name.replace(/ /g, '_')}-8.json`);
    if (!f) continue;
    const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { modules_ns: { core0: number; core1: number }[] };
    const src = presets[name]?.() ?? (JSON.parse(readFileSync(`${bench}/${name}.json`, 'utf8')) as Patch);
    const { patch: p, groups } = deviceView(src, true);
    return { name, p, groups, helpers: fxHelperIds(src), ns: j.modules_ns.map((m) => m.core0 + m.core1) };
  }
  return undefined;
}
const names = [...new Set(dirs.flatMap((d) => readdirSync(d).filter((f) => /^modtime-.*-8\.json$/.test(f)).map((f) => f.slice(8, -7).replace(/_/g, ' '))))];
const rows = names.map((n) => load(n)!).map((r) => {
  const base = fixes.has(r.name) ? load(fixes.get(r.name)!) : undefined;
  if (!base) return r;
  return { ...r, ns: r.ns.map((x, i) => (base.p.modules[i]?.type === r.p.modules[i].type ? Math.max(x, base.ns[i]) : x)) };
});

const { rig, table } = planCosts(CPU);
const median: PlanCosts = rig;
/** main's and PR #1079's plan: each copy, in E.order, where it would end first at these costs (as schedule() at one cost) */
function greedy(s: Schedule, p: Patch, c: PlanCosts, helpers: Set<number>): Schedule {
  const off = (m: number): boolean => !!p.modules[m].bypass && !helpers.has(p.modules[m].id) && p.modules[m].type !== 'fm1' && p.modules[m].type !== 'output';
  const lane = s.copies.map((n) => new Array<number>(n).fill(0));
  const fin = s.copies.map((n) => new Array<number>(n).fill(0));
  const end = [0, SCH_FORK];
  let total = 0, n1 = 0;
  for (const m of s.kernels) {
    const k = off(m) ? 0 : c.cost('reverb');
    const best = end[1] + k < end[0] + k ? 1 : 0;
    lane[m][1] = best;
    fin[m][1] = end[best] += k;
    total += k;
    n1 += best;
  }
  for (const m of s.order) {
    const k = off(m) ? c.bypass : s.kernels.includes(m) ? SCH_RV_MIX : c.cost(p.modules[m].type);
    for (let v = 0; v < s.copies[m]; v++) {
      let best = 0, bf = 0;
      for (let l = 0; l < (p.modules[m].type === 'steps' ? 1 : 2); l++) {
        let t = end[l];
        for (const [f, w] of s.deps.get(`${m}/${v}`)!) t = Math.max(t, fin[f][w] + (lane[f][w] !== l ? SCH_SYNC : 0));
        if (l === 0 || t + k < bf) [bf, best] = [t + k, l];
      }
      lane[m][v] = best;
      fin[m][v] = end[best] = bf;
      total += k;
      n1 += best;
    }
  }
  const items: [number, number][][] = [[], []];
  for (const m of s.kernels) items[lane[m][1]].push([m, 1]);
  for (const m of s.order) for (let v = 0; v < s.copies[m]; v++) items[lane[m][v]].push([m, v]);
  return { ...s, on: n1 > 0 && Math.max(...end) + SCH_FORK < total, lane, items };
}

const plans = ['main', 'median', 'plan'] as const;
const result: Record<string, Record<string, number>> = {};
console.log(`${'patch'.padEnd(16)} ${'main us'.padStart(8)} ${'median'.padStart(8)} ${'plan'.padStart(8)}   (points of a half against main; * one core)`);
for (const r of rows) {
  const copies = (m: number): number => r.groups.find((g) => g.modules.has(r.p.modules[m].id))?.cfg.parts ?? 1;
  const s = schedule(r.p, r.groups, rig, table, r.helpers);
  const sched: Record<(typeof plans)[number], Schedule> = { main: greedy(s, r.p, table, r.helpers), median: greedy(s, r.p, median, r.helpers), plan: s };
  const us: Record<string, number> = {};
  for (const k of plans) {
    const x = sched[k];
    const work = scheduleWork(x, (m) => ((r.ns[m] ?? 0) * CYCLES_PER_NS) / copies(m));
    const item = (m: number, v: number): number => work(m, v) + ITEM_CYCLES;
    const one = x.order.reduce((a, m) => a + Array.from({ length: x.copies[m] }, (_, v) => item(m, v)).reduce((b, c) => b + c, 0), 0);
    us[k] = (x.on ? scheduleTime(x, item, SCH_SYNC * 64, SCH_FORK * 64) : one) / CYCLES_PER_NS / 1000;
  }
  result[r.name] = us;
  const pts = (k: string): string => (((us[k] - us.main) / HALF_US) * 100).toFixed(1).padStart(7) + (sched[k as keyof typeof sched].on ? ' ' : '*');
  console.log(`${r.name.padEnd(16)} ${us.main.toFixed(0).padStart(7)}${sched.main.on ? ' ' : '*'} ${pts('median')} ${pts('plan')}`);
}
const groupsOf = { 'factory bank': rows.filter((r) => presets[r.name]), 'benchmark': rows.filter((r) => !presets[r.name]) };
for (const [g, rs] of Object.entries(groupsOf)) {
  if (!rs.length) continue;
  for (const k of ['median', 'plan']) {
    const d = rs.map((r) => ((result[r.name][k] - result[r.name].main) / HALF_US) * 100);
    const worst = rs[d.indexOf(Math.max(...d))].name;
    console.log(`${g.padEnd(13)} ${k.padEnd(7)} worst ${Math.max(...d).toFixed(1)} (${worst}), best ${Math.min(...d).toFixed(1)}, mean ${(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1)}`);
  }
}
if (out) writeFileSync(out, JSON.stringify({ itemCycles: ITEM_CYCLES, halfUs: HALF_US, us: result }, null, 1) + '\n');
