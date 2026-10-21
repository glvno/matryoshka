// SPDX-License-Identifier: GPL-3.0-only
// Where the fixed-point engine spends its cycles, on the rv32im model of tools/cpu (the same one npm run cpu-costs counts).
//   npm run cpu-hot                           every check of cpu-checks.ts (factory patches and assemblies): peak cycles of a
//                                             block and the load that is on the FM-1 (cpu-costs.json scale)
//   npm run cpu-hot -- --save F.json          also write those numbers to F.json
//   npm run cpu-hot -- --compare F.json       and put them beside an earlier --save (before / after an engine change)
//   npm run cpu-hot -- --hot NAME [--lines N] one check, cycles by function and by source line (inlined code counts where it
//                                             was written), from a build with debug info (build/cpu/hot.elf, the same code)
// Run from web/.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
// @ts-ignore: plain JavaScript modules
import { pool } from '../../tools/cpu/pool.mjs';
// @ts-ignore: plain JavaScript modules
import { profile, readElf } from '../../tools/cpu/rv32.mjs';
import { CPU } from '../src/cpu';
import { cpuChecks } from '../src/cpu-checks';
import { encodePatch } from '../src/patchbin';
import { deviceView } from '../src/poly';
import { DEVICE_COMPILE } from '../src/device-compile';

const ROOT = new URL('../../', import.meta.url).pathname;
const NOTE = 72, BLOCKS = 24, SKIP = Number(process.env.CPU_SKIP ?? 3);
const ON = (n: number): number => (1 << 16) | n;
// CPU_NOTES=n holds only the first n notes of each check (what idle voices save when fewer keys are down than voices)
const events = (notes: number[]): number[] => [...notes.slice(0, Number(process.env.CPU_NOTES ?? notes.length)).map(ON), ...Array(BLOCKS).fill(3 << 16)];
const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const load = (c: number): number => (100 * (c / CPU.cyclesPerUs + CPU.fixedUs)) / CPU.blockUs; // as the meter (cpuEstimate)

execSync('tools/cpu/build.sh', { cwd: ROOT, stdio: 'inherit' });
const checks = cpuChecks(NOTE);
const hot = arg('--hot');

if (hot) {
  const c = checks.find((x) => x.name === hot);
  if (!c) throw new Error(`no check ${hot}: ${checks.map((x) => x.name).join(', ')}`);
  const elf = `${ROOT}build/cpu/hot.elf`;
  execSync(
    `clang --target=riscv32-unknown-elf -march=rv32im -mabi=ilp32 -Os -g -ffunction-sections -fno-builtin -ffreestanding -nostdlib -Wall -Wno-unused-function -fuse-ld=lld -Wl,-T,tools/cpu/link.ld -Ifirmware/src -DNO_PROF -o ${elf} tools/cpu/prof.c`,
    { cwd: ROOT, stdio: 'inherit' },
  );
  const hist = new Float64Array(4 << 20);
  const r = profile(readElf(elf), encodePatch(c.patch, true), events(c.notes), undefined, hist);
  const blocks = r.blocks.slice(SKIP).map((b: { total: number }) => b.total);
  const total = hist.reduce((s, v) => s + v, 0);
  const pcs: number[] = [];
  hist.forEach((v, i) => v && pcs.push(i * 4));
  // llvm-symbolizer: one JSON line per address, its inlined frames innermost first
  const lines = execFileSync('llvm-symbolizer', [`--obj=${elf}`, '--output-style=JSON', '--inlines'], { input: pcs.map((a) => '0x' + a.toString(16)).join('\n') + '\n', maxBuffer: 1 << 28 }).toString().trim().split('\n');
  const byFn = new Map<string, number>(), byLine = new Map<string, number>();
  pcs.forEach((a, i) => {
    const sym = JSON.parse(lines[i]).Symbol?.[0] ?? { FunctionName: '?', FileName: '?', Line: 0 };
    const cyc = hist[a / 4];
    const fn = sym.FunctionName;
    byFn.set(fn, (byFn.get(fn) ?? 0) + cyc);
    const key = `${String(sym.FileName).replace(/^.*\//, '')}:${sym.Line}  ${fn}`;
    byLine.set(key, (byLine.get(key) ?? 0) + cyc);
  });
  const top = (m: Map<string, number>, n: number): void => {
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, n)) console.log(`${(100 * v / total).toFixed(1).padStart(5)} %  ${String(Math.round(v)).padStart(9)}  ${k}`);
  };
  console.log(`${c.name}: ${Math.round(total)} cycles over the run, peak block ${Math.max(...blocks)} (${load(Math.max(...blocks)).toFixed(0)} %)\n-- by function`);
  top(byFn, 25);
  console.log('-- by line');
  top(byLine, Number(arg('--lines') ?? 40));
  process.exit(0);
}

