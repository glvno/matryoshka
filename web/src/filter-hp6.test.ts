// SPDX-License-Identifier: GPL-3.0-only
// The Multimode filter's hp6 output: the MS-20 filter's resonant 6 dB high pass (hp + 2 bp over the same denominator).
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { FM1_PRESETS } from './presets';

const SR = 48000;
const C4 = 261.6255653;

function render(e: Engine, n: number): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  return { l, r };
}
const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const db = (a: number, b: number): number => 20 * Math.log10(a / b);

/** a sine at `hz` through the filter's `port`, rms over half a second after settling */
function sineThrough(port: string, hz: number, params: Record<string, number>): number {
  const p = emptyPatch();
  addModule(p, DEFS.fm1, 0, 0);
  const o = addModule(p, DEFS.osc, 0, 0);
  const f = addModule(p, DEFS.filter, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  const semis = 12 * Math.log2(hz / C4);
  o.params.wave = 0;
  o.params.coarse = Math.round(semis);
  o.params.fine = 100 * (semis - o.params.coarse);
  o.params.level = 0.01; // room for the resonance peak below the output's clamp
  Object.assign(f.params, { res: 0, ...params });
  out.params.level = 1;
  connect(p, DEFS, { module: o.id, port: 'out' }, { module: f.id, port: 'in' });
  connect(p, DEFS, { module: f.id, port }, { module: out.id, port: 'l' });
  const e = new Engine(SR);
  e.load(p);
  render(e, SR / 2);
  return rms(render(e, SR / 2).l);
}

describe('Multimode hp6: a resonant 6 dB high pass', () => {
  it('falls about 6 dB per octave well below the cutoff, where hp falls 12', () => {
    const six = db(sineThrough('hp6', 250, { cutoff: 4000 }), sineThrough('hp6', 125, { cutoff: 4000 }));
    const twelve = db(sineThrough('hp', 250, { cutoff: 4000 }), sineThrough('hp', 125, { cutoff: 4000 }));
    expect(six).toBeGreaterThan(5.5);
    expect(six).toBeLessThan(6.5);
    expect(twelve).toBeGreaterThan(11.5);
  });

  it('passes the band above the cutoff at unity', () => {
    const flat = sineThrough('hp6', 8000, { cutoff: 200 });
    expect(flat / (0.01 / Math.SQRT2)).toBeCloseTo(1, 1);
  });

  it('peaks at the cutoff with PEAK (res) up', () => {
    const above = sineThrough('hp6', 8000, { cutoff: 1000, res: 0.9 });
    const at = sineThrough('hp6', 1000, { cutoff: 1000, res: 0.9 });
    expect(db(at, above)).toBeGreaterThan(18); // sqrt(5) / k at the cutoff: 20 dB at k = 0.218
    const mild = sineThrough('hp6', 1000, { cutoff: 1000, res: 0 });
    expect(db(mild, above)).toBeLessThan(2);
  });

  it('stays finite and bounded at full resonance under a swept cutoff', () => {
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    o.params.wave = 2;
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    Object.assign(lfo.params, { rate: 3, depth: 1 });
    const f = addModule(p, DEFS.filter, 0, 0);
    Object.assign(f.params, { cutoff: 300, res: 1, cvamt: 4 });
    const out = addModule(p, DEFS.output, 0, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: f.id, port: 'in' });
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: f.id, port: 'cv' });
    connect(p, DEFS, { module: f.id, port: 'hp6' }, { module: out.id, port: 'l' });
    const e = new Engine(SR);
    e.load(p);
    const { l } = render(e, SR * 2);
    expect(l.every(Number.isFinite)).toBe(true);
    expect(rms(l)).toBeGreaterThan(0.01);
  });

  it('leaves every other output as it was: patching hp6 changes nothing on hp', () => {
    const build = (withSix: boolean): Patch => {
      const p = emptyPatch();
      addModule(p, DEFS.fm1, 0, 0);
      const o = addModule(p, DEFS.osc, 0, 0);
      o.params.wave = 2;
      const f = addModule(p, DEFS.filter, 0, 0);
      Object.assign(f.params, { cutoff: 500, res: 0.6 });
      const out = addModule(p, DEFS.output, 0, 0);
      connect(p, DEFS, { module: o.id, port: 'out' }, { module: f.id, port: 'in' });
      connect(p, DEFS, { module: f.id, port: 'hp' }, { module: out.id, port: 'l' });
      if (withSix) connect(p, DEFS, { module: f.id, port: 'hp6' }, { module: out.id, port: 'r' });
      return p;
    };
    const run = (p: Patch): Float32Array => {
      const e = new Engine(SR);
      e.load(p);
      return render(e, 4096).l;
    };
    expect(run(build(true))).toEqual(run(build(false)));
    expect(DEFS.filter.outputs.map((o) => o.name)).toEqual(['lp24', 'lp12', 'bp', 'hp', 'mix', 'notch', 'peak', 'ap', 'hp6']);
  });

  it('Sallen 20 runs its high pass through hp6 and keeps its card rows', () => {
    const p = FM1_PRESETS['Sallen 20']();
    const card = p.assemblies!.find((a) => a.params.some((r) => r.head === 'highpass'))!;
    const cutoff = card.params.find((r) => r.head === 'highpass')!;
    const hpf = p.modules.find((m) => m.id === cutoff.module)!;
    expect(hpf.type).toBe('filter');
    expect(card.params.some((r) => r.module === hpf.id && r.param === 'res' && r.label === 'peak')).toBe(true);
    const leaving = p.cables.filter((c) => c.from.module === hpf.id).map((c) => c.from.port);
    expect(leaving).toEqual(['hp6']);
  });
});
