// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CPU, cpuEstimate } from './cpu';
import { cpuChecks, looseModel } from './cpu-checks';
import { DEFS } from './modules';
import { EDITOR_ONLY } from './patch';
import { PRESETS } from './presets';
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
