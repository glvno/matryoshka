// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch } from './patch';

const SR = 48000, STEP = 6000;
function rig(dir: number, len = 4, swing = 50) {
  const p = emptyPatch('directions'), main = addModule(p, DEFS.fm1, 0, 0), st = addModule(p, DEFS.steps, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  Object.assign(st.params, { dir, len, swing, gate: 0.25 });
  st.notes = Array.from({ length: len }, (_, at) => ({ at, len: 1, note: 60 + at, vel: 20 + (at % 10) * 10 }));
  out.params.level = 1;
  connect(p, DEFS, { module: st.id, port: 'trig' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: st.id, port: 'vel' }, { module: out.id, port: 'r' });
  const e = new Engine(SR); e.load(p); e.transport(true);
  return { e, p, st, main };
}
function play(e: Engine, frames: number) {
  const l = new Float32Array(frames), r = new Float32Array(frames); e.render(l, r);
  const edges = [...l.keys()].filter(i => l[i] > 0.5 && (i === 0 || l[i - 1] <= 0.5));
  return { at: edges, steps: edges.map(i => Math.round((r[i] * 127 - 20) / 10) || 0), l };
}
it('backward starts at the last step and visits every step before wrapping', () => {
  expect(play(rig(1).e, STEP * 8 - 1).steps).toEqual([3, 2, 1, 0, 3, 2, 1, 0]);
});

it('ping-pong turns at each end without repeating either endpoint', () => {
  expect(play(rig(2).e, STEP * 13 - 1).steps).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0]);
});
it('random visits stay in the pattern and repeat deterministically after a reload', () => {
  const run = () => play(rig(3).e, STEP * 20 - 1).steps;
  const a = run();
  expect(a).toEqual(run());
  expect(a).toHaveLength(20);
  expect(a.every(k => k >= 0 && k < 4)).toBe(true);
  expect(new Set(a).size).toBeGreaterThan(2);
  expect(a.slice(0, 4)).not.toEqual(a.slice(4, 8));
  expect(a).not.toEqual(play(rig(0).e, STEP * 20 - 1).steps);
});
it('backward note lengths count visited steps and stop at the end of the traversal', () => {
  const { e, st } = rig(1);
  e.setTrack(st.id, [{ at: 3, len: 2, note: 63, vel: 50 }]);
  const { l } = play(e, STEP * 4 - 1);
  expect(l[STEP]).toBe(1);
  expect(l[STEP + STEP / 4 + 2]).toBe(0);
});
it.each([[1, 0], [2, 3], [3, 0]])('recording in mode %i rounds ahead to the next visited step', (dir, phase) => {
  const { e, st } = rig(dir); e.arm(st.id); e.setRec(st.id, true);
  play(e, phase * STEP + 4096);
  e.noteOn(80, 1); play(e, 256); e.noteOff(80); play(e, 128);
  const recorded = e.takeRecorded();
  play(e, STEP - 4096 - 256 - 128 + 256);
  expect(recorded).toHaveLength(1);
  expect(recorded[0].note.at).toBe(e.stepsView()[0].pos);
});
it('a reverse take starting on step 64 keeps its held duration after saving', () => {
  const { e, st } = rig(1, 64); e.arm(st.id); e.setRec(st.id, true);
  play(e, 128); e.noteOn(90, 1); play(e, STEP * 3); e.noteOff(90); play(e, 128);
  const recorded = e.takeRecorded();
  expect(recorded[0].note).toMatchObject({ at: 63, len: 3 });
  const p = rig(1, 64).p;
  p.modules.find(m => m.id === st.id)!.notes = [recorded[0].note];
  const saved = validatePatch(p, DEFS);
  expect(saved.modules.find(m => m.id === st.id)!.notes![0]).toMatchObject({ at: 63, len: 3 });
});
it.each([0, 1, 2, 3])('mode %i handles one-step patterns and resets swing at each pass', dir => {
  const single = play(rig(dir, 1, 75).e, STEP * 5 - 1);
  expect(single.steps).toEqual([0, 0, 0, 0, 0]);
  expect(single.at).toEqual([0, 5999, 11999, 17999, 23999]);
});
it.each([1, 2, 3])('mode %i swings the second visit, regardless of the selected step', dir => {
  expect(play(rig(dir, 4, 75).e, STEP * 4 - 1).at).toEqual([0, 8999, 11999, 20999]);
});
it('two-step ping-pong alternates, and a stopped reverse track restarts from the end', () => {
  expect(play(rig(2, 2).e, STEP * 6 - 1).steps).toEqual([0, 1, 0, 1, 0, 1]);
  const { e } = rig(1); play(e, STEP * 2); e.transport(false); play(e, STEP);
  e.transport(true); expect(play(e, STEP - 1).steps).toEqual([3]);
});
it('changing direction and shortening a pattern takes effect at the next step', () => {
  const { e, st } = rig(0); play(e, STEP * 2 - 1);
  e.setParam(st.id, 'dir', 1); e.setParam(st.id, 'len', 2);
  expect(play(e, STEP * 4).steps).toEqual([1, 0, 1, 0]);
});

it('shortening a swung reverse pattern cancels a queued step outside its length', () => {
  const { e, st } = rig(1, 4, 75); play(e, 7000);
  e.setParam(st.id, 'len', 2);
  const next = play(e, 6000);
  expect(next.at).toEqual([4999]);
  expect(next.steps).toEqual([1]);
});
it('shortening a pass releases its old notes at the new pass boundary', () => {
  const { e, st } = rig(1, 64);
  e.setTrack(st.id, [{ at: 63, len: 64, note: 63, vel: 50 }]);
  play(e, 1000); e.setParam(st.id, 'len', 2);
  const { l } = play(e, 24000);
  expect(l[4000]).toBe(1);
  expect(l[12000]).toBe(0);
  expect(l[23999]).toBe(0);
});
it('forward keeps an older note sounding across a shortened pass, as before play modes', () => {
  const { e, st } = rig(0, 16);
  e.setTrack(st.id, [{ at: 0, len: 8, note: 60, vel: 50 }]);
  play(e, 1000); e.setParam(st.id, 'len', 2);
  const { l } = play(e, 24000);
  expect(l[12000]).toBe(1);
});
