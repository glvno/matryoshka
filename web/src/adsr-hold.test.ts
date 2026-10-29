// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';

it('ADSR hold defers release, preserves key attacks, and cannot start or freeze a released envelope', () => {
  expect(DEFS.adsr.inputs.map(p => p.name)).toEqual(['gate', 'p1', 'p2', 'hold']);
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0), env = addModule(p, DEFS.adsr, 0, 0);
  Object.assign(env.params, { a: 0.02, d: 0.05, s: 0.3, r: 0.1 });
  connect(p, DEFS, { module: main.id, port: 'gate' }, { module: env.id, port: 'gate' });
  connect(p, DEFS, { module: main.id, port: 'sustain' }, { module: env.id, port: 'hold' });
  const e = new Engine(48000);
  e.load(p);
  const level = (seconds = 0.2) => {
    e.render(new Float32Array(48000 * seconds), new Float32Array(48000 * seconds));
    return e.envStates(env.id)![0].v;
  };
  e.cc(64, 64);
  expect(level()).toBe(0);
  e.noteOn(60);
  expect(level()).toBeCloseTo(0.3, 3);
  e.noteOff(60);
  expect(level()).toBeCloseTo(0.3, 3);
  e.noteOn(60);
  expect(level(0.01)).toBeGreaterThan(0.7);
  e.cc(64, 0);
  expect(level()).toBeCloseTo(0.3, 3); // pedal-up cannot release a physically held key
  e.noteOff(60);
  const releasing = level(0.01);
  e.cc(64, 127);
  expect(level(0.05)).toBeLessThan(releasing / 4);
  expect(level()).toBe(0);
});
