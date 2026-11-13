// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import SOURCE from '../factory/bank.json';
import { Engine } from './engine';
import { sharedFilterFactory } from './factory-paraphony';
import { DEFS } from './modules';
import { addModule, validatePatch } from './patch';

const ENGINES = [
  { name: 'Oracle V', amp: 15 },
  { name: 'Hera 4', amp: 12 },
  { name: 'Expander S', amp: 12 },
  { name: 'Io 4', amp: 48 },
];

function rig(name: string) {
  const p = sharedFilterFactory(validatePatch(structuredClone(SOURCE.find(s => s.name === name)!.patch), DEFS));
  for (const m of p.modules) if (m.type === 'adsr') Object.assign(m.params, { a: 0.001, d: 0.001, s: 0.8, r: 0.1, long: 0 });
  const envelope = p.modules.find(m => m.name === 'shared filter envelope')!;
  Object.assign(envelope.params, { a: 0.1, d: 0.01, s: 0.25, r: 0.2 });
  const key = p.modules.find(m => m.name === 'shared key control')!;
  const e = new Engine(44118);
  e.load(p);
  const render = (seconds: number) => {
    const l = new Float32Array(Math.ceil(44118 * seconds));
    const r = new Float32Array(l.length);
    e.render(l, r);
    return { l, r };
  };
  return { p, e, envelope, key, render };
}

it.each(ENGINES)('$name keeps note release and stealing independent while its filter follows first/last held keys', ({ name, amp }) => {
  const { e, envelope, key, render } = rig(name);
  render(0.03);
  expect(e.probeVoices(amp, 'out')!.every(v => v.every(sample => sample === 0))).toBe(true);
  e.noteOn(60);
  render(0.25);
  expect(e.envStates(envelope.id)![0].stage).toBe(3);
  expect(e.probe(key.id, 'pitch')![127]).toBeCloseTo(0, 4);
  expect(e.probeVoices(amp, 'out')!.filter(v => v.some(sample => Math.abs(sample) > 0.001))).toHaveLength(1);

  e.noteOn(64);
  render(0.01);
  // A second held key changes shared pitch, not the shared contour's attack.
  expect(e.envStates(envelope.id)![0].stage).toBe(3);
  expect(e.probe(key.id, 'pitch')![127]).toBeCloseTo(1 / 3, 4);
  expect(e.probeVoices(amp, 'out')!.filter(v => v.some(sample => Math.abs(sample) > 0.001))).toHaveLength(2);
  e.noteOff(64);
  render(0.01);
  const released = e.voiceNotes().findIndex(v => v.note === 64);
  expect(e.probeVoices(amp, 'out')![released].some(sample => Math.abs(sample) > 0.001)).toBe(true);
  expect(e.probe(key.id, 'pitch')![127]).toBeCloseTo(0, 4);
  expect(e.envStates(envelope.id)![0].stage).toBe(3);
  render(0.25);
  // The held note remains; released and never-used oscillator pitches cannot leak
  // through a global envelope that is still open.
  expect(e.probeVoices(amp, 'out')!.filter(v => v.some(sample => Math.abs(sample) > 0.001))).toHaveLength(1);
  e.noteOff(60);
  render(0.01);
  expect(e.envStates(envelope.id)![0].stage).toBe(4);
  expect(e.envStates(envelope.id)![0].v).toBeGreaterThan(0.05);
  const silent = render(0.6);
  expect(Math.max(...silent.l.slice(-128).map(Math.abs), ...silent.r.slice(-128).map(Math.abs))).toBeLessThan(0.001);

  for (const note of [72, 69, 67, 64, 60]) e.noteOn(note);
  render(0.25);
  e.noteOff(72); // descending notes also exercise Io's original low-note priority
  render(0.01);
  const replacement = e.voiceNotes().findIndex(v => v.note === 60);
  expect(e.voiceNotes()[replacement].on).toBe(true);
  expect(e.probeVoices(amp, 'out')![replacement].some(sample => Math.abs(sample) > 0.001)).toBe(true);
  for (const note of [69, 67, 64, 60]) e.noteOff(note);
  render(0.6);
  expect(e.envStates(envelope.id)![0].v).toBeLessThan(0.001);
});

it('Expander retains audible left/right voice placement through its shared filter pair', () => {
  const { p, e, render } = rig('Expander S');
  const width = p.assemblies!.find(a => a.name.endsWith('SF/PA'))!.params.find(row => row.label === 'width')!;
  e.setParam(width.module, width.param, 1);
  e.noteOn(60);
  const { l, r } = render(0.3);
  const energy = (samples: Float32Array) => samples.reduce((sum, sample) => sum + sample * sample, 0);
  expect(energy(l)).toBeGreaterThan(0.01);
  expect(energy(r)).toBeLessThan(energy(l) * 0.001);
});

it('Oracle key tracking hears processed keys and returns to the remaining held note', () => {
  const { p, e, key, render } = rig('Oracle V');
  // Insert harmony in the existing Steps -> ARP path, before BOTH allocators.
  // The highest generated note differs from Main's physical keyboard pitch.
  const harmony = addModule(p, DEFS.harm, 0, 0);
  harmony.params.type = 1;
  const arpFeed = p.cables.find(c => c.to.module === 67 && c.to.port === 'keys')!;
  const upstream = { ...arpFeed.from };
  arpFeed.from = { module: harmony.id, port: 'keys' };
  p.cables.push({ from: upstream, to: { module: harmony.id, port: 'keys' } });
  e.load(p);
  const track = p.modules.find(m => m.name === 'shared last-key tracking')!;
  const filter = p.modules.find(m => m.name === 'shared filter')!;
  e.setParam(track.id, 'pos', 2);
  e.setParam(41, 'gain', 0); // isolate key-follow from the shared envelope amount
  e.noteOn(60);
  render(0.1);
  expect(e.probe(key.id, 'pitch')![127]).toBeCloseTo(7 / 12, 4);
  const cutoff = () => e.parameterValues().find(m => m.id === filter.id)!.params.cutoff;
  const base = cutoff();
  e.noteOn(72);
  render(0.1);
  expect(cutoff()).toBeCloseTo(base * 2, 0);
  e.noteOff(72);
  render(0.1);
  expect(cutoff()).toBeCloseTo(base, 0);
});
