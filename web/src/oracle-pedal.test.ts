// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { XL_PRESETS } from './presets';

function rig(mode: 'rEL' | 'HLd', release: 'OFF' | 'ON') {
  const p = XL_PRESETS['Oracle V XL']();
  const rows = p.assemblies!.flatMap(a => a.params);
  for (const [label, choice] of [['release/sustain', mode], ['release', release]]) {
    const row = rows.find(r => r.label === label)!;
    expect(row.names).toEqual(label === 'release' ? ['OFF', 'ON'] : ['rEL', 'HLd']);
    p.modules.find(m => m.id === row.module)!.params[row.param] = row.names!.indexOf(choice) + 1;
  }
  const vintage = rows.find(r => r.label === 'vintage')!;
  p.modules.find(m => m.id === vintage.module)!.params[vintage.param] = 0;
  const voice = p.assemblies!.find(a => a.name === 'voice')!;
  const envs = p.modules.filter(m => voice.modules.includes(m.id) && m.type === 'adsr');
  expect(envs).toHaveLength(2);
  for (const env of envs) Object.assign(env.params, { a: 0.001, d: 0.001, s: 0.7, r: 1, long: 0 });
  const e = new Engine(44118);
  e.load(p);
  const levels = (seconds = 0.1) => {
    e.render(new Float32Array(Math.ceil(44118 * seconds)), new Float32Array(Math.ceil(44118 * seconds)));
    return envs.map(env => e.probeVoices(env.id, 'env')![0][0]);
  };
  return { e, envs, levels, alloc: p.modules.find(m => m.type === 'alloc')! };
}

it.each([['OFF', 64], ['ON', 0]] as const)('Oracle rEL uses programmed release with switch %s and pedal %i', (release, pedal) => {
  const { e, levels } = rig('rEL', release);
  e.cc(64, pedal);
  expect(levels()).toEqual([0, 0]);
  e.noteOn(60);
  levels();
  e.noteOff(60);
  for (const level of levels(0.15)) {
    expect(level).toBeGreaterThan(0.05);
    expect(level).toBeLessThan(0.65); // release is decaying, not held at sustain
  }
  for (const level of levels(2)) expect(level).toBeLessThan(0.01);
});

it('Oracle rEL releases fast with Release OFF and pedal below 64', () => {
  const { e, levels } = rig('rEL', 'OFF');
  e.cc(64, 63);
  e.noteOn(60);
  levels();
  e.noteOff(60);
  for (const level of levels(0.15)) expect(level).toBeLessThan(0.01);
});

it.each(['OFF', 'ON'] as const)('Oracle HLd holds both envelopes with Release %s and lets them go on pedal-up', (release) => {
  const { e, envs, levels } = rig('HLd', release);
  e.cc(64, 64);
  expect(levels()).toEqual([0, 0]);
  e.noteOn(60);
  levels();
  e.noteOff(60);
  for (const level of levels(1.5)) expect(level).toBeCloseTo(0.7, 1);
  // The filter reaching zero must not cancel hold on the other envelope.
  e.setParam(envs[0].id, 's', 0);
  const held = levels();
  expect(held[0]).toBeLessThan(0.01);
  expect(held[1]).toBeCloseTo(0.7, 1);
  e.cc(64, 63);
  const released = levels(0.15);
  if (release === 'ON') expect(released[1]).toBeGreaterThan(0.05);
  else expect(released[1]).toBeLessThan(0.01);
  for (const level of levels(2)) expect(level).toBeLessThan(0.01);
  e.cc(64, 127);
  for (const level of levels()) expect(level).toBeLessThan(0.01);
});

it('Oracle HLd still retriggers envelopes when a held voice is reused', () => {
  const { e, envs, levels, alloc } = rig('HLd', 'ON');
  e.setParam(alloc.id, 'assign', 1); // lowest free: reuse voice one after its physical key is up
  for (const env of envs) {
    e.setParam(env.id, 'a', 0.05);
    e.setParam(env.id, 'd', 0.3);
    e.setParam(env.id, 's', 0.2);
  }
  e.cc(64, 127);
  e.noteOn(60);
  levels(1);
  e.noteOff(60);
  for (const level of levels()) expect(level).toBeCloseTo(0.2, 1);
  e.noteOn(60);
  for (const level of levels(0.03)) expect(level).toBeGreaterThan(0.5);
});
