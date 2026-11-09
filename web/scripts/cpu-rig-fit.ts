// SPDX-License-Identifier: GPL-3.0-only
// The CPU model's calibration on the test rig (scripts/cpu-costs.ts RIG; src/cpu.ts CpuTable.rig), worked out from the rig's
// surveys of the factory patches (tools/rig_cpu_survey.py): prints the constants to freeze in cpu-costs.ts and a table of
// each factory patch: the rig, the estimate before (the table's scale of 2026-10-20, no factors) and after.
//   - a target: a factory patch's steady peak (the median of a phase's samples after the first, the most over its phases at
//     rest and with 1, 4 and 8 keys, the transport stopped or running), at the voices it played: a phase where the overload
//     guard dropped parts counts at that many voices fewer, a muted phase not at all;
//   - a patch that changed since the survey of today's firmware (no target there) takes its target from the survey of the
//     firmware before, times the median rise of the patches that did not change (the same estimate in both);
//   - the scale and the fixed time per block: least squares of the targets on the estimate before (est = a x before + b);
//   - each factory engine's factor: the most any of its patch's targets needs, so the estimate reads at least what the rig
//     measured at every voice count it played.
// Run from web/: npx vite-node scripts/cpu-rig-fit.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assembliesOf, parentOf } from '../src/assembly';
import { CPU, cpuEstimate, type CpuTable } from '../src/cpu';
import { DEFS } from '../src/modules';
import { validatePatch, type Patch } from '../src/patch';
import { FM1_PRESETS } from '../src/presets';
import { deviceView } from '../src/poly';

const ROOT = new URL('../../', import.meta.url).pathname;
/** The combined development build: every factory patch, transport stopped and running. */
const NOW: { file: string; at?: Record<string, number>; only?: string[]; skip?: string[] }[] = [
  { file: 'docs/measurements/cpu-survey-2026-11-09-rig-integration.json' },
  { file: 'docs/measurements/cpu-survey-2026-11-09-rig-integration-run.json' },
];
/** the survey of the firmware before (release-1.10 with the second core) and the commit its factory patches are from */
const BEFORE = { file: 'docs/measurements/cpu-survey-2026-11-05-rig-merged-split.json', commit: 'e3235d64' };
/** factory patches renamed since a survey: the survey's name, today's */
const RENAMED: Record<string, string> = { 'Hera 5': 'Hera 4' };
/** the scale before (2026-10-20, cpu-costs.ts SURVEY then; the second core's idle cost of 2026-11-05) */
const BASE = { cyclesPerUs: 233.4, fixedUs: 23, idleUs: 24 };

type Reading = { name: string } & Record<string, number[] | number | string | boolean>;
const read = (f: string): Reading[] => JSON.parse(readFileSync(ROOT + f, 'utf8'));
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[(v.length - 1) >> 1];
const PHASES = ['n0', 'n1', 'n4', 'n8'];
const voicesOf = (p: Patch): number => Math.max(1, ...deviceView(p, true).groups.map((g) => g.cfg.parts));
/** a copy of `p` with its largest poly group at `v` voices */
const withVoices = (p: Patch, v: number): Patch => {
  const q = structuredClone(p), n = voicesOf(p);
  for (const m of q.modules) if (m.type === 'alloc' && (m.params.voices ?? 1) === n) m.params.voices = v;
  return q;
};
const base: CpuTable = { ...CPU, cyclesPerUs: BASE.cyclesPerUs, fixedUs: BASE.fixedUs, cores: { ...CPU.cores!, idleUs: BASE.idleUs }, rig: undefined };
const before = (p: Patch): number => cpuEstimate(p, base).us;

/** a survey's targets: patch name -> voices -> steady peak (us) */
function targets(files: { file: string; at?: Record<string, number>; only?: string[]; skip?: string[] }[], voices: (name: string) => number | undefined): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const f of files)
    for (const r of read(f.file)) {
      const name = RENAMED[r.name] ?? r.name;
      if ((f.only && !f.only.includes(name)) || f.skip?.includes(name)) continue;
      const n = f.at?.[name] ?? voices(name);
      if (n === undefined) continue;
      for (const ph of PHASES) {
        const s = r[`${ph}_samples`] as number[] | undefined;
        if (!s || s.length < 2 || r[`${ph}_ovl`]) continue;
        const v = n - Number(r[`${ph}_shed`] ?? 0);
        const t = out.get(name) ?? new Map<number, number>();
        t.set(v, Math.max(t.get(v) ?? 0, median(s.slice(1))));
        out.set(name, t);
      }
    }
  return out;
}

// today's patches at their own voices
const today = new Map(Object.entries(FM1_PRESETS).map(([n, f]) => [n, f()]));
const now = targets(NOW, (n) => (today.has(n) ? voicesOf(today.get(n)!) : undefined));
// patches whose structure changed since today's survey and that it could not measure (none since #781's survey)
const CHANGED = new Set<string>([]);
for (const n of CHANGED) now.delete(n);

