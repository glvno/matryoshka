// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { connect } from './patch';
import { XL_PRESETS } from './presets';

it('Oracle V XL keeps five poly voices and applies its chord offsets and detune only in unison', () => {
  const p = XL_PRESETS['Oracle V XL']();
  const rows = p.assemblies!.flatMap(a => a.params);
  const count = rows.find(r => r.label === 'uni voices')!;
  const detune = rows.find(r => r.label === 'uni detune')!;
  const chord = rows.find(r => r.label === 'chord 2')!;
  const alloc = p.modules.find(m => m.type === 'alloc')!;
  const main = p.modules.find(m => m.type === 'fm1')!;
  expect(count.module).toBe(alloc.id); expect(count.param).toBe('stack');
  expect(alloc.params.voices).toBe(5);
  p.cables = p.cables.filter(c => c.to.port !== 'keys');
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  const gates = p.cables.filter(c => c.from.module === alloc.id && c.from.port === 'unison' && c.to.port === 'b').map(c => c.to.module);
  expect(gates).toHaveLength(2);
  p.modules.find(m => m.id === detune.module)!.params[detune.param] = 1;
  p.modules.find(m => m.id === chord.module)!.params[chord.param] = .5;
  const e = new Engine(44118); e.load(p);
  const signals = () => {
    e.render(new Float32Array(128 * 5), new Float32Array(128 * 5));
    return gates.map(id => e.probeVoices(id, 'mul')!.map(v => v[0] || 0));
  };
  e.noteOn(60);
  expect(signals()).toEqual([Array(5).fill(0), Array(5).fill(0)]);
  e.allNotesOff(); e.setParam(alloc.id, 'unison', 1); e.noteOn(60);
  const [chords, detunes] = signals();
  chords.forEach((v, i) => expect(v).toBeCloseTo(i === 1 ? .5 : 0, 6));
  detunes.forEach((v, i) => expect(v).toBeCloseTo((i / 2 - 1) / 12, 6));
  e.setParam(count.module, count.param, 2);
  expect(e.voiceNotes().filter(v => v.on)).toHaveLength(2);
  e.allNotesOff(); e.setParam(alloc.id, 'unison', 0);
  for (const n of [60, 62, 64, 65, 67]) e.noteOn(n);
  expect(e.voiceNotes().filter(v => v.on)).toHaveLength(5);
  expect(signals()).toEqual([Array(5).fill(0), Array(5).fill(0)]);
});
