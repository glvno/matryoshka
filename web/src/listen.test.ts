// SPDX-License-Identifier: GPL-3.0-only
// Listening to one signal (#939, listen.ts): the listened output replaces the Output at the Output's level, faded in and
// back out, through a limiter that holds its peaks to the factory peak cap; only audio outputs can be listened to; with the
// engine, the signal is the output's own (an oscillator heard while the patch's Output plays nothing).
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { HEADROOM } from './headroom';
import { LISTEN_CEILING, ListenMix, listenable } from './listen';
import { DEFS } from './modules';
import { addModule, emptyPatch } from './patch';

const SR = 48000;
const sine = (n: number, a: number, at = 0): Float32Array => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * 440 * (at + i)) / SR));

/** blocks of 128 through a ListenMix over an Output playing `outV` constantly; the listened signal is `src(at)` */
function run(mix: ListenMix, blocks: number, src: (at: number) => Float32Array, level: number, outV = 0): Float32Array[] {
  const outs: Float32Array[] = [];
  for (let b = 0; b < blocks; b++) {
    const l = new Float32Array(128).fill(outV), r = new Float32Array(128).fill(outV);
    if (mix.sources) mix.process(l, r, 128, [src(b * 128)], level);
    outs.push(l);
  }
  return outs;
}

describe('ListenMix', () => {
  it('plays the listened signal at the Output level in place of the Output once faded in', () => {
    const mix = new ListenMix(SR);
    mix.set([{ id: 1, port: 'out' }]);
    const outs = run(mix, 40, (at) => sine(128, 0.5, at), 0.4, 0.3);
    const last = outs.at(-1)!, want = sine(128, 0.5 * 0.4, 39 * 128);
    for (let i = 0; i < 128; i++) expect(last[i]).toBeCloseTo(want[i], 2);   // (the DC blocker barely touches 440 Hz)
  });

  it('holds a loud signal to the factory peak cap', () => {
    expect(LISTEN_CEILING).toBe(HEADROOM);
    const mix = new ListenMix(SR);
    mix.set([{ id: 1, port: 'out' }]);
    const outs = run(mix, 100, (at) => sine(128, 4, at), 1);
    expect(Math.max(...outs.flatMap((b) => [...b].map(Math.abs)))).toBeLessThanOrEqual(LISTEN_CEILING + 1e-6);
    expect(Math.max(...[...outs.at(-1)!].map(Math.abs))).toBeGreaterThan(0.8 * LISTEN_CEILING);   // (limited, not muted)
  });

  it('fades back to the Output and then mixes nothing', () => {
    const mix = new ListenMix(SR);
    mix.set([{ id: 1, port: 'out' }]);
    run(mix, 20, (at) => sine(128, 0.5, at), 1, 0.3);
    mix.set(null);
    expect(mix.sources).not.toBeNull();   // (still fading)
    const outs = run(mix, 20, (at) => sine(128, 0.5, at), 1, 0.3);
    expect(mix.sources).toBeNull();
    for (const v of outs.at(-1)!) expect(v).toBeCloseTo(0.3, 6);
  });

  it('removes a DC offset', () => {
    const mix = new ListenMix(SR);
    mix.set([{ id: 1, port: 'out' }]);
    const outs = run(mix, 3000, () => new Float32Array(128).fill(0.5), 1);
    expect(Math.abs(outs.at(-1)![127])).toBeLessThan(0.01);
  });
});

it('offers only audio outputs', () => {
  expect(listenable('audio')).toBe(true);
  for (const kind of ['control', 'gate', 'keys', undefined]) expect(listenable(kind)).toBe(false);
});

it('hears an output the Output does not play, through Engine.probe', () => {
  const p = emptyPatch('l');
  addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);   // (nothing cabled into it: the patch is silent)
  out.params.level = 0.5;
  const e = new Engine(SR);
  e.load(p);
  const mix = new ListenMix(SR);
  mix.set([{ id: osc.id, port: 'out' }]);
  let peak = 0, outPeak = 0;
  for (let b = 0; b < 200; b++) {
    const l = new Float32Array(128), r = new Float32Array(128);
    e.render(l, r);
    for (const v of l) outPeak = Math.max(outPeak, Math.abs(v));
    mix.process(l, r, 128, mix.sources!.map((s) => e.probe(s.id, s.port)), e.outputLevel());
    if (b > 100) for (const v of l) peak = Math.max(peak, Math.abs(v));
  }
  expect(outPeak).toBe(0);
  expect(e.outputLevel()).toBe(0.5);
  expect(peak).toBeGreaterThan(0.2);
  expect(peak).toBeLessThanOrEqual(0.5 + 1e-3);
});
