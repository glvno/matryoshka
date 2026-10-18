// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { demoPatch } from './demo';
import { Engine } from './engine';

describe('the demo patch', () => {
  it('loads, remembers its octave, and sounds with no key held (the drone plays on its own)', () => {
    const p = demoPatch();
    expect(p.octave).toBe(-2);
    const drone = p.assemblies!.find((a) => a.label === 'Synthi throb')!;
    expect(p.modules.filter((m) => drone.modules.includes(m.id) && m.bypass)).toEqual([]);
    const e = new Engine(48000);
    e.load(p);
    const l = new Float32Array(48000 * 3), r = new Float32Array(l.length);
    e.render(l, r);
    let s = 0;
    for (let i = 48000 * 2; i < l.length; i++) s += l[i] * l[i];
    expect(Math.sqrt(s / 48000)).toBeGreaterThan(0.02);
  });

  it('its drums (the drum kit) and the Hera line are Steps tracks on the transport: louder once it runs', () => {
    const p = demoPatch();
    expect(p.modules.filter((m) => m.type === 'steps').map((m) => m.name)).toEqual(['PUMP', 'KICK', 'SNARE', 'CLAP', 'CL HAT', 'OP HAT', 'COWBELL', 'HERA']);
    expect(p.assemblies!.some((a) => a.name === 'drum kit')).toBe(true);
    expect(p.modules.some((m) => m.type === 'seq')).toBe(false);
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
});
