// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, polyCfg, validatePatch } from './patch';
import { encodePatch, formatOf } from './patchbin';

function setup(voices = 5, stack = 2, unison = 1) {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0), alloc = addModule(p, DEFS.alloc, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  Object.assign(alloc.params, { voices, stack, unison });
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  connect(p, DEFS, { module: alloc.id, port: 'gate' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: alloc.id, port: 'unison' }, { module: out.id, port: 'r' });
  const e = new Engine(44118); e.load(p);
  const held = () => e.voiceNotes().filter(v => v.on).map(v => v.note);
  const mode = () => {
    e.render(new Float32Array(128), new Float32Array(128));
    return voices > 1 ? e.probeVoices(alloc.id, 'unison')!.map(v => v[0]) : [e.probe(alloc.id, 'unison')![0]];
  };
  return { p, alloc, e, held, mode };
}

it('stacks only the requested voices, with priority and release, without reducing polyphony', () => {
  for (const priority of [0, 1, 2]) {
    const { e, alloc, held } = setup();
    e.setParam(alloc.id, 'priority', priority);
    e.noteOn(60); e.noteOn(67);
    expect(held()).toEqual(Array(2).fill(priority === 1 ? 60 : 67));
    e.noteOff(67); expect(held()).toEqual([60, 60]);
    e.noteOff(60); expect(held()).toEqual([]);
    e.setParam(alloc.id, 'unison', 0);
    for (const n of [60, 62, 64, 65, 67]) e.noteOn(n);
    expect(held().sort()).toEqual([60, 62, 64, 65, 67]);
    expect(alloc.params.voices).toBe(5);
  }
});

it('changes a held unison stack immediately and wakes newly used voices', () => {
  const { e, alloc, held } = setup();
  e.noteOn(60);
  for (let i = 0; i < 40; i++) e.render(new Float32Array(128), new Float32Array(128));
  for (const [stack, count] of [[4, 4], [1, 1], [0, 5], [16, 5]]) {
    e.setParam(alloc.id, 'stack', stack);
    expect(held()).toEqual(Array(count).fill(60));
    e.render(new Float32Array(128), new Float32Array(128));
    expect(e.probeVoices(alloc.id, 'gate')!.map(v => v[0])).toEqual(Array.from({ length: 5 }, (_, i) => i < count ? 1 : 0));
  }
});

it('keeps a separate saved count in poly mode and treats zero or absent as all voices', () => {
  const { p, alloc, e, held } = setup(5, 2, 0);
  e.noteOn(60); e.noteOn(64); e.noteOn(67);
  e.setParam(alloc.id, 'stack', 1);
  expect(held()).toEqual([60, 64, 67]);
  delete alloc.params.stack;
  const restored = validatePatch(p, DEFS);
  const a = restored.modules.find(m => m.id === alloc.id)!;
  expect(a.params.stack).toBe(0);
  a.params.unison = 1;
  const old = new Engine(44118); old.load(restored); old.noteOn(60);
  expect(old.voiceNotes().filter(v => v.on)).toHaveLength(5);
});

it('reports unison mode with no held key and with a one-voice allocator', () => {
  for (const voices of [1, 5]) {
    const { e, alloc, mode } = setup(voices);
    expect(mode()).toEqual(Array(voices).fill(1));
    e.noteOn(60); e.noteOff(60);
    expect(mode()).toEqual(Array(voices).fill(1));
    e.setParam(alloc.id, 'unison', 0);
    expect(mode()).toEqual(Array(voices).fill(0));
  }
});

it('preserves the poly count and other group settings in the compact device record', () => {
  const { p, alloc } = setup();
  Object.assign(alloc.params, { assign: 3, priority: 2, steal: 0, legato: 1 });
  const b = encodePatch(p);
  expect(b[1]).toBe(formatOf(p));
  expect([...b.slice(8, 12)]).toEqual([0x25, 3, 0x81, 0x82]);
  alloc.params.stack = 16;
  expect(encodePatch(p)[8]).toBe(0x85);
  expect(polyCfg(alloc).unisonParts).toBe(16);
});
