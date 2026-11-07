// SPDX-License-Identifier: GPL-3.0-only
// A Voicing's assign and unison on a cable (#681): one Selector row is a polysynth's key assign switch.
import { expect, it } from 'vitest';
import { BLOCK, Engine } from './engine';
import { DEFS, voicingSetting } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { deviceView } from './poly';
import { encodePatch, formatOf, FORMAT_1_11 } from './patchbin';

/** four voices; a Selector (Io 4's KEY ASSIGNMENT: POLY I, POLY II, UNISON I, UNISON II) into unison by its value and
 * into assign by its second position's gate */
function setup(voices = 4) {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0), alloc = addModule(p, DEFS.alloc, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  const sel = addModule(p, DEFS.select, 0, 0);
  Object.assign(sel.params, { count: 4, pos: 1, v1: 0, v2: 0, v3: 1, v4: 2 });
  Object.assign(alloc.params, { voices });
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  connect(p, DEFS, { module: alloc.id, port: 'gate' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: sel.id, port: 'out' }, { module: alloc.id, port: 'unison' });
  connect(p, DEFS, { module: sel.id, port: 'g2' }, { module: alloc.id, port: 'assign' });
  const e = new Engine(44118);
  e.load(p);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  const block = (): void => e.render(l, r);
  const pos = (k: number): void => { e.setParam(sel.id, 'pos', k); block(); };
  block();
  return { p, e, sel, alloc, pos, block, notes: () => e.voiceNotes().map((v) => (v.on ? v.note : -1)) };
}

it('moves a setting by whole choices, one a unit, within its choices', () => {
  expect([-1, 0, 0.49, 0.5, 1, 2.6, 9].map((cv) => voicingSetting(0, cv, 2))).toEqual([0, 0, 0, 1, 1, 2, 2]);
  expect(voicingSetting(3, -1, 3)).toBe(2);
});

it('a four-way key assign switch on one Selector: POLY I, POLY II, UNISON I, UNISON II', () => {
  const { e, pos, block, notes } = setup();
  // POLY I: rotate (a released voice is not the next one used)
  e.noteOn(60); e.noteOff(60); e.noteOn(62); block();
  expect(notes()).toEqual([-1, 62, -1, -1]);
  e.noteOff(62);
  // POLY II: the lowest free voice
  pos(2);
  e.noteOn(64); block();
  expect(notes()).toEqual([64, -1, -1, -1]);
  e.noteOn(67); block();
  expect(notes()).toEqual([64, 67, -1, -1]);
  // UNISON I with both keys held: every voice on the last key, and back to the other when it lifts
  pos(3);
  expect(notes()).toEqual([67, 67, 67, 67]);
  e.noteOff(67); block();
  expect(notes()).toEqual([64, 64, 64, 64]);
  // UNISON II: the voices shared out among the held keys
  e.noteOn(72); block();
  pos(4);
  expect(notes()).toEqual([64, 64, 72, 72]);
  // back to POLY I: the voices keep their notes until their keys lift, new keys play polyphonically
  pos(1);
  expect(notes()).toEqual([64, 64, 72, 72]);
  e.noteOff(72); block();
  expect(notes()).toEqual([64, 64, -1, -1]);
  e.noteOn(55); block();
  expect(notes().filter((n) => n === 55)).toHaveLength(1);
  e.noteOff(64); e.noteOff(55); block();
  expect(notes()).toEqual([-1, -1, -1, -1]);
});

it('keys let go in poly are not held again in unison (no stuck note)', () => {
  const { e, pos, block, notes } = setup();
  pos(3);
  e.noteOn(60); block();
  pos(1);
  e.noteOff(60); block();
  pos(3);
  e.noteOn(62); block();
  e.noteOff(62); block();
  expect(notes()).toEqual([-1, -1, -1, -1]);
});

it('POLY / MONO: unison with a stack of one plays one voice', () => {
  const { e, alloc, pos, block, notes } = setup(3);
  e.setParam(alloc.id, 'stack', 1);
  block();
  e.noteOn(60); e.noteOn(64); block();
  expect(notes()).toEqual([60, 64, -1]);
  pos(3);
  expect(notes()).toEqual([64, -1, -1]);
  e.noteOff(64); block();
  expect(notes()).toEqual([60, -1, -1]);
});

it('the device form hands the cables to the Part; the patch needs the 1.11 format', () => {
  const { p, alloc } = setup();
  const view = deviceView(p, true);
  const into = view.patch.cables.filter((c) => c.to.module === alloc.id).map((c) => c.to.port).sort();
  expect(into).toEqual(['assign', 'unison']);
  expect(formatOf(p)).toBe(FORMAT_1_11);
  expect(encodePatch(p)[1]).toBe(FORMAT_1_11);
  // without the cables it stays in an older format
  p.cables = p.cables.filter((c) => c.to.module !== alloc.id || c.to.port === 'keys');
  expect(formatOf(p)).toBeLessThan(FORMAT_1_11);
});

it('a one-voice Voicing with a cable gets a group of its own', () => {
  const { p } = setup(1);
  expect(deviceView(p, true).groups).toHaveLength(1);
});
