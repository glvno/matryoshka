// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch } from './patch';
import { encodePatch, formatOf, GROUP_REC } from './patchbin';
import { deviceView } from './poly';
import { MAX_PARTS } from './patch';

const SR = 44100;

/** Main keys -> Arpeggiator -> Voice allocator (`voices`) -> saw -> VCA <- ADSR -> output */
function arpPatch(arpParams: Record<string, number> = {}, voices = 1, tempo = 120): { p: Patch; ids: Record<string, number> } {
  const p = emptyPatch('arp');
  const main = addModule(p, DEFS.fm1, 0, 0);
  const arp = addModule(p, DEFS.arp, 300, 0);
  const alloc = addModule(p, DEFS.alloc, 600, 0);
  const osc = addModule(p, DEFS.osc, 900, 0);
  const env = addModule(p, DEFS.adsr, 900, 300);
  const vca = addModule(p, DEFS.vca, 1200, 0);
  const out = addModule(p, DEFS.output, 1500, 0);
  main.params.tempo = tempo;
  Object.assign(arp.params, arpParams);
  alloc.params.voices = voices;
  const w = (a: number, ap: string, b: number, bp: string): void => {
    if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`${ap} -> ${bp}`);
  };
  w(main.id, 'keys', arp.id, 'keys');
  w(arp.id, 'keys', alloc.id, 'keys');
  w(alloc.id, 'pitch', osc.id, 'pitch');
  w(alloc.id, 'gate', env.id, 'gate');
  w(osc.id, 'out', vca.id, 'in');
  w(env.id, 'env', vca.id, 'cv');
  w(vca.id, 'out', out.id, 'l');
  return { p, ids: { main: main.id, arp: arp.id, alloc: alloc.id } };
}

/** the notes the allocator's parts start over `blocks` blocks (a new sounding note per change) */
function played(e: Engine, blocks: number): number[] {
  const l = new Float32Array(128), r = new Float32Array(128);
  const seq: number[] = [];
  let last = '';
  for (let b = 0; b < blocks; b++) {
    e.render(l, r);
    const on = e.voiceNotes().filter((v) => v.on).map((v) => v.note);
    const k = on.join(',');
    if (k !== last && on.length) seq.push(on[on.length - 1]);
    last = k;
  }
  return seq;
}

/** blocks of one 1/16 step at 120 bpm (6 ticks of 48 a second = 0.125 s) */
const STEP = Math.round((0.125 * SR) / 128);

