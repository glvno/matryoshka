// SPDX-License-Identifier: GPL-3.0-only
// #525: the Matrix module, 4 inputs x 4 outputs with a pin (−1..1) between each, in the 1.9 format (49); its FM-1 pages
// are its outputs' columns.
import { describe, expect, it } from 'vitest';
import { DEFS, IMPLS, MATRIX_N, matrixPin } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { encodePatch, FORMAT_1_9, formatOf, TYPE_ORDER, WRITE_FLOOR } from './patchbin';
import { fm1PageTitle, modulePages } from './pages';
import { longName } from './labels';
import { outputRange } from './ranges';
import { matrixCost } from './cpu';
import TABLE from './cpu-costs.json';

const SR = 44118;

/** one block of a Matrix: `inp` the inputs patched (a value per sample), `p` its pins, `used` the outputs read */
function block(inp: Record<string, number[]>, p: Record<string, number>, used?: Record<string, boolean>) {
  const def = DEFS.matrix, n = 8;
  const ins = Object.fromEntries(def.inputs.map((d) => [d.name, Float32Array.from(inp[d.name] ?? Array(n).fill(0))]));
  const out = Object.fromEntries(def.outputs.map((o) => [o.name, new Float32Array(n).fill(NaN)]));
  const connected = Object.fromEntries(def.inputs.map((d) => [d.name, d.name in inp]));
  const params = { ...Object.fromEntries(def.params.map((q) => [q.name, q.default])), ...p };
  IMPLS.matrix.process({ sr: SR, n, inp: ins, out, connected, used, p: params, voice: {} as never }, IMPLS.matrix.init(SR));
  return out;
}

describe('Matrix (#525)', () => {
  it('is appended after the Range, with four inputs, four outputs and sixteen pins at 0', () => {
    expect(TYPE_ORDER[TYPE_ORDER.length - 1]).toBe('matrix');
    expect(TYPE_ORDER[TYPE_ORDER.length - 2]).toBe('range');
    expect(DEFS.matrix.inputs.map((i) => i.name)).toEqual(['in1', 'in2', 'in3', 'in4', 'p1', 'p2']);
    expect(DEFS.matrix.outputs.map((o) => o.name)).toEqual(['out1', 'out2', 'out3', 'out4']);
    expect(DEFS.matrix.params).toHaveLength(MATRIX_N * MATRIX_N);
    for (const q of DEFS.matrix.params) expect([q.min, q.max, q.default, q.step, q.unit]).toEqual([-1, 1, 0, 0.01, undefined]);
  });

  it('orders its pins output by output, in 1..in 4 within each', () => {
    expect(DEFS.matrix.params.slice(0, 6).map((q) => q.name)).toEqual(['i1o1', 'i2o1', 'i3o1', 'i4o1', 'i1o2', 'i2o2']);
    expect(matrixPin(3, 4)).toBe('i3o4');
    expect(longName('matrix', 'i3o4')).toBe('in 3 → out 4');
  });

  it('sums each input times its pin into each output', () => {
    const o = block({ in1: [1, 0.5, -1, 0, 0, 0, 0, 0], in2: [0.25, 0.25, 0.25, 0.25, 0, 0, 0, 0], in4: Array(8).fill(-0.5) },
      { i1o1: 0.5, i2o1: -1, i4o1: 0.2, i1o3: 1, i3o2: 1, i2o4: 0.125 });
    expect(o.out1[0]).toBeCloseTo(1 * 0.5 - 0.25 - 0.1, 6);
    expect(o.out1[2]).toBeCloseTo(-0.5 - 0.25 - 0.1, 6);
    expect([...o.out2]).toEqual(Array(8).fill(0));       // (in3 is not patched)
    expect([...o.out3].slice(0, 3)).toEqual([1, 0.5, -1]);
    expect(o.out4[0]).toBeCloseTo(0.25 * 0.125, 6);
  });

  it('leaves an output nothing reads unwritten', () => {
    const o = block({ in1: Array(8).fill(1) }, { i1o1: 1, i1o2: 1 }, { out1: true, out2: false, out3: false, out4: false });
    expect(o.out1[0]).toBe(1);
    expect(Number.isNaN(o.out2[0])).toBe(true);
  });

  it('has a page per output on the FM-1, named OUT 1..OUT 4, its pins in 1..in 4', () => {
    const p = emptyPatch();
    const m = addModule(p, DEFS.matrix, 0, 0);
    const pages = modulePages(p, m, DEFS);
    expect(pages.map((pg) => fm1PageTitle('Matrix', pg))).toEqual(['OUT 1', 'OUT 2', 'OUT 3', 'OUT 4']);
    expect(pages[1].rows.map((r) => r.param)).toEqual(['i1o2', 'i2o2', 'i3o2', 'i4o2']);
  });

  it('gives each output its range from its pins', () => {
    expect(outputRange('matrix', 'out2', { i1o2: 0.5, i3o2: -1 })).toContain('−1.5..1.5');
  });

  it('is written in the 1.9 format when it reaches the FM-1', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0), out = addModule(p, DEFS.output, 300, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    const m = addModule(p, DEFS.matrix, 600, 0);
    expect(formatOf(p)).toBe(WRITE_FLOOR);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: m.id, port: 'in1' });
    connect(p, DEFS, { module: m.id, port: 'out3' }, { module: out.id, port: 'r' });
    expect(formatOf(p)).toBe(FORMAT_1_9);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_9);
    expect(DEFS.matrix.since).toBe(FORMAT_1_9);
  });

  it('costs its outputs read and, in each, its pins in use (CPU model)', () => {
    const t = (TABLE as unknown as { types: Record<string, { matrix: { out: number; pins: number[] } }> }).types.matrix.matrix;
    const p = emptyPatch();
    const m = addModule(p, DEFS.matrix, 0, 0);
    Object.assign(m.params, { i1o1: 0.5, i2o1: -1, i3o1: 0.3, i1o2: 1 });
    const cost = (ins: string[], outs: string[], moved: string[] = []): number => matrixCost(m, t, new Set(ins), new Set(outs), new Set(moved));
    expect(cost([], ['out1'])).toBe(0);                                   // (the pins' inputs unpatched)
    expect(cost(['in1', 'in2'], ['out1'])).toBe(t.pins[1]);
    expect(cost(['in1', 'in2', 'in3', 'in4'], ['out1', 'out2'])).toBe(t.pins[2] + t.out + t.pins[0]);
    expect(cost(['in4'], ['out1'], ['i4o1'])).toBe(t.pins[0]);           // (a pin a cable moves is in use at 0)
    expect(t.pins[3]).toBeGreaterThan(t.pins[0]);
  });
});
