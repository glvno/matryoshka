// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { FM1_PRESETS } from './presets';
import WT from './wavetables.json';

it('appends the EML COLOR bank while preserving old modulation ranges', () => {
  const bank = DEFS.wavetable.params.find((p) => p.name === 'bank')!;
  expect(bank.choices).toEqual(['analog', 'organ', 'formant', 'digital', 'eml color']);
  expect(bank.max).toBe(3);
  expect(bank.top).toBe(4);
});

it('COLOR ends with a double saw: its fundamental vanishes and its pitch rises an octave', () => {
  const bank = WT.banks.indexOf('eml color');
  expect(bank).toBe(4);
  const end = WT.frames[bank * 8 + 7];
  expect(end.filter((_, i) => i % 2 === 0).flat().every((v) => Math.abs(v) < 1e-6)).toBe(true);
  const crossings = (pos: number): number => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.wavetable, 0, 0), out = addModule(p, DEFS.output, 0, 0);
    Object.assign(osc.params, { bank, pos, level: 1 });
    out.params.level = 1;
    connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
    const e = new Engine(44118);
    e.load(p);
    const l = new Float32Array(22059);
    e.render(l, new Float32Array(l.length));
    return l.reduce((n, v, i) => n + Number(i > 0 && l[i - 1] < 0 && v >= 0), 0);
  };
  const ratio = crossings(1) / crossings(0);
  expect(ratio).toBeGreaterThan(1.95);
  expect(ratio).toBeLessThan(2.05);
});

it('COLOR has triangle, square and saw landmarks in the original order', () => {
  expect(WT.frames[32]).toEqual(WT.frames[1]);
  expect(WT.frames[35]).toEqual(WT.frames[5]);
  expect(WT.frames[37]).toEqual(WT.frames[3]);
});

it('Vernon uses the COLOR bank for oscillators 2, 3 and 4', () => {
  const p = FM1_PRESETS['Vernon 100']();
  const oscs = p.modules.filter((m) => m.type === 'wavetable');
  expect(oscs).toHaveLength(3);
  expect(oscs.map((m) => m.params.bank)).toEqual([4, 4, 4]);
});
