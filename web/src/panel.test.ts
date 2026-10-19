// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch } from './patch';
import { encodePatch } from './patchbin';
import { subtractiveSaw } from './test-patches';

describe('the panel section (#60)', () => {
  it('writes the button modes, the switched-on ones and the labels after the header', () => {
    const p = subtractiveSaw();
    const main = p.modules.find((m) => m.type === 'fm1')!;
    main.panel = { toggle: ['arp', 'fx', 'rec'], on: ['arp', 'glo'], labels: { k5: 'cutoff', fx: 'gate!', bogus: 'x', seq: 'x' } }; // (k5: the knobs have no labels any more)
    const v = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(v.modules[0].panel).toEqual({ toggle: ['arp', 'fx'], on: ['arp'], labels: { fx: 'GATE!' } }); // seq / rec are the device's (#83)
    const b = encodePatch(v);
    const dv = new DataView(b.buffer);
    expect(dv.getUint16(8, true)).toBe((1 << 6) | 1); // arp = button 6, fx = button 0
    expect(dv.getUint16(10, true)).toBe(1 << 6);
    const label = (i: number): string => String.fromCharCode(...b.slice(12 + i * 10, 22 + i * 10)).replace(/\0+$/, '');
    expect(label(0)).toBe('GATE!'); // fx
    expect(label(1)).toBe('');
  });

  it('a held button and a switched one reach the Main module\'s outputs; CC 80.. holds them', () => {
    const p = emptyPatch();
    const main = addModule(p, DEFS.fm1, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    connect(p, DEFS, { module: main.id, port: 'fx' }, { module: out.id, port: 'l' });
    main.panel = { toggle: ['arp'], on: ['arp'] };
    const e = new Engine(44100);
    e.load(p);
    const l = new Float32Array(128), r = new Float32Array(128);
    e.render(l, r);
    expect(e.probe(main.id, 'arp')![0]).toBe(1); // saved switched on
    expect(e.probe(main.id, 'fx')![0]).toBe(0);
    e.cc(80, 127);
    e.render(l, r);
    expect(e.probe(main.id, 'fx')![0]).toBe(1);
    e.cc(80, 0);
    e.render(l, r);
    expect(e.probe(main.id, 'fx')![0]).toBe(0);
  });
});
