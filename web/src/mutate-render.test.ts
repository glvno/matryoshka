// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Make candidates by ear (#1033, D-996): what a render measures, how a sound fits a category, a round that keeps the
// candidates that pass and fills with the nearest, and a round that leaves the browser's storage as it was (no sound kept).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardScope, mutatePatch, PROFILES } from './mutate';
import { DEFS } from './modules';
import { filterRound, fitScore, measureShape, OVERSAMPLE, PASS, type Shape } from './mutate-render';
import type { Patch } from './patch';
import { renderPhrase } from './phrase-render';
import { makePhrase } from './phrases';
import { FM1_PRESETS } from './presets';

const SR = 44100;
const held = makePhrase('held', 57);   // (3 s held from 0, nothing after: the render runs 6 s)

/** a 220 Hz sine through an ADSR-shaped contour: a linear attack, decay and release that come 99 % of the way in their time */
function contour(a: number, d: number, s: number, r: number): [Float32Array, Float32Array] {
  const n = 6 * SR, out = new Float32Array(n), off = 3;
  let level = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t >= off) level *= Math.exp(-4.6 / (r * SR));
    else if (t < a) level = t / a;
    else level = s + (level - s) * Math.exp(-4.6 / (d * SR));
    out[i] = 0.5 * level * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  return [out, out];
}

describe('measureShape', () => {
  it('reads attack, decay, sustain, release and brightness from a render of the held note', () => {
    const s = measureShape(...contour(0.1, 0.4, 0.5, 0.6), SR, held);
    expect(s.attack).toBeGreaterThan(0.07);
    expect(s.attack).toBeLessThan(0.11);
    expect(s.sustain).toBeCloseTo(0.5, 1);
    expect(s.decay).toBeGreaterThan(0.3);
    expect(s.decay).toBeLessThan(0.5);
    expect(s.release).toBeGreaterThan(0.45);
    expect(s.release).toBeLessThan(0.75);
    expect(s.brightness).toBeGreaterThan(200);
    expect(s.brightness).toBeLessThan(240);
  });

  it('says silent, and a release the render ends before is a least value', () => {
    expect(measureShape(new Float32Array(6 * SR), new Float32Array(6 * SR), SR, held)).toEqual({ silent: true });
    const s = measureShape(...contour(0.01, 0.4, 0.9, 20), SR, held);
    expect(s.releaseAtLeast).toBe(true);
    expect(s.decay).toBeUndefined();   // (a fall of less than a fifth has no decay to read)
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
      n: 3, profile: PROFILES.pad, parent: { name: '0' } as Patch, phrase: held, sr: SR,
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
      n: 2, profile: PROFILES.pad, parent: {} as Patch, phrase: held, sr: SR, next: () => ({}) as Patch,
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
      n: 1, profile: PROFILES.pluck, parent: p, phrase: held, sr: SR,
      next: () => mutatePatch(p, cardScope(p), 'mutate', 0.1, DEFS, Math.random, { category: 'pluck', anchor: p }).patch,
      render: (q) => renderPhrase(q, held),
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
