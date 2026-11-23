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
//     measured at every voice count it played;
//   - an engine the rig measured at several voice counts instead gets a factor for its modules inside a poly group
//     (CpuTable.rig.voices): least squares of the rig's rise from one voice count to the next on the estimate's, over every
//     patch of that engine measured at several counts; the same factor for its other modules; and its own time a block
//     (CpuTable.rig.blockUs), the least that makes the estimate read at least the rig at every count (none where the
//     estimate already does: then the least factor on its other modules that still does);
//   - the master FX bus's factor (CpuTable.rig.fx): least squares of the rig's rise, from a poly factory patch as shipped
//     to the same patch with every stage of its bus on, on the estimate's rise (POLY); those patches then count as
//     targets of their engines too, so the estimate with every stage on still reads at least the rig.
// Run from web/: npx vite-node scripts/cpu-rig-fit.ts [--table PATH]   (--table: another table, such as
// scripts/cpu-costs-emu.ts's, whose own scale stays: the 1.14 bank has no patch without an engine of its own)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assembliesOf, assemblyById, bypassAssembly, parentOf } from '../src/assembly';
import { CPU as SHIPPED, cpuEstimate, type CpuTable } from '../src/cpu';
import { rackOf } from '../src/fx-drawer';
import { DEFS } from '../src/modules';
import { validatePatch, type Patch } from '../src/patch';
import { deviceView } from '../src/poly';
import { FM1_PRESETS } from '../src/presets';

const ROOT = new URL('../../', import.meta.url).pathname;
const at = process.argv.indexOf('--table');
const CPU: CpuTable = at > 0 ? JSON.parse(readFileSync(process.argv[at + 1], 'utf8')) : SHIPPED;
/** The 1.21 build (main with #1102's cheaper module copies and #1105's block fixed cost, firmware CI run 44450005183):
 * every patch of the 1.14 bank, transport stopped and running, then its poly patches at more voices than they play (Oracle
 * V and Cassia 1 at 5, Algo Four at 8, Expander S at 6, Hera 3 at 5 and 6). `at`: the voices a record played, by the
 * survey's or today's name. */
const NOW: { file: string; at?: Record<string, number>; only?: string[]; skip?: string[] }[] = [
  { file: 'docs/measurements/cpu-survey-2026-11-19-rig-main121-bank114.json' },
  { file: 'docs/measurements/cpu-survey-2026-11-19-rig-main121-bank114-run.json' },
  ...['', '-run'].map((s) => ({
    file: `docs/measurements/cpu-survey-2026-11-19-rig-main121-voices114${s}.json`,
    at: { 'Oracle V': 5, 'Cassia 1': 5, 'Algo Four': 8, 'Expander S': 6, 'Hera 3 5': 5, 'Hera 3 6': 6 },
  })),
];
/** Today's poly factory patches on the same build at several voice counts each, as shipped ("NAME vN") and with every
 * stage of their master FX bus on ("NAME vN fx"), transport stopped and running
 * (docs/measurements/2026-11-19-rig-voices-121.md): the pairs the FX bus's factor is fitted to, and the voice slopes */
const POLY = ['', '-run'].map((s) => `docs/measurements/cpu-survey-2026-11-19-rig-main121-poly${s}.json`);
/** Today's factory bank on the same build, every stage of each master FX bus on ("NAME fx"; a patch without a bus as it
 * is), transport stopped and running: targets too, so no factory patch reads under the rig */
const FACTORY = ['', '-run'].map((s) => `docs/measurements/cpu-survey-2026-11-19-rig-main121-factoryfx${s}.json`);
/** the survey of the firmware before (release-1.10 with the second core) and the commit its factory patches are from */
const BEFORE = { file: 'docs/measurements/cpu-survey-2026-11-05-rig-merged-split.json', commit: 'e3235d64' };
/** factory patches renamed since a survey, or measured under another name (a voice count after it): the survey's name, today's */
const RENAMED: Record<string, string> = { 'Hera 5': 'Hera 4', 'Oracle V 5': 'Oracle V', 'Cassia 1 5': 'Cassia 1', 'Algo Four 8': 'Algo Four', 'Expander S 6': 'Expander S', 'Hera 3 5': 'Hera 3', 'Hera 3 6': 'Hera 3' };
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
      const n = f.at?.[r.name] ?? f.at?.[name] ?? voices(name);
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

