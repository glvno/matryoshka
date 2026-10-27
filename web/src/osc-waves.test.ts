// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, DEVICE_SR } from './modules';
import { addModule, connect, emptyPatch, validatePatch } from './patch';

function render(wave: number, unison = 1): Float32Array {
  const p = emptyPatch();
  const osc = addModule(p, DEFS.osc, 0, 0);
  Object.assign(osc.params, { wave, level: .25, unison, detune: 12 });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
  const e = new Engine(DEVICE_SR);
  e.load(validatePatch(p, DEFS));
  const left = new Float32Array(4096);
  e.render(left, new Float32Array(left.length));
  return left;
}

it.each([1, 3])('reverse saw and sharktooth work with %i unison copies', (copies) => {
  const saw = render(2, copies), tri = render(1, copies), shark = render(4, copies), reverse = render(5, copies);
  for (let i = 0; i < saw.length; i++) {
    expect(reverse[i]).toBeCloseTo(-saw[i], 7);
    expect(shark[i]).toBeCloseTo((tri[i] + saw[i]) / 2, 7);
  }
});
