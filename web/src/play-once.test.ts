// SPDX-License-Identifier: GPL-3.0-only
// Play once (#632): a bar counted in with a click, the pattern or the song once, then the transport stops by itself.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type ModuleInst, type Patch } from './patch';
import type { StepNote } from './track';

const SR = 48000; // 120 bpm: a tick every 1000 samples, a beat every 24000, a bar every 96000, a 1/16 step every 6000
const note = (at: number): StepNote => ({ at, len: 1, note: 60, vel: 100 });

/** Main at 120 bpm, Steps tracks (their trig summed on the left output at 0.5 each, so a click (0.25 at most) tells apart) */
function rig(tracks: { len: number; at: number[] }[]): { p: Patch; st: ModuleInst[]; main: ModuleInst } {
  const p = emptyPatch('once');
  const main = addModule(p, DEFS.fm1, 0, 0);
  main.params.tempo = 120;
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 0.5;
  const st = tracks.map((t) => {
    const s = addModule(p, DEFS.steps, 0, 0);
    s.params.len = t.len;
    s.notes = t.at.map(note);
    connect(p, DEFS, { module: s.id, port: 'trig' }, { module: out.id, port: 'l' });
    return s;
  });
  return { p, st, main };
}

/** render n samples in blocks of 128 as the worklet does: the left side, and the transport after each block */
function run(e: Engine, n: number): { l: Float32Array; running: boolean[] } {
  const l = new Float32Array(n), running: boolean[] = [];
  for (let off = 0; off < n; off += 128) {
    const a = new Float32Array(Math.min(128, n - off)), b = new Float32Array(a.length);
    e.render(a, b);
    l.set(a, off);
    running.push(e.transportRunning);
  }
  return { l, running };
}
/** where the trig rises (above the click's level) */
const rises = (l: Float32Array): number[] => [...l.keys()].filter((i) => l[i] > 0.4 && (i === 0 || l[i - 1] <= 0.4));
/** where a click begins: a sample off zero after at least 1000 at zero, below the trig's level */
const clicks = (l: Float32Array, to: number): number[] => {
  const at: number[] = [];
  let quiet = 1000;
  for (let i = 0; i < to; i++) {
    if (l[i] !== 0 && Math.abs(l[i]) <= 0.26 && quiet >= 1000) at.push(i);
    quiet = l[i] === 0 ? quiet + 1 : 0;
  }
  return at;
};

describe('play once (#632)', () => {
  it('counts in a bar with a click on each beat, beat 1 higher, while the transport stays stopped', () => {
    const { p } = rig([{ len: 16, at: [0, 4, 8, 12] }]);
    const e = new Engine(SR);
    e.load(p);
    e.playOnce();
    expect(e.onceState).toBe(1);
    const { l, running } = run(e, 96000);
    expect(clicks(l, 96000)).toEqual([0, 23999, 47999, 71999]);
    expect(Math.max(...l.subarray(0, 100))).toBeCloseTo(0.25, 3);
    expect(running.every((r) => !r)).toBe(true);
    // beat 1's period is half the others' (2 kHz against 1 kHz)
    const flips = (from: number): number => [...l.subarray(from, from + 200).keys()].filter((i) => i > 0 && Math.sign(l[from + i]) !== Math.sign(l[from + i - 1])).length;
    expect(flips(0)).toBeGreaterThan(1.8 * flips(23999));
  });

  it('then plays the pattern once and stops by itself', () => {
    const { p } = rig([{ len: 16, at: [0, 4, 8, 12] }]);
    const e = new Engine(SR);
    e.load(p);
    e.playOnce();
    const { l, running } = run(e, 96000 * 3);
    const r = rises(l);
    expect(r).toHaveLength(4);
    expect(r[0]).toBeGreaterThanOrEqual(96000);
    expect(r[0]).toBeLessThan(96000 + 256);
    for (const d of r.slice(1).map((x, i) => x - r[i])) expect(Math.abs(d - 24000)).toBeLessThanOrEqual(1);   // (as PLAY plays it)
    const first = running.indexOf(true), last = running.lastIndexOf(true);
    expect(first * 128).toBeGreaterThanOrEqual(95872);
    expect((last - first + 1) * 128).toBeGreaterThanOrEqual(96000 - 256);   // (the whole pass, about a bar)
    expect((last - first + 1) * 128).toBeLessThan(96000 + 512);
    expect(e.transportRunning).toBe(false);
    expect(e.onceState).toBe(0);
  });

  it('a shorter track plays its pass once, then nothing until the longest has played its own', () => {
    const { p } = rig([{ len: 16, at: [] }, { len: 6, at: [0] }]);
    const e = new Engine(SR);
    e.load(p);
    e.playOnce();
    const { l, running } = run(e, 96000 * 3);
    expect(rises(l)).toHaveLength(1);
    expect(running.filter((x) => x).length * 128).toBeGreaterThanOrEqual(96000 - 256);
  });

  it('a song plays its entries once each', () => {
    const { p, st, main } = rig([{ len: 4, at: [0] }]);
    st[0].patterns = [{ notes: [note(0), note(2)] }];
    main.seq = { song: 1, songs: [[{ pat: 0, shift: 0 }, { pat: 1, shift: 0 }, { pat: 0, shift: 0 }]] };
    const e = new Engine(SR);
    e.load(p);
    e.playOnce();
    const { l } = run(e, 96000 * 3);
    expect(rises(l)).toHaveLength(4);   // (1 + 2 + 1)
    expect(e.transportRunning).toBe(false);
  });

  it('the transport ends it: started in the count-in it runs on as PLAY started it; stopped, nothing plays', () => {
    const { p } = rig([{ len: 16, at: [0] }]);
    const e = new Engine(SR);
    e.load(p);
    e.playOnce();
    run(e, 40000);
    e.transport(true);
    expect(e.onceState).toBe(0);
    const a = run(e, 96000 * 3);
    expect(rises(a.l)).toHaveLength(4);   // (at once, then each bar)
    expect(e.transportRunning).toBe(true);
    e.transport(false);
    e.playOnce();
    run(e, 30000);
    e.transport(false);
    const b = run(e, 96000 * 2);
    expect(rises(b.l)).toHaveLength(0);
    expect(clicks(b.l, b.l.length)).toEqual([]);
  });

  it('a track on its own clock (clk patched) is left out: it never holds the transport', () => {
    const { p, st, main } = rig([{ len: 16, at: [0] }, { len: 64, at: [0] }]);
    connect(p, DEFS, { module: main.id, port: 'gate' }, { module: st[1].id, port: 'clk' });
    const e = new Engine(SR);
    e.load(p);
    e.playOnce();
    run(e, 96000 * 2 + 1000);
    expect(e.transportRunning).toBe(false);
  });
});
