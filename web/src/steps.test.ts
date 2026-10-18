// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, stepPlays } from './modules';
import { addModule, connect, emptyPatch, stepByte, stepOf, validatePatch, type ModuleInst, type Patch } from './patch';
import { deviceBudget, encodePatch, recordSize } from './patchbin';

const SR = 48000; // 120 bpm: a tick every 1000 samples, a 1/16 step every 6000

/** Main (120 bpm) -> a Steps module whose trig goes to the left output, acc to the right */
function rig(steps: number[], params: Record<string, number> = {}): { p: Patch; st: ModuleInst; main: ModuleInst } {
  const p = emptyPatch('steps');
  const main = addModule(p, DEFS.fm1, 0, 0);
  main.params.tempo = 120;
  const st = addModule(p, DEFS.steps, 0, 0);
  Object.assign(st.params, params);
  st.steps = Array.from({ length: 64 }, (_, k) => steps[k] ?? 0);
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  connect(p, DEFS, { module: st.id, port: 'trig' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: st.id, port: 'acc' }, { module: out.id, port: 'r' });
  return { p, st, main };
}

/** render `n` samples; the samples where l / r rise */
function edges(e: Engine, n: number): { trig: number[]; acc: number[]; l: Float32Array } {
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  const rise = (b: Float32Array): number[] => [...b.keys()].filter((i) => b[i] > 0.5 && (i === 0 || b[i - 1] <= 0.5));
  return { trig: rise(l), acc: rise(r), l };
}

const ON = stepByte({ on: true, accent: false, chance: 100 });
const ACC = stepByte({ on: true, accent: true, chance: 100 });

