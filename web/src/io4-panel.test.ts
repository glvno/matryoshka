// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { DEFS, LFO_RANGE_K } from './modules';
import { FM1_PRESETS } from './presets';
import { deviceBudget } from './patchbin';

const io4 = FACTORY.find((d) => d.name === 'Io 4')!;
const named = (label: string, nth = 0) => io4.params.filter((r) => r.label === label && r.param === 'pos')[nth]?.names;

it('Io 4 names its switches with the Jupiter-4 panel legends', () => {
  expect(named('range')).toEqual(["16'", "8'", "4'"]);
  expect(named('wave form', 0)).toEqual(['OFF', 'SAW', 'SQUARE', 'PULSE']);
  expect(named('wave form', 1)).toEqual(['SINE', 'SQUARE', 'SAW', 'REV SAW']);
  expect(named('kybd follow')).toEqual(['10%', '40%', '70%', '100%']);
  for (const lever of ['vco', 'vcf', 'vca']) expect(named(lever)).toEqual(['LFO', 'OFF', 'BEND']);
});

it('Io 4 LFO RATE reaches the Jupiter-4\'s 80 Hz: the fast range, shown as the rate the LFO runs at', () => {
  const rows = io4.params.filter((r) => r.label === 'rate');
  const lfo = io4.modules[rows[0].module - 1];
  expect(lfo.type).toBe('lfo');
  expect(rows[0].param).toBe('rate');
  expect(lfo.params.range).toBe(2);
  const rate = DEFS.lfo.params.find((p) => p.name === 'rate')!;
  expect(rate.max * LFO_RANGE_K[2]).toBe(80);
  expect(rate.altText!.text(rate.max, { range: 2 })).toBe('80 Hz');
  expect(rate.altText!.text(lfo.params.rate, lfo.params)).toBe('4.5 Hz'); // as before (4.5 Hz on the wide range)
  expect(rate.altText!.text(4, { range: 0 })).toBe('4 Hz');
});

it('the factory Io 4 keeps its four voices and its Arpeggiator within the FM-1 budget', () => {
  const p = FM1_PRESETS['Io 4']();
  expect(p.modules.some((m) => m.type === 'arp')).toBe(true);
  expect(p.modules.find((m) => m.type === 'alloc' && m.params.voices === 4)).toBeDefined();
  expect(deviceBudget(p).fits).toBe(true);
});
