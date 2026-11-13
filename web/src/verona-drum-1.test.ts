// SPDX-License-Identifier: GPL-3.0-only
// Verona Drum 1 and Verona Drum 1 XL (#613, after the Vermona DRM1 MKIV; docs/ledger/patches-and-presets.md D-862..D-864): the
// cards carry the original's knobs per channel, every row sounds its channel, and a closed hi-hat cuts an open one.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { instIsEngine } from './engines';
import type { Patch } from './patch';
import { deviceBudget } from './patchbin';
import { CPU_VOICE_TOP } from './cpu';
import { applyPreset } from './device-presets';
import { factoryPresets } from './factory-presets';
import { PRESET_MIGRATIONS, migrateValues } from './preset-migrate';
import { structureOf } from './structure';
import { readLineage } from '../scripts/lineage-lib';
import { FM1_PRESETS } from './presets';
import { relocatedPatches } from './community-factory';

const SR = 44118;
/** the knobs of each channel as the manual lists them (pages 11 to 18), in its order */
const KNOBS: Record<string, string[]> = {
  kick: ['decay', 'pitch', 'bend', 'time', 'wave', 'noise', 'attack'],
  drum: ['decay', 'pitch', 'bend', 'attack', 'fm int', 'fm freq', 'wave'],
  multi: ['decay', 'pitch', 'bend', 'attack', 'pitch 2', 'pitch 3', 'highpass'],
  snare: ['decay rev', 'reverb', 'decay noise', 'noise', 'attack', 'resonance', 'filter'],
  hat: ['decay', 'filter', 'bend', 'attack', 'resonance', 'mix', 'pitch'],
  clap: ['decay rev', 'reverb', 'clap', 'noise color', 'noise', 'resonance', 'filter'],
};
/** the card's rows by heading */
function sections(p: Patch, name: string): Map<string, string[]> {
  const a = p.assemblies!.find((x) => x.name === name && instIsEngine(p, x))!;
  const out = new Map<string, string[]>();
  let head = '';
  for (const r of a.params) {
    if (r.head) head = r.head;
    out.set(head, [...(out.get(head) ?? []), r.label!]);
  }
  return out;
}
/** the peak of the left channel over `ms` after a hit of each note in `hits` ([at ms, note]) */
function play(p: Patch, hits: [number, number][], ms: number, from = 0): number {
  const e = new Engine(SR);
  e.load(p);
  const l = new Float32Array(Math.round((SR * ms) / 1000));
  const r = new Float32Array(l.length);
  const at = (t: number): number => Math.round((SR * t) / 1000);
  let done = 0;
  for (const [t, note] of [...hits].sort((a, b) => a[0] - b[0])) {
    e.render(l.subarray(done, at(t)), r.subarray(done, at(t)));
    done = at(t);
    e.noteOn(note, 100);
    e.render(l.subarray(done, done + 256), r.subarray(done, done + 256));
    done += 256;
    e.noteOff(note);
  }
  e.render(l.subarray(done), r.subarray(done));
  let peak = 0;
  for (let i = at(from); i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]));
  return peak;
}

/** as `play`, with each key held: [at ms, note, on] (the keys stay down until their off, so two rows overlap) */
function playHeld(p: Patch, evs: [number, number, boolean][], ms: number, from = 0): number {
  const e = new Engine(SR);
  e.load(p);
  const l = new Float32Array(Math.round((SR * ms) / 1000));
  const r = new Float32Array(l.length);
  const at = (t: number): number => Math.round((SR * t) / 1000);
  let done = 0;
  for (const [t, note, on] of [...evs].sort((a, b) => a[0] - b[0])) {
    e.render(l.subarray(done, at(t)), r.subarray(done, at(t)));
    done = at(t);
    if (on) e.noteOn(note, 100);
    else e.noteOff(note);
  }
  e.render(l.subarray(done), r.subarray(done));
  let peak = 0;
  for (let i = at(from); i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]));
  return peak;
}

