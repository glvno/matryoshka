// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import SOURCE from '../factory/bank.json';
import { rowTargets } from './assembly';
import { Engine } from './engine';
import { sharedArticulationFactory } from './factory-shared-articulation';
import { DEFS } from './modules';
import { addModule, validatePatch, type Patch } from './patch';

const SR = 44118;
const engines = [
  { name: 'Oracle V', allocator: 6, member: 15, oscillator: 9 },
  { name: 'Hera 4', allocator: 7, member: 12, oscillator: 8 },
  { name: 'Expander S', allocator: 4, member: 12, oscillator: 5 },
  { name: 'Io 4', allocator: 2, member: 48, oscillator: 40 },
];
const peak = (samples: Float32Array): number => samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
const energy = (samples: Float32Array): number => samples.reduce((sum, sample) => sum + sample * sample, 0);
const source = (name: string): Patch => validatePatch(structuredClone(SOURCE.find(s => s.name === name)!.patch), DEFS);

function rig(name: string, compile: boolean, original = source(name)) {
  const p = sharedArticulationFactory(original);
  for (const m of p.modules) if (m.type === 'adsr') Object.assign(m.params, { a: 0.005, d: 0.005, s: 0.55, r: 0.2, long: 0 });
  const env = p.modules.find(m => m.name === 'shared amplitude envelope')!;
  env.params.a = 0.15;
  const mask = p.modules.find(m => m.name === 'phrase membership')!;
  const amp = p.modules.find(m => m.name === 'shared amplitude' || m.name === 'shared amplitude left')!;
  const control = p.modules.find(m => m.name === 'shared amplitude control')!;
  const key = p.modules.find(m => m.name === 'shared key control')!;
  const root = p.assemblies!.find(a => a.children?.length)!;
  const e = new Engine(SR);
  e.load(p, compile);
  const render = (seconds: number) => {
    const l = new Float32Array(Math.max(1, Math.ceil(seconds * SR / 128)) * 128);
    const r = new Float32Array(l.length);
    e.render(l, r);
    return { l, r };
  };
  // Exercise the actual promoted control, including stereo/envelope aliases.
  const row = (label: string, value: number) => {
    const ref = root.params.find(r => r.label === label)!;
    for (const target of rowTargets(ref)) e.setParam(target.module, target.param, value);
  };
  return { p, e, env, mask, amp, control, key, render, row };
}

