// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CPU, cpuEstimate, runCost, type TypeCost } from './cpu';
import { cpuChecks, looseModel } from './cpu-checks';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, EDITOR_ONLY, validatePatch } from './patch';
import { FM1_PRESETS } from './presets';
import { relocatedPatches } from './community-factory';
import { withParts } from './test-poly';
import { deviceView } from './poly';
import type { Patch } from './patch';
import { acid, twoOpFM } from './test-patches';

// Historical rig recordings must not follow changes to the live factory catalogue.
const survey = JSON.parse(readFileSync(new URL('./cpu-survey-factory-1.13.json', import.meta.url), 'utf8')) as { patches: Record<string, Patch> };
const measuredPatches = Object.fromEntries(Object.entries(survey.patches).map(([name, patch]) => [name, () => validatePatch(structuredClone(patch), DEFS)]));

describe('CPU estimate', () => {
  it('charges moving oscillator pitch from the active wide LFO rate', () => {
    const p = emptyPatch();
    const lfo = addModule(p, DEFS.lfo, 0, 0), osc = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 0, 0);
    Object.assign(lfo.params, { wave: 1, rate: .02, wide: 55, range: 0 });
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: osc.id, port: 'pitch' });
    connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
    const oscillatorCost = () => cpuEstimate(p).modules.find(m => m.id === osc.id)!.cycles;
    const slow = oscillatorCost();
    lfo.params.range = 3;
    expect(oscillatorCost()).toBeGreaterThan(slow);
    lfo.params.wide = .0008;
    expect(oscillatorCost()).toBe(slow);
  });
  it('counts Io 4 voice-level flaws before choosing the VCA gain fast path', () => {
    const p = relocatedPatches['Io 4']();
    const withFlaws = cpuEstimate(p);
    for (const a of p.assemblies ?? []) for (const f of a.poly?.flaws ?? []) f.level = 100;
    const withoutFlaws = cpuEstimate(p);
    const cost = (e: typeof withFlaws): number => e.modules.filter((m) => m.type === 'vca').reduce((sum, m) => sum + m.cycles, 0);
    expect(cost(withFlaws)).toBeGreaterThan(cost(withoutFlaws));
  });
  it('only discounts exact fixed gains, not nearby values or modulated gains', () => {
    const p = acid();
    const m = p.modules.find((m) => m.type === 'vca')!;
    const costs = { run: 500, cv: 0, dims: [{ param: 'gain', exact: [0, 1] }], grid: [100, 200, 500] };
    const cost = (gain: number, moved = false): number => {
      m.params.gain = gain;
      return runCost(m, costs, new Set(['in', 'cv']), new Set(['out']), new Set(moved ? ['gain'] : []));
    };
    expect(cost(0)).toBeLessThan(cost(.01));
    expect(cost(1)).toBeLessThan(cost(.99));
    expect(cost(1, true)).toBe(cost(.99));
    expect(cost(1 + 1e-7)).toBe(cost(1)); // both encode to the same Q16 gain
  });
  it('has a cost for every module type (npm run cpu-costs after adding one)', () => {
    expect(Object.keys(CPU.types).sort()).toEqual(Object.keys(DEFS).filter((t) => !EDITOR_ONLY.has(t)).sort()); // the Scope never runs
  });

  const checks = cpuChecks(CPU.note);
  it('was counted on the patches it is checked on', () => {
    expect(CPU.checks.map((c) => c.name)).toEqual(checks.map((c) => c.name));
  });

  // the model against the emulator's count of the whole patch (its peak block, the note-on included): never more than 5 % low;
  // at most 15 % high, except where a module's cost depends on what it is fed or how fast a modulation moves (looseModel:
  // the table takes the worst case there)
  for (const { name, patch } of checks)
    it(`matches the counted engine: ${name}`, () => {
      const counted = CPU.checks.find((c) => c.name === name)!.cycles;
      const est = cpuEstimate(patch).cycles;
      expect(est).toBeGreaterThan(0.95 * counted);
      if (!looseModel(patch)) expect(est).toBeLessThan(1.15 * counted);
    });

  it('counts every part of a poly assembly', () => {
    const mono = cpuEstimate(acid());
    const poly = cpuEstimate(withParts(acid(), 4));
    expect(poly.cycles).toBeGreaterThan(3 * (mono.cycles - CPU.block) * 0.9);
    expect(poly.modules.find((m) => m.type === 'osc')!.copies).toBe(4);
  });

  it('counts a bypassed module as a copy', () => {
    const p = acid();
    const f = p.modules.find((m) => m.type === 'filter')!;
    const on = cpuEstimate(p).cycles;
    f.bypass = true;
    expect(cpuEstimate(p).cycles).toBeLessThan(on - 20000);
  });

  it('turns the oscillator FM mode on with the pm input and index, or a parameter input moving the index', () => {
    const p = twoOpFM();
    const osc = p.modules.filter((m) => m.type === 'osc');
    const costs = cpuEstimate(p).modules.filter((m) => m.type === 'osc').map((m) => m.cycles);
    expect(Math.max(...costs)).toBeGreaterThan(1.8 * Math.min(...costs));
    expect(osc.length).toBe(2);
  });

  it('puts a factory patch well inside the FM-1, a reverb at about a fifth', () => {
    expect(cpuEstimate(acid()).use).toBeLessThan(0.3);
    const reverb = CPU.types.reverb.run / CPU.cyclesPerUs / CPU.blockUs;
    expect(reverb).toBeGreaterThan(0.1);
    expect(reverb).toBeLessThan(0.3);
  });
});
// The factory patches on the test rig (docs/measurements/2026-11-09-rig-integration.md: the longest audio interrupt at
// rest and with 1 / 4 / 8 keys held, the transport stopped and running), which the scale and the engines' factors were fitted
// to (scripts/cpu-rig-fit.ts, frozen in cpu-costs.ts SURVEY and RIG). The estimate is each patch's worst case, every voice
// playing; the rig's figure is its steady peak (the median of a phase's samples after the first, the most over the phases).
// A patch whose overload guard dropped parts counts at the voices it kept; one the guard muted is left out. A new survey
// after large engine or firmware changes replaces the files and the fit.
describe('CPU estimate against the test rig (docs/measurements/cpu-survey-2026-11-09-rig-integration*.json)', () => {
  type Reading = { name: string } & Record<string, number[] | number>;
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../../docs/measurements/${f}`, import.meta.url), 'utf8')) as Reading[];
  const files = [
    read('cpu-survey-2026-11-09-rig-integration.json'), read('cpu-survey-2026-11-09-rig-integration-run.json'),
  ];
  const median = (v: number[]): number => [...v].sort((a, b) => a - b)[(v.length - 1) >> 1];
  // Published measurements belong to the frozen v1.13.0 patch, not today's factory pattern/format.
  // The fixture's encoded SHA-256 was checked against the recorded input before retaining it here.
  const publishedScrounge = JSON.parse(readFileSync(new URL('./cpu-scrounge-1.13.json', import.meta.url), 'utf8')) as Patch;
  const scroungeBaseline = JSON.parse(readFileSync(new URL('../../docs/measurements/cpu-survey-2026-11-10-scrounge-baseline.json', import.meta.url), 'utf8')) as {
    fixture_sha256: string; pan_cost: TypeCost; phases: { cpu: number[][] }[];
  };
  const publishedPanTable = { ...CPU, types: { ...CPU.types, pan: scroungeBaseline.pan_cost } };
  // Exact engine optimizations changed Canvas timing, not its frozen released graph or the fitted factors.
  const canvasBaseline = JSON.parse(readFileSync(new URL('../../docs/measurements/cpu-survey-2026-11-12-canvas-exact.json', import.meta.url), 'utf8')) as {
    phases: { cpuSamples: number[][] }[];
  };
  const voicesOf = (p: Patch): number => Math.max(1, ...deviceView(p, true).groups.map((g) => g.cfg.parts));
  // renamed since the survey; played there with more voices than today; changed since (none)
  const RENAMED: Record<string, string> = {};
  const SURVEYED: Record<string, number> = {};
  const CHANGED = new Set<string>([]);
  /** the rig's steady peak (us) of each factory patch at its own voices */
  const rig = new Map<string, number>();
  for (const f of files)
    for (const r of f) {
      const name = RENAMED[r.name] ?? r.name;
      if (!measuredPatches[name] || CHANGED.has(name)) continue;
      const own = voicesOf(measuredPatches[name]());
      for (const ph of ['n0', 'n1', 'n4', 'n8']) {
        const samples = r[`${ph}_samples`] as number[];
        if (r[`${ph}_ovl`] || samples.length < 2 || (SURVEYED[name] ?? own) - Number(r[`${ph}_shed`]) !== own) continue;
        rig.set(name, Math.max(rig.get(name) ?? 0, median(samples.slice(1))));
      }
    }
  rig.set('Scrounge', Math.max(...scroungeBaseline.phases.map(p => median(p.cpu.slice(1).map(s => s[1])))));
  rig.set('Canvas', Math.max(...canvasBaseline.phases.map(p => median(p.cpuSamples.slice(1).map(s => s[1])))));
  it('has a figure for every original patch the rig measured as it is today', () => expect(rig.size).toBe(Object.keys(measuredPatches).length - CHANGED.size));
  for (const name of Object.keys(measuredPatches))
    it.skipIf(!rig.has(name))(`${name === 'Scrounge' ? 'published Pan calibration' : name === 'Canvas' ? 'current exact-engine calibration' : 'reads'} within -3 / +5 points of the rig: ${name}`, () => {
      const device = (100 * rig.get(name)!) / CPU.blockUs;
      const est = 100 * cpuEstimate(name === 'Scrounge' ? publishedScrounge : measuredPatches[name](), name === 'Scrounge' ? publishedPanTable : CPU).use;
      expect(est).toBeGreaterThanOrEqual(device - 3);
      expect(est).toBeLessThanOrEqual(device + 5);
    });
});

// #271: the second core. The split survey of 2026-11-05 (every factory patch on the test rig, split on, CI run 42093061899)
// against release-1.10's head before #271 (CI run 42096997058): core 0's estimate against the device. The estimate is the one-core model plus the idle cost minus the split's saving
// (scripts/cpu-costs.ts CORES), so it keeps the one-core model's band; and the split must never be estimated to save more than
// it saved on the rig.
describe('CPU estimate with two cores (docs/measurements/cpu-survey-2026-11-05-rig-merged-split.json)', () => {
  type Reading = { name: string; n0_us: number; n1_us: number; n4_us: number; n8_us: number; n8_samples: number[]; budget_us: number };
  const read = (f: string) => new Map((JSON.parse(readFileSync(new URL(`../../docs/measurements/${f}`, import.meta.url), 'utf8')) as Reading[]).map((r) => [r.name.toLowerCase(), r]));
  const split = read('cpu-survey-2026-11-05-rig-merged-split.json'), one = read('cpu-survey-2026-11-05-rig-release-1.10-head.json');
  const steady = (r: Reading) => [...r.n8_samples.slice(1)].sort((a, b) => a - b)[(r.n8_samples.length - 1) >> 1];
  // patches changed since the split survey (not measured as they are now): re-measure on the rig, then drop them here.
  // Algo Four: eight voices and the DX100's eight algorithms (#658), where the survey measured three voices and one
  // Oracle V: the Prophet-5's functions its FM-1 version had cut (#658), where the survey measured the 1.10 voice
  // Expander S: the SEM's modulation, sync, band pass, drone and the keyboard's portamento (#658)
  // Cassia 1: four voices with the CZ-1 functions of #658, where the survey measured two
  // Io 4: its factory patch now has the Ladder's stage saturation (#672), regenerated with its named switches
  // Hera 4, Wanderer: other instruments in their slots (Hera 6 XL's panel at four voices, Wanderer XL)
  const changedSince = new Set(['algo four', 'oracle v', 'expander s', 'cassia 1', 'io 4', 'hera 5', 'wanderer']);
  for (const name of Object.keys(measuredPatches)) {
    const s = split.get(name.toLowerCase()), o = one.get(name.toLowerCase());
    if (!s || !o || changedSince.has(name.toLowerCase())) continue;
    it(`never promises more than the split saved on the rig: ${name}`, () => {
      const e = cpuEstimate(measuredPatches[name]());
      const modelled = e.oneCoreUs - e.us, measured = steady(o) - steady(s);
      expect(modelled).toBeLessThanOrEqual(measured + 60);   // (60 us: the idle cost spreads -31..+80 us about its 24 us median)
    });
  }
});