describe('Verona Drum 1 (#613)', () => {
  const fm1 = (): Patch => FM1_PRESETS['Verona Drum 1']();
  it('fits the FM-1 and is its last factory patch, with six channels of the original\'s knobs, PAN and VOLUME each, and MASTER', () => {
    expect(Object.keys(FM1_PRESETS).at(-1)).toBe('Verona Drum 1');
    expect(deviceBudget(fm1()).fits).toBe(true);
    expect(deviceBudget(fm1()).cpu.use).toBeLessThanOrEqual(CPU_VOICE_TOP);
    const s = sections(fm1(), 'Verona Drum 1');
    expect([...s.keys()]).toEqual(['kick', 'drum 1', 'multi', 'snare', 'hi hat', 'clap', 'master']);
    const want: Record<string, string[]> = { kick: KNOBS.kick, 'drum 1': KNOBS.drum, multi: KNOBS.multi, snare: KNOBS.snare, 'hi hat': KNOBS.hat, clap: KNOBS.clap.filter((k) => k !== 'noise color') };
    for (const [head, knobs] of Object.entries(want)) expect(s.get(head), head).toEqual([...knobs, 'pan', 'volume']);
    expect(s.get('master')).toEqual(['master']);
  });

  it('names its Drum map rows after the channels, and each row sounds', () => {
    const p = fm1();
    const map = p.modules.find((m) => m.type === 'drummap')!;
    expect(map.names).toEqual(['KICK', 'DRUM 1', 'MULTI', 'SNARE', 'HH OPEN', 'HH CLOSE', 'CLAP', 'ROW 8']);
    for (let r = 1; r <= 7; r++) expect(play(p, [[0, map.params[`n${r}`]]], 200), map.names![r - 1]).toBeGreaterThan(0.01);
  });

  it('plays a 16-step pattern on a Steps track named PATTERN between Main\'s keys and the engine (D-330)', () => {
    const p = fm1();
    const st = p.modules.find((m) => m.type === 'steps')!;
    expect(st.name).toBe('PATTERN');
    expect(st.params.len ?? 16).toBe(16);
    expect(st.notes!.length).toBeGreaterThan(16);
    expect(p.modules.some((m) => m.type === 'arp')).toBe(false);
  });

  it('pans each channel left, center and right, with MASTER scaling both outputs', () => {
    const p = fm1();
    const a = p.assemblies!.find((x) => x.name === 'Verona Drum 1')!;
    const pans = a.params.filter((r) => r.label === 'pan');
    const master = a.params.find((r) => r.label === 'master')!;
    const map = p.modules.find((m) => m.type === 'drummap')!;
    const levels = (row: number, pan: number, gain: number): number[] => {
      pans.forEach((r, i) => { p.modules.find((m) => m.id === r.module)!.params[r.param] = i === [0, 1, 2, 3, 4, 4, 5][row - 1] ? pan : 0; });
      p.modules.find((m) => m.id === master.module)!.params[master.param] = gain;
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(map.params[`n${row}`], 100);
      const l = new Float32Array(8192), r = new Float32Array(8192);
      e.render(l, r);
      return [l, r].map((x) => Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length));
    };
    expect(pans).toHaveLength(6);
    for (const row of [1, 2, 3, 4, 5, 6, 7]) {
      const left = levels(row, -1, 0.4), right = levels(row, 1, 0.4);
      const center = levels(row, 0, 0.4), half = levels(row, 0, 0.2);
      expect(left[0], `row ${row}`).toBeGreaterThan(0.001);
      expect(left[1]).toBeLessThan(1e-8);
      expect(right[0]).toBeLessThan(1e-8);
      expect(right[1]).toBeCloseTo(left[0], 6);
      expect(center[0]).toBeCloseTo(center[1], 6);
      expect(center[0]).toBeCloseTo(left[0] / Math.SQRT2, 6);
      for (let c = 0; c < 2; c++) expect(half[c]).toBeCloseTo(center[c] / 2, 6);
    }
  });

  it('keeps every saved mono control value and centers the six new pans when migrating a preset', () => {
    const p = fm1();
    const a = p.assemblies!.find((x) => x.name === 'Verona Drum 1')!;
    const from = 'db9de761';
    const migration = PRESET_MIGRATIONS[from];
    const before = readLineage().engines['Verona Drum 1'].find((x) => x.structure === from)!;
    const init = factoryPresets().find((x) => x.structure === structureOf(p, a) && x.name === 'Init')!;
    const old = before.rows.map((_, i) => (i + 1) / 100);
    const values = migrateValues(migration, old, init.values);
    expect(migration.to).toBe(init.structure);
    expect(migration.rows.filter((r) => r === -1)).toHaveLength(6);
    expect(new Set(migration.rows.filter((r) => typeof r === 'number' && r >= 0)).size).toBe(old.length);
    migration.rows.forEach((r, i) => expect(values[i]).toBe(r === -1 ? 0 : old[r as number]));
    applyPreset(p, a, { structure: init.structure, name: 'Migrated', values });
    const master = a.params.find((r) => r.label === 'master')!;
    expect(p.modules.find((m) => m.id === master.module)!.params[master.param]).toBe(old[before.rows.findIndex((r) => r[1] === 'master')]);
  });

  it('a closed hit cuts the open hi-hat ringing, and dies in its fixed short time', () => {
    const p = fm1();
    const map = p.modules.find((m) => m.type === 'drummap')!;
    const [open, closed] = [map.params.n5, map.params.n6];
    const ringing = play(p, [[0, open]], 400, 250);
    const cut = play(p, [[0, open], [100, closed]], 400, 250);
    expect(ringing).toBeGreaterThan(0.002);
    expect(cut).toBeLessThan(ringing / 20);
  });

  it('a hi-hat row pressed while its other row\'s key is still down plays, either way round (the 1.10 early check, D-866)', () => {
    const p = fm1();
    const map = p.modules.find((m) => m.type === 'drummap')!;
    const [open, closed] = [map.params.n5, map.params.n6];
    const ringing = playHeld(p, [[0, open, true], [300, open, false]], 400, 250);
    expect(ringing).toBeGreaterThan(0.002);
    // the open row held, then the closed row: it cuts the open hat
    const cut = playHeld(p, [[0, open, true], [20, closed, true], [300, open, false], [300, closed, false]], 400, 250);
    expect(cut).toBeLessThan(ringing / 20);
    // the closed row held, then the open row: it rings
    expect(playHeld(p, [[0, closed, true], [20, open, true], [300, open, false], [300, closed, false]], 400, 250)).toBeGreaterThan(ringing / 2);
  });
});

