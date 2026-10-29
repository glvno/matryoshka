// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { applyPreset, presetsOf } from './device-presets';
import './factory-presets';
import { DEFS } from './modules';
import { connect } from './patch';
import { XL_PRESETS } from './presets';

it('Algo Four XL exposes native rate controls for every operator and preserves eight voices', () => {
  const p = XL_PRESETS['Algo Four XL']();
  const envs = p.modules.filter(m => m.type === 'rateenv');
  expect(envs).toHaveLength(4);
  expect(p.modules.find(m => m.type === 'alloc')!.params.voices).toBe(8);
  const card = p.assemblies!.find(a => a.params.some(r => r.label === 'algorithm'))!;
  for (const env of envs) {
    for (const [label, param] of [['ar', 'ar'], ['d1r', 'd1r'], ['d1l', 'd1l'], ['d2r', 'd2r'], ['rr', 'rr'], ['rate scaling', 'krs']]) {
      expect(card.params.some(r => r.module === env.id && r.param === param && r.label === label)).toBe(true);
    }
  }
});

it('Algo Four pedal holds all four operators without hiding reused-key attacks, and portamento assignment releases them', () => {
  const p = XL_PRESETS['Algo Four XL']();
  const alloc = p.modules.find(m => m.type === 'alloc')!, main = p.modules.find(m => m.type === 'fm1')!;
  alloc.params.voices = 1; // force the sustained voice to be reused
  p.cables = p.cables.filter(c => c.to.port !== 'keys');
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  const envs = p.modules.filter(m => m.type === 'rateenv');
  for (const env of envs) Object.assign(env.params, { ar: 31, d1r: 31, d1l: 10, d2r: 0, rr: 15 });
  const foot = p.assemblies!.flatMap(a => a.params).find(r => r.label === 'foot sw')!;
  const e = new Engine(48000); e.load(p);
  const render = (seconds = 0.1) => e.render(new Float32Array(48000 * seconds), new Float32Array(48000 * seconds));
  const levels = () => envs.map(env => e.envStates(env.id)![0].v);
  e.cc(64, 64); render(); expect(levels()).toEqual([0, 0, 0, 0]);
  e.noteOn(60); render(); const held = levels();
  held.forEach(v => expect(v).toBeGreaterThan(0.1));
  e.noteOff(60); render(); expect(levels()).toEqual(held);
  e.noteOn(60); render(128 / 48000);
  envs.forEach((env, i) => expect(Math.max(...e.probe(env.id, 'env')!)).toBeGreaterThan(held[i]));
  e.noteOff(60); render(); expect(levels()).toEqual(held);
  e.cc(64, 63); render(); expect(levels()).toEqual([0, 0, 0, 0]);
  e.setParam(foot.module, foot.param, 2); // PORTAMENTO does not hold envelopes
  e.cc(64, 127); e.noteOn(60); render(); e.noteOff(60); render();
  expect(levels()).toEqual([0, 0, 0, 0]);
});

it('Algo Four XL keeps Pad, Pluck, Tight and Long with their musical timing', () => {
  const play = (name: string, seconds: number) => {
    const p = XL_PRESETS['Algo Four XL']();
    const card = p.assemblies!.find(a => a.params.some(r => r.label === 'algorithm'))!;
    const preset = presetsOf(p, card).find(p => p.name === name)!;
    expect(preset, name).toBeDefined();
    expect(applyPreset(p, card, preset)).toBe(true);
    const alloc = p.modules.find(m => m.type === 'alloc')!, main = p.modules.find(m => m.type === 'fm1')!;
    alloc.params.voices = 1;
    p.cables = p.cables.filter(c => c.to.port !== 'keys');
    connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
    const env = p.modules.find(m => m.type === 'rateenv')!;
    const e = new Engine(48000); e.load(p); e.noteOn(60);
    e.render(new Float32Array(48000 * seconds), new Float32Array(48000 * seconds));
    return e.envStates(env.id)![0].v;
  };
  expect(play('Pad', 0.02)).toBeLessThan(play('Init', 0.02) / 2);
  expect(play('Pluck', 0.5)).toBe(0);
  expect(play('Long', 0.1)).toBeGreaterThan(play('Tight', 0.1));
});
