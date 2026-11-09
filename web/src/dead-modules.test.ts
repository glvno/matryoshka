// SPDX-License-Identifier: GPL-3.0-only
// The device compile pass's dead modules (device-compile.ts, D-361, #801): what goes, what stays, and that the module
// indices the editor and the FM-1 exchange afterwards all map through the same form.
import { describe, expect, it } from 'vitest';
import { deadModules, hoistable, seeded } from './device-compile';
import { shownModules } from './device-shown';
import { deviceIndex } from './device';
import { BLOCK, Engine } from './engine';
import { DEFS } from './modules';
import { makeAssembly } from './assembly';
import { addModule, connect, hasMorph, newPatch, validatePatch, type ModuleInst, type Patch } from './patch';
import { deviceView, setPoly } from './poly';
import { deviceRecord, deviceSection, encodePatch, FLAG_CABLES3, layout, lockRecord, moduleRecordSize, PANEL_BYTES, TYPE_ORDER } from './patchbin';

const add = (p: Patch, type: string, params: Record<string, number> = {}): ModuleInst => {
  const m = addModule(p, DEFS[type], 0, 0);
  Object.assign(m.params, params);
  return m;
};
const wire = (p: Patch, from: ModuleInst, out: string, to: ModuleInst, inp: string): void => {
  connect(p, DEFS, { module: from.id, port: out }, { module: to.id, port: inp });
};
const outOf = (p: Patch): ModuleInst => p.modules.find((m) => m.type === 'output')!;
const mainOf = (p: Patch): ModuleInst => p.modules.find((m) => m.type === 'fm1')!;
const dead = (p: Patch): number[] => [...deadModules(deviceView(p).patch, [], shownModules(p))];

/** a heard voice: an oscillator on Main's pitch into the Output */
function voice(p: Patch, params: Record<string, number> = {}): ModuleInst {
  const o = add(p, 'osc', params);
  wire(p, mainOf(p), 'pitch', o, 'pitch');
  wire(p, o, 'out', outOf(p), 'l');
  return o;
}

/** the binary's modules (type names) and cables (module indices, port names), read back (a patch without poly groups) */
function readBack(p: Patch): { types: string[]; cables: string[] } {
  const b = encodePatch(p);
  const { p: dev, v, keep } = layout(p);
  const n = b[2], ncab = b[4] | (b[5] << 8), flags = b[6] | (b[7] << 8);
  expect(b[3]).toBe(0);
  let at = 8 + PANEL_BYTES;
  const types: string[] = [];
  for (let i = 0; i < n; i++) {
    types.push(TYPE_ORDER[b[at] & 0x7f]);
    at += moduleRecordSize(dev.modules[i], v, hasMorph(dev), keep.get(dev.modules[i].id));
  }
  const port = (i: number, k: number, side: 'outputs' | 'inputs'): string => DEFS[types[i]][side][k].name;
  const cables: string[] = [];
  for (let c = 0; c < ncab; c++) {
    if (flags & FLAG_CABLES3) {
      const [f, t, ports] = [b[at], b[at + 1], b[at + 2]];
      cables.push(`${f}.${port(f, ports >> 4, 'outputs')}>${t}.${port(t, ports & 15, 'inputs')}`);
      at += 3;
    } else {
      cables.push(`${b[at]}.${port(b[at], b[at + 1], 'outputs')}>${b[at + 2]}.${port(b[at + 2], b[at + 3], 'inputs')}`);
      at += 4;
    }
  }
  return { types, cables };
}

/** the patch played with or without the compile pass, a note and its release */
function render(p: Patch, compile: boolean): Float32Array {
  const e = new Engine(44118);
  e.load(structuredClone(p), compile);
  const out = new Float32Array(40 * BLOCK);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  e.noteOn(60);
  for (let k = 0; k < 40; k++) {
    if (k === 25) e.noteOff(60);
    l.fill(0);
    r.fill(0);
    e.render(l, r);
    out.set(l, k * BLOCK);
  }
  return out;
}

