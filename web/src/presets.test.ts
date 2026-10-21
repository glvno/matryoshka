// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DRUM_MAP_DEFAULT, drumRowName } from './modules';
import { PRESETS } from './presets';
import type { Patch } from './patch';

const SR = 48000;
const KIT_NOTES = [53, 55, 57, 59, 60, 62, 64, 65]; // the white keys from F3, the FM-1's lowest key at octave 0
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);

/** a kit's Drum map, DRUMS track and Main, and the rows (1..8) with a gate cable */
function kit(name: string): { p: Patch; rows: number[] } {
  const p = PRESETS[name]();
  const map = p.modules.find((m) => m.type === 'drummap')!;
  const rows = [...new Set(p.cables.filter((c) => c.from.module === map.id && /^g\d$/.test(c.from.port)).map((c) => +c.from.port.slice(1)))].sort();
  return { p, rows };
}

/** the peak of `n` samples rendered */
function peak(e: Engine, n: number): number {
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(l[i]), Math.abs(r[i]));
  return m;
}

describe('factory drum kits: the keys play the drums out of the box (#141)', () => {
  for (const [name, wired] of [['808 Kit', [1, 2, 3, 4, 5, 6, 7, 8]], ['909 Kit', [1, 2, 3]]] as const) {
    it(`${name}: Main's keys into DRUMS, the rows on the white keys from F3, the steps on the rows, octave -1`, () => {
      const { p, rows } = kit(name);
      const main = p.modules.find((m) => m.type === 'fm1')!;
      const st = p.modules.find((m) => m.type === 'steps' && m.name === 'DRUMS')!;
      const map = p.modules.find((m) => m.type === 'drummap')!;
      expect(p.cables.some((c) => c.from.module === main.id && c.from.port === 'keys' && c.to.module === st.id && c.to.port === 'keys')).toBe(true);
      expect(KIT_NOTES.map((_, r) => map.params[`n${r + 1}`])).toEqual(KIT_NOTES);
      expect(rows).toEqual(wired);
      for (const r of rows) {
        const n = map.params[`n${r}`];
        expect(n >= 53 && n <= 79 && WHITE.has(n % 12), `row ${r}`).toBe(true);
      }
      const hit = new Set(rows.map((r) => map.params[`n${r}`]));
      expect(st.notes!.length).toBeGreaterThan(0);
      for (const n of st.notes!) expect(hit.has(n.note), `step note ${n.note}`).toBe(true);
      expect(p.octave).toBe(-1);
    });

    it(`${name}: transport stopped, nothing armed, each wired row's key sounds; armed, the key still plays through DRUMS`, () => {
      const { p, rows } = kit(name);
      const map = p.modules.find((m) => m.type === 'drummap')!;
      for (const r of rows) {
        const e = new Engine(SR);
        e.load(p);
        expect(peak(e, 4096), `row ${r} before`).toBe(0);
        e.noteOn(map.params[`n${r}`], 1);
        expect(peak(e, 8192), `row ${r}`).toBeGreaterThan(0.01);
      }
      const e = new Engine(SR);
      e.load(p);
      e.arm(p.modules.find((m) => m.type === 'steps')!.id);
      expect(peak(e, 4096)).toBe(0);
      e.noteOn(53, 1);
      expect(peak(e, 8192)).toBeGreaterThan(0.01);
    });
  }

  it('row names: the 808 rows are the defaults; the 909 names row 3 HAT', () => {
    const names = (n: string): string[] => {
      const m = PRESETS[n]().modules.find((x) => x.type === 'drummap')!;
      return [0, 1, 2].map((r) => drumRowName(m.names, r));
    };
    expect(PRESETS['808 Kit']().modules.find((x) => x.type === 'drummap')!.names).toBeUndefined();
    expect(names('808 Kit')).toEqual(DRUM_MAP_DEFAULT.slice(0, 3).map((d) => d.name));
    expect(names('909 Kit')).toEqual(['KICK', 'SNARE', 'HAT']);
  });

  it('a Drum map\'s own defaults stay General MIDI', () => {
    expect(DRUM_MAP_DEFAULT.map((d) => d.note)).toEqual([36, 38, 39, 42, 46, 45, 37, 56]);
  });
});
