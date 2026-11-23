// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cardCosts, cardCostText, CPU, cpuEstimate, runCost } from './cpu';
import { allModules, assembliesOf, assemblyById, bypassAssembly, deviceModules, drawers, ownerOf, rackOf, type AssemblyInst } from './assembly';
import { cpuChecks, looseModel } from './cpu-checks';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, EDITOR_ONLY, validatePatch } from './patch';
import { FM1_PRESETS } from './presets';
import { relocatedPatches } from './community-factory';
import { withParts } from './test-poly';
import type { Patch } from './patch';
import { acid, twoOpFM } from './test-patches';

// The rig's recordings are of the graphs it played (the 1.14 bank), not the live factory catalogue.
const survey = JSON.parse(readFileSync(new URL('./cpu-survey-factory-1.14.json', import.meta.url), 'utf8')) as { patches: Record<string, Patch> };
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

  it('counts a type\'s cold first copy once a block and takes it off every other copy (TypeCost.cold, D-1107)', () => {
    const p = withParts(acid(), 4);
    const copies = cpuEstimate(p).modules.filter((m) => m.type === 'osc').reduce((n, m) => n + m.copies, 0);
    const cold = 1000;
    const table = { ...CPU, types: { ...CPU.types, osc: { ...CPU.types.osc, cold } } };
    expect(copies).toBeGreaterThan(1);
    expect(cpuEstimate(p, table).cycles).toBeCloseTo(cpuEstimate(p).cycles - cold * (copies - 1), 6);
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
// The factory patches on the test rig (docs/measurements/cpu-survey-2026-11-19-rig-main121-*.json: the longest audio
// interrupt at rest and with 1 / 4 / 8 keys held, the transport stopped and running, on the 1.21 build: main with the
// cheaper module copies of #1102 and the block's fixed cost of #1105), which the engines' factors were fitted to
// (scripts/cpu-rig-fit.ts, frozen in cpu-costs.ts RIG). The estimate is
// each patch's worst case, every voice playing; the rig's figure is its steady peak (the median of a phase's samples after the first, the most
// over the phases). A patch whose overload guard dropped parts counts at the voices it kept; one the guard muted is left
// out. The estimate never reads under the rig (D-365). A new survey after large engine or firmware changes replaces the
// files and the fit.
type Reading = { name: string } & Record<string, number[] | number>;
const readSurvey = (f: string) => JSON.parse(readFileSync(new URL(`../../docs/measurements/${f}`, import.meta.url), 'utf8')) as Reading[];
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[(v.length - 1) >> 1];
/** the rig's steady peak (us) of each record name over both files, the phases it played without shedding */
function steadyPeaks(files: Reading[][]): Map<string, number> {
  const rig = new Map<string, number>();
  for (const f of files)
    for (const r of f)
      for (const ph of ['n0', 'n1', 'n4', 'n8']) {
        const samples = r[`${ph}_samples`] as number[];
        if (r[`${ph}_ovl`] || samples.length < 2 || Number(r[`${ph}_shed`])) continue;
        rig.set(r.name, Math.max(rig.get(r.name) ?? 0, median(samples.slice(1))));
      }
  return rig;
}
describe('CPU estimate against the test rig (docs/measurements/cpu-survey-2026-11-19-rig-main121-bank114*.json)', () => {
  const files = [readSurvey('cpu-survey-2026-11-19-rig-main121-bank114.json'), readSurvey('cpu-survey-2026-11-19-rig-main121-bank114-run.json')];
  const rig = new Map([...steadyPeaks(files)].filter(([name]) => measuredPatches[name]));
  it('has a figure for every patch the rig measured', () => expect(rig.size).toBe(Object.keys(measuredPatches).length));
  for (const name of Object.keys(measuredPatches))
    it.skipIf(!rig.has(name))(`reads the rig to 6 points over it: ${name}`, () => {
      const device = (100 * rig.get(name)!) / CPU.blockUs;
      const est = 100 * cpuEstimate(measuredPatches[name]()).use;
      expect(est).toBeGreaterThanOrEqual(device);
      expect(est).toBeLessThanOrEqual(device + 6);
    });
});

// Today's poly factory patches at several voice counts, as shipped ("NAME vN") and with every stage of their master FX
// bus on ("NAME vN fx"), on the same build: the estimate follows the rig as voices are added (it read Expander S at
// seven voices with every stage on 9.7 points over the rig before its voice factor came from the rig's rises, #782)
describe('CPU estimate of the poly factory patches by voices (docs/measurements/cpu-survey-2026-11-19-rig-main121-poly*.json)', () => {
  const rig = steadyPeaks([readSurvey('cpu-survey-2026-11-19-rig-main121-poly.json'), readSurvey('cpu-survey-2026-11-19-rig-main121-poly-run.json')]);
  for (const [name, us] of rig)
    it(`reads the rig to 4 points over it: ${name}`, () => {
      const [, base, v, fx] = /^(.*) v(\d+)( fx)?$/.exec(name)!;
      const p = FM1_PRESETS[base]();
      const top = Math.max(...p.modules.filter((m) => m.type === 'alloc').map((m) => m.params.voices ?? 1));
      for (const m of p.modules) if (m.type === 'alloc' && (m.params.voices ?? 1) === top) m.params.voices = Number(v);
      if (fx) for (const e of rackOf(p).effects) bypassAssembly(p, assemblyById(p, e.asm)!, false);
      const device = (100 * us) / CPU.blockUs, est = 100 * cpuEstimate(p).use;
      expect(est).toBeGreaterThanOrEqual(device);
      expect(est).toBeLessThanOrEqual(device + 4);
    });
});

// #802: the second core. The same firmware with the second core's work refused (tools/m1_link.py cores split off: core 0
// renders every module, the second core idles) against the two-core schedule, 8 keys held: core 0's saving must never be
// estimated above what the rig saved. A patch that shed voices on one core has no one-core figure to compare.
describe('CPU estimate with two cores (docs/measurements/cpu-survey-2026-11-14-rig-reverb-split-off.json)', () => {
  type Reading = { name: string; n8_samples: number[]; n8_shed: number };
  const read = (f: string) => new Map((JSON.parse(readFileSync(new URL(`../../docs/measurements/${f}`, import.meta.url), 'utf8')) as Reading[]).map((r) => [r.name, r]));
  const two = read('cpu-survey-2026-11-14-rig-reverb.json'), one = read('cpu-survey-2026-11-14-rig-reverb-split-off.json');
  const steady = (r: Reading) => [...r.n8_samples.slice(1)].sort((a, b) => a - b)[(r.n8_samples.length - 2) >> 1];
  for (const name of Object.keys(measuredPatches)) {
    const s = two.get(name), o = one.get(name);
    if (!s || !o || o.n8_shed) continue;
    it(`never promises more than the second core saved on the rig: ${name}`, () => {
      const e = cpuEstimate(measuredPatches[name]());
      expect(e.oneCoreUs - e.us).toBeLessThanOrEqual(steady(o) - steady(s) + 60);   // (60 us: the second core's idle cost and its noise)
    });
  }
});

// #942: each card's share of the block, a poly card's per voice, an assembly card the sum of everything inside it
describe('card costs', () => {
  const p = relocatedPatches['Io 4']();
  const est = cpuEstimate(p);
  const costs = cardCosts(p, est);
  const block = CPU.cyclesPerUs * CPU.blockUs;
  it('gives each module its share of the block, all its copies', () => {
    for (const m of est.modules) expect(costs.modules.get(m.id)!.share).toBeCloseTo(m.cycles / block, 9);
  });
  it('gives a module of a poly group what one voice costs', () => {
    const poly = est.modules.find((m) => m.copies > 1)!;
    const c = costs.modules.get(poly.id)!;
    expect(c.voices).toBe(poly.copies);
    expect(c.perVoice! * c.voices!).toBeCloseTo(c.share, 9);
    expect(cardCostText(c)).toMatch(/%\/v$/);
  });
  it('sums an assembly card over every module inside it, its voices too', () => {
    const top = assembliesOf(p).find((a) => a.poly)!;
    const ids = new Set(allModules(p, top));
    const inside = est.modules.filter((m) => ids.has(m.id));
    const c = costs.assemblies.get(top.id)!;
    expect(c.share).toBeCloseTo(inside.reduce((s, m) => s + m.cycles, 0) / block, 9);
    expect(c.perVoice).toBeCloseTo(inside.filter((m) => m.copies > 1).reduce((s, m) => s + m.cycles / m.copies, 0) / block, 9);
  });
  it('leaves out a card the FM-1 never runs (the Scope)', () => {
    const q = relocatedPatches['Io 4']();
    const scope = addModule(q, DEFS.scope, 0, 0);
    expect(cardCosts(q, cpuEstimate(q)).modules.has(scope.id)).toBe(false);
  });
  it('gives an instrument card its own modules and its FX drawer card its effects (#1214), adding up to the instrument', () => {
    const name = Object.keys(FM1_PRESETS).find((n) => drawers(FM1_PRESETS[n]()).some((d) => d.drawer!.taps))!;
    const q = FM1_PRESETS[name]();
    for (const e of rackOf(q).effects) bypassAssembly(q, assemblyById(q, e.asm)!, false);   // (effects on, so they cost)
    const d = drawers(q).find((x) => x.drawer!.taps)!, inst = ownerOf(q, d) as AssemblyInst;
    const e = cpuEstimate(q), c = cardCosts(q, e);
    const sum = (ids: number[]): number => e.modules.filter((m) => ids.includes(m.id)).reduce((s, m) => s + m.cycles, 0) / block;
    const fx = allModules(q, d), own = deviceModules(q, inst);
    expect(own.some((id) => fx.includes(id)), name).toBe(false);
    expect(sum(fx), name).toBeGreaterThan(0);
    expect(c.assemblies.get(inst.id)!.share).toBeCloseTo(sum(own), 9);
    expect(c.assemblies.get(d.id)!.share).toBeCloseTo(sum(fx), 9);
    expect(c.assemblies.get(inst.id)!.share + c.assemblies.get(d.id)!.share).toBeCloseTo(sum(allModules(q, inst)), 9);
  });
});
