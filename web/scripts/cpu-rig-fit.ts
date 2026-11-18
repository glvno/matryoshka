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
//   - the master FX bus's factor (CpuTable.rig.fx): least squares of the rig's rise, from a poly factory patch as shipped
//     to the same patch with every stage of its bus on, on the estimate's rise (POLYFX); those patches then count as
//     targets of their engines too, so the estimate with every stage on still reads at least the rig.
// Run from web/: npx vite-node scripts/cpu-rig-fit.ts [--table PATH]   (--table: another table, such as
// scripts/cpu-costs-emu.ts's, whose own scale stays: the 1.14 bank has no patch without an engine of its own)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assembliesOf, parentOf } from '../src/assembly';
import { CPU as SHIPPED, cpuEstimate, type CpuTable } from '../src/cpu';
import { fxBusOf } from '../src/fx-bus';
import { setFxStageEnabled } from '../src/fx-preset';
import { DEFS } from '../src/modules';
import { validatePatch, type Patch } from '../src/patch';
import { deviceView } from '../src/poly';
import { FM1_PRESETS } from '../src/presets';

const ROOT = new URL('../../', import.meta.url).pathname;
const at = process.argv.indexOf('--table');
const CPU: CpuTable = at > 0 ? JSON.parse(readFileSync(process.argv[at + 1], 'utf8')) : SHIPPED;
/** The 1.20 headroom build (#868, #979, #1072, #1073): the float filters, Resonator, Reverb, Delay filters and Low pass
 * gate (D-1112), hot code in RAM (D-398), the two-core plan from the rig's module costs (D-1101), on top of the build with
 * modulation every 16 samples (#806, D-1106): every patch of the 1.14 bank, transport stopped and running; then the poly
 * patches at more voices than they play (#868 step 7, the D-870 tops; Hera 3 at 5 and 6 voices, #860), on the same build.
 * `at`: the voices a record played, by the survey's or today's name. */
const NOW: { file: string; at?: Record<string, number>; only?: string[]; skip?: string[] }[] = [
  { file: 'docs/measurements/cpu-survey-2026-11-18-rig-headroom120-bank114.json' },
  { file: 'docs/measurements/cpu-survey-2026-11-18-rig-headroom120-bank114-run.json' },
  ...['', '-run'].map((s) => ({
    file: `docs/measurements/cpu-survey-2026-11-18-rig-headroom120-voices114${s}.json`,
    at: { 'Oracle V': 5, 'Cassia 1': 5, 'Algo Four': 8, 'Expander S': 6, 'Hera 3 5': 5, 'Hera 3 6': 6 },
  })),
];
/** The poly factory patches of 1.20 at the voices the rig played, as shipped ("NAME vN") and with every stage of their
 * master FX bus on ("NAME vN fx"), on the voices builds of 2026-11-18 (docs/measurements/2026-11-18-rig-voices-120.md;
 * Hera 6 at six on its own build) and on the build that raised Cassia 1 and Algo Four
 * (docs/measurements/2026-11-18-rig-fxbus-voices.md): the pairs the FX bus's factor is fitted to */
const POLYFX: { file: string; pairs: [string, number, string][] }[] = [
  ...['', '-run'].map((s) => ({ file: `docs/measurements/cpu-survey-2026-11-18-rig-voices120${s}.json`, pairs: [['Oracle V', 5, 'Oracle V v5'], ['Expander S', 6, 'Expander S v6'], ['Algo Four', 7, 'Algo Four v7'], ['Cassia 1', 4, 'Cassia 1 v4'], ['Cassia 1', 5, 'Cassia 1 v5'], ['Io 4', 4, 'Io 4 v4']] as [string, number, string][] })),
  ...['', '-run'].map((s) => ({ file: `docs/measurements/cpu-survey-2026-11-18-rig-voices120-hera6${s}.json`, pairs: [['Hera 6', 6, 'Hera 6 v6+1']] as [string, number, string][] })),
  ...['', '-run'].map((s) => ({ file: `docs/measurements/cpu-survey-2026-11-18-rig-fxbus-voices${s}.json`, pairs: [['Cassia 1', 5, 'Cassia 1 v5'], ['Algo Four', 8, 'Algo Four v8'], ['Expander S', 4, 'Expander S v4']] as [string, number, string][] })),
  ...['', '-run'].map((s) => ({ file: `docs/measurements/cpu-survey-2026-11-18-rig-fxbus-expander7${s}.json`, pairs: [['Expander S', 7, 'Expander S v7']] as [string, number, string][] })),
];
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
const pts: { name: string; v: number; us: number; was: number; patch: Patch }[] = [];
for (const [n, t] of now)
  for (const [v, us] of t) {
    const patch = withVoices(today.get(n)!, v);
    pts.push({ name: n, v, us, was: before(patch), patch });
  }
