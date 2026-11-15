// SPDX-License-Identifier: GPL-3.0-only
// Shush 101, after the Roland SH-101 (#869, D-1057, D-1202): its factory patch fits with every FX stage on, and the panel's
// switches do what the SH-101's do, measured in the browser engine.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEVICE_SR as SR } from './modules';
import type { Patch } from './patch';
import { deviceBudget } from './patchbin';
import { CPU_VOICE_TOP } from './cpu';
import { FM1_PRESETS } from './presets';

const base = (): Patch => FM1_PRESETS['Shush 101']();
/** the factory patch with card rows set (by label; a Selector row by its position name) */
function variant(set: Record<string, number | string>): Patch {
  const p = base();
  const a = p.assemblies!.find((x) => x.label === 'Shush 101')!;
  for (const [label, v] of Object.entries(set)) {
    const r = a.params.find((x) => x.label === label)!;
    const value = typeof v === 'string' ? r.names!.indexOf(v) + 1 : v;
    if (typeof v === 'string') expect(value, `${label} ${v}`).toBeGreaterThan(0);
    for (const t of [r, ...(r.also ?? [])]) p.modules.find((m) => m.id === t.module)!.params[t.param] = value;
  }
  return p;
}
type Ev = [number, number, boolean]; // seconds, note, on
function render(p: Patch, events: Ev[], seconds: number): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  const out = new Float32Array(Math.ceil((seconds * SR) / 128) * 128), l = new Float32Array(128), r = new Float32Array(128);
  const ev = [...events].sort((x, y) => x[0] - y[0]);
  for (let o = 0, k = 0; o < out.length; o += 128) {
    while (k < ev.length && ev[k][0] * SR <= o) {
      const [, n, on] = ev[k++];
      if (on) e.noteOn(n, 0.8); else e.noteOff(n);
    }
    e.render(l, r);
    out.set(l, o);
  }
  return out;
}
/** fundamental (Hz, from rising zero crossings) and the fraction of samples above zero over [t0, t1) s */
function pitchDuty(x: Float32Array, t0: number, t1: number): { hz: number; duty: number } {
  const a = Math.floor(t0 * SR), b = Math.floor(t1 * SR);
  let first = -1, last = -1, n = 0, pos = 0;
  for (let i = a + 1; i < b; i++) {
    if (x[i] > 0) pos++;
    if (x[i - 1] <= 0 && x[i] > 0) {
      if (first < 0) first = i; else n++;
      last = i;
    }
  }
  return { hz: n ? (n * SR) / (last - first) : 0, duty: pos / (b - a) };
}
const rms = (x: Float32Array, t0: number, t1: number): number => {
  let s = 0;
  const a = Math.floor(t0 * SR), b = Math.floor(t1 * SR);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};
const st = (hz: number, ref: number): number => 12 * Math.log2(hz / ref);
const C4 = 261.63;
// one source at a time, the filter open, the VCA on the gate
const dry = { freq: 16000, res: 0, env: 0, kybd: 0, vca: 'GATE', pulse: 0, saw: 0, 'sub osc': 0, noise: 0 };
const hold: Ev[] = [[0, 60, true], [1, 60, false]];
const legato: Ev[] = [[0, 60, true], [0.5, 72, true], [0.55, 60, false], [1.2, 72, false]];
const detached: Ev[] = [[0, 60, true], [0.45, 60, false], [0.5, 72, true], [1.2, 72, false]];

