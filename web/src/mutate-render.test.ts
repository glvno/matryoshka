// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Generate by ear (#1033, D-996): the probe and what its render measures, censored at its window, how a sound fits a
// category, a round that keeps the candidates that pass and fills with the nearest, and a round that leaves the browser's
// storage as it was (no sound kept).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keysOf } from './levels';
import { cardScope, mutatePatch, PROFILES } from './mutate';
import { DEFS } from './modules';
import { filterRound, fitScore, measureProbe, OVERSAMPLE, PASS, PROBE_HOLD, PROBE_RENDER, PROBE_SECONDS, probePhrase, type Shape } from './mutate-render';
import type { Patch } from './patch';
import { renderPhrase } from './phrase-render';
import { PHRASE_VEL } from './phrases';
import { FM1_PRESETS } from './presets';

const SR = 44100;

/** a 220 Hz sine through an ADSR-shaped contour as the probe plays it (held PROBE_HOLD, PROBE_SECONDS in all): a linear
 *  attack, decay and release that come 99 % of the way in their time */
function contour(a: number, d: number, s: number, r: number): [Float32Array, Float32Array] {
  const n = PROBE_SECONDS * SR, out = new Float32Array(n);
  let level = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t >= PROBE_HOLD) level *= Math.exp(-4.6 / (r * SR));
    else if (t < a) level = t / a;
    else level = s + (level - s) * Math.exp(-4.6 / (d * SR));
    out[i] = 0.5 * level * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  return [out, out];
}

describe('the probe', () => {
  it('is one note, velocity 100, held 1 s: C3, or a drum engine’s first Drum map row', () => {
    const mono = FM1_PRESETS['Shush 101']();
    expect(probePhrase(mono)).toEqual({ kind: 'held', notes: [{ at: 0, len: 1, note: 48, vel: PHRASE_VEL }], length: 2 });
    const drums = FM1_PRESETS['Elvira 2']();
    const row = Math.round(drums.modules.find((m) => m.type === 'drummap')!.params.n1 as number);
    expect(keysOf(drums).key).toEqual([row]);
    expect(probePhrase(drums).notes.map((n) => n.note)).toEqual([row]);
  });

  it('renders 2 s at most, and stops once the release has fallen 60 dB', async () => {
    const pluck = FM1_PRESETS['Shush 101']();
    const [l] = await renderPhrase(pluck, probePhrase(pluck), PROBE_RENDER);
    expect(l.length).toBeLessThanOrEqual(PROBE_SECONDS * SR);
    expect(l.length).toBeGreaterThan(PROBE_HOLD * SR);
  });
});

describe('measureProbe', () => {
  it('reads attack, decay, sustain, release and brightness from a render of the probe', () => {
    const s = measureProbe(...contour(0.1, 0.4, 0.4, 0.6), SR);
    expect(s.attack).toBeGreaterThan(0.07);
    expect(s.attack).toBeLessThan(0.11);
    expect(s.attackAtLeast).toBeUndefined();
    expect(s.sustain).toBeCloseTo(0.4, 1);
    expect(s.decay).toBeGreaterThan(0.3);
    expect(s.decay).toBeLessThan(0.5);
    expect(s.release).toBeGreaterThan(0.45);
    expect(s.release).toBeLessThan(0.75);
    expect(s.releaseAtLeast).toBeUndefined();
    expect(s.brightness).toBeGreaterThan(200);
    expect(s.brightness).toBeLessThan(240);
  });

  it('says silent; an attack still rising at the end of the hold and a release not 90 % down are at least 1 s', () => {
    expect(measureProbe(new Float32Array(PROBE_SECONDS * SR), new Float32Array(PROBE_SECONDS * SR), SR)).toEqual({ silent: true });
    const s = measureProbe(...contour(2, 1, 1, 6), SR);
    expect(s).toMatchObject({ attack: 1, attackAtLeast: true, release: 1, releaseAtLeast: true });
    expect(s.decay).toBeUndefined();
  });

  it('censored values classify pads and drones, and nothing short', () => {
    for (const [a, r] of [[2, 6], [0.6, 6], [2, 3]]) {
      const s = measureProbe(...contour(a, 1, 1, r), SR);
      expect(s.releaseAtLeast).toBe(true);
      expect(fitScore(s, PROFILES.pad), `pad ${a}/${r}`).toBeLessThanOrEqual(PASS);
      expect(fitScore(s, PROFILES.drone), `drone ${a}/${r}`).toBeLessThanOrEqual(PASS);
      for (const short of ['lead', 'stab', 'pluck', 'bass'] as const) expect(fitScore(s, PROFILES[short]), `${short} ${a}/${r}`).toBeGreaterThan(PASS);
    }
  });
});

