// SPDX-License-Identifier: GPL-3.0-only
// Sallen 20's ESP on the FM-1 (no audio input there): SIGNAL IN picks an internal signal, ESP ROUTE patches one output
// as the MS-20 manual does. Each route does something with no browser cable; OFF / OFF plays as the patch without them.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEVICE_SR } from './modules';
import { removeModule, type Patch } from './patch';
import { FM1_PRESETS } from './presets';
import { removeMember } from './assembly';

const SR = DEVICE_SR;
const card = (p: Patch) => p.assemblies!.find((a) => a.params.some((r) => r.label === 'esp route'))!;
function set(p: Patch, label: string, v: number, after?: string): void {
  const rows = card(p).params;
  const from = after ? rows.findIndex((r) => r.label === after) : 0;
  const r = rows.slice(from).find((x) => x.label === label)!;
  p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
}
function render(p: Patch, secs: number, note?: number): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  if (note !== undefined) e.noteOn(note, 0.8);
  const n = Math.round(secs * SR), out = new Float32Array(n), l = new Float32Array(128), r = new Float32Array(128);
  for (let i = 0; i < n; i += 128) {
    e.render(l, r);
    out.set(l.subarray(0, Math.min(128, n - i)), i);
  }
  return out;
}
const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
function pitch(a: Float32Array): number {
  let first = -1, last = -1, z = 0;
  for (let i = 1; i < a.length; i++)
    if (a[i - 1] <= 0 && a[i] > 0) {
      const at = i - 1 - a[i - 1] / (a[i] - a[i - 1]);
      if (first < 0) first = at;
      last = at;
      z++;
    }
  return ((z - 1) * SR) / (last - first);
}

describe('Sallen 20 ESP on the FM-1', () => {
  it('OFF / OFF plays exactly as the patch without the ESP routing', () => {
    const p = FM1_PRESETS['Sallen 20']();
    const q = FM1_PRESETS['Sallen 20']();
    const a = card(q);
    const routing = a.params.filter((r) => r.label === 'signal in' || r.label === 'esp route').map((r) => r.module);
    const route = routing[1];
    const gated = q.cables.filter((c) => c.from.module === route).map((c) => c.to.module); // the route's VCAs and Logic
    for (const id of [...routing, ...gated]) {
      removeModule(q, id);
      removeMember(q, a, id);
      a.params = a.params.filter((r) => r.module !== id);
    }
    expect(q.modules.length).toBe(p.modules.length - 5);
    expect(render(p, 1.5, 57)).toEqual(render(q, 1.5, 57));
  });

  it('ENV>GAIN: VCO 1 into SIGNAL IN opens the VCA with no key held', () => {
    const p = FM1_PRESETS['Sallen 20']();
    set(p, 'signal in', 2);
    expect(rms(render(p, 0.5).subarray(SR / 4))).toBe(0); // route OFF: silent without a key
    set(p, 'esp route', 3);
    expect(rms(render(p, 0.5).subarray(SR / 4))).toBeGreaterThan(0.02);
  });

  it('TRIG>EGS: the MG into SIGNAL IN fires both EGs with no key held', () => {
    const p = FM1_PRESETS['Sallen 20']();
    set(p, 'signal in', 4);
    set(p, 'threshold', 0.2);
    expect(rms(render(p, 1).subarray(SR / 2))).toBe(0);
    set(p, 'esp route', 4);
    expect(rms(render(p, 1).subarray(SR / 2))).toBeGreaterThan(0.02);
  });

  it('F-V>VCO 2: VCO 2 follows VCO 1, an octave up when VCO 1 goes up an octave', () => {
    const at = (scale: number, route: number): number => {
      const p = FM1_PRESETS['Sallen 20']();
      set(p, 'signal in', 2);
      set(p, 'esp route', route);
      set(p, 'vco 1 scale', scale);
      set(p, 'vco 1 level', 0);
      set(p, 'vco 2 level', 1);
      set(p, 'vco 2 wave', 2); // square: one pair of edges per cycle
      set(p, 'cutoff', 16000, 'eg2/ext'); // the low pass's (after the high pass's rows)
      return pitch(render(p, 1.5, 57).subarray(SR / 2));
    };
    expect(at(4, 2) / at(3, 2)).toBeCloseTo(2, 1);
    expect(at(4, 1) / at(3, 1)).toBeCloseTo(1, 2); // route OFF: VCO 2 keeps its pitch
  });
});