describe('Arpeggiator module', () => {
  it('survives the device compile pass (its keys cables are gone there, it still plays its group) and idle parts', () => {
    const { p, ids } = arpPatch({ mode: 0, rate: 4, gate: 0.3 }, 3);
    const view = deviceView(p, true);
    expect(view.patch.modules.some((m) => m.id === ids.arp)).toBe(true);
    expect(view.groups.map((g) => g.src)).toContain(ids.arp);
    const bin = encodePatch(p);
    expect(bin.length).toBeGreaterThan(0);
    const render = (compile: boolean): Float32Array => {
      const e = new Engine(SR);
      e.load(structuredClone(p), compile);
      for (const n of [64, 60, 67]) e.noteOn(n, 1);
      const out = new Float32Array(STEP * 12 * 128), l = new Float32Array(128), r = new Float32Array(128);
      for (let b = 0; b < STEP * 12; b++) {
        e.render(l, r);
        out.set(l, b * 128);
      }
      return out;
    };
    const a = render(false), b = render(true);
    expect(a.some((x) => x !== 0)).toBe(true);
    let diff = -1;
    for (let i = 0; i < a.length && diff < 0; i++) if (a[i] !== b[i]) diff = i;
    expect(diff).toBe(-1);
    // the last step still sounds: a part the arpeggiator plays is never left idle while its gate is up
    expect(b.subarray(b.length - STEP * 128).some((x) => x !== 0)).toBe(true);
  });

  it('plays the held keys one at a time, up, from the Main module\'s tempo', () => {
    const e = new Engine(SR);
    e.load(arpPatch({ mode: 0, rate: 4, gate: 0.5 }).p);
    for (const n of [64, 60, 67]) e.noteOn(n, 1);
    expect(played(e, STEP * 6 + 2)).toEqual([60, 64, 67, 60, 64, 67, 60]);
  });

  it('down, up-down, as played, and octaves', () => {
    const run = (params: Record<string, number>, steps: number): number[] => {
      const e = new Engine(SR);
      e.load(arpPatch({ rate: 4, gate: 0.5, ...params }).p);
      for (const n of [64, 60, 67]) e.noteOn(n, 1);
      return played(e, STEP * (steps - 1) + 2);
    };
    expect(run({ mode: 1 }, 4)).toEqual([67, 64, 60, 67]);
    expect(run({ mode: 2 }, 6)).toEqual([60, 64, 67, 64, 60, 64]);
    expect(run({ mode: 4 }, 4)).toEqual([64, 60, 67, 64]);
    expect(run({ mode: 0, octaves: 2 }, 7)).toEqual([60, 64, 67, 72, 76, 79, 60]);
  });

  it('the gate is a share of the step; at 100 % the notes join but every one restarts the envelope', () => {
    const e = new Engine(SR);
    e.load(arpPatch({ rate: 4, gate: 0.5 }).p);
    e.noteOn(60, 1);
    const l = new Float32Array(128), r = new Float32Array(128);
    let off = 0;
    for (let b = 0; b < STEP; b++) {
      e.render(l, r);
      if (!e.voiceNotes().some((v) => v.on)) off++;
    }
    expect(off).toBeGreaterThan(STEP * 0.4);
    expect(off).toBeLessThan(STEP * 0.6);
  });

  it('latch keeps the arpeggio after the keys are let go; a new chord replaces it', () => {
    const e = new Engine(SR);
    e.load(arpPatch({ rate: 4, gate: 0.5, latch: 1 }).p);
    e.noteOn(60, 1);
    e.noteOn(64, 1);
    e.noteOff(60);
    e.noteOff(64);
    expect(played(e, STEP * 3 + 2)).toEqual([60, 64, 60, 64]);
    e.noteOn(72, 1);
    const after = played(e, STEP * 3 + 2);
    expect(after.slice(-2)).toEqual([72, 72]); // (the note sounding when the chord changed may finish first)
    expect(after.slice(1)).not.toContain(60);
  });

  it('without latch it stops when the keys are let go', () => {
    const e = new Engine(SR);
    e.load(arpPatch({ rate: 4, gate: 1 }).p);
    e.noteOn(60, 1);
    played(e, STEP);
    e.noteOff(60);
    played(e, 2);
    expect(e.voiceNotes().some((v) => v.on)).toBe(false);
  });

  it('a faster tempo, a faster rate', () => {
    const steps = (tempo: number, rate: number): number => {
      const e = new Engine(SR);
      e.load(arpPatch({ rate, gate: 0.5 }, 1, tempo).p);
      e.noteOn(60, 1);
      e.noteOn(67, 1);
      return played(e, Math.round(SR / 128)).length; // one second
    };
    expect(steps(120, 4)).toBe(9); // 1/16 at 120 bpm: 8 a second (the first at once, the ninth at the end of the second)
    expect(steps(120, 6)).toBe(17); // 1/32
    expect(steps(60, 4)).toBe(5);
  });

  it('with something in clk: one step per rising edge there', () => {
    const { p, ids } = arpPatch({ rate: 0, gate: 0.5 });
    const lfo = addModule(p, DEFS.lfo, 0, 300);
    lfo.params.wave = 3; // square
    lfo.params.rate = 4;
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: ids.arp, port: 'clk' });
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(60, 1);
    e.noteOn(64, 1);
    expect(played(e, Math.round(SR / 128)).length).toBeGreaterThanOrEqual(4);
  });

  it('several voices: the allocator spreads the arpeggio\'s notes, the keys reach no other group', () => {
    const e = new Engine(SR);
    e.load(arpPatch({ rate: 4, gate: 1 }, 4).p);
    e.noteOn(60, 1);
    e.noteOn(64, 1);
    played(e, STEP * 3 + 2);
    expect(e.voiceNotes().filter((v) => v.on)).toHaveLength(1);
  });
});