describe('fitScore', () => {
  it('is 0 inside the profile, more the farther out, Infinity when silent', () => {
    const pad: Shape = { attack: 1, decay: 1, sustain: 0.8, release: 2, brightness: 300 };
    expect(fitScore(pad, PROFILES.pad, { brightness: 400 })).toBe(0);
    expect(fitScore(pad, PROFILES.pluck)).toBeGreaterThan(5);
    expect(fitScore({ ...pad, attack: 0.15 }, PROFILES.pad)).toBeCloseTo(1, 6);   // (an octave short)
    expect(fitScore({ ...pad, brightness: 800 }, PROFILES.pad, { brightness: 400 })).toBeCloseTo(0.5, 6);   // (an octave brighter: half)
    expect(fitScore({ ...pad, sustain: 0.9, release: 9, releaseAtLeast: true }, PROFILES.drone)).toBeCloseTo(Math.log2(9 / 8), 6);
    expect(fitScore({ silent: true }, PROFILES.pad)).toBe(Infinity);
  });
});

describe('filterRound', () => {
  it('keeps the candidates that pass as they come, then the nearest of the rest, at most OVERSAMPLE times rendered', async () => {
    // (a "render" per candidate whose contour is its number's: a pad's attack for 2 and 5, a little short for 3, a pluck
    // for the rest)
    const attacks: Record<number, number> = { 2: 1, 5: 1.2, 3: 0.2 };
    const shapes = (k: number): [Float32Array, Float32Array] => (k in attacks ? contour(attacks[k], 1, 0.8, 2) : contour(0.001, 0.05, 0, 0.01));
    let k = 0;
    const kept: [number, number][] = [];
    const r = await filterRound({
      n: 3, profile: PROFILES.pad, parent: { name: '0' } as Patch, sr: SR,
      next: () => ({ name: String(++k) }) as Patch,
      render: async (p) => shapes(Number(p.name)),
      keep: (p, fit) => void kept.push([Number(p.name), fit]),
    });
    expect(r).toEqual({ passed: 2, rendered: 3 * OVERSAMPLE, filled: 1 });
    expect(kept.map((x) => x[0])).toEqual([2, 5, 3]);
    expect(kept.slice(0, 2).every((x) => x[1] <= PASS)).toBe(true);
  });

  it('stops when told, keeping what passed', async () => {
    let calls = 0;
    const r = await filterRound({
      n: 2, profile: PROFILES.pad, parent: {} as Patch, sr: SR, next: () => ({}) as Patch,
      render: async () => contour(1, 1, 0.8, 2), keep: () => {}, cancelled: () => ++calls > 2,
    });
    expect(r.rendered).toBeLessThan(2);
  });
});

describe('a round by ear and the browser (#1033)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders in memory only: storage, caches and files are left as they were', async () => {
    localStorage.setItem('matryoshka.patch', '{"kept":true}');
    const before = JSON.stringify({ ...localStorage });
    const set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem');
    const opened = vi.fn();
    vi.stubGlobal('indexedDB', { open: opened });
    vi.stubGlobal('caches', { open: opened });
    const url = vi.spyOn(URL, 'createObjectURL');
    const p = FM1_PRESETS['Shush 101']();
    const kept: Patch[] = [];
    const r = await filterRound({
      n: 1, profile: PROFILES.pluck, parent: p, sr: SR,
      next: () => mutatePatch(p, cardScope(p), 'mutate', 0.1, DEFS, Math.random, { category: 'pluck', anchor: p }).patch,
      render: (q) => renderPhrase(q, probePhrase(q), PROBE_RENDER),
      keep: (q) => void kept.push(q),
    });
    expect(kept.length).toBe(1);
    expect(r.rendered).toBeGreaterThan(0);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(url).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).toBe(before);
    vi.unstubAllGlobals();
  }, 30_000);
});
