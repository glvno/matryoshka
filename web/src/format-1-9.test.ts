// SPDX-License-Identifier: GPL-3.0-only
// #518 (format 49, the 1.9 format): the oscillator's pm2 / pm3 / index inputs and a phase modulation index past 8 rad,
// the LFO's random wave and its wide rate up to 80 Hz, a module's own name (on the FM-1: a device of kind 2).
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS, LFO_RANDOM, LFO_WAVES, PM_TOP } from './modules';
import { addModule, connect, emptyPatch, fixTrack, validatePatch, type Patch } from './patch';
import { makeAssembly } from './assembly';
import { deviceSection, encodePatch, FORMAT_1_9, formatOf, NAMED_MODULE, paramsAt, VERSION, WRITE_FLOOR } from './patchbin';
import { devicesOf } from './pages';
import { diffPatches } from './diff';
import { paramHint } from './labels';

const N = 4096;
function render(p: Patch): Float32Array {
  const e = new Engine(N);
  e.load(p);
  const l = new Float32Array(N);
  e.render(l, new Float32Array(N));
  return l;
}

/** a modulator into the carrier's `port`, the carrier into the Output; `params` on the carrier */
function fm(port: string, params: Record<string, number>, index?: number): Patch {
  const p = emptyPatch();
  const mod = addModule(p, DEFS.osc, 0, 0), car = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  Object.assign(mod.params, { coarse: 7, level: 0.8 });
  Object.assign(car.params, params);
  out.params.level = 1;
  connect(p, DEFS, { module: mod.id, port: 'out' }, { module: car.id, port });
  if (index !== undefined) {
    const c = addModule(p, DEFS.const, 0, 0);
    c.params.value = index;
    connect(p, DEFS, { module: c.id, port: 'out' }, { module: car.id, port: 'index' });
  }
  connect(p, DEFS, { module: car.id, port: 'out' }, { module: out.id, port: 'l' });
  return p;
}
const maxDiff = (a: Float32Array, b: Float32Array): number => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);

describe('phase modulation (#518)', () => {
  it('labels the index in radians and reaches 16 rad past the range modulation moves over', () => {
    for (const t of ['osc', 'wavetable', 'pd']) expect(DEFS[t].params.find((q) => q.name === 'pm')).toMatchObject({ unit: 'rad', max: 8, top: PM_TOP, grew: { since: 49, from: 8 } });
    expect(PM_TOP).toBe(16);
    expect(paramHint('osc', 'pm')).toMatch(/level × pm/);
  });

  it('appends pm2 / pm3 after the existing parameters and pm2, pm3, index after the existing ports', () => {
    expect(DEFS.osc.params.slice(-2).map((q) => [q.name, q.since])).toEqual([['pm2', 49], ['pm3', 49]]);
    expect(DEFS.osc.inputs.map((i) => i.name)).toEqual(['pitch', 'pm', 'sync', 'p1', 'p2', 'pm2', 'pm3', 'index']);
    expect(paramsAt('osc', 48).length).toBe(11);
  });

  it('pm2 alone plays as pm does with the same index', () => {
    expect(maxDiff(render(fm('pm2', { pm2: 3 })), render(fm('pm', { pm: 3 })))).toBeLessThan(1e-4);
    expect(maxDiff(render(fm('pm3', { pm3: 3 })), render(fm('pm', { pm: 3 })))).toBeLessThan(1e-4);
  });

  it('the index input multiplies the phase modulation: 0.5 into it halves the index', () => {
    expect(maxDiff(render(fm('pm', { pm: 4 }, 0.5)), render(fm('pm', { pm: 2 })))).toBeLessThan(1e-4);
  });

  it('an index past 8 rad modulates further', () => {
    expect(maxDiff(render(fm('pm', { pm: 12 })), render(fm('pm', { pm: 8 })))).toBeGreaterThan(0.1);
  });
});

describe('LFO (#518)', () => {
  it('appends the random wave after S&H and takes the wide rate to 80 Hz', () => {
    expect(LFO_WAVES).toEqual(['sine', 'triangle', 'saw', 'square', 'S&H', 'random']);
    expect(LFO_RANDOM).toBe(5);
    expect(DEFS.lfo.params.find((q) => q.name === 'wave')).toMatchObject({ max: 4, top: 5 });
    expect(DEFS.lfo.params.find((q) => q.name === 'wide')).toMatchObject({ max: 80 });
  });

  it('random glides between new values each cycle, without a jump', () => {
    const p = emptyPatch();
    const lfo = addModule(p, DEFS.lfo, 0, 0), out = addModule(p, DEFS.output, 0, 0);
    Object.assign(lfo.params, { wave: LFO_RANDOM, rate: 4, depth: 1 });
    out.params.level = 1;
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: out.id, port: 'l' });
    const l = render(p);
    let step = 0, at = 0;
    for (let i = 1; i < N; i++) if (Math.abs(l[i] - l[i - 1]) > step) (step = Math.abs(l[i] - l[i - 1])), (at = i);
    expect(step, `at ${at}`).toBeLessThan(0.007);   // (4 Hz at 4096 samples a second: 1024 samples a cycle; a swing of at most 2 along the S-curve, 1.5 x 2 / 1024 at its steepest)
    expect(Math.max(...l) - Math.min(...l)).toBeGreaterThan(0.2);
    expect(Math.max(...l.map(Math.abs))).toBeLessThanOrEqual(1);
  });
});

