// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';

function setup(voices = 3, unison = 0, steal = 1) {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0);
  const alloc = addModule(p, DEFS.alloc, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  Object.assign(alloc.params, { voices, unison, steal });
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  connect(p, DEFS, { module: alloc.id, port: 'low' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: alloc.id, port: 'high' }, { module: out.id, port: 'r' });
  const e = new Engine(44118); e.load(p);
  const flags = () => {
    e.render(new Float32Array(128), new Float32Array(128));
    return ['low', 'high'].map(port => voices > 1 ? e.probeVoices(alloc.id, port)?.map(v => v[0]) : [e.probe(alloc.id, port)?.[0]]);
  };
  return { e, flags };
}

it('marks the held lowest and highest voices and moves those marks when either is released', () => {
  const { e, flags } = setup();
  expect(flags()).toEqual([[0, 0, 0], [0, 0, 0]]);
  e.noteOn(67); e.noteOn(60); e.noteOn(64);
  expect(flags()).toEqual([[0, 1, 0], [1, 0, 0]]);
  e.noteOff(60);
  expect(flags()).toEqual([[0, 0, 1], [1, 0, 0]]);
  e.noteOff(67);
  expect(flags()).toEqual([[0, 0, 1], [0, 0, 1]]);
  e.allNotesOff();
  expect(flags()).toEqual([[0, 0, 0], [0, 0, 0]]);
});

it('follows the voices after stealing and ignores refused notes in no-steal mode', () => {
  for (const steal of [0, 1]) {
    const { e, flags } = setup(3, 0, steal);
    e.noteOn(60); e.noteOn(64); e.noteOn(67); e.noteOn(72);
    expect(flags()).toEqual(steal ? [[0, 1, 0], [1, 0, 0]] : [[1, 0, 0], [0, 0, 1]]);
    e.noteOff(72); e.noteOff(60);
    expect(flags()).toEqual([[0, 1, 0], [0, 0, 1]]);
  }
});

it('marks every held unison voice, and the only mono voice, as both extremes', () => {
  for (const voices of [1, 3]) {
    const { e, flags } = setup(voices, 1);
    e.noteOn(60); e.noteOn(67);
    expect(flags()).toEqual([Array(voices).fill(1), Array(voices).fill(1)]);
    e.noteOff(67);
    expect(flags()).toEqual([Array(voices).fill(1), Array(voices).fill(1)]);
    e.noteOff(60);
    expect(flags()).toEqual([Array(voices).fill(0), Array(voices).fill(0)]);
  }
});

it('keeps older output indices and parameter ranges unchanged', () => {
  for (const type of ['alloc', 'part']) {
    expect(DEFS[type].outputs.map(o => o.name)).toEqual(['pitch', 'gate', 'vel', 'index', 'legato', 'jump', 'trig', 'low', 'high', 'unison']);
  }
});
