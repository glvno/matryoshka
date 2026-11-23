// SPDX-License-Identifier: GPL-3.0-only
// D-1253, D-1353: Note Out, a MIDI note from a gate, sent by the FM-1 only (format 66). The FM-1's side (the notes, their timing,
// the Note Offs on a bypass, a stop or a patch change) is tools/note_out_test.sh; here the type, the format and the
// browser's side, which sends nothing.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { paramHint, moduleTag } from './labels';
import { DEFS, NOTE_OUT_CHANNEL, NOTE_OUT_NOTE } from './modules';
import { MUTATE_SKIP } from './mutate';
import { addModule, connect, defaultMap, NOTE_NAMES, newPatch, SHARED_TYPES, validatePatch } from './patch';
import { encodePatch, FORMAT_1_27, formatOf, SECTION_FORMATS, TYPE_ORDER, VERSION, WRITE_FLOOR } from './patchbin';
import { deviceView } from './poly';

const SR = 44118;

/** a square LFO into a Note Out's gate, nothing into the Output */
function rig() {
  const p = newPatch(DEFS);
  const lfo = addModule(p, DEFS.lfo, 0, 0), n = addModule(p, DEFS.nout, 300, 0);
  Object.assign(lfo.params, { wave: 3, rate: 37 });
  connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: n.id, port: 'gate' });
  return { p, n };
}

describe('Note Out (D-1253)', () => {
  it('is appended after the EQ: gate and vel in, no outputs, channel 1..16 (5) and note 0..127 (C1) by name', () => {
    expect(TYPE_ORDER.slice(-2)).toEqual(['eq', 'nout']);
    expect(DEFS.nout.label).toBe('Note Out');
    expect(DEFS.nout.inputs.map((i) => [i.name, i.kind])).toEqual([['gate', 'gate'], ['vel', 'control'], ['p1', 'control'], ['p2', 'control']]);
    expect(DEFS.nout.outputs).toEqual([]);
    expect(DEFS.nout.params.map((q) => [q.name, q.min, q.max, q.default, q.step])).toEqual([['channel', 1, 16, 5, 1], ['note', 0, 127, 36, 1]]);
    expect([NOTE_OUT_CHANNEL, NOTE_OUT_NOTE]).toEqual([5, 36]);
    expect(DEFS.nout.params[0].choices).toBeUndefined();
    expect(DEFS.nout.params[1].choices).toBe(NOTE_NAMES);
    expect(defaultMap(DEFS.nout)).toEqual({ p1: ['channel'], p2: ['note'] });
  });

  it('runs once even inside a poly assembly, Mutate leaves it alone, and its help says it sends from the FM-1 only', () => {
    expect(SHARED_TYPES.has('nout')).toBe(true);
    expect(MUTATE_SKIP.nout).toBe(true);
    expect(moduleTag('nout').tag).toBe('MIDI');
    for (const q of ['channel', 'note']) expect(paramHint('nout', q)).toMatch(/^Sends MIDI from the FM-1 only/);
  });

  it('stays in the FM-1\'s patch though it reaches nothing it is heard by: it sends MIDI', () => {
    const { p, n } = rig();
    expect(deviceView(p, true).patch.modules.map((m) => m.type)).toContain('nout');
    expect(encodePatch(p)[2]).toBe(4);   // (Main, the Output, the LFO and the Note Out)
    expect(n.type).toBe('nout');
  });

  it('a patch with one is written in format 66, every other patch keeps its lower format; it passes validatePatch', () => {
    expect(VERSION).toBe(FORMAT_1_27);
    expect(FORMAT_1_27).toBe(66);
    expect(SECTION_FORMATS[FORMAT_1_27]).toBe('the Note Out module');
    expect(DEFS.nout.since).toBe(FORMAT_1_27);
    const plain = newPatch(DEFS);
    expect(formatOf(plain)).toBe(WRITE_FLOOR);
    const { p } = rig();
    expect(formatOf(p)).toBe(FORMAT_1_27);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_27);
    const back = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(back.modules.find((m) => m.type === 'nout')?.params).toEqual({ channel: 5, note: 36 });
  });

  it('the browser\'s engine sends nothing and sounds nothing from it', () => {
    const { p } = rig();
    const e = new Engine(SR);
    e.load(p);
    const l = new Float32Array(128), r = new Float32Array(128);
    for (let b = 0; b < 200; b++) {
      e.render(l, r);
      expect(l.every((v) => v === 0) && r.every((v) => v === 0)).toBe(true);
    }
  });
});
