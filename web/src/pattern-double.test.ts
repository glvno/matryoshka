// SPDX-License-Identifier: GPL-3.0-only
// The double (D-838, pattern-ops.ts doublePattern): every track's pattern twice as long, its steps repeated in the new
// half, so it plays the same twice; all or nothing. The FM-1's side is firmware/test/patlink_test.c (the same patches
// doubled byte for byte, scripts/pattern-vectors.ts) and panel_test.c (SEQ held + OCT+). Both engines play a doubled
// pattern sample for sample as the pattern played twice.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFm1EngineWasm } from '../scripts/fm1-wasm.mjs';
import { Engine } from './engine';
import { Fm1Engine } from './fm1-engine';
import { Fm1Bridge } from './fm1-engine-host';
import { DEFS } from './modules';
import { addModule, emptyPatch, type ModuleInst, type Patch } from './patch';
import { doublePattern } from './pattern-ops';
import { FM1_PRESETS } from './presets';
import { condAB, type StepNote } from './track';
import './factory-presets';

const n = (at: number, len: number, note: number, more: Partial<StepNote> = {}): StepNote => ({ at, len, note, vel: 100, ...more });
const lock = (at: number, module: number, value: number) => ({ at, module, param: 'value', value });

interface Rig { p: Patch; a: ModuleInst; b: ModuleInst; c: ModuleInst; k: number }
function rig(): Rig {
  const p = emptyPatch('RIG');
  addModule(p, DEFS.fm1, 0, 0);
  const [a, b, c] = [0, 1, 2].map(() => addModule(p, DEFS.steps, 0, 0));
  const k = addModule(p, DEFS.const, 0, 0).id;
  a.params.len = b.params.len = c.params.len = 16;
  return { p, a, b, c, k };
}

describe('the double (D-838)', () => {
  it('copies every note attribute and P-lock into the new half; a cut or tied note keeps what it sounded; a drone stays one', () => {
    const { p, a, k } = rig();
    a.patterns = [{ len: 12, notes: [n(0, 1, 36, { chance: 50 }), n(2, 3, 40, { vel: 90, cond: condAB(1, 2) }), n(4, 1, 42, { ratchet: 3, micro: 5 }),
      n(5, 64, 44, { wrap: true }), n(9, 5, 49, { wrap: true }), n(10, 6, 47), n(14, 1, 50), n(30, 1, 51)],
    locks: [lock(0, k, 0.25), lock(10, k, -0.5), lock(13, k, 0.75)] }];
    expect(doublePattern(p, 1)).toEqual({ len: 32 });
    const x = a.patterns![0]!;
    expect(x.len).toBe(24);
    expect(x.notes).toEqual([
      n(0, 1, 36, { chance: 50 }), n(2, 3, 40, { vel: 90, cond: condAB(1, 2) }), n(4, 1, 42, { ratchet: 3, micro: 5 }), n(5, 64, 44, { wrap: true }),
      n(9, 5, 49), n(10, 2, 47),
      n(12, 1, 36, { chance: 50 }), n(14, 3, 40, { vel: 90, cond: condAB(1, 2) }), n(16, 1, 42, { ratchet: 3, micro: 5 }),
      n(21, 5, 49, { wrap: true }), n(22, 2, 47), n(30, 1, 51),
    ]);
    expect(x.locks).toEqual([lock(0, k, 0.25), lock(10, k, -0.5), lock(12, k, 0.25), lock(22, k, -0.5)]);
  });

  it('pattern 1: the track\'s length doubles, its other patterns on the track\'s length keep it as their own', () => {
    const { p, a } = rig();
    a.notes = [n(0, 1, 36)];
    a.patterns = [{ notes: [n(0, 1, 37)] }, null, { notes: [], len: 10 }];
    expect(doublePattern(p, 0)).toEqual({ len: 32 });
    expect(a.params.len).toBe(32);
    expect(a.notes).toEqual([n(0, 1, 36), n(16, 1, 36)]);
    expect(a.patterns).toEqual([{ notes: [n(0, 1, 37)], len: 16 }, null, { notes: [], len: 10 }]);
  });

  it('a track without the pattern gets it from its pattern 1 (D-542); the longest track is what it says; twice to 64', () => {
    const { p, a, b, c, k } = rig();
    a.patterns = [{ notes: [n(1, 1, 50)], len: 8 }];
    b.params.len = 32;
    b.notes = [n(3, 1, 60)];
    b.locks = [lock(3, k, 1)];
    expect(doublePattern(p, 1)).toEqual({ len: 64 });
    expect(b.patterns).toEqual([{ len: 64, notes: [n(3, 1, 60), n(35, 1, 60)], locks: [lock(3, k, 1), lock(35, k, 1)] }]);
    expect(b.notes).toEqual([n(3, 1, 60)]);
    expect(c.patterns).toEqual([{ len: 32 }]);
    expect(a.patterns![0]!.len).toBe(16);
    const was = structuredClone(p);
    expect(doublePattern(p, 1)).toEqual({ refused: 'steps' });
    expect(p).toEqual(was);
  });

  it('refuses, changing nothing, past 128 note words in a pattern, 1536 in the patch, 64 P-locks in a pattern, 256 in the patch', () => {
    const cases: [string, (r: Rig) => void, string][] = [
      ['pattern notes', ({ a }) => { a.notes = Array.from({ length: 70 }, (_, i) => n(i % 16, 1, 30 + Math.floor(i / 16))); }, 'notes'],
      ['patch notes', ({ a, b }) => {
        a.notes = Array.from({ length: 60 }, (_, i) => n(i % 16, 1, 30 + Math.floor(i / 16)));
        b.patterns = Array.from({ length: 12 }, () => ({ notes: Array.from({ length: 128 }, (_, i) => n(i % 16, 1, 30 + Math.floor(i / 16))) }));
      }, 'notes'],
      ['pattern locks', ({ a, k }) => { a.params.len = 32; a.locks = Array.from({ length: 32 }, (_, i) => lock(i, k, 0.5)); a.locks.push({ at: 0, module: k, param: 'other', value: 1 }); }, 'locks'],
      ['patch locks', ({ a, b, k }) => {
        a.locks = Array.from({ length: 16 }, (_, i) => lock(i, k, 0.5));
        b.patterns = Array.from({ length: 4 }, () => ({ locks: Array.from({ length: 60 }, (_, i) => ({ at: i, module: k, param: `p${Math.floor(i / 60)}`, value: 1 })) }));
      }, 'locks'],
    ];
    for (const [name, set, why] of cases) {
      const r = rig();
      set(r);
      const was = structuredClone(r.p);
      expect(doublePattern(r.p, 0), name).toEqual({ refused: why });
      expect(r.p, name).toEqual(was);
    }
  });
});