describe('dead modules (D-361, #801)', () => {
  it('drops a chain no one hears, however long, and keeps the editor\'s patch whole', () => {
    const p = newPatch(DEFS);
    voice(p);
    const lfo = add(p, 'lfo'), flt = add(p, 'filter'), vca = add(p, 'vca');
    wire(p, lfo, 'out', flt, 'cv');
    wire(p, flt, 'lp12', vca, 'in');
    expect(dead(p).sort()).toEqual([lfo.id, flt.id, vca.id].sort());
    const n = p.modules.length;
    encodePatch(p);
    expect(p.modules.length).toBe(n);
    expect(deviceView(p, true).patch.modules.map((m) => m.type)).toEqual(['fm1', 'output', 'osc']);
  });

  it('keeps what does something of its own or what the FM-1 addresses: Steps, Arpeggiator, Drum map, P-lock and Toggle targets', () => {
    const p = newPatch(DEFS);
    voice(p);
    const steps = add(p, 'steps'), arp = add(p, 'arp'), map = add(p, 'drummap');
    const locked = add(p, 'lfo'), toggled = add(p, 'delay');
    steps.locks = [{ at: 0, module: locked.id, param: 'rate', value: 2 }];
    const main = mainOf(p);
    main.panel = { ...main.panel, kinds: { ...main.panel?.kinds, fx: 'bypass' }, targets: { fx: { module: toggled.id } } };
    const lost = add(p, 'noise');
    const shown = shownModules(p);
    expect(shown.held).toEqual(new Set([locked.id, toggled.id]));
    expect(dead(p)).toEqual([lost.id]);
    const kept = deviceView(p, true).patch.modules.map((m) => m.id);
    for (const m of [steps, arp, map, locked, toggled]) expect(kept).toContain(m.id);
    // the lock goes to the FM-1 with its target's index in the binary
    const dev = deviceView(p, true).patch;
    const rec = lockRecord(p, dev);
    expect(rec[0]).toBe(1);   // one track
    expect(rec[1]).toBe(dev.modules.findIndex((m) => m.id === steps.id));
    expect(rec[4]).toBe(dev.modules.findIndex((m) => m.id === locked.id));   // (rows 1, pairs 1: module, parameter)
  });

  it('keeps dead modules before one that starts from its index: a Random, a Steps track, a Shift register, an oscillator with analog tolerances', () => {
    for (const [type, params] of [['random', {}], ['shreg', {}], ['osc', { analog: 0.5 }]] as const) {
      const p = newPatch(DEFS);
      const before = add(p, 'lfo');
      const m = add(p, type, params);
      wire(p, mainOf(p), 'gate', m, type === 'osc' ? 'pitch' : 'clock');
      wire(p, m, type === 'shreg' ? 'dac' : 'out', outOf(p), 'l');
      const after = add(p, 'noise');
      expect(dead(p), type).toEqual([after.id]);
      expect(deviceIndex(p, before.id), type).toBe(2);
    }
    // an oscillator without analog drops what comes before it, unless the FM-1 or a modulation can raise its analog
    const p = newPatch(DEFS);
    const before = add(p, 'lfo');
    const o = add(p, 'osc');
    wire(p, mainOf(p), 'pitch', o, 'pitch');
    wire(p, o, 'out', outOf(p), 'l');
    const a = makeAssembly(p, [o.id], 'voice');   // (in an assembly with no card rows: the FM-1 cannot set its analog)
    expect(seeded(o, shownModules(p))).toBe(false);
    expect(dead(p)).toEqual([before.id]);
    a.params = [{ module: o.id, param: 'analog', label: 'analog' }];   // a card row: the FM-1's knob can raise it
    expect(seeded(o, shownModules(p))).toBe(true);
    expect(dead(p)).toEqual([]);
    a.params = [];
    o.paramsB = { ...o.params, analog: 0.3 };   // its morph B side
    expect(dead(p)).toEqual([]);
  });

  it('sounds the same with and without the pass, the modules that start from their index after dropped ones', () => {
    const p = newPatch(DEFS);
    const lfo = add(p, 'lfo');   // dead, before the oscillator: stays
    voice(p, { wave: 2, analog: 1 });
    const clk = add(p, 'lfo', { wave: 3, rate: 13 }), rnd = add(p, 'random');
    wire(p, clk, 'out', rnd, 'clock');
    wire(p, rnd, 'held', outOf(p), 'r');
    const lost = add(p, 'random');   // dead and last: goes
    wire(p, clk, 'out', lost, 'clock');
    expect(dead(p)).toEqual([lost.id]);
    expect(deviceIndex(p, lfo.id)).toBe(2);
    expect(render(p, true)).toEqual(render(p, false));
  });

  it('runs neither an oscillator with analog tolerances nor a Shift register once for all voices (each voice has its own)', () => {
    const p = newPatch(DEFS);
    const out = outOf(p);
    const sr = add(p, 'shreg'), lfo = add(p, 'lfo'), o = add(p, 'osc', { analog: 0.6 }), vca = add(p, 'vca');
    const alloc = add(p, 'alloc');
    wire(p, mainOf(p), 'keys', alloc, 'keys');
    wire(p, lfo, 'out', sr, 'clock');
    wire(p, sr, 'dac', vca, 'cv');
    wire(p, o, 'out', vca, 'in');
    wire(p, alloc, 'gate', o, 'sync');
    wire(p, vca, 'out', out, 'l');
    const poly = validatePatch(structuredClone(p), DEFS);
    setPoly(poly, DEFS, makeAssembly(poly, [sr.id, lfo.id, o.id, vca.id], 'voice'), true);
    const { patch, groups } = deviceView(poly);
    const g = groups.find((x) => x.modules.has(lfo.id))!;
    const h = hoistable(patch, g, shownModules(poly));
    expect(h.has(lfo.id)).toBe(true);
    expect(h.has(sr.id) || h.has(o.id)).toBe(false);
  });

  it('maps every module index through the same form: the binary, the device pages, deviceIndex', () => {
    const p = newPatch(DEFS);
    const o = voice(p);   // (a plain module's device: the FM-1 can raise its analog, so what comes before it stays)
    const lost = add(p, 'lfo'), lost2 = add(p, 'filter');
    wire(p, lost, 'out', lost2, 'cv');
    const env = add(p, 'adsr'), vca = add(p, 'vca');
    wire(p, mainOf(p), 'gate', env, 'gate');
    wire(p, o, 'out', vca, 'in');
    wire(p, env, 'env', vca, 'cv');
    wire(p, vca, 'out', outOf(p), 'r');
    const dev = deviceView(p, true).patch;
    expect(dev.modules.map((m) => m.type)).toEqual(['fm1', 'output', 'osc', 'adsr', 'vca']);
    // the editor's ids to the binary's indices and back
    for (const m of p.modules) {
      const i = deviceIndex(p, m.id);
      expect(i, m.type).toBe(dev.modules.findIndex((x) => x.id === m.id));
      if (i >= 0) expect(dev.modules[i].id).toBe(m.id);
    }
    expect(deviceIndex(p, lost.id)).toBe(-1);
    expect(deviceIndex(p, lost2.id)).toBe(-1);
    // the binary holds the kept modules, its cables join them by their new indices
    const back = readBack(p);
    expect(back.types).toEqual(['fm1', 'output', 'osc', 'adsr', 'vca']);
    expect(back.cables.sort()).toEqual(['0.pitch>2.pitch', '2.out>1.l', '0.gate>3.gate', '2.out>4.in', '3.env>4.cv', '4.out>1.r'].sort());
    // the device pages list the kept plain modules by their new indices, the dropped ones not at all
    const devs = deviceSection(p, dev);
    expect(devs.some((d) => d.module === lost.id || d.module === lost2.id)).toBe(false);
    const rec = deviceRecord(devs, dev);
    const own = devs.flatMap((d) => (d.module === undefined ? [] : [dev.modules.findIndex((x) => x.id === d.module)]));
    let at = 1;
    const listed: number[] = [];
    for (const d of devs) {
      expect(d.module).toBeDefined();   // (plain modules only here: kind 0 or 2, then the index)
      listed.push(rec[at + 1]);
      at += rec[at] === 2 ? 3 + rec[at + 2] : 2;
    }
    expect(listed).toEqual(own);
  });
});
