// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { demoPatch } from './demo';
import { Engine } from './engine';
import { TEMPO_MAX } from './modules';

describe('the demo patch', () => {
  it('loads and sounds with no key held once the transport runs', () => {
    const p = demoPatch();
    const drone = p.assemblies!.find((a) => a.label === 'Synthi throb')!;
    expect(p.modules.filter((m) => drone.modules.includes(m.id) && m.bypass)).toEqual([]);
    const e = new Engine(48000);
    e.load(p);
    e.transport(true);
    const l = new Float32Array(48000 * 3), r = new Float32Array(l.length);
    e.render(l, r);
    let s = 0;
    for (let i = 48000 * 2; i < l.length; i++) s += l[i] * l[i];
    expect(Math.sqrt(s / 48000)).toBeGreaterThan(0.02);
  });

  it('its drums (one DRUMS track into the kit\'s Drum map), the Hera line and the melodies are Steps tracks on the transport: louder once it runs', () => {
    const p = demoPatch();
    expect(p.modules.filter((m) => m.type === 'steps').map((m) => m.name)).toEqual(['PUMP', 'HERA', 'INTRO', 'DRUMS', 'BARS', 'CLK16', 'XYLO', 'BAR 13', 'OPER', 'BAR 29']);
    const kit = p.assemblies!.find((a) => a.name === 'drum kit')!;
    const map = p.modules.find((m) => m.type === 'drummap')!;
    expect(kit.modules).toContain(map.id);
    const drums = p.modules.find((m) => m.name === 'DRUMS')!;
    expect(p.cables.some((c) => c.from.module === drums.id && c.from.port === 'keys' && c.to.module === map.id)).toBe(true);
    // HERA plays Hera 6 through its keys out; Main's keys reach the operator through OPER's keys in
    const hera = p.modules.find((m) => m.name === 'HERA')!, oper = p.modules.find((m) => m.name === 'OPER')!;
    expect(p.cables.filter((c) => c.from.module === hera.id).map((c) => c.from.port)).toEqual(['keys']);
    expect(p.cables.some((c) => c.to.module === oper.id && c.to.port === 'keys' && p.modules.find((m) => m.id === c.from.module)?.type === 'fm1')).toBe(true);
    expect(p.modules.some((m) => m.type === 'seq')).toBe(false);
    p.modules.find((m) => m.id === 71)!.params.l2 = 0; // the drone's plate: it plays with the transport stopped too
    const energy = (run: boolean): number => {
      const e = new Engine(48000);
      e.load(p);
      e.transport(run);
      const l = new Float32Array(48000 * 2), r = new Float32Array(l.length);
      e.render(l, r);
      let s = 0;
      for (let i = 0; i < l.length; i++) s += l[i] * l[i];
      return s;
    };
    expect(energy(true)).toBeGreaterThan(energy(false) * 2);
  });

  it('XYLO starts at bar 13 and OPER at bar 29 (counted in bars from PLAY); Main\'s keys play the operator, stopped too', () => {
    const p = demoPatch();
    p.modules.find((m) => m.type === 'fm1')!.params.tempo = TEMPO_MAX; // (the fastest: the test renders less)
    const sr = 48000, bar = (sr * 60 * 4) / TEMPO_MAX;
    const e = new Engine(sr);
    e.load(p);
    const xylo = p.modules.find((m) => m.name === 'XYLO')!.id, oper = p.modules.find((m) => m.name === 'OPER')!.id;
    const first: Record<number, number> = {};
    e.transport(true);
    const blk = 1024, l = new Float32Array(blk), r = new Float32Array(blk);
    for (let t = 0; t < bar * 29.5; t += blk) {
      e.render(l, r);
      for (const v of e.stepsView()) if ((v.id === xylo || v.id === oper) && v.pos >= 0 && first[v.id] === undefined) first[v.id] = t;
    }
    expect(Math.abs(first[xylo] - bar * 12)).toBeLessThan(blk * 2);
    expect(Math.abs(first[oper] - bar * 28)).toBeLessThan(blk * 2);
    // stopped: a key plays the operator (through OPER)
    const mix = (id: number) => p.modules.find((m) => m.id === id)!.params;
    Object.assign(mix(28), { l1: 0, l2: 0, l3: 0, l4: 0 });
    mix(71).l2 = 0;
    const s = new Engine(sr);
    s.load(p);
    s.noteOn(68, 1);
    const k = new Float32Array(sr / 2);
    s.render(k, new Float32Array(k.length));
    expect(Math.max(...Array.from(k.subarray(sr / 4)).map(Math.abs))).toBeGreaterThan(0.01);
  }, 60_000);

  it('the Hera line waits four bars, then starts at its first step; again after stop and PLAY', () => {
    const p = demoPatch();
    const mix = (id: number) => p.modules.find((m) => m.id === id)!.params;
    expect(mix(28).l4).toBe(0.38);
    Object.assign(mix(28), { l1: 0, l2: 0, l3: 0 }); // only the Hera (drums and drone off)
    mix(71).l2 = 0; // the drone's plate
    const sr = 48000, bar = Math.round((sr * 60 * 4) / p.modules.find((m) => m.type === 'fm1')!.params.tempo);
    const e = new Engine(sr);
    e.load(p);
    const rms = (l: Float32Array, a: number, b: number): number => {
      let s = 0;
      for (let i = a; i < b; i++) s += l[i] * l[i];
      return Math.sqrt(s / (b - a));
    };
    for (let pass = 0; pass < 2; pass++) {
      e.transport(true);
      const l = new Float32Array(bar * 5), r = new Float32Array(l.length);
      e.render(l, r);
      expect(rms(l, 0, bar * 4 - 128)).toBeLessThan(1e-4);
      expect(rms(l, bar * 4, bar * 5)).toBeGreaterThan(0.01);
      e.transport(false);
      const t = new Float32Array(sr * 4); // the release and the chorus die away
      e.render(t, new Float32Array(t.length));
    }
  }, 60_000); // (renders ~33 s of the whole demo: several seconds on a CI runner)
});
