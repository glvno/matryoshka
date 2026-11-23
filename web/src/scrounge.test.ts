// SPDX-License-Identifier: GPL-3.0-only
// The full Scrounge (factory/bank.json since D-1056): the neutral labs Scrooge with one Steps track per row, LEN GLB, the
// per-voice SLEW, MELT and switches, one VOL, and its grooves as patterns 1 to 10: song 1 (CHAIN) plays the first six,
// song 2 the four with per-step CHOP and TIME (scripts/gen-scrounge-grooves.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from './engine';
import { deviceBudget, encodePatch } from './patchbin';
import { cpuEstimate, CPU_VOICE_TOP } from './cpu';
import { factoryPresets } from './factory-presets';
import { PRESET_MIGRATIONS, migrateValues } from './preset-migrate';
import { structureOf } from './structure';
import { readLineage } from '../scripts/lineage-lib';
import { presetsHPatches } from '../scripts/factory-lz';
import { factoryWithPatterns, FM1_PRESETS } from './presets';
import { assembliesOf } from './assembly';
import { patternNotes, type StepNote } from './track';
import type { ModuleInst, Patch } from './patch';

const SR = 48000;
/** the Drum map rows' keys: VOICE 1 .. VOICE 5, MOD X, MOD Y */
const KEYS = [53, 55, 57, 59, 60, 62, 64];
const SCROUNGE_TRACKS = ['VOICE 1', 'VOICE 2', 'VOICE 3', 'VOICE 4', 'VOICE 5', 'MOD X', 'MOD Y', 'LEN GLB'];
const scrounge = (): Patch => FM1_PRESETS.Scrounge();
/** Scrounge with its grooves, songs and LEN GLB's resets, as it shipped up to 1.24.1 */
const scroungeSet = (): Patch => factoryWithPatterns('Scrounge');
const track = (p: Patch, name: string): ModuleInst => p.modules.find((m) => m.type === 'steps' && m.name === name)!;
/** every track empty but LEN GLB, so a test plays only what it puts there */
const silence = (p: Patch): Patch => {
  for (const m of p.modules) if (m.type === 'steps' && m.name !== 'LEN GLB') { m.notes = []; delete m.patterns; }
  return p;
};
const lane = (s: string, note: number): StepNote[] => (patternNotes(s) ?? []).map((n) => ({ ...n, note }));
const setRow = (p: Patch, head: string, label: string, v: number): void => {
  const card = assembliesOf(p).find((a) => a.name === 'Scrounge')!;
  const r = card.params.slice(card.params.findIndex((x) => x.head === head)).find((x) => x.label === label)!;
  p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
};
/** both outputs summed, `secs` with the transport running */
function run(p: Patch, secs: number): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  e.transport(true);
  const l = new Float32Array(Math.round(SR * secs)), r = new Float32Array(l.length);
  e.render(l, r);
  return l.map((v, i) => v + r[i]);
}
/** the loudest sample of each of the first n sixteenth steps at 120 BPM */
const stepPeaks = (x: Float32Array, n: number): number[] => {
  const step = (SR * 60) / 120 / 4;
  return Array.from({ length: n }, (_, k) => {
    let m = 0;
    for (let i = Math.round(k * step); i < Math.round((k + 1) * step); i++) m = Math.max(m, Math.abs(x[i]));
    return m;
  });
};
const rms = (x: Float32Array, from: number, to: number): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};