// The survey is fitted against the graphs it played (the 1.14 bank), not today's candidates.
const survey = JSON.parse(readFileSync(new URL('../src/cpu-survey-factory-1.14.json', import.meta.url), 'utf8')) as { patches: Record<string, Patch> };
const today = new Map(Object.entries(survey.patches).map(([name, patch]) => [name, validatePatch(structuredClone(patch), DEFS)]));
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

/** a factory patch's engine: its top-level assembly of the patch's name, or of ENGINE_NAME's (<7PH, Init and the like
 * have none) */
const ENGINE_NAME: Record<string, string> = { 'Hera 3': 'Hera 4', 'Hera 6': 'Hera 4' };   // (the 1.14 bank's Hera 3 and 1.20's Hera 6 play the Hera 4 engine)
const engineOf = (p: Patch): string | undefined => assembliesOf(p).find((x) => !parentOf(p, x.id) && x.name.toLowerCase() === (ENGINE_NAME[p.name] ?? p.name).toLowerCase())?.name;

// the scale and the fixed time: est = a x before + b, least squares over the targets of the patches without an engine of
// their own (what the scale is for: modules outside a factory engine; each engine then gets its factor). A survey with
// fewer than three such patches (the 1.14 bank has none) keeps the frozen scale (cpu-costs.ts SURVEY, CORES)
/** a target: `variant` names the patch whatever its voices (the rises of the voice factor are taken within one) */
type Point = { name: string; variant: string; v: number; us: number; was: number; patch: Patch };
const pts: Point[] = [];
for (const [n, t] of now)
  for (const [v, us] of t) {
    const patch = withVoices(today.get(n)!, v);
    pts.push({ name: n, variant: `${n} (1.14)`, v, us, was: before(patch), patch });
  }
const plain = pts.filter((p) => !engineOf(p.patch));
const N = plain.length, sx = plain.reduce((s, p) => s + p.was, 0), sy = plain.reduce((s, p) => s + p.us, 0);
const sxx = plain.reduce((s, p) => s + p.was * p.was, 0), sxy = plain.reduce((s, p) => s + p.was * p.us, 0);
const frozen = new Set(plain.map((p) => p.name)).size < 3;
const a = frozen ? BASE.cyclesPerUs / CPU.cyclesPerUs : (N * sxy - sx * sy) / (N * sxx - sx * sx), b = frozen ? CPU.fixedUs - a * BASE.fixedUs : (sy - a * sx) / N;
const scaled: CpuTable = frozen ? { ...CPU, rig: undefined }
  : { ...base, cyclesPerUs: Math.round((10 * BASE.cyclesPerUs) / a) / 10, fixedUs: Math.round(b + a * BASE.fixedUs), cores: { ...base.cores!, idleUs: Math.round(a * BASE.idleUs) } };

