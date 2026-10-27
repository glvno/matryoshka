// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { XL_PRESETS } from './presets';

function frequency(ratio: number, coarse = 0, fine = 0, detune = 3) {
  const p = emptyPatch(), osc = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  Object.assign(osc.params, { wave: 0, coarse, fine, level: 1 });
  const tuning = addModule(p, DEFS.ratio, 0, 0);
  Object.assign(tuning.params, { ratio, detune });
  connect(p, DEFS, { module: tuning.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
  const e = new Engine(48000); e.load(p);
  const l = new Float32Array(48000); e.render(l, new Float32Array(l.length));
  const edges: number[] = [];
  for (let i = 1; i < l.length; i++) if (l[i - 1] < 0 && l[i] >= 0) edges.push(i - 1 - l[i - 1] / (l[i] - l[i - 1]));
  return (edges.length - 1) * 48000 / (edges.at(-1)! - edges[0]);
}

it('offers the original 64 operator ratios, with unity as the default', () => {
  const ratio = DEFS.ratio.params.find(p => p.name === 'ratio')!;
  expect(ratio.choices).toHaveLength(64);
  expect(ratio.choices!.slice(0, 6)).toEqual(['0.50', '0.71', '0.78', '0.87', '1.00', '1.41']);
  expect(ratio.choices!.at(-1)).toBe('25.95');
  expect(ratio.default).toBe(4);
});
it.each([[0, 0.5], [1, 0.71], [4, 1], [8, 2], [11, 3.14], [63, 25.95]])('ratio %i plays the displayed multiplier %f', (index, multiplier) => {
  expect(frequency(index) / 261.6255653).toBeCloseTo(multiplier, 3);
});
it('ratio composes with coarse and fine tuning', () => {
  expect(frequency(8, -12, 50) / 261.6255653).toBeCloseTo(2 ** (50 / 1200), 4);
});
it('Algo Four XL exposes ratio choices and signed detune positions for all four operators', () => {
  const p = XL_PRESETS['Algo Four XL']();
  const card = p.assemblies!.find(a => a.params.some(r => r.label === 'algorithm'))!;
  const ratios = card.params.filter(r => r.label === 'freq ratio'), detunes = card.params.filter(r => r.label === 'detune');
  expect(ratios).toHaveLength(4); expect(detunes).toHaveLength(4);
  for (const row of ratios) expect(row.param).toBe('ratio');
  for (const row of detunes) {
    expect(row.param).toBe('detune');
    expect(p.modules.find(m => m.id === row.module)!.type).toBe('ratio');
  }
  expect(DEFS.ratio.params[1].choices).toEqual(['-3', '-2', '-1', '0', '+1', '+2', '+3']);
  expect(p.modules.find(m => m.type === 'alloc')!.params.voices).toBe(8);
});

it.each([0, 1, 2, 3, 4, 5, 6])('detune position %i shifts pitch in the stated direction and range', (detune) => {
  expect(1200 * Math.log2(frequency(4, 0, 0, detune) / frequency(4))).toBeCloseTo((detune - 3) * 2.6 / 3, 1);
});