if (process.argv.includes('--types')) {
  // every check's peak block, per module type: where the cycles go across the whole set
  const PROF = pool({ prof: `${ROOT}build/cpu/prof.elf` });
  const by = new Map<string, { sum: number; cv: number; run: number; n: number }>();
  let all = 0;
  await Promise.all(
    checks.map(async (c) => {
      const dv = deviceView(c.patch).patch;
      const r = await PROF.run('prof', encodePatch(c.patch, true), events(c.notes));
      const pk = r.blocks.slice(SKIP).reduce((a: { total: number }, b: { total: number }) => (b.total > a.total ? b : a));
      all += pk.total;
      for (const [key, st] of pk.nodes as Map<string, { sum: number; cv: number; run: number }>) {
        const t = dv.modules[Number(key.split('/')[0])].type;
        const e = by.get(t) ?? { sum: 0, cv: 0, run: 0, n: 0 };
        e.sum += st.sum; e.cv += st.cv; e.run += st.run; e.n++;
        by.set(t, e);
      }
    }),
  );
  let stages = { sum: 0, cv: 0, run: 0 };
  for (const [t, v] of [...by].sort((a, b) => b[1].sum + b[1].cv + b[1].run - (a[1].sum + a[1].cv + a[1].run))) {
    const tot = v.sum + v.cv + v.run;
    stages = { sum: stages.sum + v.sum, cv: stages.cv + v.cv, run: stages.run + v.run };
    console.log(`${t.padEnd(10)} ${(100 * tot / all).toFixed(1).padStart(5)} %  instances ${String(v.n).padStart(4)}  per instance ${String(Math.round(tot / v.n)).padStart(6)}   sum ${(100 * v.sum / all).toFixed(1)} %  cv ${(100 * v.cv / all).toFixed(1)} %  run ${(100 * v.run / all).toFixed(1)} %`);
  }
  console.log(`all checks' peaks ${all}: input sums ${(100 * stages.sum / all).toFixed(1)} %, parameter inputs ${(100 * stages.cv / all).toFixed(1)} %, module work ${(100 * stages.run / all).toFixed(1)} %, the rest ${(100 * (all - stages.sum - stages.cv - stages.run) / all).toFixed(1)} %`);
  process.exit(0);
}

const nodes = arg('--nodes');
if (nodes) {
  // per module of the patch as the device gets it: input sums, parameter inputs and the module's own work, summed over its
  // copies, at the peak block
  const c = checks.find((x) => x.name === nodes);
  if (!c) throw new Error(`no check ${nodes}`);
  const dv = deviceView(c.patch).patch;
  const r = profile(readElf(`${ROOT}build/cpu/prof.elf`), encodePatch(c.patch, true), events(c.notes));
  const blocks = r.blocks.slice(SKIP);
  const peakB = blocks.reduce((a: { total: number }, b: { total: number }) => (b.total > a.total ? b : a));
  const rows = new Map<string, { sum: number; cv: number; run: number; copies: number }>();
  for (const [key, st] of peakB.nodes as Map<string, { sum: number; cv: number; run: number }>) {
    const m = dv.modules[Number(key.split('/')[0])];
    const name = `${m.type}#${m.id}`;
    const e = rows.get(name) ?? { sum: 0, cv: 0, run: 0, copies: 0 };
    e.sum += st.sum; e.cv += st.cv; e.run += st.run; e.copies++;
    rows.set(name, e);
  }
  const all = [...rows].sort((a, b) => b[1].sum + b[1].cv + b[1].run - (a[1].sum + a[1].cv + a[1].run));
  let acc = 0;
  for (const [k, v] of all) {
    const t = v.sum + v.cv + v.run;
    acc += t;
    console.log(`${k.padEnd(16)} x${v.copies}  ${String(t).padStart(7)} ${(100 * t / peakB.total).toFixed(1).padStart(5)} %   sum ${v.sum}  cv ${v.cv}  run ${v.run}`);
  }
  console.log(`peak block ${peakB.total}; modules ${acc}; the rest (block loop, output, hooks) ${peakB.total - acc}`);
  process.exit(0);
}

// CPU_ELF=path counts another build of the engine (an older one: its numbers for --save / --compare); CPU_NOCOMPILE=1 sends
// the patches without the device compile pass (what firmware before it got)
if (process.env.CPU_NOCOMPILE) DEVICE_COMPILE.on = false;
const POOL = pool({ plain: process.env.CPU_ELF ?? `${ROOT}build/cpu/plain.elf` });
const before: Record<string, number> = arg('--compare') ? JSON.parse(readFileSync(arg('--compare')!, 'utf8')) : {};
const peaks: Record<string, number> = {};
await Promise.all(
  checks.map(async (c) => {
    const r = await POOL.run('plain', encodePatch(c.patch, true), events(c.notes));
    if (r.exit) throw new Error(`${c.name}: refused (${r.exit})`);
    peaks[c.name] = Math.max(...r.blocks.slice(SKIP).map((b: { total: number }) => b.total));
  }),
);
let sumB = 0, sumA = 0;
for (const c of checks) {
  const a = peaks[c.name], b = before[c.name];
  const cmp = b ? `   was ${String(b).padStart(8)} ${load(b).toFixed(0).padStart(4)} %   ${((100 * (a - b)) / b).toFixed(1).padStart(6)} %` : '';
  if (b) (sumB += b), (sumA += a);
  console.log(`${c.name.padEnd(30)} ${String(a).padStart(8)} ${load(a).toFixed(0).padStart(4)} %${cmp}`);
}
if (sumB) console.log(`all checks: ${((100 * (sumA - sumB)) / sumB).toFixed(1)} %`);
if (arg('--save')) writeFileSync(arg('--save')!, JSON.stringify(peaks, null, 1) + '\n');
process.exit(0);
