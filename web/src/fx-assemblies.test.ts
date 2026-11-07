// SPDX-License-Identifier: GPL-3.0-only
// The effect assemblies of #661, played in the browser engine: a known input, the behaviour each one is for.
import { describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly, targetsOf } from './assembly';
import { applyPreset } from './device-presets';
import { BLOCK, Engine } from './engine';
import { shippedPresets } from './factory-presets';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';

const SR = 48000;
const C4 = 261.6256;

/** a sine (C4 + `coarse` semitones, or noise) at a level set by an Offset, into the named factory effect, its out into the
 * Output; `at(defId)` is the patch id of the definition's module `defId` */
function rig(name: string, o: { coarse?: number; wave?: number; noise?: boolean; preset?: string } = {}) {
  const def = FACTORY.find((d) => d.name === name);
  if (!def) throw new Error(`no factory assembly ${name}`);
  const p = emptyPatch('t');
  const src = o.noise ? addModule(p, DEFS.noise, 0, 0) : addModule(p, DEFS.osc, 0, 0);
  Object.assign(src.params, o.noise ? { level: 1 } : { wave: o.wave ?? 0, level: 1, coarse: o.coarse ?? 0 });
  const lvl = addModule(p, DEFS.const, 0, 0);
  lvl.params.value = 0;
  const vca = addModule(p, DEFS.vca, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  connect(p, DEFS, { module: src.id, port: 'out' }, { module: vca.id, port: 'in' });
  connect(p, DEFS, { module: lvl.id, port: 'out' }, { module: vca.id, port: 'cv' });
  const a = insertAssembly(p, DEFS, def, 0, 0);
  for (const t of targetsOf(a.inputs.find((r) => r.label === 'in')!)) expect(connect(p, DEFS, { module: vca.id, port: 'out' }, t)).toBe(true);
  const o1 = a.outputs.find((r) => r.label === 'out')!;
  connect(p, DEFS, { module: o1.module, port: o1.port }, { module: out.id, port: 'l' });
  if (o.preset) expect(applyPreset(p, a, shippedPresets(def).find((x) => x.name === o.preset)!), o.preset).toBe(true);
  const e = new Engine(SR);
  e.load(p);
  const at = (defId: number): number => a.modules[def.modules.findIndex((m) => m.id === defId)];
  const row = (label: string, v: number): void => {
    const r = a.params.find((x) => x.label === label)!;
    e.setParam(r.module, r.param, v);
  };
  /** play `seconds` at input level `level`; the probed outputs' samples, in order */
  const run = (seconds: number, level: number, probes: [number, string][]): Float32Array[] => {
    e.setParam(lvl.id, 'value', level);
    const n = Math.round((seconds * SR) / BLOCK);
    const got = probes.map(() => new Float32Array(n * BLOCK));
    const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
    for (let b = 0; b < n; b++) {
      e.render(l, r);
      probes.forEach(([id, port], k) => got[k].set(e.probe(id, port)!, b * BLOCK));
    }
    return got;
  };
  return { def, a, e, at, row, run, out: [o1.module, o1.port] as [number, string], input: [vca.id, 'out'] as [number, string] };
}

/** the magnitude of the frequency f in x (Goertzel), as an amplitude */
function tone(x: Float32Array, f: number): number {
  const w = (2 * Math.PI * f) / SR, k = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i] + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2)) / x.length;
}
const rms = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const mean = (x: Float32Array): number => x.reduce((s, v) => s + v, 0) / x.length;

