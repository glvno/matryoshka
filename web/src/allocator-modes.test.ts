// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { encodePatch, formatOf } from './patchbin';

function patch(assign: number, steal = 1, voices = 3) {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0);
  const alloc = addModule(p, DEFS.alloc, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  Object.assign(alloc.params, { voices, assign, steal });
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  connect(p, DEFS, { module: alloc.id, port: 'gate' }, { module: out.id, port: 'l' });
  return { p, alloc };
}

it('no-steal keeps held voices for every assignment and priority, then uses a released voice', () => {
  for (const assign of [0, 1, 2, 3]) for (const priority of [0, 1, 2]) {
    const { p, alloc } = patch(assign, 0, 2);
    alloc.params.priority = priority;
    const e = new Engine(44118);
    e.load(p);
    e.noteOn(60); e.noteOn(64);
    e.noteOn(67); e.noteOn(55);
    expect(e.voiceNotes().map((v) => v.note), `${assign}/${priority}`).toEqual([60, 64]);
    e.noteOff(55); e.noteOff(67);
    expect(e.voiceNotes().every((v) => v.on)).toBe(true);
    e.noteOn(60, 0.4); // a repeated press keeps its existing voice
    expect(e.voiceNotes().map((v) => v.note)).toEqual([60, 64]);
    e.noteOff(60);
    expect(e.voiceNotes().map((v) => v.on)).toEqual([false, true]);
    e.noteOn(67);
    expect(e.voiceNotes().map((v) => v.note)).toEqual([67, 64]);
  }
});

it('reset assignment rotates overlapping notes but restarts at voice one after every key is released', () => {
  const { p } = patch(3);
  const e = new Engine(44118);
  e.load(p);
  e.noteOn(60); e.noteOn(64);
  expect(e.voiceNotes().map((v) => v.note)).toEqual([60, 64, -1]);
  e.noteOff(60); e.noteOn(67);
  expect(e.voiceNotes().map((v) => v.note)).toEqual([60, 64, 67]);
  e.noteOff(64); e.noteOff(67); e.noteOn(69); e.noteOff(69); e.noteOn(71);
  expect(e.voiceNotes().map((v) => v.note)).toEqual([71, 64, 67]);
});

it('reset assignment counts a held key whose voice was stolen, and all-notes-off clears it', () => {
  const { p } = patch(3);
  const e = new Engine(44118);
  e.load(p);
  for (const n of [60, 61, 62, 63]) e.noteOn(n);
  for (const n of [61, 62, 63]) e.noteOff(n); // 60 is still held, although its voice was stolen
  e.noteOn(64); e.noteOff(64); e.noteOn(65);
  expect(e.voiceNotes().map((v) => v.note)).toEqual([64, 65, 62]);
  e.allNotesOff(); e.noteOn(67);
  expect(e.voiceNotes().map((v) => v.note)).toEqual([67, 65, 62]);
});

it('the group record carries no-steal separately from note priority and keeps old defaults', () => {
  const { p, alloc } = patch(3, 0);
  alloc.params.priority = 2;
  const bytes = encodePatch(p);
  expect(bytes[1]).toBe(formatOf(p));
  expect(Array.from(bytes.slice(8, 12))).toEqual([3, 3, 0, 0x82]);
  const old = patch(0).p;
  expect(Array.from(encodePatch(old).slice(8, 12))).toEqual([3, 0, 0, 0]);
});

it('reset assignment tracks refused keys at both ends of the MIDI range', () => {
  for (const note of [0, 31, 32, 63, 64, 95, 96, 127]) {
    const { p } = patch(3, 0);
    const e = new Engine(44118);
    e.load(p);
    for (const n of [60, 61, 62, note]) e.noteOn(n);
    for (const n of [60, 61, 62]) e.noteOff(n);
    e.noteOn(65); e.noteOff(65); e.noteOn(67);
    expect(e.voiceNotes().map((v) => v.note)).toEqual([65, 67, 62]);
    e.noteOff(note); e.noteOff(67); e.noteOn(69);
    expect(e.voiceNotes().map((v) => v.note)).toEqual([69, 67, 62]);
  }
});

it('live assignment edits preserve the held-key state', () => {
  const { p, alloc } = patch(0);
  const e = new Engine(44118);
  e.load(p);
  e.noteOn(60); e.noteOn(61); e.noteOn(62); e.noteOn(63);
  e.setParam(alloc.id, 'assign', 3);
  e.noteOff(61); e.noteOff(62); e.noteOff(63);
  e.noteOn(65); e.noteOff(65); e.noteOn(67);
  expect(e.voiceNotes().map((v) => v.note)).toEqual([65, 67, 62]);
  e.noteOff(60); e.noteOff(67); e.noteOn(69);
  expect(e.voiceNotes().map((v) => v.note)).toEqual([69, 67, 62]);
});
