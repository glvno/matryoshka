// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import SOURCE from '../factory/bank.json';
import { Engine } from './engine';
import { sharedCassiaContours } from './factory-cassia-sharing';
import { DEFS, ENV8_HOLD } from './modules';
import { validatePatch, type Patch } from './patch';

const contours = [20, 40, 27, 29];
const source = (): Patch => validatePatch(structuredClone(SOURCE.find(s => s.name === 'Cassia 1')!.patch), DEFS);
const params = (p: Patch, id: number) => p.modules.find(m => m.id === id)!.params;

function rig(p: Patch, compile: boolean) {
  const e = new Engine(44118);
  e.load(p, compile);
  // Whole blocks keep the probes aligned with the last rendered audio block.
  const render = (seconds: number) => {
    const l = new Float32Array(Math.ceil(seconds * 44118 / 128) * 128);
    const r = new Float32Array(l.length);
    e.render(l, r);
    return { l, r };
  };
  return { e, render };
}

const peak = (samples: Float32Array): number => samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
const sounding = (e: Engine, id: number): number => e.probeVoices(id, 'out')!.filter(v => peak(v) > 0.0001).length;

it.each([false, true])('Cassia joins a shared phrase but releases each DCA independently (device compile=%s)', compile => {
  const p = sharedCassiaContours(source());
  for (const [i, id] of contours.entries()) {
    Object.assign(params(p, id), { l1: 1 - i * 0.1, r1: 0.005, l2: 0.2 + i * 0.05, r2: 0.3, l3: 0, r3: 0.3, sus: 2, end: 3 });
  }
  for (const id of [28, 30]) Object.assign(params(p, id), { l1: 1, r1: 0.005, l2: 0, r2: 0.05, sus: 1, end: 2 });
  const { e, render } = rig(p, compile);
  render(0.03);
  for (const id of [35, 36]) expect(sounding(e, id)).toBe(0);
  e.noteOn(60, 0.8);
  render(0.08);
  const before = contours.map(id => e.envStates(id)![0].v);
  e.noteOn(64, 0.6);
  render(0.01);
  for (const [i, id] of contours.entries()) {
    // A new per-note attack would turn this descending segment upward.
    expect(e.envStates(id)![0].stage).toBe(2);
    expect(e.envStates(id)![0].v).toBeLessThan(before[i]);
  }
  for (const id of [35, 36]) expect(sounding(e, id)).toBe(2);
  e.noteOff(64);
  render(0.01);
  const released = e.voiceNotes().findIndex(v => v.note === 64);
  for (const id of contours) expect(e.envStates(id)![0].stage).toBe(2);
  for (const id of [28, 30]) {
    expect(e.envStates(id)![released].stage).toBe(2);
    expect(e.envStates(id)![released].v).toBeGreaterThan(0);
  }
  for (const id of [35, 36]) expect(peak(e.probeVoices(id, 'out')![released])).toBeGreaterThan(0.0001);
  render(0.09);
  for (const id of contours) expect(e.envStates(id)![0].stage).toBe(2);
  for (const id of [35, 36]) {
    expect(sounding(e, id)).toBe(1);
    const audio = e.probeVoices(id, 'out')!;
    // This includes the released voice and both never-allocated voices, while
    // shared pitch/brightness contours are still open for the held note.
    e.voiceNotes().forEach((note, v) => { if (!note.on) expect(peak(audio[v])).toBe(0); });
  }
  e.noteOff(60);
  render(0.01);
  for (const id of contours) {
    expect(e.envStates(id)![0].stage).toBe(3);
    expect(e.envStates(id)![0].v).toBeGreaterThan(0);
  }
  const tail = render(0.6);
  expect(peak(tail.l.slice(-128))).toBeLessThan(0.00001);
  expect(peak(tail.r.slice(-128))).toBeLessThan(0.00001);
});

it.each([false, true])('Cassia retains all line/wave/ring/noise modes and per-note touch during live mode changes (device compile=%s)', compile => {
  const original = source();
  // Different lines, both wave slots, resonance ranges, contour shapes, local
  // DCA levels and touch make accidental 1+1 copying or global modulation audible.
  for (const [i, id] of contours.entries()) {
    Object.assign(params(original, id), { l1: 0.3 + i * 0.15, r1: 0.005, l2: 0.2 + i * 0.1, r2: 0.01, l3: 0, r3: 0.05, sus: 2, end: 3 });
  }
  Object.assign(params(original, 28), { l1: 0.9, r1: 0.005, l2: 0.7, r2: 0.01, l3: 0, r3: 0.05, sus: 2, end: 3 });
  Object.assign(params(original, 30), { l1: 0.6, r1: 0.005, l2: 0.4, r2: 0.01, l3: 0, r3: 0.05, sus: 2, end: 3 });
  params(original, 13).value = 2;
  params(original, 16).value = 5;
  params(original, 34).fine = 7;
  for (const [i, id] of [26, 47, 43, 44].entries()) params(original, id).gain = 0.03 + i * 0.02;
  params(original, 51).gain = 0.7;
  params(original, 52).gain = 0.4;
  const reference = rig(original, compile);
  const shared = rig(sharedCassiaContours(original), compile);
  for (const { e } of [reference, shared]) {
    // Simultaneous notes are the equality boundary: phrase and per-note time
    // contours agree, but velocity/key-follow and ring products must not mix.
    e.noteOn(48, 0.35);
    e.noteOn(65, 0.9);
  }
  reference.render(0.08);
  shared.render(0.08);
  for (const id of [28, 30]) expect(shared.e.envStates(id)!.filter(s => s.stage === ENV8_HOLD)).toHaveLength(2);
  for (let wave = 1; wave <= 8; wave++) {
    for (const line of [1, 2, 3, 4]) {
      for (const mod of [1, 2, 3]) {
        for (const { e } of [reference, shared]) {
          e.setParam(11, 'pos', wave);
          e.setParam(12, 'pos', 9 - wave);
          e.setParam(14, 'pos', 9 - wave);
          e.setParam(15, 'pos', wave);
          e.setParam(10, 'pos', line);
          e.setParam(38, 'pos', mod);
        }
        const expected = reference.render(0.015);
        const actual = shared.render(0.015);
        const label = `wave=${wave}, line=${line}, mod=${mod}`;
        // Compare settled audible blocks, not cable lists: g3 crosses the
        // summing boundary, including feedback scheduling on a live switch.
        for (const channel of ['l', 'r'] as const) {
          const want = expected[channel].slice(-128);
          const got = actual[channel].slice(-128);
          expect(peak(got), label).toBeGreaterThan(0.00001);
          expect(Math.max(...got.map((sample, i) => Math.abs(sample - want[i]))), label).toBeLessThan(0.00001);
        }
      }
    }
  }
});