describe('the Steps module (#83)', () => {
  it('step bytes: on, accent, chance in 5 % steps', () => {
    expect(stepOf(stepByte({ on: true, accent: true, chance: 35 }))).toEqual({ on: true, accent: true, chance: 35 });
    expect(stepByte({ on: true, accent: false, chance: 2 })).toBe(1 | (19 << 2)); // 5 % is the least
    expect(stepOf(0)).toEqual({ on: false, accent: false, chance: 100 });
  });

  it('plays nothing until the transport runs, the first step when it starts, then one step per 1/16 on the clock', () => {
    const { p } = rig([ON, ON, 0, ON]);
    const e = new Engine(SR);
    e.load(p);
    expect(edges(e, 20000).trig).toEqual([]);
    e.transport(true);
    const { trig } = edges(e, 30000);
    expect(trig).toEqual([0, 5999, 17999, 95999].filter((t) => t < 30000)); // steps 0, 1, 3 (the tick ends its period)
  });

  it('wraps at len, accents raise acc with trig, gate is a share of the step', () => {
    const { p } = rig([ACC, 0, ON], { len: 3, gate: 0.5 });
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    const { trig, acc, l } = edges(e, 40000);
    expect(trig).toEqual([0, 11999, 17999, 29999, 35999]);
    expect(acc).toEqual([0, 17999, 35999]);
    expect([...l.slice(17999, 17999 + 3000)].every((v) => v === 1)).toBe(true);
    expect(l[17999 + 3000]).toBe(0);
  });

  it('a trig that follows a trig gets one low sample first, so an envelope restarts', () => {
    const { p } = rig([ON, ON], { len: 2, gate: 1 });
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    const { trig, l } = edges(e, 13000);
    expect(trig).toEqual([0, 6000, 12000]); // steps at 0, 5999, 11999, each a sample late after the low one
    expect(l[5999]).toBe(0);
  });

  it('rate picks the note length; swing delays every second step', () => {
    const a = rig([ON, ON, ON, ON], { rate: 2 }); // 1/8 = 12 ticks
    const e = new Engine(SR);
    e.load(a.p);
    e.transport(true);
    expect(edges(e, 40000).trig).toEqual([0, 11999, 23999, 35999]);
    const b = rig([ON, ON, ON, ON], { swing: 75 });
    const f = new Engine(SR);
    f.load(b.p);
    f.transport(true);
    expect(edges(f, 24000).trig).toEqual([0, 5999 + 3000, 11999, 17999 + 3000]); // half a step late at 75 %
  });

  it('stop and run again start from step 1; reset makes the next step the first', () => {
    const { p, main, st } = rig([ACC, ON, ON, ON]);
    connect(p, DEFS, { module: main.id, port: 'gate' }, { module: st.id, port: 'reset' });
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    edges(e, 14000); // steps 0, 1, 2
    e.transport(false);
    edges(e, 5000);
    e.transport(true);
    expect(edges(e, 128).acc).toEqual([0]);
    edges(e, 12000 - 128); // steps 1, 2 played
    e.noteOn(60, 1);
    const r = edges(e, 6500);
    expect(r.acc.length).toBe(1); // the step after the reset is step 0 (accented)
  });

  it('a muted track keeps its place but stays silent; setStep changes the pattern without a reload', () => {
    const { p, st } = rig([ON]);
    const e = new Engine(SR);
    e.load(p);
    e.setMute(st.id, true);
    e.transport(true);
    expect(edges(e, 13000).trig).toEqual([]);
    expect(e.stepsView()).toEqual([{ id: st.id, pos: 2, mute: true }]);
    e.setMute(st.id, false);
    e.setStep(st.id, 3, ON);
    expect(edges(e, 6000).trig).toEqual([17999 - 13000]);
  });

  it('a chance plays about that often and the same way every time (the hash of the seed, the time round and the step)', () => {
    const half = stepByte({ on: true, accent: false, chance: 50 });
    const { p } = rig([half], { len: 1 });
    const runs = [0, 1].map(() => {
      const e = new Engine(SR);
      e.load(p);
      e.transport(true);
      return edges(e, 6000 * 400).trig.length;
    });
    expect(runs[0]).toBe(runs[1]);
    expect(runs[0]).toBeGreaterThan(160);
    expect(runs[0]).toBeLessThan(240);
    expect(stepPlays(1, 2, 3, 0)).toBe(false);
    expect(stepPlays(1, 2, 3, ON)).toBe(true);
  });

  it('with a cable in clk it steps on every rising edge instead', () => {
    const { p, st } = rig([ON, 0, ON]);
    const l = addModule(p, DEFS.lfo, 0, 0);
    Object.assign(l.params, { wave: 3, rate: 8, depth: 1 });
    connect(p, DEFS, { module: l.id, port: 'out' }, { module: st.id, port: 'clk' });
    const e = new Engine(SR);
    e.load(p);
    const { trig } = edges(e, 18000); // no transport needed; 8 Hz = an edge every 6000 samples, from sample 0
    expect(trig).toEqual([0, 12000]);
  });

  it('the name and the pattern go into its record; old patches lose cables from the SEQ / REC buttons', () => {
    const { p, st } = rig([ACC, 0, ON]);
    st.name = 'kick drum!';
    const v = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(v.modules[1].name).toBe('KICK DRU');
    const bin = encodePatch(v);
    const rec = bin.length - 4 * v.cables.length - recordSize('output') - recordSize('steps');
    const data = rec + recordSize('steps') - 72;
    expect(String.fromCharCode(...bin.slice(data, data + 8))).toBe('KICK DRU');
    expect([...bin.slice(data + 8, data + 11)]).toEqual([ACC, 0, ON]);
    const old = JSON.parse(JSON.stringify(p));
    old.cables.push({ from: { module: old.modules[0].id, port: 'rec' }, to: { module: st.id, port: 'reset' } });
    expect(validatePatch(old, DEFS).cables.length).toBe(2);
  });

  it('the FM-1 takes 16 tracks', () => {
    const { p } = rig([ON]);
    for (let i = 0; i < 16; i++) addModule(p, DEFS.steps, 0, 0);
    expect(deviceBudget(p).over.map((o) => o.key)).toContain('tracks');
  });
});
