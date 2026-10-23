// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { armable, armableDevices, armedFromMask, armMask, armView, keepArmed, mutedCables, virtualCables } from './arm';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { newPatch } from './patch';
import { wireEngine } from './engines';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type ModuleInst, type Patch } from './patch';

const SR = 48000;

/** Main, a Voicing module A (its gate on the left) and a Drum map B (its first row's gate on the right; an unkeyed Voicing
 * would leave the patch, and the Output mono), Main's keys cabled into A only; the keys played are B's first row (36) */
function rig(): { p: Patch; main: ModuleInst; a: ModuleInst; b: ModuleInst; out: ModuleInst } {
  const p = emptyPatch('arm');
  const main = addModule(p, DEFS.fm1, 0, 0);
  main.params.tempo = 120;
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  const a = addModule(p, DEFS.alloc, 0, 0);
  const b = addModule(p, DEFS.drummap, 0, 0);
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: a.id, port: 'keys' });
  connect(p, DEFS, { module: a.id, port: 'gate' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: b.id, port: 'g1' }, { module: out.id, port: 'r' });
  return { p, main, a, b, out };
}

/** the left and right outputs at the end of a block, after a block for the keys to land */
function at(e: Engine): [number, number] {
  const l = new Float32Array(384), r = new Float32Array(384);
  e.render(l, r);
  return [l[383], r[383]];
}

describe('arming as a set (#190)', () => {
  it('anything with a keys input can be armed; Main and plain modules cannot', () => {
    const { p, main, a, out } = rig();
    expect(armable(p, `m${a.id}`)).toBe(true);
    expect(armable(p, `m${main.id}`)).toBe(false);
    expect(armable(p, `m${out.id}`)).toBe(false);
    expect(armableDevices(p).length).toBe(2);
    expect(keepArmed(p, [`m${a.id}`, `m${out.id}`, 'm999'])).toEqual([`m${a.id}`]);
  });

  it('none armed: the cables decide (the same patch)', () => {
    const { p } = rig();
    expect(armView(p, [])).toBe(p);
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(36, 1);
    expect(at(e)).toEqual([1, 0]);
  });

  it('armed: only armed devices hear Main, cable or not; several at once', () => {
    const { p, a, b } = rig();
    expect(virtualCables(p, [`m${b.id}`]).map((c) => c.to.module)).toEqual([b.id]);
    expect(mutedCables(p, [`m${b.id}`]).map((c) => c.to.module)).toEqual([a.id]);
    expect(mutedCables(p, [`m${a.id}`, `m${b.id}`])).toEqual([]);
    const e = new Engine(SR);
    e.load(p);
    e.arm([`m${b.id}`]);
    e.noteOn(36, 1);
    expect(at(e)).toEqual([0, 1]); // B hears the key, A (cabled) does not
    e.noteOff(36);
    at(e);
    e.arm([`m${a.id}`, `m${b.id}`]);
    e.noteOn(36, 1);
    expect(at(e)).toEqual([1, 1]); // a layer
    e.arm([]);
    expect(at(e)).toEqual([0, 0]); // the held key went quiet with the change
    e.noteOn(36, 1);
    expect(at(e)).toEqual([1, 0]); // the cables again
  });

  it('arming reroutes only Main: a Steps track keeps its cable into what it drives', () => {
    const { p, a, b } = rig();
    const st = addModule(p, DEFS.steps, 0, 0);
    connect(p, DEFS, { module: st.id, port: 'keys' }, { module: a.id, port: 'keys' });
    const v = armView(p, [`m${b.id}`]);
    expect(v.cables.some((c) => c.from.module === st.id && c.to.module === a.id)).toBe(true);
    expect(v.cables.some((c) => c.to.module === a.id && c.from.module !== st.id)).toBe(false); // Main's cable into A muted
  });

  it('goes to the FM-1 as a mask of the armed devices\' modules, and comes back from one (#191)', () => {
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Hera 6')!, 0, 0);
    const b = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 0, 900);
    wireEngine(p, a);
    wireEngine(p, b);
    const out = p.modules.find((m) => m.type === 'output')!;
    connect(p, DEFS, { module: b.outputs[0].module, port: b.outputs[0].port }, { module: out.id, port: 'r' }); // (both reach the Output: the FM-1 drops what does not)
    const [lo, hi] = armMask(p, [`a${b.id}`]);
    expect(lo || hi).toBeTruthy();
    expect(armedFromMask(p, lo, hi)).toEqual([`a${b.id}`]);
    const both = armMask(p, [`a${a.id}`, `a${b.id}`]);
    expect(armedFromMask(p, ...both).sort()).toEqual([`a${a.id}`, `a${b.id}`].sort());
    expect(armMask(p, [])).toEqual([0, 0]);
  });
});
