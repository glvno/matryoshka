// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, DRUM_MAP_DEFAULT, drumRowsOf, notePlays } from './modules';
import { addModule, connect, emptyPatch, modulate, morphValue, stepByte, topOf, validatePatch, type ModuleInst, type Patch } from './patch';
import { deviceBudget, encodePatch, FLAG_NOTES, recordSize } from './patchbin';
import { deviceView } from './poly';
import { migrateSteps, noteWord, STEPS_RATES, type StepNote } from './track';

const SR = 48000; // 120 bpm: a tick every 1000 samples, a 1/16 step every 6000

/** Main (120 bpm) -> a Steps module (its pattern written as step bytes, migrated) whose trig goes to the left output, vel
 * to the right */
function rig(steps: number[], params: Record<string, number> = {}): { p: Patch; st: ModuleInst; main: ModuleInst } {
  const p = emptyPatch('steps');
  const main = addModule(p, DEFS.fm1, 0, 0);
  main.params.tempo = 120;
  const st = addModule(p, DEFS.steps, 0, 0);
  Object.assign(st.params, params);
  st.notes = migrateSteps(Array.from({ length: 64 }, (_, k) => steps[k] ?? 0));
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  connect(p, DEFS, { module: st.id, port: 'trig' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: st.id, port: 'vel' }, { module: out.id, port: 'r' });
  return { p, st, main };
}

/** render `n` samples; the samples where l rises */
function edges(e: Engine, n: number): { trig: number[]; l: Float32Array; r: Float32Array } {
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  const rise = (b: Float32Array): number[] => [...b.keys()].filter((i) => b[i] > 0.5 && (i === 0 || b[i - 1] <= 0.5));
  return { trig: rise(l), l, r };
}

const ON = stepByte({ on: true, accent: false, chance: 100 });
const ACC = stepByte({ on: true, accent: true, chance: 100 });
const note = (at: number, len: number, n: number, vel = 100, chance?: number): StepNote => ({ at, len, note: n, vel, ...(chance ? { chance } : {}) });