describe('effect assemblies (#661)', () => {
  it('ship on the Effects shelf, each with one in and one out', () => {
    for (const name of ['envelope filter', 'ducking delay', 'gated reverb', 'overdrive', 'octave fuzz']) {
      const d = FACTORY.find((x) => x.name === name)!;
      expect(d.category, name).toBe('Effects');
      expect(d.inputs.map((r) => r.label), name).toEqual(['in']);
      expect(d.outputs.map((r) => r.label), name).toEqual(['out']);
    }
  });

  it('envelope filter: the cutoff follows the level, so a louder input comes out brighter', () => {
    // a saw at C3: the share of its 6th harmonic against the fundamental, quiet and loud
    const x = rig('envelope filter', { coarse: -12, wave: 2 });
    const f0 = C4 / 2;
    const bright = (level: number): number => {
      x.run(0.3, level, [x.out]);
      const [y] = x.run(0.2, level, [x.out]);
      return tone(y, 6 * f0) / tone(y, f0);
    };
    const quiet = bright(0.05), loud = bright(0.8);
    expect(loud).toBeGreaterThan(quiet * 4);
    // the Follower's envelope is what moves: it tracks the level
    const [env] = x.run(0.2, 0.8, [[x.at(1), 'env']]);
    expect(mean(env.subarray(env.length / 2))).toBeGreaterThan(0.5);
  });

  it('ducking delay: the echoes drop while the dry signal plays and come back in the gap', () => {
    const x = rig('ducking delay', { coarse: 0 });
    // echoes before the Compressor (the Delay's wet line) and after it (what is heard)
    const probes: [number, string][] = [[x.at(1), 'out'], [x.at(2), 'out']];
    const [rawOn, duckOn] = x.run(1.5, 0.5, probes);
    const half = rawOn.length / 2;
    expect(rms(rawOn, half)).toBeGreaterThan(0.1); // the delay has echoes while playing
    expect(rms(duckOn, half) / rms(rawOn, half)).toBeLessThan(0.1); // ducked by more than 20 dB
    // the input stops: after the release the echoes pass at full level
    const [rawOff, duckOff] = x.run(0.6, 0, probes);
    const from = Math.round(0.35 * SR), to = Math.round(0.5 * SR);
    expect(rms(rawOff, from, to)).toBeGreaterThan(0.02);
    expect(rms(duckOff, from, to) / rms(rawOff, from, to)).toBeGreaterThan(0.8);
    // duck 1 (ratio 1): no ducking at all
    x.row('duck', 1);
    const [raw1, duck1] = x.run(1, 0.5, probes);
    expect(rms(duck1, raw1.length / 2) / rms(raw1, raw1.length / 2)).toBeGreaterThan(0.95);
  });

  it('gated reverb: the gate holds the tail while the hit is loud, then closes it', () => {
    const x = rig('gated reverb', { noise: true });
    x.run(0.2, 0, []);
    // a 60 ms burst of noise, then silence
    const probes: [number, string][] = [[x.at(1), 'out'], [x.at(2), 'out']];
    const [rvHit, gHit] = x.run(0.06, 0.7, probes);
    const [rvTail, gTail] = x.run(1.0, 0, probes);
    const rv = new Float32Array([...rvHit, ...rvTail]), g = new Float32Array([...gHit, ...gTail]);
    const ms = (t: number): number => Math.round((t / 1000) * SR);
    // inside the hold (250 ms) the gate is open: the reverb passes (at the VCA's 0.7)
    expect(rms(g, ms(100), ms(200)) / rms(rv, ms(100), ms(200))).toBeGreaterThan(0.65);
    // after hold + close the reverb still rings, but nothing comes through
    expect(rms(rv, ms(500), ms(800))).toBeGreaterThan(0.01);
    expect(rms(g, ms(500), ms(800))).toBeLessThan(rms(rv, ms(500), ms(800)) * 0.01);
    // a longer hold keeps it open longer
    x.row('hold', 0.6);
    x.run(1.5, 0, []);
    const [rv2a, g2a] = x.run(0.06, 0.7, probes);
    const [rv2b, g2b] = x.run(1.0, 0, probes);
    const rv2 = new Float32Array([...rv2a, ...rv2b]), g2 = new Float32Array([...g2a, ...g2b]);
    expect(rms(g2, ms(500), ms(600)) / rms(rv2, ms(500), ms(600))).toBeGreaterThan(0.65);
  });

  it('overdrive: drive adds harmonics, tone takes the top off', () => {
    const x = rig('overdrive', { coarse: -12 });
    const f0 = C4 / 2;
    const thd = (): number => {
      x.run(0.3, 0.5, [x.out]);
      const [y] = x.run(0.2, 0.5, [x.out]);
      return (tone(y, 3 * f0) + tone(y, 5 * f0)) / tone(y, f0);
    };
    x.row('drive', 1.5);
    const low = thd();
    x.row('drive', 20);
    const high = thd();
    expect(high).toBeGreaterThan(low * 2);
    x.row('tone', 16000);
    x.run(0.3, 0.5, []);
    const [open] = x.run(0.2, 0.5, [x.out]);
    x.row('tone', 600);
    x.run(0.3, 0.5, []);
    const [dark] = x.run(0.2, 0.5, [x.out]);
    expect(tone(dark, 9 * f0) / tone(dark, f0)).toBeLessThan((tone(open, 9 * f0) / tone(open, f0)) * 0.3);
    expect(Math.max(...open.map(Math.abs))).toBeLessThan(1);
  });

  it('octave fuzz: a sine comes out with its fundamental an octave down, and no offset', () => {
    const x = rig('octave fuzz', { coarse: -12 });
    const f0 = C4 / 2;
    x.row('fuzz', 0); // the octave alone
    x.run(0.3, 0.5, []);
    const [y] = x.run(0.5, 0.5, [x.out]);
    expect(tone(y, f0 / 2)).toBeGreaterThan(0.1);
    expect(tone(y, f0 / 2)).toBeGreaterThan(tone(y, f0));
    expect(Math.abs(mean(y))).toBeLessThan(0.02);
    // together with the fuzz both are there; nothing an octave down without the octave row
    x.row('fuzz', 0.6);
    const [both] = x.run(0.5, 0.5, [x.out]);
    expect(tone(both, f0 / 2)).toBeGreaterThan(0.1);
    expect(tone(both, f0)).toBeGreaterThan(0.1);
    x.row('octave', 0);
    x.run(0.1, 0.5, []);
    const [fuzz] = x.run(0.5, 0.5, [x.out]);
    expect(tone(fuzz, f0 / 2)).toBeLessThan(0.01);
    // silence after the input stops: the octave's pulse sits on the input's envelope
    x.row('octave', 0.6);
    x.run(0.5, 0, []);
    const [quiet] = x.run(0.2, 0, [x.out]);
    expect(rms(quiet)).toBeLessThan(0.001);
  });

  it('ship their cards\' presets: each plays a saw and noise at half scale below full scale, no louder than the input', () => {
    for (const name of ['envelope filter', 'ducking delay', 'gated reverb', 'overdrive', 'octave fuzz']) {
      const list = shippedPresets(FACTORY.find((d) => d.name === name)!);
      expect(list.length, name).toBeGreaterThanOrEqual(4);
      for (const pr of list)
        for (const src of [{ coarse: -24, wave: 2 }, { noise: true }]) {
          const x = rig(name, { ...src, preset: pr.name });
          const [y, inp] = x.run(1, 0.5, [x.out, x.input]);
          const [t] = x.run(1, 0, [x.out]);
          const peak = Math.max(...y.map(Math.abs), ...t.map(Math.abs));
          const gain = rms(y, y.length / 2) / rms(inp, inp.length / 2);
          expect(peak, `${name} ${pr.name}`).toBeLessThan(1);
          // (noise loses most of its energy in a low pass: the loudness is compared on the saw)
          if (!src.noise) expect(gain, `${name} ${pr.name}`).toBeGreaterThan(0.3);
          expect(gain, `${name} ${pr.name}`).toBeLessThan(1.5);
        }
    }
  });
});
