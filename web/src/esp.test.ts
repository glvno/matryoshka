// SPDX-License-Identifier: GPL-3.0-only
// The Follower (`esp`), after the Korg MS-20's External Signal Processor: pitch to voltage, envelope follower, trigger.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, IMPLS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { FM1_PRESETS, PRESETS } from './presets';

const SR = 44118;
const C4 = 261.6255653;
const BLOCK = 128;
const Q2 = 22059, Q4 = 11029, Q8 = 5514;

type Wave = 'sine' | 'saw' | 'square';
/** sine, naive saw, and a soft square (tanh of a sine: steep edges between samples, as a band-limited oscillator's) */
const sample = (w: Wave, ph: number): number =>
  w === 'sine' ? Math.sin(2 * Math.PI * ph) : w === 'saw' ? 2 * ph - 1 : Math.tanh(6 * Math.sin(2 * Math.PI * ph)) / Math.tanh(6);

/** run the module on `src` (a function of the sample index), return its outputs */
function follow(src: (i: number) => number, len: number, p: Record<string, number> = {}, connected = true) {
  const impl = IMPLS.esp, def = DEFS.esp;
  const st = impl.init(SR);
  const params = { ...Object.fromEntries(def.params.map((q) => [q.name, q.default])), ...p };
  const outs = Object.fromEntries(def.outputs.map((o) => [o.name, new Float32Array(len)]));
  for (let at = 0; at < len; at += BLOCK) {
    const n = Math.min(BLOCK, len - at);
    const inp = new Float32Array(n);
    for (let i = 0; i < n; i++) inp[i] = src(at + i);
    const out = Object.fromEntries(def.outputs.map((o) => [o.name, new Float32Array(n)]));
    impl.process({ sr: SR, n, inp: { in: inp }, out, connected: { in: connected }, p: params, voice: {} as never }, st);
    for (const o of def.outputs) outs[o.name].set(out[o.name], at);
  }
  return outs;
}
const tone = (w: Wave, hz: number, amp = 0.5) => (i: number): number => amp * sample(w, (i * hz / SR) % 1);
const mean = (a: Float32Array, from: number, to = a.length): number => a.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);
const cents = (pitch: number, hz: number): number => 1200 * (pitch - Math.log2(hz / C4));

describe('Follower: pitch to voltage', () => {
  for (const w of ['sine', 'saw', 'square'] as Wave[])
    for (const hz of [55, 110, 220, 440, 880, 1760])
      it(`tracks a ${w} at ${hz} Hz within 3 cents, in octaves from C4`, () => {
        const { pitch } = follow(tone(w, hz), Q2, { lowcut: 20, highcut: 4000 });
        const p = mean(pitch, Q4);
        expect(Math.abs(cents(p, hz))).toBeLessThan(3);
        // steady: no sample of the last quarter second more than 10 cents off
        for (let i = Q4; i < Q2; i += 97) expect(Math.abs(cents(pitch[i], hz))).toBeLessThan(10);
      });

  it('follows a pitch change within a few periods', () => {
    const { pitch } = follow((i) => (i < Q4 ? tone('saw', 220)(i) : tone('saw', 440)(i)), Q2);
    expect(Math.abs(cents(mean(pitch, Q8, Q4), 220))).toBeLessThan(3);
    expect(Math.abs(cents(pitch[Q4 + 1000], 440))).toBeLessThan(10); // 1000 samples: 10 periods of 440 Hz
  });

  it('adds cv adjust in semitones', () => {
    const { pitch } = follow(tone('sine', 220), Q2, { cvadj: 7 });
    expect(Math.abs(cents(mean(pitch, Q4), 220) - 700)).toBeLessThan(3);
  });

  it('gives no pitch for silence, and holds the last pitch when the signal stops', () => {
    expect(follow(() => 0, Q4).pitch.every((v) => v === 0)).toBe(true);
    const quiet = follow(tone('sine', 440, 0.0005), Q4).pitch; // below the floor (-48 dB after the band pass)
    expect(quiet.every((v) => v === 0)).toBe(true);
    const { pitch } = follow((i) => (i < Q4 ? tone('sine', 330)(i) : 0), Q2);
    const held = pitch[Q2 - 1];
    expect(Math.abs(cents(held, 330))).toBeLessThan(3);
  });

  it('a high cut below the harmonics keeps a bright saw on its fundamental', () => {
    const { pitch } = follow(tone('saw', 110), Q2, { highcut: 200 });
    expect(Math.abs(cents(mean(pitch, Q4), 110))).toBeLessThan(3);
  });
});

