// SPDX-License-Identifier: GPL-3.0-only
// P-locks (#524): the model (track.ts), the binary (patchbin.ts lockRecord, locks.ts lockPlan) and the playing (engine.ts
// locksStep). engine.c plays the same: golden kits steps-locks, steps-locks-poly.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type ModuleInst, type Patch } from './patch';
import { deviceBudget, encodePatch, FLAG_LOCKS, FORMAT_1_9, formatOf, lockRecord, WRITE_FLOOR } from './patchbin';
import { lockPlan } from './locks';
import { deviceView } from './poly';
import { fixLocks, fixPatterns, LOCKS_MAX, locksAt, setLock, type StepLock } from './track';

const SR = 48000; // 120 bpm: a 1/16 step every 6000 samples
const STEP = 6000;

/** Main (120 bpm) -> a Steps track (pitch to the right output); an Offset whose value goes to the left output */
function rig(): { p: Patch; st: ModuleInst; k: ModuleInst } {
  const p = emptyPatch('locks');
  const main = addModule(p, DEFS.fm1, 0, 0);
  main.params.tempo = 120;
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  const st = addModule(p, DEFS.steps, 0, 0);
  Object.assign(st.params, { len: 4, gate: 1 });
  st.notes = [0, 1, 2, 3].map((at) => ({ at, len: 1, note: 60, vel: 100 }));
  const k = addModule(p, DEFS.const, 0, 0);
  k.params.value = 0.5;
  connect(p, DEFS, { module: st.id, port: 'pitch' }, { module: out.id, port: 'r' });
  connect(p, DEFS, { module: k.id, port: 'out' }, { module: out.id, port: 'l' });
  return { p, st, k };
}

/** the left output mid-step, `n` steps from now */
function steps(e: Engine, n: number): number[] {
  const l = new Float32Array(n * STEP), r = new Float32Array(n * STEP);
  e.render(l, r);
  return Array.from({ length: n }, (_, k) => Math.round(l[k * STEP + STEP / 2] * 100) / 100);
}
const lock = (at: number, module: number, param: string, value: number): StepLock => ({ at, module, param, value });

describe('P-locks: the model', () => {
  it('locks come out valid, sorted, one per step and row, at most LOCKS_MAX', () => {
    expect(fixLocks([lock(3, 2, 'b', 1), lock(1, 2, 'a', 0.5), { at: 64, module: 1, param: 'x', value: 0 }, { at: 1, module: 2, param: 'a', value: 0.7 }, 'x', { at: 0, module: 1, param: '', value: 1 }]))
      .toEqual([lock(1, 2, 'a', 0.7), lock(3, 2, 'b', 1)]);
    expect(fixLocks([])).toBeUndefined();
    expect(fixLocks(Array.from({ length: 80 }, (_, i) => lock(i % 64, i, 'value', 0)))!.length).toBe(LOCKS_MAX);
    expect(fixPatterns([{ locks: [lock(0, 1, 'value', 1)] }])).toEqual([{ locks: [lock(0, 1, 'value', 1)] }]);
  });

  it('setLock adds, changes and removes a step\'s lock on a row', () => {
    let l = setLock(undefined, 2, 5, 'cutoff', 300);
    l = setLock(l, 0, 5, 'res', 0.5);
    l = setLock(l, 2, 5, 'cutoff', 400);
    expect(l).toEqual([lock(0, 5, 'res', 0.5), lock(2, 5, 'cutoff', 400)]);
    expect(locksAt(l, 2)).toEqual([lock(2, 5, 'cutoff', 400)]);
    expect(setLock(setLock(l, 0, 5, 'res', null), 2, 5, 'cutoff', null)).toBeUndefined();
  });

  it('validatePatch keeps a track\'s locks and drops them elsewhere', () => {
    const { p, st, k } = rig();
    st.locks = [lock(1, k.id, 'value', 2)];
    (k as ModuleInst & { locks?: StepLock[] }).locks = [lock(1, k.id, 'value', 2)];
    const v = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(v.modules.find((m) => m.id === st.id)!.locks).toEqual([lock(1, k.id, 'value', 2)]);
    expect(v.modules.find((m) => m.id === k.id)!.locks).toBeUndefined();
  });
});