const plain = pts.filter((p) => !engineOf(p.patch));
const N = plain.length, sx = plain.reduce((s, p) => s + p.was, 0), sy = plain.reduce((s, p) => s + p.us, 0);
const sxx = plain.reduce((s, p) => s + p.was * p.was, 0), sxy = plain.reduce((s, p) => s + p.was * p.us, 0);
const frozen = new Set(plain.map((p) => p.name)).size < 3;
const a = frozen ? BASE.cyclesPerUs / CPU.cyclesPerUs : (N * sxy - sx * sy) / (N * sxx - sx * sx), b = frozen ? CPU.fixedUs - a * BASE.fixedUs : (sy - a * sx) / N;
const scaled: CpuTable = frozen ? { ...CPU, rig: undefined }
  : { ...base, cyclesPerUs: Math.round((10 * BASE.cyclesPerUs) / a) / 10, fixedUs: Math.round(b + a * BASE.fixedUs), cores: { ...base.cores!, idleUs: Math.round(a * BASE.idleUs) } };

// the master FX bus's factor: least squares of the rig's rise from each POLYFX patch as shipped to every stage on, on the
// estimate's rise (at the shipped engine factors: the rise is the bus's own cost), over 0.30..1.00
const allOn = (src: Patch): Patch => {
  const p = structuredClone(src);
  for (const s of fxBusOf(p)!.stages) setFxStageEnabled(p, s, true);
  return p;
};
const steady = (r: Reading): number | undefined => {
  const v = PHASES.filter((ph) => !r[`${ph}_ovl`] && !Number(r[`${ph}_shed`] ?? 0)).map((ph) => r[`${ph}_samples`] as number[] | undefined)
    .filter((s): s is number[] => !!s && s.length >= 2).map((s) => median(s.slice(1)));
  return v.length ? Math.max(...v) : undefined;
};
const pairs = new Map<string, { name: string; v: number; shipped: Patch; on: Patch; us: [number, number] }>();
for (const f of POLYFX) {
  const recs = read(f.file);
  for (const [n, v, r] of f.pairs) {
    const key = `${n} ${v}`, got = [r, `${r} fx`].map((x) => recs.filter((y) => y.name === x).map(steady).find((s) => s !== undefined)!);
    const pair = pairs.get(key) ?? { name: n, v, shipped: withVoices(FM1_PRESETS[n](), v), on: allOn(withVoices(FM1_PRESETS[n](), v)), us: [0, 0] };
    pair.us = [Math.max(pair.us[0], got[0]), Math.max(pair.us[1], got[1])];
    pairs.set(key, pair);
  }
}
const withFx = (t: CpuTable, fx: number): CpuTable => ({ ...t, rig: { engines: t.rig?.engines ?? {}, voices: t.rig?.voices, fx, survey: '' } });
let fx = 1, fxErr = Infinity;
for (let i = 30; i <= 100; i++) {
  const t = withFx({ ...scaled, rig: CPU.rig }, i / 100);
  const err = [...pairs.values()].reduce((s, q) => s + (cpuEstimate(q.on, t).us - cpuEstimate(q.shipped, t).us - (q.us[1] - q.us[0])) ** 2, 0);
  if (err < fxErr) [fx, fxErr] = [i / 100, err];
}
for (const [key, q] of pairs) {
  pts.push({ name: `${key} (1.20)`, v: q.v, us: q.us[0], was: before(q.shipped), patch: q.shipped });
  pts.push({ name: `${key} fx (1.20)`, v: q.v, us: q.us[1], was: before(q.on), patch: q.on });
}