describe('the Steps module (#83, #133)', () => {
  it('plays nothing until the transport runs, the first step when it starts, then one step per 1/16 on the clock', () => {
    const { p } = rig([ON, ON, 0, ON]);
    const e = new Engine(SR);
    e.load(p);
    expect(edges(e, 20000).trig).toEqual([]);
    e.transport(true);
    const { trig } = edges(e, 30000);
    expect(trig).toEqual([0, 5999, 17999, 95999].filter((t) => t < 30000)); // steps 0, 1, 3 (the tick ends its period)
  });

  it('wraps at len, vel holds the last note (an accent is full velocity), gate is a share of the step', () => {
    const { p } = rig([ACC, 0, ON], { len: 3, gate: 0.5 });
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    const { trig, l, r } = edges(e, 40000);
    expect(trig).toEqual([0, 11999, 17999, 29999, 35999]);
    expect(r[5000]).toBe(1);
    expect(r[12000]).toBeCloseTo(100 / 127, 6);
    expect(r[18000]).toBe(1);
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

  it('1/64 steps every tick and a half (every second step half a tick after a tick), 1/2 every 48 ticks; swing reaches 80 % (#351)', () => {
    const fast = rig([ON, ON, ON, ON, ON, ON], { rate: STEPS_RATES.indexOf('1/64') });
    const e = new Engine(SR);
    e.load(fast.p);
    e.transport(true);
    expect(edges(e, 7000).trig).toEqual([0, 999 + 500, 2999, 3999 + 500, 5999]);
    const slow = rig([ON, ON], { rate: STEPS_RATES.indexOf('1/2'), len: 2 });
    const f = new Engine(SR);
    f.load(slow.p);
    f.transport(true);
    expect(edges(f, 100000).trig).toEqual([0, 47999, 95999]);
    const sw = rig([ON, ON, ON, ON], { swing: 80 });
    const g = new Engine(SR);
    g.load(sw.p);
    g.transport(true);
    expect(edges(g, 24000).trig).toEqual([0, 5999 + 3600, 11999, 17999 + 3600]); // 0.6 of a step late at 80 %
  });

  it('the rates and swing past the old ranges are a stretch: pins and the morph span the old range, stored values keep their meaning (#351)', () => {
    const rate = DEFS.steps.params.find((d) => d.name === 'rate')!, swing = DEFS.steps.params.find((d) => d.name === 'swing')!;
    expect(STEPS_RATES.slice(0, 7)).toEqual(['1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32']); // (appended: indices keep their meaning)
    expect([rate.max, topOf(rate), swing.max, topOf(swing)]).toEqual([6, 8, 75, 80]);
    expect(modulate(swing, 60, 0.5)).toBe(72.5); // half the old span (25 %), as before the stretch
    expect(modulate(swing, 60, 1)).toBe(75);
    expect(modulate(swing, 80, -0.2)).toBe(75);
    expect(modulate(swing, 78, 0.5)).toBe(80); // a base past max is clamped to the stretch, not pulled back to max
    expect(modulate(rate, 8, 0.1)).toBe(8);
    expect(morphValue(rate, 4, 8, 0.6)).toBe(8);
    expect(morphValue(swing, 60, 80, 0.5)).toBe(70);
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
    expect(edges(e, 128).r[0]).toBe(1); // step 0: accented
    edges(e, 12000 - 128); // steps 1, 2 played
    e.noteOn(60, 1);
    const r = edges(e, 6500);
    expect(r.r[6400]).toBe(1); // the step after the reset is step 0 (accented)
  });

  it('a muted track keeps its place but plays no new notes; setTrack changes the notes without a reload', () => {
    const { p, st } = rig([ON]);
    const e = new Engine(SR);
    e.load(p);
    e.setMute(st.id, true);
    e.transport(true);
    expect(edges(e, 13000).trig).toEqual([]);
    expect(e.stepsView()).toEqual([{ id: st.id, pos: 2, mute: true }]);
    e.setMute(st.id, false);
    e.setTrack(st.id, [note(0, 1, 60), note(3, 1, 60)]);
    expect(edges(e, 6000).trig).toEqual([17999 - 13000]);
  });

  it('a chance plays about that often and the same way every time (the hash of the seed, the time round, the step and the note)', () => {
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
    expect(notePlays(1, 2, 3, 0, 100)).toBe(true);
    const plays = (j: number): boolean[] => Array.from({ length: 40 }, (_, loop) => notePlays(7, loop, 3, j, 50));
    expect(plays(0)).not.toEqual(plays(1)); // two notes of a step each ask for themselves
  });

  it('a migrated tied run is one longer note: no new trig, the same pitch, the gate falling gate x step into its last step', () => {
    const TIE = stepByte({ on: false, accent: false, chance: 100, tie: true });
    const { p, st } = rig([ON, TIE, TIE, ON, 0, TIE, ON], { len: 7, gate: 0.5 });
    expect(st.notes).toEqual([note(0, 3, 60), note(3, 1, 60), note(6, 1, 60)]); // (the tie after an off step is dropped)
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    const { trig, l } = edges(e, 42000);
    expect(trig).toEqual([0, 17999, 35999, 41999]); // (41999: step 0 again)
    expect(l[11500]).toBe(1);
    expect(l[14500]).toBe(1);
    expect(l[15500]).toBe(0);
    expect(l[31000]).toBe(0);
  });

  it('a note longer than what is left of the pattern ends at its end; a note past len never plays', () => {
    const { p, st } = rig([], { len: 4, gate: 0.5 });
    st.notes = [note(2, 8, 60), note(5, 1, 72)];
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    const { trig, l } = edges(e, 48000);
    expect(trig).toEqual([11999, 35999]);
    expect(l[11999 + 8999]).toBe(1); // through step 3, half of it
    expect(l[11999 + 9001]).toBe(0);
  });

  it('a chord: one trig, pitch and vel from its last (highest) note; keys out plays every note into a Voice allocator', () => {
    const { p, st } = rig([], { len: 4, gate: 0.5 });
    st.notes = [note(0, 2, 48, 90), note(0, 1, 64, 80), note(0, 1, 67, 70)];
    const al = addModule(p, DEFS.alloc, 0, 0);
    al.params.voices = 4;
    connect(p, DEFS, { module: st.id, port: 'keys' }, { module: al.id, port: 'keys' });
    const out = p.modules.find((m) => m.type === 'output')!;
    p.cables = p.cables.filter((c) => c.to.port !== 'r');
    const mx = addModule(p, DEFS.mixer, 0, 0); // the sum of the voices' gates, a quarter of it (the output clips at 1)
    Object.assign(mx.params, { l1: 0.25, master: 1 });
    connect(p, DEFS, { module: al.id, port: 'gate' }, { module: mx.id, port: 'in1' });
    connect(p, DEFS, { module: mx.id, port: 'out' }, { module: out.id, port: 'r' });
    expect(deviceView(p).groups.map((g) => g.src)).toEqual([st.id]);
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    const { trig, r } = edges(e, 12000);
    expect(trig).toEqual([0]);
    expect(r[64]).toBe(0); // the notes reach the groups at the start of the next block
    expect(r[200]).toBeCloseTo(0.75, 5);
    expect(r[3100]).toBeCloseTo(0.25, 5); // the two short notes end at half a step, the long one holds
    expect(r[9000]).toBeCloseTo(0.25, 5);
    expect(r[9300]).toBe(0); // and ends at half of step 2 (9000; block-quantized: by the block after)
  });

  it('transpose moves the keys out by whole semitones (and pitch as before)', () => {
    const { p, st } = rig([], { len: 1 });
    st.notes = [note(0, 1, 60)];
    const c = addModule(p, DEFS.const, 0, 0);
    c.params.value = 2 / 12;
    connect(p, DEFS, { module: c.id, port: 'out' }, { module: st.id, port: 'transpose' });
    const al = addModule(p, DEFS.alloc, 0, 0);
    connect(p, DEFS, { module: st.id, port: 'keys' }, { module: al.id, port: 'keys' });
    const out = p.modules.find((m) => m.type === 'output')!;
    p.cables = p.cables.filter((c) => c.to.port !== 'r');
    connect(p, DEFS, { module: al.id, port: 'pitch' }, { module: out.id, port: 'r' });
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    expect(edges(e, 1000).r[500]).toBeCloseTo(2 / 12, 4);
  });

  it('armed (#134): the keys go into the track and through to what it plays, not where they go otherwise; disarmed: back', () => {
    const { p, st, main } = rig([], { len: 16 });
    const out = p.modules.find((m) => m.type === 'output')!;
    p.cables = [];
    const kb = addModule(p, DEFS.alloc, 0, 0); // what Main's keys play: its gate on the left
    connect(p, DEFS, { module: main.id, port: 'keys' }, { module: kb.id, port: 'keys' });
    connect(p, DEFS, { module: kb.id, port: 'gate' }, { module: out.id, port: 'l' });
    const al = addModule(p, DEFS.alloc, 0, 0); // what the track plays: its gate on the right
    connect(p, DEFS, { module: st.id, port: 'keys' }, { module: al.id, port: 'keys' });
    connect(p, DEFS, { module: al.id, port: 'gate' }, { module: out.id, port: 'r' });
    const e = new Engine(SR);
    e.load(p);
    const at = (): [number, number] => { const { l, r } = edges(e, 384); return [l[383], r[383]]; };
    e.noteOn(60, 0.8);
    expect(at()).toEqual([1, 0]);
    e.arm(st.id); // the key held goes quiet; its release later goes to the track, which never had it
    expect(at()).toEqual([0, 0]);
    e.noteOff(60);
    e.noteOn(64, 0.8);
    expect(at()).toEqual([0, 1]); // (two blocks: into the track, then out of it)
    e.noteOff(64);
    expect(at()).toEqual([0, 0]);
    e.noteOn(67, 0.5);
    at();
    e.arm(null); // the note played through ends; the keys play Main's instrument again
    expect(at()).toEqual([0, 0]);
    e.noteOff(67);
    e.noteOn(62, 1);
    expect(at()).toEqual([1, 0]);
  });

  it('a cable from Main\'s keys into keys in: the keys pass through while no track is armed (#138)', () => {
    const { p, st, main } = rig([], { len: 16 });
    const out = p.modules.find((m) => m.type === 'output')!;
    p.cables = [];
    connect(p, DEFS, { module: main.id, port: 'keys' }, { module: st.id, port: 'keys' });
    const al = addModule(p, DEFS.alloc, 0, 0);
    connect(p, DEFS, { module: st.id, port: 'keys' }, { module: al.id, port: 'keys' });
    connect(p, DEFS, { module: al.id, port: 'gate' }, { module: out.id, port: 'l' });
    const other = addModule(p, DEFS.steps, 0, 0);
    const e = new Engine(SR);
    e.load(p);
    const at = (): number => edges(e, 384).l[383];
    e.noteOn(60, 1);
    expect(at()).toBe(1);
    e.noteOff(60);
    expect(at()).toBe(0);
    e.arm(other.id); // another track armed: the keys go there
    e.noteOn(62, 1);
    expect(at()).toBe(0);
  });

  it('the FM-1\'s form keeps that cable (the C engine reads it as "fed"), and no other keys cable', () => {
    const { p, st, main } = rig([], { len: 16 });
    p.cables = [];
    connect(p, DEFS, { module: main.id, port: 'keys' }, { module: st.id, port: 'keys' });
    const al = addModule(p, DEFS.alloc, 0, 0);
    connect(p, DEFS, { module: st.id, port: 'keys' }, { module: al.id, port: 'keys' });
    const d = deviceView(p, true).patch;
    expect(d.cables.filter((c) => c.to.port === 'keys')).toEqual([{ from: { module: main.id, port: 'keys' }, to: { module: st.id, port: 'keys' } }]);
    expect(() => encodePatch(p)).not.toThrow();
  });

  it('armed: a played note is transposed as the track\'s notes, sets the mono outputs and holds until let go; muted too', () => {
    const { p, st } = rig([], { len: 16, gate: 0.01 });
    const c = addModule(p, DEFS.const, 0, 0);
    c.params.value = 1;
    connect(p, DEFS, { module: c.id, port: 'out' }, { module: st.id, port: 'transpose' });
    const al = addModule(p, DEFS.alloc, 0, 0);
    connect(p, DEFS, { module: st.id, port: 'keys' }, { module: al.id, port: 'keys' });
    const out = p.modules.find((m) => m.type === 'output')!;
    p.cables = p.cables.filter((x) => x.to.port !== 'r');
    const mx = addModule(p, DEFS.mixer, 0, 0); // the allocator's pitch, a quarter of it (the output clips at 1)
    Object.assign(mx.params, { l1: 0.25, master: 1 });
    connect(p, DEFS, { module: al.id, port: 'pitch' }, { module: mx.id, port: 'in1' });
    connect(p, DEFS, { module: mx.id, port: 'out' }, { module: out.id, port: 'r' });
    const e = new Engine(SR);
    e.load(p);
    e.setMute(st.id, true);
    e.arm(st.id);
    e.noteOn(62, 100 / 127);
    const { l, r } = edges(e, 20000); // long after any step's gate: still held
    expect(l[100]).toBe(1);
    expect(l[19999]).toBe(1);
    expect(r[19999]).toBeCloseTo((14 / 12) / 4, 4); // D4 an octave up: the allocator's pitch
    e.noteOff(62);
    expect(edges(e, 200).l[199]).toBe(0);
  });

  it('REC running (#135): a played note lands on the nearest step and lasts the whole steps it was held, at least one', () => {
    const { p, st } = rig([], { len: 16 });
    const e = new Engine(SR);
    e.load(p);
    e.arm(st.id);
    e.setRec(st.id, true);
    e.transport(true);
    const run = (n: number): void => void edges(e, n);
    run(2 * 6000 + 1792); // step 2, under a third in
    e.noteOn(64, 90 / 127);
    run(15360); // 2.56 steps held
    e.noteOff(64);
    run(128);
    run(6 * 6000 + 4096 - (2 * 6000 + 1792 + 15360 + 128)); // step 6, two thirds in: the nearest step is 7
    e.noteOn(67, 1);
    run(1024); // a sixth of a step: still one step long
    e.noteOff(67);
    run(128);
    expect(e.takeRecorded()).toEqual([
      { id: st.id, loop: 1, note: { at: 2, len: 3, note: 64, vel: 90 } },
      { id: st.id, loop: 1, note: { at: 7, len: 1, note: 67, vel: 127 } },
    ]);
    expect(e.takeRecorded()).toEqual([]);
    e.transport(false);
    run(256);
    e.noteOn(60, 1); // stopped: nothing recorded (the editor's step entry takes it)
    run(256);
    e.noteOff(60);
    run(256);
    expect(e.takeRecorded()).toEqual([]);
  });

  it('Drum map (#137): a row\'s gate while its note sounds, its velocity; a restart gets a low sample; Main\'s keys and an armed track reach it', () => {
    const { p, st, main } = rig([], { len: 4, gate: 1 });
    st.notes = [note(0, 1, 36, 127), note(1, 1, 36, 64), note(2, 1, 38)];
    const out = p.modules.find((m) => m.type === 'output')!;
    p.cables = [];
    const dm = addModule(p, DEFS.drummap, 0, 0);
    connect(p, DEFS, { module: st.id, port: 'keys' }, { module: dm.id, port: 'keys' });
    connect(p, DEFS, { module: dm.id, port: 'g1' }, { module: out.id, port: 'l' });
    connect(p, DEFS, { module: dm.id, port: 'v1' }, { module: out.id, port: 'r' });
    expect(DEFS.drummap.params.map((pd) => pd.default)).toEqual([36, 38, 39, 42, 46, 45, 37, 56, 0]); // (repeat off)
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    const { trig, l, r } = edges(e, 18000);
    expect(trig).toEqual([128, 6017]); // (the keys arrive at the next block: 128, 6016)
    expect(l[6016]).toBe(0); // the second kick restarts the row: one low sample (an off and an on in one block)
    expect(r[3000]).toBe(1);
    expect(r[9000]).toBeCloseTo(64 / 127, 6);
    expect(l[13000]).toBe(0); // the snare's step: the kick row is down
    // Main's keys into a second map; an armed track takes them instead, and its keys out plays its own map
    const dk = addModule(p, DEFS.drummap, 0, 0);
    dk.params.n1 = 60;
    connect(p, DEFS, { module: main.id, port: 'keys' }, { module: dk.id, port: 'keys' });
    p.cables = p.cables.filter((c) => c.to.port !== 'l');
    connect(p, DEFS, { module: dk.id, port: 'g1' }, { module: out.id, port: 'l' });
    const e2 = new Engine(SR);
    e2.load(p);
    e2.noteOn(60, 1);
    expect(edges(e2, 256).l[255]).toBe(1);
    e2.noteOff(60);
    expect(edges(e2, 256).l[255]).toBe(0);
    e2.arm(st.id);
    e2.noteOn(36, 0.5);
    const a = edges(e2, 512);
    expect(a.l[511]).toBe(0); // (Main's map: nothing, the keys go to the track)
    expect(a.r[511]).toBeCloseTo(64 / 127, 6); // the track's map: the kick row at the played velocity
  });

  it('Drum map repeat (#184): white-key rows repeat every eight white keys, a black key plays the row below; other rows every span of semitones', () => {
    const white = [53, 55, 57, 59, 60, 62, 64, 65]; // F3..F4, the drum kits' rows
    expect(drumRowsOf(white, 53)).toBe(1); // F3: row 1
    expect(drumRowsOf(white, 65)).toBe(1 << 7); // F4: row 8
    expect(drumRowsOf(white, 67)).toBe(1); // G4: the next block starts
    expect(drumRowsOf(white, 52)).toBe(1 << 7); // E3: the block below ends on row 8
    expect(drumRowsOf(white, 40)).toBe(1); // E2 (8 Lire's lowest block)
    expect(drumRowsOf(white, 81)).toBe(1); // A5 (its highest)
    expect(drumRowsOf(white, 54)).toBe(1); // F#3: the white key below
    expect(drumRowsOf(white, 66)).toBe(1 << 7); // F#4
    for (let k = 0; k < 128; k++) expect(drumRowsOf(white, k), `key ${k}`).not.toBe(0); // every key plays
    const gm = DRUM_MAP_DEFAULT.map((d) => d.note); // 36..56, not all white: blocks of 21 semitones
    expect(drumRowsOf(gm, 36)).toBe(1);
    expect(drumRowsOf(gm, 57)).toBe(1);
    expect(drumRowsOf(gm, 15)).toBe(1);
    expect(drumRowsOf(gm, 41)).toBe(0); // (no row on F2 in the block)
    expect(drumRowsOf([60, 60, 62, 62, 64, 64, 65, 65], 72)).toBe(0b11000000); // (rows on one key play together: C5 is F4 a block up)
  });

  it('Drum map repeat: a row held by one key is neither restarted nor let go by another; off, only the rows\' own keys', () => {
    const p = emptyPatch('repeat');
    const main = addModule(p, DEFS.fm1, 0, 0);
    const dm = addModule(p, DEFS.drummap, 0, 0);
    Object.assign(dm.params, { n1: 53, n2: 55, n3: 57, n4: 59, n5: 60, n6: 62, n7: 64, n8: 65, repeat: 1 });
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    connect(p, DEFS, { module: main.id, port: 'keys' }, { module: dm.id, port: 'keys' });
    connect(p, DEFS, { module: dm.id, port: 'g1' }, { module: out.id, port: 'l' });
    connect(p, DEFS, { module: dm.id, port: 'v1' }, { module: out.id, port: 'r' });
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(67, 1); // G4: row 1
    expect(edges(e, 256).l[255]).toBe(1);
    e.noteOn(53, 0.5); // F3: row 1 again, held up already
    const b = edges(e, 256);
    expect(b.l[0]).toBe(1); // (no restart)
    expect(b.r[255]).toBe(1); // (the first key's velocity)
    e.noteOff(67);
    expect(edges(e, 256).l[255]).toBe(1); // F3 still holds it
    e.noteOff(53);
    expect(edges(e, 256).l[255]).toBe(0);
    e.noteOn(54, 0.5); // F#3: the row of F3
    expect(edges(e, 256).r[255]).toBeCloseTo(64 / 127, 6);
    e.allNotesOff();
    edges(e, 256);
    dm.params.repeat = 0;
    const e2 = new Engine(SR);
    e2.load(p);
    e2.noteOn(67, 1);
    expect(edges(e2, 256).l[255]).toBe(0); // off: G4 plays nothing
    e2.noteOn(53, 1);
    expect(edges(e2, 256).l[255]).toBe(1);
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

  it('the name goes into its record, the notes into the notes section; old patches lose cables from the SEQ / REC buttons and acc', () => {
    const { p, st } = rig([ACC, 0, ON]);
    st.name = 'kick drum!';
    const v = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(v.modules[1].name).toBe('KICK DRU');
    const bin = encodePatch(v);
    expect(bin[6] & FLAG_NOTES).toBeTruthy();
    // the track's record ends in its name; the notes section follows the records and cables (a device pages section after it)
    const data = [...bin.keys()].find((i) => String.fromCharCode(...bin.slice(i, i + 8)) === 'KICK DRU')!;
    const rec = data - recordSize('steps') + 8;
    const notes = rec + recordSize('steps') + recordSize('output') + 4 * v.cables.length + 1;
    expect([...bin.slice(notes - 1, notes + 2)]).toEqual([1, 1, 2]);
    const w = new DataView(bin.buffer).getUint32(notes + 2, true);
    expect(w).toBe(noteWord(note(0, 1, 60, 127)));
    const old = JSON.parse(JSON.stringify(p));
    old.cables.push({ from: { module: old.modules[0].id, port: 'rec' }, to: { module: st.id, port: 'reset' } });
    old.cables.push({ from: { module: st.id, port: 'acc' }, to: { module: old.modules[2].id, port: 'r' } });
    expect(validatePatch(old, DEFS).cables.length).toBe(2);
  });

  it('a patch saved before #133 loads with notes: its step bytes and lanes become notes', () => {
    const { p, st } = rig([]);
    const old = JSON.parse(JSON.stringify(p));
    const o = old.modules.find((m: ModuleInst) => m.id === st.id);
    delete o.notes;
    o.steps = [ACC, 0, ON, stepByte({ on: false, accent: false, chance: 100, tie: true }), stepByte({ on: true, accent: false, chance: 35 })];
    o.notes = Array.from({ length: 64 }, (_, k) => 50 + k);
    o.vels = Array.from({ length: 64 }, () => 90);
    const v = validatePatch(old, DEFS).modules.find((m) => m.id === st.id)!;
    expect(v.notes).toEqual([note(0, 1, 50, 127), note(2, 2, 52, 90), note(4, 1, 54, 90, 35)]);
    expect(v).not.toHaveProperty('steps');
    expect(v).not.toHaveProperty('vels');
  });

  it('the FM-1 takes 16 tracks and 1536 notes, every pattern counted', () => {
    const { p } = rig([ON]);
    for (let i = 0; i < 16; i++) addModule(p, DEFS.steps, 0, 0);
    expect(deviceBudget(p).over.map((o) => o.key)).toContain('tracks');
    const q = rig([]).p;
    const full = (): StepNote[] => Array.from({ length: 128 }, (_, k) => note(k >> 1, 1, 40 + (k & 1)));
    for (let i = 0; i < 2; i++) Object.assign(addModule(q, DEFS.steps, 0, 0), { notes: full(), patterns: Array.from({ length: 6 }, () => ({ notes: full() })) });
    expect(deviceBudget(q).items.find((x) => x.key === 'notes')!.used).toBe(2 * 7 * 128);
    expect(deviceBudget(q).over.map((o) => o.key)).toContain('notes');
  });
});
