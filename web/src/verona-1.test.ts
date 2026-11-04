// SPDX-License-Identifier: GPL-3.0-only
// Verona 1 and Verona 1 XL (#613, after the Vermona DRM1 MKIV; docs/ledger/patches-and-presets.md D-862..D-864): the
// cards carry the original's knobs per channel, every row sounds its channel, and a closed hi-hat cuts an open one.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { instIsEngine } from './engines';
import type { Patch } from './patch';
import { deviceBudget } from './patchbin';
import { FM1_PRESETS, XL_PRESETS } from './presets';

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

describe('Verona 1 (#613)', () => {
  const fm1 = (): Patch => FM1_PRESETS['Verona 1']();
  it('fits the FM-1 and is its last factory patch, with six channels of the original\'s knobs, VOLUME each, and MASTER', () => {
    expect(Object.keys(FM1_PRESETS).at(-1)).toBe('Verona 1');
    expect(deviceBudget(fm1()).fits).toBe(true);
    const s = sections(fm1(), 'Verona 1');
    expect([...s.keys()]).toEqual(['kick', 'drum 1', 'multi', 'snare', 'hi hat', 'clap', 'master']);
    const want: Record<string, string[]> = { kick: KNOBS.kick, 'drum 1': KNOBS.drum, multi: KNOBS.multi, snare: KNOBS.snare, 'hi hat': KNOBS.hat, clap: KNOBS.clap.filter((k) => k !== 'noise color') };
    for (const [head, knobs] of Object.entries(want)) expect(s.get(head), head).toEqual([...knobs, 'volume']);
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

  it('a closed hit cuts the open hi-hat ringing, and dies in its fixed short time', () => {
    const p = fm1();
    const map = p.modules.find((m) => m.type === 'drummap')!;
    const [open, closed] = [map.params.n5, map.params.n6];
    const ringing = play(p, [[0, open]], 400, 250);
    const cut = play(p, [[0, open], [100, closed]], 400, 250);
    expect(ringing).toBeGreaterThan(0.002);
    expect(cut).toBeLessThan(ringing / 20);
  });

  it('a closed hit pressed while the open row\'s key is still down cuts it too (the 1.10 early check)', () => {
    const p = fm1();
    const map = p.modules.find((m) => m.type === 'drummap')!;
    const [open, closed] = [map.params.n5, map.params.n6];
    const ringing = playHeld(p, [[0, open, true], [300, open, false]], 400, 250);
    const cut = playHeld(p, [[0, open, true], [20, closed, true], [300, open, false], [300, closed, false]], 400, 250);
    expect(ringing).toBeGreaterThan(0.002);
    expect(cut).toBeLessThan(ringing / 20);
  });
});

describe('Verona 1 XL (#613)', () => {
  const xl = (): Patch => XL_PRESETS['Verona 1 XL']();
  it('has all eight channels with every knob, PAN and VOLUME each, MASTER, and the hi-hats\' TRIG switch', () => {
    const s = sections(xl(), 'Verona 1 XL');
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
