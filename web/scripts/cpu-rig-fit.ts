// SPDX-License-Identifier: GPL-3.0-only
// Each factory engine's factor on the CPU cost table (scripts/cpu-costs.ts RIG; src/cpu.ts CpuTable.rig), worked out from
// the rig's surveys of the factory patches (tools/rig_cpu_survey.py): prints the factors to freeze in cpu-costs.ts and a
// table of each factory patch: the rig, the estimate of the table alone (no factors) and with the factors.
//   - a target: a factory patch's steady peak (the median of a phase's samples after the first, the most over its phases at
//     rest and with 1, 4 and 8 keys, the transport stopped or running), at the voices it played: a phase where the overload
//     guard dropped parts counts at that many voices fewer, a muted phase not at all;
//   - the table's own terms (the emulator's clock, PEAK, CORES) stay as they are;
//   - each factory engine's factor: the most any of its patch's targets needs, so the estimate reads at least what the rig
//     measured at every voice count it played.
// Run from web/: npx vite-node scripts/cpu-rig-fit.ts
import { readFileSync } from 'node:fs';
import { assembliesOf, parentOf } from '../src/assembly';
import { CPU, cpuEstimate, type CpuTable } from '../src/cpu';
import { DEFS } from '../src/modules';
import { validatePatch, type Patch } from '../src/patch';
import { deviceView } from '../src/poly';

const ROOT = new URL('../../', import.meta.url).pathname;
/** The build with modulation every 16 samples (#806, D-1106), on top of the Reverb's lines one block late (D-1103), the
 * cheaper LED and key scan (D-934) and the filter's cutoff every 4 samples (D-1105): every factory patch of the 1.14
 * bank, transport stopped and running; then the poly patches at more voices than they play (#868 step 7, the D-870 tops;
 * Hera 3 at 5 and 6 voices, #860), on the same engine; and Canvas with its envelope's linear fall (#689, format 56).
 * `at`: the voices a record played, by the survey's or today's name. */
const NOW: { file: string; at?: Record<string, number>; only?: string[]; skip?: string[] }[] = [
  { file: 'docs/measurements/cpu-survey-2026-11-14-rig-modctl.json', skip: ['Canvas'] },
  { file: 'docs/measurements/cpu-survey-2026-11-14-rig-modctl-run.json', skip: ['Canvas'] },
  ...['', '-run'].map((s) => ({ file: `docs/measurements/cpu-survey-2026-11-14-rig-step7-voices${s}.json`, at: { 'Oracle V': 5, 'Cassia 1': 5, 'Algo Four': 8, 'Expander S': 6 } })),
  ...['', '-run'].map((s) => ({ file: `docs/measurements/cpu-survey-2026-11-14-rig-hera-voices${s}.json`, at: { 'Hera 3 5': 5, 'Hera 3 6': 6 }, only: ['Hera 3'] })),
  ...['', '-run'].map((s) => ({ file: `docs/measurements/cpu-survey-2026-11-14-rig-canvas-linear${s}.json` })),
];
/** factory patches measured under another name (a voice count after it): the survey's name, today's */
const RENAMED: Record<string, string> = { 'Hera 5': 'Hera 4', 'Oracle V 5': 'Oracle V', 'Cassia 1 5': 'Cassia 1', 'Algo Four 8': 'Algo Four', 'Expander S 6': 'Expander S', 'Hera 3 5': 'Hera 3', 'Hera 3 6': 'Hera 3' };

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
const alone: CpuTable = { ...CPU, rig: undefined };

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

/** a factory patch's engine: its top-level assembly of the patch's name, or of ENGINE_NAME's (<7PH, Init and the like
 * have none) */
const ENGINE_NAME: Record<string, string> = { 'Hera 3': 'Hera 4' };   // (the 1.14 bank's Hera 3 plays the Hera 4 engine)
const engineOf = (p: Patch): string | undefined => assembliesOf(p).find((x) => !parentOf(p, x.id) && x.name.toLowerCase() === (ENGINE_NAME[p.name] ?? p.name).toLowerCase())?.name;

const pts: { name: string; v: number; us: number; was: number; patch: Patch }[] = [];
for (const [n, t] of now)
  for (const [v, us] of t) {
    const patch = withVoices(today.get(n)!, v);
    pts.push({ name: n, v, us, was: cpuEstimate(patch, alone).us, patch });
  }

// each engine's factor: the most any of its patch's targets needs (bisection on the estimate, which grows with it). An
// engine measured at two or more voice counts also gets a factor for its modules inside a poly group (CpuTable.rig.voices):
// the pair that reads at least the rig at every count measured, with the least over-read summed over them (the single
// factor, fitted at the voices a patch plays, over-read its higher counts: Hera 3 at 6 voices 94 % against 84 %)
const engines: Record<string, number> = {}, voices: Record<string, number> = {};
const tableWith = (e: string, k: number, kv?: number): CpuTable => ({ ...alone, rig: { engines: { [e]: k }, voices: kv === undefined ? undefined : { [e]: kv }, survey: '' } });
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
const fitted: CpuTable = { ...alone, rig: { engines, voices, survey: '' } };

console.log(`engines: ${JSON.stringify(Object.fromEntries(Object.entries(engines).sort()))}`);
console.log(`voices: ${JSON.stringify(Object.fromEntries(Object.entries(voices).sort()))}`);
console.log('\n| patch | voices | rig | table alone | with factors |\n|---|---:|---:|---:|---:|');
const pct = (us: number): string => `${((100 * us) / CPU.blockUs).toFixed(1)} %`;
for (const pt of pts.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.v - y.v)))
  console.log(`| ${pt.name} | ${pt.v} | ${pct(pt.us)} | ${pct(pt.was)} | ${pct(cpuEstimate(pt.patch, fitted).us)} |`);
console.log('\nthe poly factory patches at 1..8 voices (with factors):');
for (const [n, p] of today)
  if (voicesOf(p) > 1) console.log(`${n.padEnd(16)} ${Array.from({ length: 8 }, (_, i) => `${i + 1}: ${((100 * cpuEstimate(withVoices(p, i + 1), fitted).us) / CPU.blockUs).toFixed(1)}`).join('  ')}`);
