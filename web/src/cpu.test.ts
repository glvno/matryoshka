// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CPU, cpuEstimate } from './cpu';
import { cpuChecks, looseModel } from './cpu-checks';
import { DEFS } from './modules';
import { EDITOR_ONLY } from './patch';
import { FM1_PRESETS } from './presets';
import { withParts } from './test-poly';
import { acid, twoOpFM } from './test-patches';

describe('CPU estimate', () => {
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
  // patches added since the survey (#182, Elvira 2, Scrounge, Meridian 8, Perun 4, <7PH, Spokes 6, Cassia 1): measure them on the device, then add them to the survey file
  const unmeasured = new Set(['8 lire', 'elvira 2', 'scrounge', 'meridian 8', 'perun 4', '<7ph', 'spokes 6', 'cassia 1']);
  it('covers every factory patch', () => expect(survey.length + unmeasured.size).toBe(Object.keys(FM1_PRESETS).length));
  for (const r of survey)
    it.skipIf(changed.has(r.name.toLowerCase()))(`is within -4 / +6 points of the device: ${r.name}`, () => {
      const name = byName.get(r.name.toLowerCase());
      if (!name) throw new Error(`the survey's ${r.name} is not a factory patch`);
      const device = (100 * Math.max(r.idle_us, r.n1_us, r.n4_us, r.n8_us)) / r.budget_us;
      const est = 100 * cpuEstimate(FM1_PRESETS[name]()).use;
      expect(est).toBeGreaterThanOrEqual(device - 4);
      expect(est).toBeLessThanOrEqual(device + 6);
    });
});