// each engine's factor: the most any of its patch's targets needs (bisection on the estimate, which grows with it). An
// engine measured at two or more voice counts also gets a factor for its modules inside a poly group (CpuTable.rig.voices):
// the pair that reads at least the rig at every count measured, with the least over-read summed over them (the single
// factor, fitted at the voices a patch plays, over-read its higher counts: Hera 3 at 6 voices 94 % against 84 %)
const engines: Record<string, number> = {}, voices: Record<string, number> = {};
const tableWith = (e: string, k: number, kv?: number): CpuTable => ({ ...scaled, rig: { engines: { [e]: k }, voices: kv === undefined ? undefined : { [e]: kv }, fx, survey: '' } });
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
const byEngine = new Map<string, typeof pts>();
for (const pt of pts) {
  const e = engineOf(pt.patch);
  if (e) byEngine.set(e, [...(byEngine.get(e) ?? []), pt]);
}
for (const [e, list] of byEngine) {
  const estimate = (pt: (typeof pts)[number], t: CpuTable): number => cpuEstimate(pt.patch, t).us;
  if (new Set(list.map((pt) => pt.v)).size < 2) {
    engines[e] = Math.max(...list.map((pt) => least((k) => estimate(pt, tableWith(e, k)) >= pt.us)));
    continue;
  }
  let best: { ks: number; kv: number; over: number } | undefined;
  for (let ks = 0.3; ks <= 1.5 + 1e-9; ks += 0.02) {   // (capped: a shared factor past 1.5 bought a flatter slope than the counts measured support)
    const k = Math.round(ks * 100) / 100;
    const kv = Math.max(...list.map((pt) => least((v) => estimate(pt, tableWith(e, k, v)) >= pt.us)));
    const over = list.reduce((s, pt) => s + estimate(pt, tableWith(e, k, kv)) - pt.us, 0);
    if (!best || over < best.over) best = { ks: k, kv, over };
  }
  engines[e] = best!.ks;
  voices[e] = best!.kv;
}
const fitted: CpuTable = { ...scaled, rig: { engines, voices, fx, survey: '' } };

console.log(`rise of the unchanged patches since ${BEFORE.file}: x ${rise.toFixed(3)} (${rises.length} patches)`);
console.log(`scale: est = ${a.toFixed(3)} x before + ${b.toFixed(0)} us -> cyclesPerUs ${scaled.cyclesPerUs}, fixedUs ${scaled.fixedUs}, idleUs ${scaled.cores!.idleUs}`);
console.log(`engines: ${JSON.stringify(Object.fromEntries(Object.entries(engines).sort()))}`);
console.log(`voices: ${JSON.stringify(Object.fromEntries(Object.entries(voices).sort()))}`);
console.log(`fx: ${fx} (rise residual ${Math.sqrt(fxErr / pairs.size).toFixed(0)} us rms over ${pairs.size} pairs)`);
console.log('\n| patch | voices | rig | before | after |\n|---|---:|---:|---:|---:|');
const pct = (us: number): string => `${((100 * us) / CPU.blockUs).toFixed(1)} %`;
for (const pt of pts.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.v - y.v)))
  console.log(`| ${pt.name} | ${pt.v} | ${pct(pt.us)}${CHANGED.has(pt.name) ? ' (1.10 x rise)' : ''} | ${pct(pt.was)} | ${pct(cpuEstimate(pt.patch, fitted).us)} |`);
console.log('\nthe poly factory patches at 1..8 voices (after):');
for (const [n, p] of today)
  if (voicesOf(p) > 1) console.log(`${n.padEnd(16)} ${Array.from({ length: 8 }, (_, i) => `${i + 1}: ${((100 * cpuEstimate(withVoices(p, i + 1), fitted).us) / CPU.blockUs).toFixed(1)}`).join('  ')}`);
console.log('\nthe 1.20 poly factory patches with every stage of the bus on at 1..8 voices (after):');
for (const n of new Set([...pairs.values()].map((q) => q.name)))
  console.log(`${n.padEnd(16)} ${Array.from({ length: 8 }, (_, i) => `${i + 1}: ${((100 * cpuEstimate(allOn(withVoices(FM1_PRESETS[n](), i + 1)), fitted).us) / CPU.blockUs).toFixed(1)}`).join('  ')}`);
