// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cpuChecks } from './cpu-checks';
import { deadModules, hoistable } from './device-compile';
import { BLOCK, Engine } from './engine';
import { DEFS } from './modules';
import { makeAssembly } from './assembly';
import { addModule, connect, newPatch, validatePatch, type Patch } from './patch';
import { deviceView, setPoly } from './poly';

const SR = 44118;

/** the patch played with and without the compile pass: a chord, then its release */
function render(p: Patch, compile: boolean, notes: number[]): Float32Array {
  const e = new Engine(SR);
  e.load(structuredClone(p), compile);
  e.transport(true); // (Steps tracks, the drum kits, play only while it runs)
  const out = new Float32Array(48 * BLOCK * 2);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  for (const n of notes) e.noteOn(n);
  for (let b = 0; b < 48; b++) {
    if (b === 30) for (const n of notes) e.noteOff(n);
    l.fill(0);
    r.fill(0);
    e.render(l, r);
    out.set(l, b * BLOCK * 2);
    out.set(r, b * BLOCK * 2 + BLOCK);
  }
  return out;
}

describe('device compile pass', () => {
  const checks = cpuChecks(60);
  it('changes nothing that can be heard: every factory patch and assembly, sample for sample', () => {
    for (const c of checks) {
      const a = render(c.patch, false, c.notes), b = render(c.patch, true, c.notes);
      let diff = -1;
      for (let i = 0; i < a.length && diff < 0; i++) if (a[i] !== b[i]) diff = i;
      expect(diff, c.name).toBe(-1);
    }
  });

  it('drops a module nobody hears, keeps the ones before a Random module (their indices seed it)', () => {
    const p = newPatch(DEFS);
    const out = p.modules.find((m) => m.type === 'output')!;
    const lost = addModule(p, DEFS.osc, 0, 0);
    const heard = addModule(p, DEFS.osc, 0, 0);
    connect(p, DEFS, { module: heard.id, port: 'out' }, { module: out.id, port: 'l' });
    expect([...deadModules(p)]).toEqual([lost.id]);
    const rnd = addModule(p, DEFS.random, 0, 0);
    connect(p, DEFS, { module: rnd.id, port: 'out' }, { module: out.id, port: 'r' });
    expect([...deadModules(p)]).toEqual([]);
  });

  it('runs a voice card module once when every copy would compute the same, never one that reads the voice', () => {
    const p = newPatch(DEFS);
    const out = p.modules.find((m) => m.type === 'output')!;
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    const scale = addModule(p, DEFS.scale, 0, 0);
    const osc = addModule(p, DEFS.osc, 0, 0);
    const flt = addModule(p, DEFS.filter, 0, 0);
    connect(p, DEFS, { module: p.modules[0].id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: scale.id, port: 'in' });
    connect(p, DEFS, { module: scale.id, port: 'out' }, { module: flt.id, port: 'cv' });
    connect(p, DEFS, { module: osc.id, port: 'out' }, { module: flt.id, port: 'in' });
    connect(p, DEFS, { module: flt.id, port: 'lp12' }, { module: out.id, port: 'l' });
    const alloc = addModule(p, DEFS.alloc, 0, 0);
    connect(p, DEFS, { module: p.modules[0].id, port: 'keys' }, { module: alloc.id, port: 'keys' });
    p.cables = p.cables.filter((c) => !(c.to.module === osc.id && c.to.port === 'pitch'));
    connect(p, DEFS, { module: alloc.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
    const poly = validatePatch(structuredClone(p), DEFS);
    setPoly(poly, DEFS, makeAssembly(poly, [lfo.id, scale.id, osc.id, flt.id], 'voice'), true);
    const { patch, groups } = deviceView(poly);
    const g = groups.find((x) => x.modules.has(lfo.id))!;
    const h = hoistable(patch, g);
    expect(h.has(lfo.id) && h.has(scale.id)).toBe(true);
    expect(h.has(osc.id) || h.has(flt.id)).toBe(false); // the oscillator plays the voice's pitch, the filter feeds the outside
    expect(render(poly, true, [60, 64, 67])).toEqual(render(poly, false, [60, 64, 67]));
  });
});
