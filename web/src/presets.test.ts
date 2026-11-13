// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DRUM_MAP_DEFAULT, drumRowName } from './modules';
import { deviceBudget } from './patchbin';
import { EXAMPLE_PRESETS, FM1_PRESETS, PRESETS } from './presets';
import type { Patch } from './patch';
import { melodicFactoryNames, selectedFactoryProfile } from './factory-bank';

const SR = 48000;
const KIT_NOTES = [53, 55, 57, 59, 60, 62, 64, 65]; // the white keys from F3, the FM-1's lowest key at octave 0
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);

/** a kit's Drum map, DRUMS track and Main, and the rows (1..8) with a gate cable */
function kit(name: string): { p: Patch; rows: number[] } {
  const p = FM1_PRESETS[name]();
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
  for (const [name, wired] of [['808 Kit', [1, 2, 3, 4, 5, 6, 7, 8]], ['909 Kit', [1, 2, 3, 4, 5, 6, 7, 8]]] as const) {
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

  it('row names: both kits\' rows are the defaults (the 909 Kit\'s hat on row 4, CL HAT, as the 808\'s)', () => {
    const names = (n: string): string[] => {
      const m = FM1_PRESETS[n]().modules.find((x) => x.type === 'drummap')!;
      return [0, 1, 2].map((r) => drumRowName(m.names, r));
    };
    for (const k of ['808 Kit', '909 Kit']) {
      expect(FM1_PRESETS[k]().modules.find((x) => x.type === 'drummap')!.names, k).toBeUndefined();
      expect(names(k), k).toEqual(DRUM_MAP_DEFAULT.slice(0, 3).map((d) => d.name));
    }
  });

  it('a Drum map\'s own defaults stay General MIDI', () => {
    expect(DRUM_MAP_DEFAULT.map((d) => d.note)).toEqual([36, 38, 39, 42, 46, 45, 37, 56]);
  });
});

describe('example <7PH (a groove box): the 909 Kit\'s drums and a Silver Box on PATTERN, PLAY starts both', () => {
  const parts = (): { p: Patch; mix: number; drums: number; pattern: number } => {
    const p = PRESETS['<7PH']();
    const out = p.modules.find((m) => m.type === 'output')!.id;
    const mix = p.cables.find((c) => c.to.module === out && p.modules.find((m) => m.id === c.from.module)!.type === 'mixer')!.from.module;
    const drums = p.modules.find((m) => m.type === 'steps' && m.name === 'DRUMS')!.id;
    const pattern = p.modules.find((m) => m.type === 'steps' && m.name === 'PATTERN')!.id;
    return { p, mix, drums, pattern };
  };

  it('can still be sent to the FM-1 as an editor patch', () => {
    const b = deviceBudget(PRESETS['<7PH']());
    expect(b.fits, JSON.stringify(b.over)).toBe(true);
  });


  it('PLAY: the drums and the bass each sound; unarmed a key plays the bass, DRUMS armed it plays the kit', () => {
    const { p, mix, drums } = parts();
    const only = (levels: Record<string, number>): Patch => {
      const q = structuredClone(p);
      Object.assign(q.modules.find((m) => m.id === mix)!.params, levels);
      return q;
    };
    const render = (q: Patch, run: boolean, key?: number, arm?: number): number => {
      const e = new Engine(SR);
      e.load(q);
      if (arm !== undefined) e.arm(arm);
      e.transport(run);
      if (key !== undefined) e.noteOn(key, 1);
      return peak(e, SR);
    };
    const drumsOnly = only({ l4: 0 }), bassOnly = only({ l1: 0, l2: 0, l3: 0 });
    expect(render(drumsOnly, true)).toBeGreaterThan(0.05);
    expect(render(bassOnly, true)).toBeGreaterThan(0.02);
    expect(render(bassOnly, false, 58)).toBeGreaterThan(0.01);
    expect(render(drumsOnly, false, 53)).toBe(0);
    expect(render(drumsOnly, false, 53, drums)).toBeGreaterThan(0.01);
    expect(render(bassOnly, false, 53, drums)).toBe(0);
  });
});


/** n samples of the left channel: `notes` held from sample `at` (block-aligned); ARP pressed at `arpAt` when given (its
 * Toggle is engaged while the arpeggiator is bypassed: pressing it lets go) */
function play(p: Patch, notes: number[], opts: { at?: number; arpAt?: number; run?: boolean; n?: number } = {}): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  e.transport(!!opts.run);
  const n = opts.n ?? SR;
  const out = new Float32Array(n);
  let pos = 0;
  const to = (k: number): void => {
    if (k <= pos) return;
    const l = new Float32Array(k - pos), r = new Float32Array(k - pos);
    e.render(l, r);
    out.set(l, pos);
    pos = k;
  };
  const evs: [number, () => void][] = [[opts.at ?? 0, () => notes.forEach((k) => e.noteOn(k, 1))]];
  if (opts.arpAt !== undefined) evs.push([opts.arpAt, () => e.setButton(6, false)]);
  for (const [at, f] of evs.sort((a, b) => a[0] - b[0])) {
    to(at);
    f();
  }
  to(n);
  return out;
}
const loudest = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('factory melodic players', () => {

  for (const name of [...melodicFactoryNames.map(name => selectedFactoryProfile[name]?.bankName ?? name), ...Object.keys(EXAMPLE_PRESETS).filter(name => name !== '<7PH')]) {
    it(`${name}: ARP changes the played notes without silencing the instrument`, () => {
      const p = PRESETS[name]();
      const straight = play(p, [48, 55, 60], { n: SR / 2 });
      const arped = play(p, [48, 55, 60], { arpAt: 512, n: SR / 2 });
      expect(loudest(straight)).toBeGreaterThan(0.001);
      expect(loudest(arped)).toBeGreaterThan(0.001);
      expect(arped.some((x, i) => Math.abs(x - straight[i]) > 1e-4)).toBe(true);
    });
  }

  it('plays notes entered on Steps through the full player path when transport runs', () => {
    const p = PRESETS.Init();
    expect(loudest(play(p, [], { run: true }))).toBe(0);
    p.modules.find(m => m.type === 'steps')!.notes = [{ at: 0, len: 8, note: 48, vel: 100 }];
    expect(loudest(play(p, [], { run: true }))).toBeGreaterThan(0.001);
  });
});
