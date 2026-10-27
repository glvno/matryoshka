// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { around } from '../scripts/factory-build';
import { Engine } from './engine';
import { DEVICE_SR } from './modules';
import { deviceBudget } from './patchbin';
import { FM1_PRESETS } from './presets';

it.each([1, 2])('Silver Box waveform position %i selects the named oscillator wave', (pos) => {
  const { p, a, set } = around('test', 'Silver Box');
  set('waveform', pos);
  expect(a.params.find((r) => r.label === 'waveform')!.names).toEqual(['SAW', 'SQUARE']);
  const oscillator = p.modules.find((m) => m.type === 'osc')!;
  const engine = new Engine(DEVICE_SR);
  engine.load(p);
  engine.noteOn(48);
  engine.render(new Float32Array(256), new Float32Array(256));
  expect(engine.parameterValues().find((m) => m.id === oscillator.id)!.params.wave).toBe(pos + 1);
});

it('keeps the lean Silver Box in <7PH within the FM-1 budget', () => {
  const p = FM1_PRESETS['<7PH']();
  const row = p.assemblies!.flatMap((a) => a.params).find((r) => r.label === 'waveform')!;
  expect(row.param).toBe('wave');
  expect(p.modules.find((m) => m.id === row.module)!.type).toBe('osc');
  expect(deviceBudget(p).fits).toBe(true);
});
