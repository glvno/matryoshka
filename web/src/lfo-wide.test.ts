// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, defaultMap, emptyPatch, validatePatch } from './patch';
import { XL_PRESETS } from './presets';

function wave(wide: number, range = 3, sync = 0) {
  const p = emptyPatch();
  const lfo = addModule(p, DEFS.lfo, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  Object.assign(lfo.params, { wave: 2, rate: 5.5, wide, range, sync });
  out.params.level = 1;
  connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: out.id, port: 'l' });
  const e = new Engine(4096); e.load(p);
  const l = new Float32Array(4096); e.render(l, new Float32Array(4096));
  return l;
}

it('reaches the DX100 low endpoint without stalling and the high endpoint at 55 cycles per second', () => {
  const low = wave(.0008);
  expect(low[4095] - low[0]).toBeCloseTo(2 * .0008 * 4095 / 4096, 6);
  const high = wave(55);
  const wraps = Array.from(high).flatMap((v, i) => i > 0 && v - high[i - 1] < -1 ? [i] : []);
  expect(wraps.length).toBeGreaterThanOrEqual(54);
  expect((wraps.length - 1) * 4096 / (wraps.at(-1)! - wraps[0])).toBeCloseTo(55, 1);
});

it('uses the wide setting only in wide free-running mode', () => {
  for (const range of [0, 1, 2]) expect(wave(.0008, range)).toEqual(wave(55, range));
  expect(wave(.0008, 3, 1)).toEqual(wave(55, 3, 1));
});

it('keeps the old rate and modulation ranges, and defaults the appended parameter on old JSON', () => {
  const rate = DEFS.lfo.params.find(p => p.name === 'rate')!;
  const range = DEFS.lfo.params.find(p => p.name === 'range')!;
  expect(rate).toMatchObject({ min: .02, max: 40 });
  expect(range).toMatchObject({ min: 0, max: 2, top: 3 });
  expect(DEFS.lfo.params.at(-1)).toMatchObject({ name: 'wide', min: .0008, max: 55, since: 40 });
  expect(Object.values(defaultMap(DEFS.lfo)).flat()).not.toContain('wide');
  const p = emptyPatch(), lfo = addModule(p, DEFS.lfo, 0, 0);
  delete lfo.params.wide;
  expect(validatePatch(p, DEFS).modules[0].params.wide).toBe(4);
});

it('Algo Four XL exposes the full speed range through its one LFO SPEED row', () => {
  const p = XL_PRESETS['Algo Four XL']();
  const rows = p.assemblies!.flatMap(a => a.params).filter(r => r.label === 'lfo speed');
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.param).toBe('wide');
    expect(p.modules.find(m => m.id === row.module)!.params).toMatchObject({ range: 3, wide: 5.5 });
  }
});