// the FX drawers' factor: least squares of the rig's rise from each POLY patch as shipped to every effect on, on the
// estimate's rise (at the shipped engine factors: the rise is the effects' own cost), over 0.30..1.00
const allOn = (src: Patch): Patch => {
  const p = structuredClone(src);
  for (const d of rackOf(p).drawers) for (const id of d.effects) bypassAssembly(p, assemblyById(p, id)!, false);
  return p;
};
const steady = (r: Reading): number | undefined => {
  const v = PHASES.filter((ph) => !r[`${ph}_ovl`] && !Number(r[`${ph}_shed`] ?? 0)).map((ph) => r[`${ph}_samples`] as number[] | undefined)
    .filter((s): s is number[] => !!s && s.length >= 2).map((s) => median(s.slice(1)));
  return v.length ? Math.max(...v) : undefined;
};
const pairs = new Map<string, { name: string; v: number; shipped: Patch; on: Patch; us: [number, number] }>();
for (const f of POLY)
  for (const r of read(f)) {
    const m = /^(.*) v(\d+)( fx)?$/.exec(r.name), us = steady(r);
    if (!m || us === undefined) continue;
    const [n, v, on] = [m[1], Number(m[2]), m[3] ? 1 : 0], key = `${n} ${v}`;
    const pair = pairs.get(key) ?? { name: n, v, shipped: withVoices(FM1_PRESETS[n](), v), on: allOn(withVoices(FM1_PRESETS[n](), v)), us: [0, 0] };
    pair.us[on] = Math.max(pair.us[on], us);
    pairs.set(key, pair);
  }
const withFx = (t: CpuTable, fx: number): CpuTable => ({ ...t, rig: { ...(t.rig ?? { engines: {}, survey: '' }), fx } });
let fx = 1, fxErr = Infinity;
for (let i = 30; i <= 100; i++) {
  const t = withFx({ ...scaled, rig: CPU.rig }, i / 100);
  const err = [...pairs.values()].reduce((s, q) => s + (cpuEstimate(q.on, t).us - cpuEstimate(q.shipped, t).us - (q.us[1] - q.us[0])) ** 2, 0);
  if (err < fxErr) [fx, fxErr] = [i / 100, err];
}
for (const [key, q] of pairs) {
  pts.push({ name: key, variant: `${q.name} as shipped`, v: q.v, us: q.us[0], was: before(q.shipped), patch: q.shipped });
  pts.push({ name: `${key} fx`, variant: `${q.name} fx`, v: q.v, us: q.us[1], was: before(q.on), patch: q.on });
}
for (const f of FACTORY)
  for (const r of read(f)) {
    const n = r.name.replace(/ fx$/, ''), us = steady(r);
    if (!FM1_PRESETS[n] || us === undefined) continue;
    const patch = r.name.endsWith(' fx') ? allOn(FM1_PRESETS[n]()) : FM1_PRESETS[n]();
    const v = voicesOf(patch), had = pts.find((pt) => pt.variant === `${n} today` && pt.v === v);
    if (had) had.us = Math.max(had.us, us);
    else pts.push({ name: r.name, variant: `${n} today`, v, us, was: before(patch), patch });
  }

// each engine's factor: the most any of its patch's targets needs (bisection on the estimate, which grows with it). An
// engine measured at two or more voice counts gets its voice factor from the rig's rises from one count to the next (the
// least that read at least the rig at every count made the estimate climb faster than the rig: Expander S at seven voices
// with every stage on read 91.3 % against the rig's 81.6 %), the same factor on its other modules, and its own time a
// block, the least with which it reads at least the rig at every count
const engines: Record<string, number> = {}, voices: Record<string, number> = {}, blockUs: Record<string, number> = {};
const tableWith = (e: string, k: number, kv?: number, us = 0): CpuTable =>
  ({ ...scaled, rig: { engines: { [e]: k }, voices: kv === undefined ? undefined : { [e]: kv }, blockUs: { [e]: us }, fx, survey: '' } });
