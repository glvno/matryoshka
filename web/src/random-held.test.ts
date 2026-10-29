// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, DEVICE_SR } from './modules';
import { addModule, emptyPatch } from './patch';

describe('clocked random voltage', () => {
  it('holds between rising edges, differs across instances, and repeats after reload', () => {
    const p = emptyPatch();
    const key = addModule(p, DEFS.fm1, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    for (const port of ['l', 'r']) {
      const r = addModule(p, DEFS.random, 0, 0);
      p.cables.push(
        { from: { module: key.id, port: 'gate' }, to: { module: r.id, port: 'clock' } },
        { from: { module: r.id, port: 'held' }, to: { module: out.id, port } },
      );
    }
    const run = () => {
      const e = new Engine(DEVICE_SR);
      e.load(p);
      const values: number[][] = [];
      for (let k = 0; k < 8; k++) {
        e.noteOn(60);
        const l = new Float32Array(256), r = new Float32Array(256);
        e.render(l, r);
        expect(new Set(l).size).toBe(1);
        expect(new Set(r).size).toBe(1);
        expect(l[0]).not.toBe(r[0]);
        values.push([l[0], r[0]]);
        e.noteOff(60);
        e.render(l, r);
        expect([l[0], r[0]]).toEqual(values[k]);
      }
      expect(new Set(values.map((v) => v[0])).size).toBe(8);
      return values;
    };
    expect(run()).toEqual(run());
  });
});