for (const compile of [false, true]) describe(`shared articulation, device compile=${compile}`, () => {
  it.each(engines)('$name shares attack/release, cuts overlap releases and clears the old phrase on its first new sample', ({ name, member, allocator }) => {
    const original = source(name);
    const count = original.modules.find(m => m.id === allocator)!.params.voices;
    const { e, env, mask, amp, render } = rig(name, compile, original);
    render(0.12);
    expect(e.voiceNotes()).toHaveLength(count);
    expect(e.probeVoices(mask.id, 'out')!.every(v => v.every(sample => sample === 0))).toBe(true);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);

    e.noteOn(60);
    render(0.02);
    expect(e.envStates(env.id)![0].stage).toBe(1);
    render(0.3);
    expect(e.envStates(env.id)![0].stage).toBe(3);
    e.noteOn(64);
    render(0.02); // allow the original Steps pass-through to deliver the event
    expect(e.envStates(env.id)![0].stage).toBe(3);
    expect(e.probeVoices(member, 'out')!.filter(v => peak(v) > 0.001)).toHaveLength(2);

    e.noteOff(64);
    render(0.02);
    const released = e.voiceNotes().findIndex(v => v.note === 64);
    expect(e.probeVoices(member, 'out')![released].every(sample => sample === 0)).toBe(true);
    expect(e.envStates(env.id)![0].v).toBeCloseTo(0.55, 4);
    expect(peak(e.probe(amp.id, 'out')!)).toBeGreaterThan(0.0001);

    e.noteOff(60);
    render(0.02);
    const last = e.voiceNotes().findIndex(v => v.note === 60);
    expect(e.probeVoices(mask.id, 'out')![last].every(sample => sample === 1)).toBe(true);
    expect(e.probeVoices(mask.id, 'out')![released].every(sample => sample === 0)).toBe(true);
    expect(e.envStates(env.id)![0].stage).toBe(4);
    expect(peak(e.probe(amp.id, 'out')!)).toBeGreaterThan(0.0001);

    // Start during the previous common release. Observe the actual rising gate
    // block, not a later settled block that could conceal a stale-pitch burst.
    e.noteOn(67);
    let started = false;
    for (let block = 0; block < 8 && !started; block++) {
      render(0);
      const current = e.voiceNotes().findIndex(v => v.note === 67 && v.on);
      if (current < 0 || e.probeVoices(mask.id, 'out')![current][127] !== 1) continue;
      started = true;
      for (const [index, samples] of e.probeVoices(mask.id, 'out')!.entries()) if (index !== current) {
        expect(samples.every(sample => sample === 0)).toBe(true);
        expect(e.probeVoices(member, 'out')![index].every(sample => sample === 0)).toBe(true);
      }
    }
    expect(started).toBe(true);
    e.noteOff(67);
    const tail = render(0.7);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    expect(peak(tail.l.slice(-128))).toBeLessThan(0.0001);
    expect(peak(tail.r.slice(-128))).toBeLessThan(0.0001);
    expect(e.envStates(env.id)![0].stage).toBe(0);
  });

  it.each(engines)('$name does not revive a stolen pitch or restart common amplitude on voice stealing', ({ name, member }) => {
    const { e, env, mask, amp, render } = rig(name, compile);
    for (const note of [72, 69, 67, 64]) {
      e.noteOn(note);
      render(0.02);
    }
    render(0.3);
    e.noteOn(60); // descending order also exercises Io's low-note priority
    render(0.02);
    expect(e.envStates(env.id)![0].stage).toBe(3);
    expect(e.voiceNotes().filter(v => v.on)).toHaveLength(4);
    expect(e.voiceNotes().some(v => v.on && v.note === 60)).toBe(true);
    expect(e.voiceNotes().some(v => v.on && v.note === 72)).toBe(false);
    expect(e.probeVoices(member, 'out')!.filter(v => peak(v) > 0.001)).toHaveLength(4);
    for (const note of [69, 67, 64, 60]) {
      e.noteOff(note);
      render(0.02);
    }
    // 72 is still physically held but was stolen: the source allocator does not
    // restore it. The separate any-held allocator must not reopen its stale pitch.
    expect(e.probeVoices(mask.id, 'out')!.every(v => v.every(sample => sample === 0))).toBe(true);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    e.noteOff(72);
    render(0.7);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
  });

  it.each(engines)('$name clears silent latched membership even after the normal idle-check interval', ({ name, member, oscillator }) => {
    const { p, e, mask, render } = rig(name, compile);
    const levels = p.modules.filter(m => m.type === 'osc').map(m => ({ id: m.id, level: m.params.level }));
    for (const { id } of levels) e.setParam(id, 'level', 0);
    e.noteOn(60);
    render(0.3);
    e.noteOff(60);
    render(1); // local oscillator EGs have ended; >32 blocks exercises idle skipping
    for (const { id, level } of levels) e.setParam(id, 'level', id === oscillator ? Math.max(0.5, level) : level);
    e.noteOn(72);
    let started = false;
    for (let block = 0; block < 8 && !started; block++) {
      render(0);
      const next = e.voiceNotes().findIndex(v => v.on && v.note === 72);
      if (next < 0 || e.probeVoices(mask.id, 'out')![next][127] !== 1) continue;
      started = true;
      for (const [index, samples] of e.probeVoices(mask.id, 'out')!.entries()) if (index !== next) {
        expect(samples.every(sample => sample === 0)).toBe(true);
        expect(peak(e.probeVoices(member, 'out')![index])).toBe(0);
      }
    }
    expect(started).toBe(true);
  });

  it('Hera pedal holds only the common phrase and cannot start or revive an idle pitch', () => {
    const { e, env, amp, render } = rig('Hera 4', compile);
    e.cc(64, 127);
    render(0.05);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    e.noteOn(60);
    render(0.3);
    e.noteOff(60);
    render(0.08);
    expect(e.envStates(env.id)![0].stage).toBe(3);
    expect(peak(e.probe(amp.id, 'out')!)).toBeGreaterThan(0.0001);
    e.noteOn(64);
    render(0.03);
    expect(e.probeVoices(12, 'out')!.filter(v => peak(v) > 0.001)).toHaveLength(1);
    // No physical keys remained before 64: this is a new phrase even with the
    // old common envelope held by the pedal. It attacks, then settles again.
    expect(e.envStates(env.id)![0].stage).toBe(1);
    render(0.3);
    e.cc(64, 63);
    render(0.03);
    expect(e.envStates(env.id)![0].stage).toBe(3);
    e.noteOff(64);
    render(0.7);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    e.cc(64, 127);
    render(0.05);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
  });

  it('Hera GATE remains an audible envelope bypass, with note-off distinct from ENV release', () => {
    const { e, env, amp, control, render, row } = rig('Hera 4', compile);
    row('mode', 2);
    e.noteOn(60);
    render(0.025);
    expect(e.envStates(env.id)![0].v).toBeLessThan(0.3);
    expect(e.probe(control.id, 'out')![127]).toBeCloseTo(1, 4);
    expect(peak(e.probe(amp.id, 'out')!)).toBeGreaterThan(0.0001);
    e.noteOff(60);
    render(0.03);
    expect(e.envStates(env.id)![0].v).toBeGreaterThan(0);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    row('mode', 1);
    e.noteOn(64);
    render(0.025);
    expect(e.probe(control.id, 'out')![127]).toBeGreaterThan(0);
    expect(e.probe(control.id, 'out')![127]).toBeLessThan(0.5);
  });

  it('Io HOLD sustains its common release but does not self-start', () => {
    const { e, env, amp, render, row } = rig('Io 4', compile);
    row('hold', 2);
    render(0.05);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    e.noteOn(60);
    render(0.3);
    e.noteOff(60);
    render(0.1);
    expect(e.envStates(env.id)![0].stage).toBe(3);
    expect(peak(e.probe(amp.id, 'out')!)).toBeGreaterThan(0.0001);
    row('hold', 1);
    render(0.7);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    row('hold', 2);
    render(0.05);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
  });

  it('Expander preserves literal VCA ON drone and stereo, then returns safely to note-driven mode', () => {
    const { e, amp, render, row } = rig('Expander S', compile);
    row('vca on', 2);
    row('width', 1);
    const drone = render(0.2);
    expect(energy(drone.l)).toBeGreaterThan(0.001);
    expect(energy(drone.r)).toBeGreaterThan(0.001);
    expect(e.probeVoices(12, 'out')!.filter(v => peak(v) > 0.001)).toHaveLength(4);
    row('vca on', 1);
    render(0.3);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    e.noteOn(60);
    const note = render(0.3);
    expect(energy(note.l)).toBeGreaterThan(0.001);
    expect(energy(note.r)).toBeLessThan(energy(note.l) * 0.001);
    row('level', 0);
    render(0.02);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    row('level', 0.41);
    e.noteOff(60);
    render(0.02);
    expect(peak(e.probe(amp.id, 'out')!)).toBeGreaterThan(0.0001);
    render(0.7);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
    row('vca on', 2);
    render(0.1);
    expect(e.probeVoices(12, 'out')!.filter(v => peak(v) > 0.001)).toHaveLength(4);
  });

  it('Oracle velocity controls the common amp, not an independent note envelope', () => {
    const { e, env, control, render, row } = rig('Oracle V', compile);
    row('vel amp', 2);
    e.noteOn(60, 32 / 127);
    render(0.3);
    expect(e.probe(control.id, 'out')![127]).toBeCloseTo(0.55 * 32 / 127, 3);
    e.noteOn(64, 96 / 127);
    render(0.03);
    expect(e.envStates(env.id)![0].stage).toBe(3);
    expect(e.probe(control.id, 'out')![127]).toBeCloseTo(0.55 * 96 / 127, 3);
  });

  it.each([
    { name: 'Oracle V', localEnv: 12, depth: 10 },
    { name: 'Expander S', localEnv: 11, depth: 18 },
    { name: 'Expander S', localEnv: 10, depth: 20 },
  ])('$name keeps oscillator EG $localEnv independently audible inside a shared amplitude phrase', ({ name, localEnv, depth }) => {
    const snapshots: Float32Array[] = [];
    for (const amount of [0, 0.8]) {
      const { e, env, amp, render } = rig(name, compile);
      e.setParam(localEnv, 'a', 0.15);
      e.setParam(localEnv, 'd', 0.02);
      e.setParam(localEnv, 's', 0.15);
      e.setParam(depth, 'gain', amount);
      if (name === 'Oracle V') e.setParam(35, 'pos', 2); // per-pitch poly-mod -> oscillator A
      e.noteOn(60);
      render(0.35);
      e.noteOn(64);
      render(0.03);
      const first = e.voiceNotes().findIndex(v => v.note === 60 && v.on);
      const second = e.voiceNotes().findIndex(v => v.note === 64 && v.on);
      expect(e.envStates(env.id)![0].stage).toBe(3);
      expect(e.envStates(localEnv)![first].stage).toBe(3);
      expect(e.envStates(localEnv)![second].stage).toBe(1);
      expect(Math.abs(e.envStates(localEnv)![first].v - e.envStates(localEnv)![second].v)).toBeGreaterThan(0.01);
      snapshots.push(e.probe(amp.id, 'out')!.slice());
    }
    const delta = snapshots[0].reduce((sum, sample, index) => sum + Math.abs(sample - snapshots[1][index]), 0) / 128;
    expect(delta).toBeGreaterThan(0.00001);
  });

  it.each(engines)('$name plays Harmony -> ARP processed pitches from Steps without a physical key', ({ name }) => {
    const original = source(name);
    const steps = original.modules.find(m => m.type === 'steps')!;
    steps.notes = [{ at: 0, len: 16, note: 60, vel: 100, wrap: true }];
    steps.params.len = 16;
    const arp = original.modules.find(m => m.type === 'arp')!;
    arp.params.mode = 0;
    arp.bypass = true;
    let harmony = original.modules.find(m => m.type === 'harm');
    if (!harmony) {
      harmony = addModule(original, DEFS.harm, 0, 0);
      const feed = original.cables.find(c => c.to.module === arp.id && c.to.port === 'keys')!;
      const upstream = { ...feed.from };
      feed.from = { module: harmony.id, port: 'keys' };
      original.cables.push({ from: upstream, to: { module: harmony.id, port: 'keys' } });
    }
    Object.assign(harmony.params, { type: 1, sus: 0, ext: 0, voicing: 0, lock: 0 }); // major triad
    harmony.bypass = false;
    const { e, env, amp, key, render } = rig(name, compile, original);
    e.transport(true);
    render(0.3);
    expect(e.voiceNotes().filter(v => v.on).map(v => v.note).sort((a, b) => a - b)).toEqual([60, 64, 67]);
    expect(e.probe(key.id, 'pitch')![127]).toBeCloseTo(7 / 12, 4);
    expect(e.envStates(env.id)![0].stage).toBe(3);
    expect(peak(e.probe(amp.id, 'out')!)).toBeGreaterThan(0.0001);
    e.setParam(arp.id, 'mode', 1);
    e.setBypass(arp.id, false);
    const heard = new Set<number>();
    let audible = false;
    for (let block = 0; block < 200; block++) {
      render(0);
      for (const v of e.voiceNotes()) if (v.on) heard.add(v.note);
      audible ||= peak(e.probe(amp.id, 'out')!) > 0.0001;
    }
    expect(heard).toEqual(new Set([60, 64, 67]));
    expect(audible).toBe(true);
    e.transport(false);
    render(0.8);
    expect(peak(e.probe(amp.id, 'out')!)).toBe(0);
  });
});