describe('Shush 101 (#869)', () => {
  it('is the last factory patch and fits the FM-1 with every FX stage and the players on (D-1200)', () => {
    expect(Object.keys(FM1_PRESETS).at(-1)).toBe('Shush 101');
    const p = base();
    for (const m of p.modules) delete m.bypass;
    const b = deviceBudget(p);
    expect(b.fits).toBe(true);
    expect(b.cpu.use).toBeLessThanOrEqual(CPU_VOICE_TOP);
  });

  it('steps its Arpeggiator on the modulator square', () => {
    const p = base();
    const arp = p.modules.find((m) => m.type === 'arp')!;
    const lfo = p.modules.find((m) => m.type === 'lfo' && p.assemblies![0].modules.includes(m.id))!;
    expect(p.cables.some((c) => c.from.module === lfo.id && c.from.port === 'pulse' && c.to.module === arp.id && c.to.port === 'clk')).toBe(true);
  });

  it('RANGE adds exact octaves', () => {
    const got = ["16'", "8'", "4'", "2'"].map((r) => st(pitchDuty(render(variant({ ...dry, saw: 1, range: r }), hold, 1), 0.2, 0.9).hz, C4));
    got.forEach((v, i) => expect(v).toBeCloseTo((i - 1) * 12, 1));
  });

  it('SUB MODE: a square one or two octaves down, or a 25 % pulse two octaves down', () => {
    const want = [[-12, 0.5], [-24, 0.5], [-24, 0.25]];
    ['1 OCT DOWN', '2 OCT DOWN', '2 OCT PULSE'].forEach((m, i) => {
      const { hz, duty } = pitchDuty(render(variant({ ...dry, 'sub osc': 1, 'sub mode': m }), hold, 1), 0.2, 0.9);
      expect(st(hz, C4)).toBeCloseTo(want[i][0], 1);
      expect(duty).toBeCloseTo(want[i][1], 1);
    });
  });

  it('PW narrows the pulse from 50 % to 5 % (MAN)', () => {
    const duty = (pw: number): number => pitchDuty(render(variant({ ...dry, pulse: 1, 'pwm source': 'MAN', pw }), hold, 1), 0.2, 0.9).duty;
    expect(duty(0)).toBeCloseTo(0.5, 1);
    expect(duty(1)).toBeCloseTo(0.05, 1);
  });

  it('portamento: ON glides always, OFF never, AUTO only on legato notes', () => {
    const off = (mode: string, ev: Ev[]): number => Math.abs(st(pitchDuty(render(variant({ ...dry, saw: 1, portamento: 0.3, 'porta mode': mode }), ev, 1.2), 0.54, 0.58).hz, 2 * C4));
    expect(off('ON', legato)).toBeGreaterThan(1);
    expect(off('ON', detached)).toBeGreaterThan(1);
    expect(off('OFF', legato)).toBeLessThan(0.3);
    expect(off('AUTO', legato)).toBeGreaterThan(1);
    expect(off('AUTO', detached)).toBeLessThan(0.3);
  });

  it('ENV TRIGGER: GATE+TRIG restarts on a legato key, GATE does not, LFO restarts on the modulator', () => {
    const level = (mode: string): [number, number, number] => {
      const x = render(variant({ ...dry, saw: 1, vca: 'ENV', attack: 0.001, decay: 0.15 / 2.4, sustain: 0, trigger: mode, rate: 4 }), legato, 1.2);
      return [rms(x, 0.45, 0.5), rms(x, 0.5, 0.52), Math.max(...[0.8, 0.9, 1.0, 1.1].map((t) => rms(x, t, t + 0.02)))];
    };
    const [gtBefore, gtAfter] = level('GATE+TRIG');
    expect(gtAfter).toBeGreaterThan(5 * gtBefore + 0.01);
    const [gBefore, gAfter, gLate] = level('GATE');
    expect(gAfter).toBeLessThan(gBefore + 0.01);
    expect(gLate).toBeLessThan(0.01);
    expect(level('LFO')[2]).toBeGreaterThan(0.05);
  });

  it('VCA GATE holds the level where the envelope (sustain 0) has died away', () => {
    const at = (v: string): number => rms(render(variant({ ...dry, saw: 1, sustain: 0, decay: 0.05, vca: v }), hold, 1), 0.8, 0.9);
    expect(at('ENV')).toBeLessThan(0.01);
    expect(at('GATE')).toBeGreaterThan(0.05);
  });

  it('TUNE moves all three oscillators', () => {
    const p = variant({ tune: 50 });
    const osc = p.modules.filter((m) => m.type === 'osc' && p.assemblies![0].modules.includes(m.id));
    expect(osc).toHaveLength(3);
    for (const o of osc) expect(o.params.fine).toBe(50);
  });
});