describe('a doubled pattern plays the pattern twice, sample for sample (D-838)', () => {
  let wasm: WebAssembly.Module;
  beforeAll(() => {
    wasm = new WebAssembly.Module(readFileSync(buildFm1EngineWasm(join(tmpdir(), `pattern-double-${process.pid}.wasm`))));
  }, 120_000);
  const SR = 48000;
  /** Meridian 8 with ties, a cut note, a note tied across the loop point, a ratchet and micro timing either way */
  function meridian(): Patch {
    const p = FM1_PRESETS['Meridian 8']();
    const t = p.modules.find((m) => m.type === 'steps')!;
    t.notes = [...t.notes!.filter((x) => x.at > 0 && x.at < 12 && x.at !== 4 && x.at !== 6), n(0, 1, 60, { micro: -4 }), n(4, 2, 62, { ratchet: 3 }),
      n(6, 1, 64, { micro: 7 }), n(13, 6, 67), n(14, 4, 55, { wrap: true })].sort((x, y) => x.at - y.at || x.note - y.note);
    return p;
  }
  /** `secs` seconds of the left channel, the transport started at the top */
  function play(p: Patch, fm1: boolean, secs: number): Float32Array {
    const out = new Float32Array(Math.round(SR * secs)), r = new Float32Array(128);
    let render: (l: Float32Array, r: Float32Array) => void;
    if (fm1) {
      const e = new Fm1Engine(wasm, SR);
      expect(e.apply(new Fm1Bridge().load(p))).toBe(0);
      e.hear({ t: 'transport', on: true });
      render = (l, rr) => e.render(l, rr);
    } else {
      const e = new Engine(SR);
      e.load(p);
      e.transport(true);
      render = (l, rr) => e.render(l, rr);
    }
    for (let at = 0; at < out.length; at += 128) render(out.subarray(at, Math.min(at + 128, out.length)), r.subarray(0, Math.min(128, out.length - at)));
    return out;
  }
  it.each([false, true])('FM-1 engine: %s', (fm1) => {
    const p = meridian(), q = structuredClone(p);
    expect(doublePattern(q, 0)).toEqual({ len: 32 });
    const a = play(p, fm1, 4.5), b = play(q, fm1, 4.5);   // (two passes of 2 s at 120 bpm, 1/16, and the next pass's start)
    expect(a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeGreaterThan(0.01);
    expect(a.findIndex((v, i) => v !== b[i])).toBe(-1);
  }, 120_000);
});
