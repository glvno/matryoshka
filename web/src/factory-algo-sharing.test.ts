// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import SOURCE from '../factory/bank.json';
import { Engine } from './engine';
import { sharedAlgoContours } from './factory-algo-sharing';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';

const MODES = ['4', '3+4'] as const;
const ALGORITHMS = [1, 2, 3, 4, 5, 6, 7, 8];
const peak = (samples: Float32Array): number => samples.reduce((v, sample) => Math.max(v, Math.abs(sample)), 0);

function rig(operators: '4' | '3+4', algorithm = 8, setup?: (p: Patch) => void) {
  const source = validatePatch(structuredClone(SOURCE.find(s => s.name === 'Algo Four')!.patch), DEFS);
  const p = sharedAlgoContours(source, operators);
  const module = (id: number) => p.modules.find(m => m.id === id)!;
  module(19).params.pos = algorithm;
  for (const id of [4, 12]) Object.assign(module(id).params, {
    l1: 1, r1: 0.002, l2: 0.8, r2: 0.002, l3: 0.8, r3: 0.002, l4: 0, r4: 0.04, shot: 0,
  });
  for (const id of [8, 16]) Object.assign(module(id).params, { a: 0.002, d: 0.002, s: 0.8, r: 0.04, long: 0 });
  // Deliberately longer than operator 1: shared release must not leak old pitches.
  module(16).params.r = 4;
  if (operators === '3+4') module(12).params.r4 = 4;
  setup?.(p);
  const e = new Engine(44118);
  e.load(p);
  const render = (seconds: number) => {
    const l = new Float32Array(Math.ceil(44118 * seconds));
    const r = new Float32Array(l.length);
    e.render(l, r);
    return { l, r };
  };
  const voice = p.assemblies!.find(a => a.poly)!;
  const heard = (op: number) => e.probeVoices(voice.outputs.find(o => o.label === `op ${op}`)!.module, 'out')!;
  return { p, e, render, heard };
}

for (const operators of MODES) {
  it.each(ALGORITHMS)(`shared Op ${operators}, algorithm %i: only eligible carriers sound, including during long shared releases`, algorithm => {
    const { e, render, heard } = rig(operators, algorithm);
    const carriers = [1, ...(algorithm >= 6 ? [2] : []), ...(algorithm >= 5 ? [3] : []), ...(algorithm === 8 ? [4] : [])];
    const sounding = (op: number) => heard(op).filter(samples => peak(samples) > 0.001).length;
    render(0.02);
    for (const op of [1, 2, 3, 4]) expect(sounding(op)).toBe(0);
    e.noteOn(60); render(0.06);
    for (const op of [1, 2, 3, 4]) expect(sounding(op)).toBe(carriers.includes(op) ? 1 : 0);
    e.noteOn(64); render(0.04);
    for (const op of carriers) expect(sounding(op)).toBe(2);
    e.noteOff(64); render(0.005);
    const released = e.voiceNotes().findIndex(v => v.note === 64);
    // Guards preserve the local release rather than hard-cutting the note-off.
    for (const op of carriers) expect(peak(heard(op)[released])).toBeGreaterThan(0.001);
    render(0.1);
    for (const op of [1, 2, 3, 4]) expect(sounding(op)).toBe(carriers.includes(op) ? 1 : 0);

    const chord = [60, 64, 67, 69, 72, 74, 76, 79];
    for (const note of chord.slice(1)) e.noteOn(note);
    render(0.06);
    for (const op of carriers) expect(sounding(op)).toBe(8);
    for (const note of chord) e.noteOff(note);
    const tail = render(0.15);
    expect(e.envStates(16)![0].v).toBeGreaterThan(0.5);
    if (operators === '3+4') expect(e.envStates(12)![0].v).toBeGreaterThan(0.5);
    for (const op of [1, 2, 3, 4]) expect(sounding(op)).toBe(0);
    expect(peak(tail.l.slice(-128))).toBeLessThan(0.0001);
    expect(peak(tail.r.slice(-128))).toBeLessThan(0.0001);
  });

  it(`shared Op ${operators} contours follow first-held/last-released keys without restarting on overlap`, () => {
    const { e, render } = rig(operators, 8, p => {
      Object.assign(p.modules.find(m => m.id === 12)!.params, { r1: 0.08, l2: 0.25, r2: 0.01, l3: 0.25, r4: 0.1 });
      Object.assign(p.modules.find(m => m.id === 16)!.params, { a: 0.08, d: 0.01, s: 0.25, r: 0.1 });
    });
    const shared = operators === '4' ? [16] : [12, 16];
    const sustained = () => {
      for (const id of shared) expect(e.envStates(id)![0].v).toBeCloseTo(0.25, 4);
    };
    e.noteOn(60); render(0.2); sustained();
    e.noteOn(64); render(0.01); sustained();
    e.noteOff(60); render(0.01); sustained();
    e.noteOff(64); render(0.01);
    for (const id of shared) {
      expect(e.envStates(id)![0].stage).toBe(id === 12 ? 5 : 4);
      expect(e.envStates(id)![0].v).toBeLessThan(0.25);
    }
    render(0.3);
    for (const id of shared) expect(e.envStates(id)![0].v).toBe(0);
    e.noteOn(67); render(0.02);
    for (const id of shared) {
      expect(e.envStates(id)![0].v).toBeGreaterThan(0.1);
      expect(e.envStates(id)![0].v).toBeLessThan(0.4);
    }
  });
}

it.each([
  { algorithm: 1, pm: 22 }, { algorithm: 2, pm: 21 }, { algorithm: 3, pm: 20 },
  { algorithm: 4, pm: 20 }, { algorithm: 5, pm: 22 }, { algorithm: 6, pm: 20 },
  { algorithm: 7, pm: 22 },
])('algorithm $algorithm keeps shared-operator PM depth independent of the local carrier guard', ({ algorithm, pm }) => {
  const { e, render, heard } = rig('3+4', algorithm, p => {
    Object.assign(p.modules.find(m => m.id === 4)!.params, { l1: 0, l2: 0, l3: 0 });
    p.modules.find(m => m.id === 9)!.params.gain = 0; // isolate shared operators in summed PM branches
  });
  e.noteOn(60); render(0.06);
  const active = e.voiceNotes().findIndex(v => v.note === 60);
  expect(peak(e.probeVoices(pm, 'out')![active])).toBeGreaterThan(0.01);
  expect(peak(heard(3)[active])).toBe(0);
  expect(peak(heard(4)[active])).toBe(0);
  // The existing EG controls still change modulation, even while heard carriers
  // are closed by Op1; applying the guards to PM feeds would fail the first probe.
  e.setParam(12, 'l3', 0);
  e.setParam(16, 's', 0);
  render(0.02);
  expect(peak(e.probeVoices(pm, 'out')![active])).toBeLessThan(0.0001);
});

it('the Op4-only variant retains independent local Op3 release instead of coupling it to Op1', () => {
  const { e, render, heard } = rig('4', 8, p => {
    p.modules.find(m => m.id === 12)!.params.r4 = 2;
  });
  e.noteOn(60); render(0.06);
  const active = e.voiceNotes().findIndex(v => v.note === 60);
  e.noteOff(60); render(0.15);
  expect(peak(heard(1)[active])).toBe(0);
  expect(peak(heard(3)[active])).toBeGreaterThan(0.01);
  expect(e.envStates(16)![0].v).toBeGreaterThan(0.5);
  expect(peak(heard(4)[active])).toBe(0);
  expect(heard(3).filter(samples => peak(samples) > 0.001)).toHaveLength(1);
});