describe('transport and clock', () => {
  /** the Main module's run and clock outputs over `blocks` blocks */
  function mainOut(e: Engine, id: number, blocks: number): { run: number; clocks: number } {
    const l = new Float32Array(128), r = new Float32Array(128);
    let run = 0, clocks = 0;
    for (let b = 0; b < blocks; b++) {
      e.render(l, r);
      run = e.probe(id, 'run')![0];
      if (e.probe(id, 'clock')![0] > 0.5) clocks++;
    }
    return { run, clocks };
  }

  it('the clock output pulses 24 times a quarter note while the transport runs, and run is high', () => {
    const { p, ids } = arpPatch();
    const e = new Engine(SR);
    e.load(p);
    expect(mainOut(e, ids.main, 100)).toEqual({ run: 0, clocks: 0 });
    e.transport(true);
    const o = mainOut(e, ids.main, Math.round(SR / 128)); // a second at 120 bpm: 48 ticks
    expect(o.run).toBe(1);
    expect(o.clocks).toBeGreaterThanOrEqual(46);
    expect(o.clocks).toBeLessThanOrEqual(49);
    e.transport(false);
    expect(mainOut(e, ids.main, 50).clocks).toBe(0);
  });

  it('MIDI clock replaces the tempo while it comes in', () => {
    const { p, ids } = arpPatch();
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    e.clockExternal(true);
    expect(mainOut(e, ids.main, 50).clocks).toBe(0);
    let clocks = 0;
    const l = new Float32Array(128), r = new Float32Array(128);
    for (let b = 0; b < 20; b++) {
      if (b % 4 === 0) e.clockTick();
      e.render(l, r);
      if (e.probe(ids.main, 'clock')![0] > 0.5) clocks++;
    }
    expect(clocks).toBe(5);
  });
});

describe('device form', () => {
  it('the arpeggiated allocator gets a group whose record names the Arpeggiator as its source', () => {
    const { p, ids } = arpPatch({}, 1);
    const { patch, groups } = deviceView(p);
    expect(groups).toHaveLength(1);
    expect(groups[0].src).toBe(ids.arp);
    const bin = encodePatch(p);
    expect(bin[1]).toBe(formatOf(p));
    expect(bin[8 + 4 + 5 * MAX_PARTS]).toBe(patch.modules.findIndex((m) => m.id === ids.arp) + 1);
    expect(GROUP_REC).toBe(8 + 5 * MAX_PARTS);
  });

  it('a patch with the old firmware arpeggiator keeps its tempo as the Main module\'s', () => {
    const { p } = arpPatch();
    const raw = JSON.parse(JSON.stringify(p));
    delete raw.modules[0].params.tempo;
    raw.arp = { mode: 0, scale: 5, root: 60, octaves: 1, chaos: 0, vchaos: 0, rchaos: 0, steps: 16, pulses: 16, rot: 0, rate: 6, bpm: 140 };
    const q = validatePatch(raw, DEFS);
    expect(q.arp).toBeUndefined();
    expect(q.modules[0].params.tempo).toBe(140);
  });
});

describe('continuous Arpeggiator rate input', () => {
  it.each([2, 4])('runs at %f Hz independently of Main tempo', (hz) => {
    const run = (tempo: number): number[] => {
      const { p, ids } = arpPatch({ rate: 0, gate: .5 }, 1, tempo);
      const cv = addModule(p, DEFS.const, 0, 0);
      cv.params.value = hz;
      expect(connect(p, DEFS, { module: cv.id, port: 'out' }, { module: ids.arp, port: 'rate' })).toBe(true);
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(60, 1); e.noteOn(64, 1);
      return played(e, Math.floor(SR / 128));
    };
    expect(run(60)).toHaveLength(hz);
    expect(run(240)).toEqual(run(60));
  });
  it('restarts held notes when its continuous rate rises from zero', () => {
    const { p, ids } = arpPatch();
    const cv = addModule(p, DEFS.const, 0, 0);
    cv.params.value = 0;
    connect(p, DEFS, { module: cv.id, port: 'out' }, { module: ids.arp, port: 'rate' });
    const e = new Engine(SR);
    e.load(p); e.noteOn(60, 1); e.noteOn(64, 1);
    expect(played(e, 50)).toEqual([]);
    e.setParam(cv.id, 'value', 4);
    expect(played(e, Math.floor(SR / 128 / 2))).toEqual([60, 64]);
    e.setParam(cv.id, 'value', -1);
    played(e, 2); // the input is read from the preceding block
    expect(played(e, 50)).toEqual([]);
  });
  it('pauses at zero and lets a patched clock take precedence', () => {
    const { p, ids } = arpPatch();
    const cv = addModule(p, DEFS.const, 0, 0);
    cv.params.value = 0;
    connect(p, DEFS, { module: cv.id, port: 'out' }, { module: ids.arp, port: 'rate' });
    const e = new Engine(SR);
    e.load(p); e.noteOn(60, 1); e.noteOn(64, 1);
    expect(played(e, 100)).toEqual([]);
    const clk = addModule(p, DEFS.lfo, 0, 0);
    Object.assign(clk.params, { rate: 4, wave: 3 });
    connect(p, DEFS, { module: clk.id, port: 'out' }, { module: ids.arp, port: 'clk' });
    e.load(p);
    expect(played(e, Math.floor(SR / 128)).length).toBeGreaterThanOrEqual(4);
  });
});