describe('Scrounge (the FM-1 version: the whole Scrooge, D-1056)', () => {
  it('fits the FM-1 within every limit and the CPU top', () => {
    const p = scrounge();
    expect(deviceBudget(p).fits).toBe(true);
    expect(cpuEstimate(p).use).toBeLessThanOrEqual(CPU_VOICE_TOP);
  });

  it('ships in presets.h as the patch encodes', () => {
    const bin = encodePatch(scrounge());
    const h = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
    expect(presetsHPatches(h).some((x) => x.bytes.length === bin.length && x.bytes.every((b, i) => b === bin[i]))).toBe(true);
  });

  it('has one Steps track per row, each with Main\'s keys, and LEN GLB resetting them; no Arpeggiator', () => {
    const p = scrounge();
    const main = p.modules.find((m) => m.type === 'fm1')!;
    expect(p.modules.filter((m) => m.type === 'steps').map((m) => m.name)).toEqual(SCROUNGE_TRACKS);
    const engineMap = p.modules.find((m) => m.type === 'drummap' && assembliesOf(p).find((a) => a.name === 'Scrounge')!.modules.includes(m.id))!;
    SCROUNGE_TRACKS.slice(0, 7).forEach((name, k) => {
      const t = track(p, name);
      expect(p.cables.some((c) => c.from.module === main.id && c.from.port === 'keys' && c.to.module === t.id), name).toBe(true);
      // VOICE 1 plays the engine's Drum map; each other row's track a Drum map of its own, its row's key on row 1
      const map = p.modules.find((m) => p.cables.some((c) => c.from.module === t.id && c.from.port === 'keys' && c.to.module === m.id))!;
      expect(map.type, name).toBe('drummap');
      if (k === 0) expect(map.id).toBe(engineMap.id);
      else {
        expect(map.params.n1, name).toBe(KEYS[k]);
        expect(map.names?.[0], name).toBe(name);
      }
      expect(p.cables.some((c) => c.from.module === track(p, 'LEN GLB').id && c.from.port === 'trig' && c.to.module === t.id && c.to.port === 'reset'), name).toBe(true);
    });
    expect(p.modules.some((m) => m.type === 'arp')).toBe(false);
  });

  it('a step\'s velocity is its curve\'s POKE: each hit as loud as the same velocity alone, whatever came before', () => {
    const hits = (s: string): number[] => {
      const p = silence(scrounge());
      track(p, 'VOICE 4').notes = lane(s, 59);
      setRow(p, 'voice 4', 'gate', 0.03);   // (each hit over before the next)
      const x = run(p, 2.1), step = (SR * 60) / 120 / 4;
      return Array.from({ length: 16 }, (_, k) => rms(x, Math.round(k * step), Math.round((k + 1) * step)));
    };
    const loud = hits('X'.repeat(16)), soft = hits('x'.repeat(16)), both = hits('Xx'.repeat(8));
    const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(loud)).toBeGreaterThan(mean(soft) * 1.1);
    // (within 3 %: the oscillator's phase moves a hit's level a little; a POKE taken from the step's velocity mid-block
    // instead, a track's trig and velocity on the curve, lands up to 15 % off when the velocity changes)
    both.forEach((v, k) => expect(Math.abs(v / (k % 2 ? soft : loud)[k] - 1), `step ${k}`).toBeLessThan(0.03));
  });

  it('LEN GLB brings every track back to its first step after its length', () => {
    const at = (glb: number): number[] => {
      const p = silence(scroungeSet());
      const v = track(p, 'VOICE 1');
      v.notes = lane('x', 53);
      v.params.len = 12;
      track(p, 'LEN GLB').params.len = glb;
      return stepPeaks(run(p, 4.1), 32).flatMap((x, k, a) => (x > 0.02 && !(a[k - 1] > 0.02) ? [k] : []));
    };
    expect(at(16)).toEqual([0, 12, 16, 28]);
    expect(at(48)).toEqual([0, 12, 24]);
  });

  it('the keys play every row with the transport stopped', () => {
    for (const key of KEYS.slice(0, 5)) {
      const e = new Engine(SR);
      e.load(silence(scrounge()));
      e.noteOn(key, 1);
      const l = new Float32Array(SR / 4), r = new Float32Array(l.length);
      e.render(l, r);
      expect(Math.max(...l.map(Math.abs), ...r.map(Math.abs)), `key ${key}`).toBeGreaterThan(0.01);
    }
  });

  it('shape FLAT holds a curve at its POKE for the gate; TILT lets it fall', () => {
    const tail = (shape: number): number => {
      const p = silence(scrounge());
      track(p, 'VOICE 1').notes = lane('x', 53);
      setRow(p, 'voice 1', 'gate', 0.2);
      setRow(p, 'voice 1', 'shape', shape);
      const x = run(p, 0.4);
      return rms(x, Math.round(SR * 0.1), Math.round(SR * 0.18));
    };
    expect(tail(2)).toBeGreaterThan(tail(1) * 1.5);
  });

  it('X-Y adds MOD X, nothing or MOD Y to a voice\'s curve; A-B sends it to A, both or B', () => {
    const play = (xy: number, ab = 2, mod = 'X...'): [Float32Array, Float32Array] => {
      const p = silence(scrounge());
      track(p, 'VOICE 1').notes = lane('x...', 53);
      track(p, 'MOD X').notes = lane(mod, 62);   // (MOD X also opens voice 5, which takes X as made)
      setRow(p, 'voice 1', 'x-y', xy);
      setRow(p, 'voice 1', 'a-b', ab);
      const e = new Engine(SR);
      e.load(p);
      e.transport(true);
      const l = new Float32Array(SR / 2), r = new Float32Array(l.length);
      e.render(l, r);
      return [l, r];
    };
    const [off] = play(2), [x] = play(1), [y] = play(3);
    expect(rms(off.map((v, i) => v - x[i]), 0, off.length)).toBeGreaterThan(1e-3);
    expect(rms(off.map((v, i) => v - y[i]), 0, off.length)).toBeLessThan(1e-6);   // (MOD Y plays nothing here)
    const [aL, aR] = play(2, 1, '....'), [bL, bR] = play(2, 3, '....');
    expect(rms(aR, 0, aR.length)).toBeLessThan(rms(aL, 0, aL.length) / 100);
    expect(rms(bL, 0, bL.length)).toBeLessThan(rms(bR, 0, bR.length) / 100);
  });

  it('holds its grooves as patterns 1 to 10, song 1 (CHAIN) playing the first six in turn', () => {
    const p = scroungeSet();
    expect(p.modules.find((m) => m.type === 'fm1')!.seq!.songs![0]).toEqual([0, 1, 2, 3, 4, 5].map((pat) => ({ pat, shift: 0 })));
    // (Dusty Boom Bap first: the grooves after it share most of its rows, so a track whose row is the same keeps no copy)
    expect(track(p, 'VOICE 1').notes).toEqual(lane('X..x......x.....', 53));
    const kick = (j: number): StepNote[] => (track(p, 'VOICE 1').patterns?.[j - 1]?.notes ?? track(p, 'VOICE 1').notes)!;
    expect(kick(1)).toEqual(lane('X...X...X...X...', 53));
    expect(kick(5)).toEqual(lane('X.....x...X..x..', 53));
    const grooves = new Set(Array.from({ length: 10 }, (_, j) => JSON.stringify(SCROUNGE_TRACKS.map((n) => {
      const t = track(p, n);
      return j ? t.patterns?.[j - 1] ?? t.notes : t.notes;
    }))));
    expect(grooves.size).toBe(10);
    // (only pattern 10, Odd Lengths, sets LEN GLB's length: the others reset every track after 16 steps)
    expect(track(p, 'LEN GLB').patterns?.map((x) => x?.len)).toEqual([...Array(8).fill(undefined), 32]);
  });

  it('plays per-step CHOP (ratchets) and TIME (micro timing) only in patterns 7 to 10, which song 2 chains', () => {
    const p = scroungeSet();
    const timed = (j: number): StepNote[] => SCROUNGE_TRACKS.flatMap((n) => {
      const t = track(p, n);
      return ((j ? t.patterns?.[j - 1]?.notes ?? t.notes : t.notes) ?? []).filter((x) => x.ratchet || x.micro);
    });
    for (let j = 0; j < 6; j++) expect(timed(j), `pattern ${j + 1}`).toEqual([]);
    expect([6, 7, 8, 9].map((j) => timed(j).some((x) => x.ratchet))).toEqual([true, true, false, false]);
    expect([6, 7, 8, 9].map((j) => timed(j).some((x) => x.micro))).toEqual([true, false, true, false]);
    expect(p.modules.find((m) => m.type === 'fm1')!.seq!.songs![1]).toEqual([6, 7, 8, 9].map((pat) => ({ pat, shift: 0 })));
    // (and they reach the sound: pattern 7, Chopped Dust, plays otherwise without its chops and its late snare)
    const play = (q: Patch): Float32Array => {
      const e = new Engine(SR);
      e.load(q);
      e.setPattern(6);
      e.transport(true);
      const l = new Float32Array(SR * 2), r = new Float32Array(l.length);
      e.render(l, r);
      return l.map((v, i) => v + r[i]);
    };
    const plain = scroungeSet();
    for (const m of plain.modules) for (const x of m.patterns?.[5]?.notes ?? []) { delete x.ratchet; delete x.micro; }
    const a = play(p), b = play(plain);
    expect(rms(a.map((v, i) => v - b[i]), 0, a.length)).toBeGreaterThan(1e-3);
  });

  it('moves a preset of the earlier card: the A-B pan to its switch\'s nearest position, VOL A onto VOL (D-1056)', () => {
    const p = scrounge();
    const a = assembliesOf(p).find((x) => x.name === 'Scrounge')!;
    const init = factoryPresets().find((x) => x.structure === structureOf(p, a) && x.name === 'Init')!;
    const migration = PRESET_MIGRATIONS.ed682e82;
    expect(migration.to).toBe(init.structure);
    const lineage = readLineage().engines.Scrounge;
    const before = lineage.find((x) => x.structure === 'ed682e82')!, now = lineage.at(-1)!;
    const old = before.rows.map(() => 0.5);
    old[before.rows.findIndex((r) => r[0] === 'pan#11.pan')] = -0.8;
    old[before.rows.findIndex((r) => r[0] === 'pan#37.pan')] = 0.9;
    old[before.rows.findIndex((r) => r[0] === 'shape#6.level')] = 0.42;
    const values = migrateValues(migration, old, init.values);
    const at = (target: string): number => values[now.rows.findIndex((r) => r[0] === target)];
    expect(Math.round(at('select#16.pos'))).toBe(1);
    expect(Math.round(at('select#62.pos'))).toBe(3);
    expect(at('shape#6.level+shape#7.level')).toBeCloseTo(0.42, 4);
  });
});
