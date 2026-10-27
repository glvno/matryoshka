// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, DEVICE_SR } from './modules';
import { addModule, connect, emptyPatch } from './patch';

function render(audio: number, block: number): Float32Array {
  const p = emptyPatch();
  const input = addModule(p, DEFS.const, 0, 0);
  input.params.value = .4;
  const cv = addModule(p, DEFS.osc, 0, 0);
  Object.assign(cv.params, { wave: 0, coarse: 24, level: .9 });
  const filter = addModule(p, DEFS.ladder, 0, 0);
  Object.assign(filter.params, { cutoff: 800, cvamt: 3, res: .2 });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  connect(p, DEFS, { module: input.id, port: 'out' }, { module: filter.id, port: 'in' });
  connect(p, DEFS, { module: cv.id, port: 'out' }, { module: filter.id, port: audio ? 'fm' : 'cv' });
  connect(p, DEFS, { module: filter.id, port: 'lp24' }, { module: out.id, port: 'l' });
  const e = new Engine(DEVICE_SR);
  e.load(p);
  const result = new Float32Array(2048);
  for (let at = 0; at < result.length; at += block) {
    const left = new Float32Array(Math.min(block, result.length - at));
    e.render(left, new Float32Array(left.length));
    result.set(left, at);
  }
  return result;
}

it('audio-rate ladder cutoff follows each sample, independent of render block boundaries', () => {
  const sample = render(1, 1);
  expect(render(1, 128)).toEqual(sample);
  expect(render(1, 37)).toEqual(sample);
  expect(render(0, 128)).not.toEqual(sample); // old patches retain the block-mean mode
});
