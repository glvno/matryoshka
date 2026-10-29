// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';

it('Voicing pulses for a middle key press and never for a key release', () => {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  for (const [priority, port] of [[1, 'l'], [2, 'r']] as const) {
    const alloc = addModule(p, DEFS.alloc, 0, 0);
    Object.assign(alloc.params, { voices: 1, priority, legato: 2 });
    expect(connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' })).toBe(true);
    expect(connect(p, DEFS, { module: alloc.id, port: 'trig' }, { module: out.id, port })).toBe(true);
  }
  const e = new Engine(44118);
  e.load(p);
  const check = (pressed: boolean): void => {
    const l = new Float32Array(128), r = new Float32Array(128);
    e.render(l, r);
    expect(l[0]).toBe(Number(pressed));
    expect(l.slice(1).every((x) => x === 0)).toBe(true);
    expect(r).toEqual(l);
  };
  e.noteOn(60, 1); check(true);
  e.noteOn(72, 1); check(true);
  e.noteOn(67, 1); check(true); // neither pitch changes
  check(false);
  e.noteOff(72); check(false); // highest pitch changes, without a new key press
  e.noteOff(60); check(false);
  e.noteOff(67); check(false);
});

it.each(['Wanderer', 'Wanderer XL'])('%s retriggers its keyboard gate on presses only', async (name) => {
  const { PRESETS } = await import('./presets');
  const p = PRESETS[name]();
  // Select the actual factory gate circuit driven by the low-priority Voicing's key-press output.
  const path = p.cables.find((c) => c.from.port === 'trig' && p.modules.find((m) => m.id === c.from.module)?.type === 'alloc');
  expect(path).toBeDefined();
  const e = new Engine(44118);
  e.load(p);
  const block = (): Float32Array => {
    e.render(new Float32Array(128), new Float32Array(128));
    return e.probe(path!.to.module, 'sub')!;
  };
  // XL routes keys through Steps, whose events arrive one block later.
  const settled = (): number[] => [...block(), ...block()];
  e.noteOn(60, 1); settled();
  e.noteOn(72, 1); settled();
  e.noteOn(67, 1);
  const pressed = settled();
  expect(pressed.filter((v) => v === 0)).toHaveLength(1);
  expect(pressed.filter((v) => v === 1)).toHaveLength(255);
  e.noteOff(72);
  expect(settled().every((v) => v === 1)).toBe(true);
});

it('key triggers respect channel and range, and all-notes-off cancels a pending pulse', () => {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0), alloc = addModule(p, DEFS.alloc, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  Object.assign(alloc.params, { voices: 1, channel: 2, low: 60, high: 72 });
  out.params.level = 1;
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  connect(p, DEFS, { module: alloc.id, port: 'trig' }, { module: out.id, port: 'l' });
  const e = new Engine(44118);
  e.load(p);
  const pulse = (): number => {
    const l = new Float32Array(128);
    e.render(l, new Float32Array(128));
    return l.reduce((a, b) => a + b, 0);
  };
  e.noteOn(59, 1, 2); expect(pulse()).toBe(0);
  e.noteOn(60, 1, 1); expect(pulse()).toBe(0);
  e.noteOn(60, 1, 2); expect(pulse()).toBe(1);
  e.noteOn(60, 1, 2); e.noteOn(67, 1, 2); expect(pulse()).toBe(1);
  e.noteOn(64, 1, 2); e.allNotesOff(); expect(pulse()).toBe(0);
});
