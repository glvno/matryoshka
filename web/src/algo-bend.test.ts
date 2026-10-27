// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { connect } from './patch';
import { XL_PRESETS } from './presets';

it('Algo Four XL exposes LOW/HIGH/KON and bends only the selected held voices', () => {
  const p = XL_PRESETS['Algo Four XL']();
  const row = p.assemblies!.flatMap(a => a.params).find(r => r.label === 'pb mode')!;
  expect(row.names).toEqual(['LOW', 'HIGH', 'KON']);
  const alloc = p.modules.find(m => m.type === 'alloc')!;
  expect(alloc.params.voices).toBe(8);
  const main = p.modules.find(m => m.type === 'fm1')!;
  // Play this instrument directly; its optional pattern/arp players are independent of bend selection.
  p.cables = p.cables.filter(c => c.to.port !== 'keys');
  connect(p, DEFS, {module: main.id, port: 'keys'}, {module: alloc.id, port: 'keys'});
  const bendVca = p.cables.find(c => c.from.module === row.module && c.from.port === 'out' && c.to.port === 'cv')!.to.module;
  const e = new Engine(44118); e.load(p);
  e.noteOn(67); e.noteOn(60); e.noteOn(64); e.bend(1);
  const amounts = (mode: number) => {
    e.setParam(row.module, row.param, mode);
    e.render(new Float32Array(128 * 5), new Float32Array(128 * 5));
    return e.probeVoices(bendVca, 'out')!.slice(0, 3).map(v => v[0]);
  };
  for (const [mode, expected] of [[1, [0, 1, 0]], [2, [1, 0, 0]], [3, [1, 1, 1]]] as const) {
    amounts(mode).forEach((v, i) => expect(v).toBeCloseTo(expected[i] * 2 / 12, 5));
  }
  e.noteOff(60);
  const after = amounts(1);
  expect(after[0]).toBe(0); expect(after[1]).toBe(0); expect(after[2]).toBeCloseTo(2 / 12, 5);
});

it('Algo Four XL receives the dedicated breath and foot-controller signals', () => {
  const p = XL_PRESETS['Algo Four XL']();
  const main = p.modules.find(m => m.type === 'fm1')!;
  const ports = p.cables.filter(c => c.from.module === main.id).map(c => c.from.port);
  expect(ports).toContain('breath'); expect(ports).toContain('sustain');
  expect(ports).not.toContain('at'); expect(ports).not.toContain('fx');
});