describe('P-locks: the binary', () => {
  it('a patch without locks keeps its format; one with locks is format 49 with the locks section', () => {
    const { p, st, k } = rig();
    expect(formatOf(p)).toBe(WRITE_FLOOR);
    expect(lockRecord(p, deviceView(p, true).patch)).toEqual([]);
    st.locks = [lock(1, k.id, 'value', 2), lock(3, k.id, 'value', -1.5)];
    const bin = encodePatch(p);
    expect(bin[1]).toBe(FORMAT_1_9);
    expect(new DataView(bin.buffer).getUint16(6, true) & FLAG_LOCKS).toBe(FLAG_LOCKS);
    const dev = deviceView(p, true).patch;
    const ti = dev.modules.findIndex((m) => m.id === st.id), ki = dev.modules.findIndex((m) => m.id === k.id);
    // one track: its module, one row (the Offset's value), pattern 0 with two locks of 6 bytes
    expect(lockRecord(p, dev)).toEqual([1, ti, 1, 1, ki, 0, 1, 0, 2, 1, 0, 0, 0, 2, 0, 3, 0, 0, 0x80, 0xfe, 0xff]);
    expect(deviceBudget(p).items.find((i) => i.key === 'locks')!.used).toBe(2);
  });

  it('a lock on a module that is gone, or on an allocator setting, does not play; values are clamped to the range', () => {
    const { p, st, k } = rig();
    const al = addModule(p, DEFS.alloc, 0, 0);
    st.locks = [lock(0, 999, 'value', 1), lock(1, al.id, 'voices', 2), lock(2, k.id, 'value', 99)];
    const plan = lockPlan(p, deviceView(p, true).patch);
    expect(plan.length).toBe(1);
    expect(plan[0].rows.length).toBe(1);
    expect(plan[0].pats).toEqual([{ p: 0, locks: [{ at: 2, row: 0, value: 4 }] }]);
  });

  it('64 locks on each of a few patterns fit the FM-1\'s bytes; the budget counts them', () => {
    const { p, st, k } = rig();
    const full = Array.from({ length: LOCKS_MAX }, (_, i) => lock(i, k.id, 'value', (i % 8) / 4));
    st.locks = full;
    const one = encodePatch(p).length;
    st.patterns = [{ locks: full }, { locks: full }];
    const three = encodePatch(p).length;
    expect(three - one).toBeGreaterThanOrEqual(2 * 6 * LOCKS_MAX);
    expect(deviceBudget(p).items.find((i) => i.key === 'locks')!.used).toBe(3 * LOCKS_MAX);
  });
});

describe('P-locks: the engine', () => {
  it('a locked step plays its lock, the next step the normal value; stop lets go', () => {
    const { p, st, k } = rig();
    st.locks = [lock(1, k.id, 'value', 0.9), lock(3, k.id, 'value', -0.7)];
    const e = new Engine(SR);
    e.load(p);
    expect(steps(e, 2)).toEqual([0.5, 0.5]);
    e.transport(true);
    expect(steps(e, 8)).toEqual([0.5, 0.9, 0.5, -0.7, 0.5, 0.9, 0.5, -0.7]);
    e.transport(false);
    expect(steps(e, 2)).toEqual([0.5, 0.5]);
  });

  it('a knob move while a step is locked changes the normal value only', () => {
    const { p, st, k } = rig();
    st.locks = [lock(1, k.id, 'value', 0.9)];
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    expect(steps(e, 2)).toEqual([0.5, 0.9]);
    e.setParam(k.id, 'value', 1);
    expect(steps(e, 4)).toEqual([1, 1, 1, 0.9]);
  });

  it('each pattern plays its own locks; a pattern the track has not got plays pattern 1\'s', () => {
    const { p, st, k } = rig();
    st.locks = [lock(1, k.id, 'value', 0.9)];
    st.patterns = [{ notes: st.notes, locks: [lock(2, k.id, 'value', 0.8)] }];
    const e = new Engine(SR);
    e.load(p);
    e.transport(true);
    expect(steps(e, 4)).toEqual([0.5, 0.9, 0.5, 0.5]);
    e.transport(false);
    e.setPattern(1);
    expect(steps(e, 1)).toEqual([0.5]); // (stopped: it plays at once, from the next block)
    e.transport(true);
    expect(steps(e, 4)).toEqual([0.5, 0.5, 0.8, 0.5]);
    e.transport(false);
    e.setPattern(5);
    expect(steps(e, 1)).toEqual([0.5]);
    e.transport(true);
    expect(steps(e, 4)).toEqual([0.5, 0.9, 0.5, 0.5]);
  });
});
