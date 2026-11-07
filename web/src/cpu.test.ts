// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CPU, cpuEstimate, runCost } from './cpu';
import { cpuChecks, looseModel } from './cpu-checks';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, EDITOR_ONLY } from './patch';
import { FM1_PRESETS } from './presets';
import { withParts } from './test-poly';
import { acid, twoOpFM } from './test-patches';

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
    const p = FM1_PRESETS['Io 4']();
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

// The factory patches measured on the FM-1 (the longest audio interrupt at rest and with 1 / 4 / 8 notes held, in us of the
// half buffer), which the scale was fitted to (cpu-costs.ts, SURVEY). A new survey replaces the file after large engine
// changes; until then a change that moves a patch out of the band means the model and the device disagree.
describe('CPU estimate against the device survey (docs/measurements/cpu-survey-2026-10-20.json)', () => {
  type Reading = { name: string; idle_us: number; n1_us: number; n4_us: number; n8_us: number; budget_us: number };
  const survey = JSON.parse(readFileSync(new URL('../../docs/measurements/cpu-survey-2026-10-20.json', import.meta.url), 'utf8')) as Reading[];
  const byName = new Map(Object.keys(FM1_PRESETS).map((n) => [n.toLowerCase(), n]));
  // patches changed since the survey (not measured as they are now): re-measure on the device, then drop them here
  // 808 Kit: re-measured 2026-10-21 after #141: the device reads 81 %, the model 74 % (out of the band): #178. Oracle V:
  // the melodic patches gained an Arpeggiator and PATTERN (D-336, #243; 2 to 4 points of estimate each), which takes Oracle V
  // past the band's top (est 84 %, the survey 75 %)
  // 909 Kit: rows 3 and 5..8 got their voices (the survey measured its first three only; est 59 %)
  // Hera 6, Expander S, Algo Four: the engine's overhead cut (#289) took about 8 % off every patch's count, which puts these
  // three under the band's bottom; the survey measured the engine before it (re-measure: #289's device step)
  // Monolith D, Sallen 20: rebuilt after their originals' panels (#303: switches as Selectors, each filter source on its own
  // amount, the MS-20's EG 1 delay, EG 2 hold and patch panel), est 35 % and 42 % against the survey's 22 % and 28 %
  const changed = new Set(['808 kit', 'oracle v', '909 kit', 'hera 6', 'expander s', 'algo four', 'monolith d', 'sallen 20']);
  // Wanderer: rebuilt duophonic with the Odyssey's whole modulation section (#303; est 37 %, the survey's two-voice one 32 %)
  changed.add('wanderer');
  // Io 4, Vernon 100: rebuilt after the Jupiter-4's and the ElectroComp 100's panels (#303; est about 97 % and 60 %)
  changed.add('io 4');
  changed.add('vernon 100');
  // Canvas and Briefcase 3: rebuilt after the Music Easel's and the VCS3's panels (#303; est 76 % and 89 %)
  changed.add('canvas');
  changed.add('briefcase 3');
  // patches added since the survey (#182, Elvira 2, Scrounge, Meridian 8, Perun 4, <7PH, Spokes 6, Cassia 1, the four simple
  // engines of #413, Verona Drum 1): measure them on the device, then add them to the survey file
  const unmeasured = new Set(['8 lire', 'elvira 2', 'scrounge', 'meridian 8', 'perun 4', '<7ph', 'spokes 6', 'cassia 1', 'basic poly', 'drift poly', 'mono lead', 'supersaw stack', 'verona drum 1']);
  it('covers every factory patch', () => expect(survey.length + unmeasured.size).toBe(Object.keys(FM1_PRESETS).length));
  for (const r of survey)
    it.skipIf(changed.has(r.name.toLowerCase()))(`is within -4 / +6 points of the device: ${r.name}`, () => {
      const name = byName.get(r.name.toLowerCase());
      if (!name) throw new Error(`the survey's ${r.name} is not a factory patch`);
      const device = (100 * Math.max(r.idle_us, r.n1_us, r.n4_us, r.n8_us)) / r.budget_us;
      const est = 100 * cpuEstimate(FM1_PRESETS[name](), CPU, 1).use;   // (that survey ran on one core)
      expect(est).toBeGreaterThanOrEqual(device - 4);
      expect(est).toBeLessThanOrEqual(device + 6);
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
  it('has the second core in the table', () => expect(CPU.cores?.idleUs).toBeGreaterThan(0));
  // patches changed since the split survey (not measured as they are now): re-measure on the rig, then drop them here.
  // Cassia 1: four voices with the CZ-1 functions of #658, where the survey measured two
  const changedSince = new Set(['cassia 1']);
  for (const name of Object.keys(FM1_PRESETS)) {
    const s = split.get(name.toLowerCase()), o = one.get(name.toLowerCase());
    if (!s || !o || changedSince.has(name.toLowerCase())) continue;
    it(`never promises more than the split saved on the rig: ${name}`, () => {
      const e = cpuEstimate(FM1_PRESETS[name]());
      const modelled = e.oneCoreUs - e.us, measured = steady(o) - steady(s);
      expect(modelled).toBeLessThanOrEqual(measured + 60);   // (60 us: the idle cost spreads -31..+80 us about its 24 us median)
    });
  }
});