describe('format 49 is written only when a patch uses it', () => {
  const base = (): { p: Patch; o: ReturnType<typeof addModule>; l: ReturnType<typeof addModule> } => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), l = addModule(p, DEFS.lfo, 300, 0), out = addModule(p, DEFS.output, 600, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    connect(p, DEFS, { module: l.id, port: 'out' }, { module: o.id, port: 'p1' });
    return { p, o, l };
  };

  it('keeps an older format without any of it', () => {
    expect(VERSION).toBe(FORMAT_1_9);
    expect(formatOf(base().p)).toBe(WRITE_FLOOR);
    expect(encodePatch(base().p)[1]).toBe(WRITE_FLOOR);
  });

  it.each([
    ['pm2 off its default', (x: ReturnType<typeof base>) => (x.o.params.pm2 = 2)],
    ['pm past 8', (x: ReturnType<typeof base>) => (x.o.params.pm = 12)],
    ['the random wave', (x: ReturnType<typeof base>) => (x.l.params.wave = 5)],
    ['a wide rate past 55 Hz', (x: ReturnType<typeof base>) => (x.l.params.wide = 70)],
    ['a module device with its own name', (x: ReturnType<typeof base>) => (x.o.name = 'saw carrier')],
  ])('writes 49 for %s', (_, set) => {
    const x = base();
    set(x);
    expect(formatOf(x.p)).toBe(49);
    expect(encodePatch(x.p)[1]).toBe(49);
  });

  it('a wide rate at 55 Hz, S&H and pm at 8 stay older', () => {
    const x = base();
    x.l.params.wide = 55;
    x.l.params.wave = 4;
    x.o.params.pm = 8;
    expect(formatOf(x.p)).toBe(WRITE_FLOOR);
  });
});

describe('module names (#518)', () => {
  it('are kept through validation as printable text, a Steps name as a track name', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), s = addModule(p, DEFS.steps, 0, 0);
    o.name = '  saw\u0007  carrier ';
    s.name = 'bassline';
    const v = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(v.modules.find((m) => m.type === 'osc')!.name).toBe('saw carrier');
    expect(v.modules.find((m) => m.type === 'steps')!.name).toBe('BASSLINE');
    const m = { ...o, name: 'x'.repeat(40) };
    fixTrack(m);
    expect(m.name).toHaveLength(24);
  });

  it('name the device and its pages, and go to the FM-1 as a device of kind 2', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 300, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    o.name = 'saw carrier';
    const dev = devicesOf(p, DEFS).find((d) => d.module === o.id)!;
    expect(dev.name).toBe('saw carrier');
    expect(dev.pages[0].name).toBe('saw carrier');
    const b = encodePatch(p);
    const text = Array.from('saw carrier', (c) => c.charCodeAt(0));
    const at = b.findIndex((_, i) => b[i] === NAMED_MODULE && b[i + 2] === text.length && text.every((c, j) => b[i + 3 + j] === c));
    expect(at).toBeGreaterThan(0);
    expect(b[at + 1]).toBe(p.modules.indexOf(o));
  });

  it('a module inside an assembly keeps its name in the editor only', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), v = addModule(p, DEFS.vca, 0, 0);
    o.name = 'saw carrier';
    makeAssembly(p, [o.id, v.id], 'voice');
    expect(formatOf(p)).toBe(WRITE_FLOOR);
    expect(deviceSection(p, p).some((d) => d.module === o.id)).toBe(false);
  });

  it('show in Show changes', () => {
    const a = emptyPatch();
    const o = addModule(a, DEFS.osc, 0, 0);
    const b = structuredClone(a);
    b.modules.find((m) => m.id === o.id)!.name = 'saw carrier';
    b.modules.find((m) => m.id === o.id)!.params.pm = 2;
    const d = diffPatches(a, b, DEFS);
    expect(d.other.some((x) => x.includes('"saw carrier"'))).toBe(true);
    expect(d.params[0].label).toBe(`saw carrier (Oscillator #${o.id})`);
  });
});