describe('Follower: envelope and trigger', () => {
  it('env follows the level of amp (input x level)', () => {
    const { env, amp } = follow((i) => (i & 64 ? 0.25 : -0.25), Q4, { level: 2 }); // a square, |x| flat
    expect(amp[100]).toBeCloseTo(0.5, 5); // (100 & 64: high)
    expect(mean(env, Q8)).toBeCloseTo(0.5, 3);
    const s = follow((i) => (i < Q4 ? (i & 64 ? 0.5 : -0.5) : 0), Q2).env;
    expect(s[Q4 + Math.round(0.08 * SR)]).toBeLessThan(0.5 * 0.02); // 99 % gone after the release time
  });

  it('trig rises when env passes the threshold and falls below 3/4 of it', () => {
    const ramp = (i: number): number => Math.min(1, i / SR) * sample('square', (i * 220 / SR) % 1);
    const { env, trig } = follow(ramp, SR, { thresh: 0.4 });
    const on = trig.findIndex((v) => v > 0.5);
    expect(env[on]).toBeGreaterThan(0.4);
    expect(env[on - 1]).toBeLessThanOrEqual(0.4);
    const down = follow((i) => (i < Q4 ? 0.6 : 0) * sample('square', (i * 220 / SR) % 1), Q2, { thresh: 0.4 });
    const off = down.trig.findIndex((v, i) => i > Q4 && v < 0.5);
    expect(down.env[off]).toBeLessThan(0.3);
    expect(down.env[off - 1]).toBeGreaterThanOrEqual(0.3);
  });

  it('rests with nothing patched to in', () => {
    const o = follow(tone('sine', 220), BLOCK * 4, { cvadj: 12 }, false);
    expect(o.env.every((v) => v === 0) && o.trig.every((v) => v === 0) && o.bp.every((v) => v === 0)).toBe(true);
    expect(o.pitch.every((v) => v === 1)).toBe(true);
  });
});

describe('Sallen 20: the ESP', () => {
  it('has the panel rows and the patch panel jacks', () => {
    for (const p of [PRESETS['Sallen 20'], FM1_PRESETS['Sallen 20']]) {
      const patch = p();
      const a = patch.assemblies!.find((x) => x.name === 'Sallen 20')!;
      const esp = patch.modules.find((m) => m.type === 'esp')!;
      const rows = a.params.filter((r) => r.module === esp.id).map((r) => r.label);
      expect(rows).toEqual(['signal level', 'low cut', 'high cut', 'cv adjust', 'threshold']);
      expect(a.inputs.some((r) => r.label === 'esp signal in' && r.module === esp.id && r.port === 'in')).toBe(true);
      for (const label of ['esp amp out', 'esp bpf out', 'f-v cv out', 'env out', 'trig out']) expect(a.outputs.some((r) => r.label === label && r.module === esp.id), label).toBe(true);
    }
  });

  // the manual's patch ("Using the External Signal Processor", step 4): TRIG OUT to TRIGGER IN, F-V CV OUT to VCO 1+2 CV IN;
  // no key is played, the oscillator patched into SIGNAL IN plays the instrument
  const played = (patchTrig: boolean): number => {
    const p = PRESETS['Sallen 20']();
    const a = p.assemblies!.find((x) => x.name === 'Sallen 20')!;
    const inp = (label: string) => a.inputs.find((r) => r.label === label)!;
    const out = (label: string) => a.outputs.find((r) => r.label === label)!;
    const wire = (from: string, to: string): void => {
      const t = inp(to);
      for (const r of [t, ...(t.also ?? [])]) connect(p, DEFS, { module: out(from).module, port: out(from).port }, { module: r.module, port: r.port });
    };
    const src = addModule(p, DEFS.osc, 0, 0);
    Object.assign(src.params, { wave: 2, coarse: 7, level: 0.5 });
    connect(p, DEFS, { module: src.id, port: 'out' }, { module: inp('esp signal in').module, port: 'in' });
    wire('f-v cv out', 'vco 1+2 cv in');
    if (patchTrig) wire('trig out', 'trigger in');
    const e = new Engine(SR);
    e.load(p);
    const l = new Float32Array(Q2), r = new Float32Array(Q2);
    e.render(l, r);
    return Math.sqrt(l.slice(Q4).reduce((s, v) => s + v * v, 0) / (Q2 - Q4));
  };

  it('plays from a patched-in oscillator through TRIG OUT and F-V CV OUT, and is silent without the trigger', () => {
    expect(played(true)).toBeGreaterThan(0.01);
    expect(played(false)).toBeLessThan(1e-4);
  });
});

it('emptyPatch can hold a Follower wired to an Output', () => {
  const p = emptyPatch();
  const f = addModule(p, DEFS.esp, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  connect(p, DEFS, { module: f.id, port: 'amp' }, { module: out.id, port: 'l' });
  const e = new Engine(SR);
  e.load(p);
  e.render(new Float32Array(256), new Float32Array(256));
});
