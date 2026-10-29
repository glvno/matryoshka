// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { XL_PRESETS } from './presets';

it.each([64, 127])('Hera 6 XL holds sounding voices at CC 64 value %i and releases at 63', (down) => {
  const p = XL_PRESETS['Hera 6 XL']();
  const voice = p.assemblies!.find(a => a.name === 'voice')!;
  const env = p.modules.find(m => voice.modules.includes(m.id) && m.type === 'adsr')!;
  Object.assign(env.params, { a: 0.001, d: 0.001, s: 0.6, r: 0.001, long: 0 });
  const e = new Engine(44118);
  e.load(p);
  const levels = () => {
    e.render(new Float32Array(128 * 20), new Float32Array(128 * 20));
    return e.probeVoices(env.id, 'env')!.map(v => v[127]);
  };
  const sounding = () => levels().filter(v => v > 0.1);
  e.cc(64, down);
  expect(sounding()).toHaveLength(0); // a pedal alone must not start any voice
  e.noteOn(60);
  expect(sounding()).toHaveLength(1);
  e.noteOff(60);
  expect(sounding()).toHaveLength(1);
  e.noteOn(64);
  expect(sounding()).toHaveLength(2);
  e.cc(64, 63);
  expect(sounding()).toHaveLength(1); // release the pedal, keep the physically held note
  e.noteOff(64);
  expect(sounding()).toHaveLength(0);
  e.cc(64, down);
  expect(sounding()).toHaveLength(0); // do not revive released voices
});

it('Hera hold lets a voice that decays to silence go, even while the pedal stays down', () => {
  const p = XL_PRESETS['Hera 6 XL']();
  const voice = p.assemblies!.find(a => a.name === 'voice')!;
  const env = p.modules.find(m => voice.modules.includes(m.id) && m.type === 'adsr')!;
  Object.assign(env.params, { a: 0.001, d: 0.001, s: 0, r: 0.001, long: 0 });
  const e = new Engine(44118);
  e.load(p);
  const render = () => e.render(new Float32Array(128 * 100), new Float32Array(128 * 100));
  e.cc(64, 127);
  e.noteOn(60);
  render();
  e.noteOff(60);
  render();
  e.setParam(env.id, 's', 0.8);
  render();
  expect(e.envStates(env.id)!.every(v => v.v === 0)).toBe(true);
  e.noteOn(67);
  render();
  expect(e.envStates(env.id)!.filter(v => v.v > 0.7)).toHaveLength(1);
});
