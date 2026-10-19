// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { demoPatch } from './demo';
import { Engine } from './engine';

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

  it('its drums (the drum kit) and the Hera line are Steps tracks on the transport: louder once it runs', () => {
    const p = demoPatch();
    expect(p.modules.filter((m) => m.type === 'steps').map((m) => m.name)).toEqual(['PUMP', 'KICK', 'SNARE', 'CLAP', 'CL HAT', 'OP HAT', 'COWBELL', 'HERA', 'INTRO']);
    expect(p.assemblies!.some((a) => a.name === 'drum kit')).toBe(true);
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