/** the least factor (to 0.01) with which `reads(k)` holds: the estimate grows with it */
const least = (reads: (k: number) => boolean): number => {
  let lo = 0.3, hi = 3;
  for (let i = 0; i < 24; i++) {
    const k = (lo + hi) / 2;
    if (reads(k)) hi = k;
    else lo = k;
  }
  return Math.ceil(hi * 100) / 100;
};
const byEngine = new Map<string, Point[]>();
for (const pt of pts) {
  const e = engineOf(pt.patch);
  if (e) byEngine.set(e, [...(byEngine.get(e) ?? []), pt]);
}
const slopes: Record<string, string> = {};
for (const [e, list] of byEngine) {
  const estimate = (pt: Point, t: CpuTable): number => cpuEstimate(pt.patch, t).us;
  if (new Set(list.map((pt) => pt.v)).size < 2) {
    engines[e] = Math.max(...list.map((pt) => least((k) => estimate(pt, tableWith(e, k)) >= pt.us)));
    continue;
  }
  const steps: [Point, Point][] = [];
  for (const variant of new Set(list.map((pt) => pt.variant))) {
    const s = list.filter((pt) => pt.variant === variant).sort((x, y) => x.v - y.v);
    for (let i = 1; i < s.length; i++) steps.push([s[i - 1], s[i]]);
  }
  let kv = 1, err = Infinity;
  for (let i = 30; i <= 200; i++) {
    const t = tableWith(e, i / 100, i / 100);
    const r = steps.reduce((s, [x, y]) => s + (estimate(y, t) - estimate(x, t) - (y.us - x.us)) ** 2, 0);
    if (r < err) [kv, err] = [i / 100, r];
  }
  const short = Math.max(...list.map((pt) => pt.us - estimate(pt, tableWith(e, kv, kv))));
  if (short > 0) [engines[e], blockUs[e]] = [kv, Math.ceil(short)];
  else engines[e] = least((k) => list.every((pt) => estimate(pt, tableWith(e, k, kv)) >= pt.us));
  voices[e] = kv;
  slopes[e] = `${steps.length} rises, ${Math.sqrt(err / steps.length).toFixed(0)} us rms`;
}
const fitted: CpuTable = { ...scaled, rig: { engines, voices, blockUs, fx, survey: '' } };

console.log(`rise of the unchanged patches since ${BEFORE.file}: x ${rise.toFixed(3)} (${rises.length} patches)`);
console.log(`scale: est = ${a.toFixed(3)} x before + ${b.toFixed(0)} us -> cyclesPerUs ${scaled.cyclesPerUs}, fixedUs ${scaled.fixedUs}, idleUs ${scaled.cores!.idleUs}`);
console.log(`engines: ${JSON.stringify(Object.fromEntries(Object.entries(engines).sort()))}`);
console.log(`voices: ${JSON.stringify(Object.fromEntries(Object.entries(voices).sort()))} (${JSON.stringify(slopes)})`);
console.log(`blockUs: ${JSON.stringify(Object.fromEntries(Object.entries(blockUs).sort()))}`);
console.log(`fx: ${fx} (rise residual ${Math.sqrt(fxErr / pairs.size).toFixed(0)} us rms over ${pairs.size} pairs)`);
console.log('\n| patch | voices | rig | before | after |\n|---|---:|---:|---:|---:|');
const pct = (us: number): string => `${((100 * us) / CPU.blockUs).toFixed(1)} %`;
for (const pt of pts.sort((x, y) => (x.variant < y.variant ? -1 : x.variant > y.variant ? 1 : x.v - y.v)))
  console.log(`| ${pt.variant} | ${pt.v} | ${pct(pt.us)}${CHANGED.has(pt.name) ? ' (1.10 x rise)' : ''} | ${pct(pt.was)} | ${pct(cpuEstimate(pt.patch, fitted).us)} |`);
console.log('\nthe poly factory patches at 1..8 voices (after):');
for (const [n, p] of today)
  if (voicesOf(p) > 1) console.log(`${n.padEnd(16)} ${Array.from({ length: 8 }, (_, i) => `${i + 1}: ${((100 * cpuEstimate(withVoices(p, i + 1), fitted).us) / CPU.blockUs).toFixed(1)}`).join('  ')}`);
console.log("\ntoday's poly factory patches with every stage of the bus on at 1..8 voices (after):");
for (const n of new Set([...pairs.values()].map((q) => q.name)))
  console.log(`${n.padEnd(16)} ${Array.from({ length: 8 }, (_, i) => `${i + 1}: ${((100 * cpuEstimate(allOn(withVoices(FM1_PRESETS[n](), i + 1)), fitted).us) / CPU.blockUs).toFixed(1)}`).join('  ')}`);
