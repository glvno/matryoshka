// SPDX-License-Identifier: GPL-3.0-only
// The Multimode filter's opt-in self-oscillation (`osc`, format 47): at full resonance it sustains a bounded, sine-like
// oscillation at its cutoff with nothing on its input, as the Korg MS-20's filters do at full PEAK.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, FILTER_OSC_FROM } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { encodePatch, encodedSize, formatOf, recordSize, WRITE_FLOOR } from './patchbin';
import { FM1_PRESETS } from './presets';

const SR = 44118;

function render(p: Patch, n: number): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  return l;
}
const peak = (a: Float32Array): number => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** the filter alone (nothing on its input, or a saw at `saw` level), its `port` to the output */
function alone(params: Record<string, number>, port = 'lp12', saw = 0): Patch {
  const p = emptyPatch();
  addModule(p, DEFS.fm1, 0, 0);
  const f = addModule(p, DEFS.filter, 0, 0);
  Object.assign(f.params, params);
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  if (saw) {
    const o = addModule(p, DEFS.osc, 0, 0);
    Object.assign(o.params, { wave: 2, level: saw });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: f.id, port: 'in' });
  }
  connect(p, DEFS, { module: f.id, port }, { module: out.id, port: 'l' });
  return p;
}

/** the frequency from the rising zero crossings (interpolated) of the last second */
function pitch(a: Float32Array): number {
  const t = a.subarray(a.length - SR);
  let first = -1, last = -1, z = 0;
  for (let i = 1; i < t.length; i++)
    if (t[i - 1] < 0 && t[i] >= 0) {
      const at = i - 1 - t[i - 1] / (t[i] - t[i - 1]);
      if (first < 0) first = at;
      last = at;
      z++;
    }
  return ((z - 1) * SR) / (last - first);
}

describe('Multimode self-oscillation (osc)', () => {
  it('sustains with nothing on its input at full PEAK, bounded, at the cutoff', () => {
    for (const cutoff of [110, 440, 1760]) {
      const a = render(alone({ cutoff, res: 1, osc: 1 }), SR * 3);
      const tail = a.subarray(a.length - SR);
      expect(peak(tail), `${cutoff} Hz`).toBeGreaterThan(0.4);
      expect(peak(tail), `${cutoff} Hz`).toBeLessThan(0.6);
      expect(Math.abs(pitch(a) / cutoff - 1), `${cutoff} Hz`).toBeLessThan(0.01);
    }
  });

  it('follows the cutoff: two octaves up, two octaves higher', () => {
    const lo = pitch(render(alone({ cutoff: 200, res: 1, osc: 1 }), SR * 3));
    const hi = pitch(render(alone({ cutoff: 800, res: 1, osc: 1 }), SR * 3));
    expect(Math.log2(hi / lo)).toBeCloseTo(2, 1);
  });

  it('is sine-like: the third harmonic is small', () => {
    const a = render(alone({ cutoff: 441.18, res: 1, osc: 1 }), SR * 3).subarray(SR * 2); // 100 samples a cycle
    const bin = (k: number): number => {
      let re = 0, im = 0;
      for (let i = 0; i < a.length; i++) {
        re += a[i] * Math.cos((2 * Math.PI * k * 441.18 * i) / SR);
        im += a[i] * Math.sin((2 * Math.PI * k * 441.18 * i) / SR);
      }
      return Math.hypot(re, im);
    };
    expect(bin(3) / bin(1)).toBeLessThan(0.05);
  });

  it('stays finite and bounded under a loud input and a swept cutoff', () => {
    const p = alone({ cutoff: 300, res: 1, osc: 1, cvamt: 4 }, 'hp6', 4);
    const f = p.modules.find((m) => m.type === 'filter')!;
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    Object.assign(lfo.params, { rate: 3, depth: 1 });
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: f.id, port: 'cv' });
    const a = render(p, SR * 2);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(peak(a)).toBeLessThan(40);
  });

  it('off, or on below its threshold, plays exactly as before', () => {
    expect(peak(render(alone({ cutoff: 440, res: 1 }), SR))).toBe(0); // off: no input, no sound
    for (const res of [0.2, FILTER_OSC_FROM])
      expect(render(alone({ cutoff: 700, res, osc: 1 }, 'hp6', 0.5), 8192)).toEqual(render(alone({ cutoff: 700, res }, 'hp6', 0.5), 8192));
  });

  it('costs bytes only in a patch that turns it on: it is written in format 46 otherwise', () => {
    const off = alone({ cutoff: 440, res: 1 });
    const on = alone({ cutoff: 440, res: 1, osc: 1 });
    expect(formatOf(off)).toBe(WRITE_FLOOR);
    expect(formatOf(on)).toBe(47);
    expect(encodePatch(off)[1]).toBe(WRITE_FLOOR);
    expect(encodePatch(on)[1]).toBe(47);
    expect(encodePatch(on).length - encodePatch(off).length).toBe(4);
    expect(recordSize('filter', WRITE_FLOOR)).toBe(recordSize('filter') - 4);
    for (const p of [off, on]) expect(encodePatch(p).length).toBe(encodedSize(p));
  });

  it('Sallen 20 turns it on in both filters; its rows are unchanged', () => {
    const p = FM1_PRESETS['Sallen 20']();
    const filters = p.modules.filter((m) => m.type === 'filter');
    expect(filters.length).toBe(2);
    expect(filters.every((m) => m.params.osc === 1)).toBe(true);
    expect(p.assemblies!.some((a) => a.params.some((r) => r.param === 'osc'))).toBe(false);
    expect(encodePatch(p)[1]).toBe(47);
  });
});
