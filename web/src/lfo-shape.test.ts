// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { FM1_PRESETS } from './presets';

function cycle(shape?: number, back = false): [Float32Array, Float32Array] {
  const p = emptyPatch();
  const lfo = addModule(p, DEFS.lfo, 0, 0);
  Object.assign(lfo.params, { wave: 1, rate: 1, dir: Number(back) });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: lfo.id, port: 'pulse' }, { module: out.id, port: 'r' });
  if (shape !== undefined) {
    const source = addModule(p, DEFS.const, 0, 0);
    source.params.value = shape;
    connect(p, DEFS, { module: source.id, port: 'out' }, { module: lfo.id, port: 'shape' });
  }
  const e = new Engine(4096);
  e.load(p);
  const l = new Float32Array(4096), r = new Float32Array(4096);
  e.render(l, r);
  return [l, r];
}

it.each([.25, .5, .75])('shape %f sets triangle rise time and simultaneous pulse width', (shape) => {
  const [triangle, pulse] = cycle(shape);
  const peak = triangle.indexOf(Math.max(...triangle));
  expect((peak + 1) / triangle.length).toBeCloseTo(shape, 3);
  expect(pulse.filter((v) => v > 0).length / pulse.length).toBeCloseTo(shape, 2);
});

it('defaults to the same symmetric wave and reverses the shaped wave', () => {
  expect(cycle()).toEqual(cycle(.5));
  const [triangle, pulse] = cycle(.25, true);
  expect((triangle.indexOf(Math.max(...triangle)) + 1) / triangle.length).toBeCloseTo(.75, 3);
  expect(pulse.filter((v) => v > 0).length / pulse.length).toBeCloseTo(.25, 2);
});

it('reaches both saw directions and fully closed or open pulse widths', () => {
  const [falling, closed] = cycle(0), [rising, open] = cycle(1);
  expect(falling[1024]).toBeGreaterThan(falling[3072]);
  expect(rising[1024]).toBeLessThan(rising[3072]);
  expect([...closed].every((v) => v === -1)).toBe(true);
  expect([...open].every((v) => v === 1)).toBe(true);
});

it('Sallen 20 uses one continuous waveform knob for both modulation-generator outputs', () => {
  const p = FM1_PRESETS['Sallen 20']();
  const card = p.assemblies!.find((a) => a.params.some((r) => r.head === 'mg'))!;
  const row = card.params.find((r) => r.label === 'waveform')!;
  const knob = p.modules.find((m) => m.id === row.module)!;
  expect(knob.type).toBe('macro');
  expect(knob.params.value).toBe(.5);
  const pulse = card.outputs.find((o) => o.label === 'mg rectangle')!;
  expect(pulse.port).toBe('pulse');
  expect(p.cables.some((c) => c.from.module === knob.id && c.to.module === pulse.module && c.to.port === 'shape')).toBe(true);
});