// the survey of the firmware before, its own patches
const git = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 });
const old = new Map<string, Patch>();
for (const f of git('ls-tree', '--name-only', BEFORE.commit, 'web/presets/').split('\n').filter((x) => x.endsWith('.json'))) {
  const p = validatePatch(JSON.parse(git('show', `${BEFORE.commit}:${f}`)), DEFS);
  old.set(p.name, p);
}
const then = targets([{ file: BEFORE.file }], (n) => (old.has(n) ? voicesOf(old.get(n)!) : undefined));
const rises: number[] = [];
for (const [n, t] of now) {
  const p = today.get(n)!, q = old.get(n);
  const a = t.get(voicesOf(p)), b = then.get(n)?.get(voicesOf(p));
  if (q && a && b && Math.abs(before(p) / before(q) - 1) < 0.01) rises.push(a / b);
}
const rise = median(rises);
for (const n of CHANGED) {
  const t = then.get(n);
  if (t) now.set(n, new Map([...t].map(([v, us]) => [v, us * rise])));
}

/** a factory patch's engine: its top-level assembly of the patch's name (<7PH, the 909 Kit, Init and the like have none) */
const engineOf = (p: Patch): string | undefined => assembliesOf(p).find((x) => !parentOf(p, x.id) && x.name.toLowerCase() === p.name.toLowerCase())?.name;

// the scale and the fixed time: est = a x before + b, least squares over the targets of the patches without an engine of
// their own (what the scale is for: modules outside a factory engine; each engine then gets its factor)
const pts: { name: string; v: number; us: number; was: number; patch: Patch }[] = [];
for (const [n, t] of now)
  for (const [v, us] of t) {
    const patch = withVoices(today.get(n)!, v);
    pts.push({ name: n, v, us, was: before(patch), patch });
  }
const plain = pts.filter((p) => !engineOf(p.patch));
const N = plain.length, sx = plain.reduce((s, p) => s + p.was, 0), sy = plain.reduce((s, p) => s + p.us, 0);
const sxx = plain.reduce((s, p) => s + p.was * p.was, 0), sxy = plain.reduce((s, p) => s + p.was * p.us, 0);
const a = (N * sxy - sx * sy) / (N * sxx - sx * sx), b = (sy - a * sx) / N;
const scaled: CpuTable = { ...base, cyclesPerUs: Math.round((10 * BASE.cyclesPerUs) / a) / 10, fixedUs: Math.round(b + a * BASE.fixedUs), cores: { ...base.cores!, idleUs: Math.round(a * BASE.idleUs) } };

// each engine's factor: the most any of its patch's targets needs (bisection on the estimate, which grows with it)
const engines: Record<string, number> = {};
for (const pt of pts) {
  const e = engineOf(pt.patch);
  if (!e) continue;
  let lo = 0.3, hi = 3;
  for (let i = 0; i < 40; i++) {
    const k = (lo + hi) / 2;
    if (cpuEstimate(pt.patch, { ...scaled, rig: { engines: { [e]: k }, survey: '' } }).us < pt.us) lo = k;
    else hi = k;
  }
  engines[e] = Math.max(engines[e] ?? 0, Math.ceil(hi * 100) / 100);
}
const fitted: CpuTable = { ...scaled, rig: { engines, survey: '' } };

console.log(`rise of the unchanged patches since ${BEFORE.file}: x ${rise.toFixed(3)} (${rises.length} patches)`);
console.log(`scale: est = ${a.toFixed(3)} x before + ${b.toFixed(0)} us -> cyclesPerUs ${scaled.cyclesPerUs}, fixedUs ${scaled.fixedUs}, idleUs ${scaled.cores!.idleUs}`);
console.log(`engines: ${JSON.stringify(Object.fromEntries(Object.entries(engines).sort()))}`);
console.log('\n| patch | voices | rig | before | after |\n|---|---:|---:|---:|---:|');
const pct = (us: number): string => `${((100 * us) / CPU.blockUs).toFixed(1)} %`;
for (const pt of pts.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.v - y.v)))
  console.log(`| ${pt.name} | ${pt.v} | ${pct(pt.us)}${CHANGED.has(pt.name) ? ' (1.10 x rise)' : ''} | ${pct(pt.was)} | ${pct(cpuEstimate(pt.patch, fitted).us)} |`);
console.log('\nthe poly factory patches at 1..8 voices (after):');
for (const [n, p] of today)
  if (voicesOf(p) > 1) console.log(`${n.padEnd(16)} ${Array.from({ length: 8 }, (_, i) => `${i + 1}: ${((100 * cpuEstimate(withVoices(p, i + 1), fitted).us) / CPU.blockUs).toFixed(1)}`).join('  ')}`);
