// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { around } from '../scripts/factory-build';
import { Engine } from './engine';
import { DEVICE_SR } from './modules';

it.each([1, 2, 3])('Monolith oscillator %i follows all six panel wave positions', (oscillator) => {
  const waves = [1, oscillator === 3 ? 5 : 4, 2, 3, 3, 3];
  for (let pos = 1; pos <= 6; pos++) {
    const { p, a, set } = around('test', 'Monolith D');
    set(`osc ${oscillator} wave`, pos);
    const row = a.params.find((r) => r.label === `osc ${oscillator} wave`)!;
    expect(row.names).toHaveLength(6);
    expect(row.names![1]).toBe(oscillator === 3 ? 'REVERSE SAW' : 'TRI/SAW');
    const wire = p.cables.find((c) => c.from.module === row.module && c.to.port === 'p1')!;
    const engine = new Engine(DEVICE_SR);
    engine.load(p);
    engine.noteOn(60);
    engine.render(new Float32Array(256), new Float32Array(256));
    const values = engine.parameterValues().find((m) => m.id === wire.to.module)!.params;
    expect(Math.round(values.wave)).toBe(waves[pos - 1]);
    if (pos >= 4) expect(values.pw).toBeCloseTo([.5, .25, .1][pos - 4], 3);
  }
});

it('routes the modulation wheel mix into the audio-rate filter input', () => {
  const { p, a } = around('test', 'Monolith D');
  const row = a.params.find((r) => r.label === 'filter mod')!;
  const filter = p.modules.find((m) => m.type === 'ladder')!;
  expect(p.cables.find((c) => c.from.module === row.module && c.to.module === filter.id)?.to.port).toBe('fm');
});
