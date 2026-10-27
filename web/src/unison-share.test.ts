// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { encodePatch, formatOf } from './patchbin';
import { FM1_PRESETS } from './presets';

function setup(priority = 1, voices = 4, stack = 0) {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0), alloc = addModule(p, DEFS.alloc, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  Object.assign(alloc.params, { voices, stack, unison: 2, priority });
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  connect(p, DEFS, { module: alloc.id, port: 'gate' }, { module: out.id, port: 'l' });
  const e = new Engine(44118); e.load(p);
  return { p, alloc, e, notes: () => e.voiceNotes().map(v => v.on ? v.note : -1) };
}

it('Jupiter-4 shared unison redistributes one, two, three and four held keys and back', () => {
  const { e, notes } = setup();
  e.noteOn(60); expect(notes()).toEqual([60, 60, 60, 60]);
  e.noteOn(67); expect(notes()).toEqual([60, 60, 67, 67]);
  e.noteOn(64); expect(notes()).toEqual([60, 64, 67, -1]);
  e.noteOn(55); expect(notes()).toEqual([55, 60, 64, 67]);
  e.noteOff(60); expect(notes()).toEqual([55, 64, 67, -1]);
  e.noteOff(64); expect(notes()).toEqual([55, 55, 67, 67]);
  e.noteOff(55); expect(notes()).toEqual([67, 67, 67, 67]);
  e.noteOff(67); expect(notes()).toEqual([-1, -1, -1, -1]);
});

it('selects excess held notes by priority, but always assigns them in keyboard order', () => {
  for (const [priority, wanted] of [[0, [50, 55, 64, 67]], [1, [50, 55, 60, 64]], [2, [60, 64, 67, 72]]] as const) {
    const { e, notes } = setup(priority);
    for (const n of [72, 60, 64, 67, 55, 50]) e.noteOn(n);
    expect(notes()).toEqual(wanted);
    e.noteOff(50);
    expect(notes()).toEqual(priority === 2 ? [60, 64, 67, 72] : [55, 60, 64, 67]);
  }
});

it('remembers all MIDI keys, including still-held keys beyond the former sixteen-key list', () => {
  const { e, notes } = setup();
  for (let n = 0; n < 128; n++) e.noteOn(n);
  expect(notes()).toEqual([0, 1, 2, 3]);
  for (let n = 0; n < 125; n++) e.noteOff(n);
  expect(notes()).toEqual([125, 126, 127, -1]);
  e.noteOff(126); expect(notes()).toEqual([125, 125, 127, 127]);
  e.allNotesOff(); expect(notes()).toEqual([-1, -1, -1, -1]);
});

it('honors the separate unison pool and live count edits without reducing polyphony', () => {
  const { e, alloc, notes } = setup(1, 8, 6);
  e.noteOn(60); e.noteOn(64);
  expect(notes()).toEqual([60, 60, 60, 64, 64, 64, -1, -1]);
  e.setParam(alloc.id, 'stack', 4);
  expect(notes()).toEqual([60, 60, 64, 64, -1, -1, -1, -1]);
  e.setParam(alloc.id, 'unison', 1);
  expect(notes()).toEqual([60, 60, 60, 60, -1, -1, -1, -1]);
  e.setParam(alloc.id, 'unison', 2);
  expect(notes()).toEqual([60, 60, 64, 64, -1, -1, -1, -1]);
  expect(alloc.params.voices).toBe(8);
});

it('encodes shared unison without changing older unison or legato values', () => {
  const { p, alloc } = setup();
  alloc.params.legato = 2;
  expect(encodePatch(p)[1]).toBe(formatOf(p));
  expect(encodePatch(p)[10]).toBe(0xC2);
  alloc.params.unison = 1; expect(encodePatch(p)[10]).toBe(0x82);
  alloc.params.unison = 0; expect(encodePatch(p)[10]).toBe(2);
  const pdef = DEFS.alloc.params.find(p => p.name === 'unison')!;
  expect(pdef.max).toBe(1); expect(pdef.top).toBe(2); expect(pdef.toggle).toBeUndefined();
});

it('Io 4 keeps its four voices and exposes the shared mode on its existing unison row', () => {
  const p = FM1_PRESETS['Io 4']();
  const row = p.assemblies!.flatMap(a => a.params).find(r => r.param === 'unison' && p.modules.find(m => m.id === r.module)?.type === 'alloc')!;
  const alloc = p.modules.find(m => m.id === row.module)!;
  expect(alloc.params.voices).toBe(4); expect(alloc.params.priority).toBe(1);
  expect(DEFS.alloc.params.find(p => p.name === row.param)!.choices).toEqual(['off', 'on', 'share']);
});