describe('Verona Drum 1 XL (#613)', () => {
  const xl = (): Patch => relocatedPatches['Verona Drum 1 XL']();
  it('has all eight channels with every knob, PAN and VOLUME each, MASTER, and the hi-hats\' TRIG switch', () => {
    const s = sections(xl(), 'Verona Drum 1 XL');
    expect([...s.keys()]).toEqual(['kick', 'drum 1', 'drum 2', 'multi', 'snare', 'hi hat 1', 'hi hat 2', 'clap', 'master']);
    const want: Record<string, string[]> = {
      kick: KNOBS.kick, 'drum 1': KNOBS.drum, 'drum 2': KNOBS.drum, multi: KNOBS.multi, snare: KNOBS.snare,
      'hi hat 1': [...KNOBS.hat, 'trig'], 'hi hat 2': [...KNOBS.hat, 'trig'], clap: KNOBS.clap,
    };
    for (const [head, knobs] of Object.entries(want)) expect(s.get(head), head).toEqual([...knobs, 'pan', 'volume']);
  });

  it('plays the closed hi-hats on the CLOSED track\'s rows whatever TRIG says', () => {
    const p = xl();
    const maps = p.modules.filter((m) => m.type === 'drummap');
    const closed = maps.find((m) => m.names?.[0] === 'HH 1 CL')!;
    const main = maps.find((m) => m.names?.[0] === 'KICK')!;
    // HI HAT 2 ships open: its row rings, its closed row does not
    expect(play(p, [[0, main.params.n7]], 400, 250)).toBeGreaterThan(0.001);
    expect(play(p, [[0, closed.params.n2]], 400, 250)).toBeLessThan(1e-4);
    expect(play(p, [[0, closed.params.n2]], 60)).toBeGreaterThan(0.005);
    expect(p.modules.filter((m) => m.type === 'steps').map((m) => m.name)).toEqual(['PATTERN', 'CLOSED']);
  });

  it('a hi-hat row pressed while its other row\'s key is still down plays, either way round (the 1.10 early check)', () => {
    const p = xl();
    const maps = p.modules.filter((m) => m.type === 'drummap');
    const closed = maps.find((m) => m.names?.[0] === 'HH 1 CL')!.params.n2;
    const open = maps.find((m) => m.names?.[0] === 'KICK')!.params.n7;   // HI HAT 2 ships open
    const ringing = playHeld(p, [[0, open, true], [300, open, false]], 400, 250);
    expect(playHeld(p, [[0, open, true], [20, closed, true], [300, open, false], [300, closed, false]], 400, 250)).toBeLessThan(ringing / 20);
    // the closed row held, then the open row: it rings
    expect(playHeld(p, [[0, closed, true], [20, open, true], [300, open, false], [300, closed, false]], 400, 250)).toBeGreaterThan(ringing / 2);
  });
});
