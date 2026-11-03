// SPDX-License-Identifier: GPL-3.0-only
// #526: modulation scaling. A parameter input's depth in the parameter's units up to ±2, a bipolar macro range, the Range module.
import { describe, expect, it } from 'vitest';
import { DEFS, IMPLS, RANGE_T_MAX, rangeCurve } from './modules';
import { addModule, connect, DEPTH_MAX, emptyPatch, fixMatrix, rangeShare, validatePatch, type Patch, type ParamDef } from './patch';
import { encodePatch, FORMAT_1_9, formatOf, RANGE_BIPOLAR, TYPE_ORDER, WRITE_FLOOR } from './patchbin';
import { depthText, parseDepth, storedDepth } from './depth';
import { swingsBoth } from './parameter-menu';
import { parse, rangeFrame } from './protocol';
import { outputRange } from './ranges';

const pd = (type: string, name: string): ParamDef => DEFS[type].params.find((q) => q.name === name)!;

describe('depth in the parameter\'s units (#526)', () => {
  it('reads in octaves on a logarithmic parameter, in its unit on a linear one, in % of the slider on the cutoff', () => {
    const attack = pd('adsr', 'a'); // 0.001..5 s, logarithmic: log2(5000) octaves
    expect(depthText(attack, 1)).toBe(`+${Number(Math.log2(5000).toPrecision(3))} oct`);
    expect(depthText(pd('delay', 'time'), -0.5)).toMatch(/^−\d+(\.\d+)? ms$/);
    expect(depthText(pd('filter', 'cutoff'), 0.25)).toBe('+25 %');
    expect(depthText(pd('osc', 'pw'), 0)).toBe('0');
  });

  it('takes a typed value as typed, fractions too, within ±2 ranges, on the Q16 grid', () => {
    const attack = pd('adsr', 'a');
    const oct = Math.log2(5000);
    expect(parseDepth('1/8', attack)).toBe(storedDepth(0.125 / oct));
    expect(parseDepth('-7/12 oct', attack)).toBe(storedDepth(-7 / 12 / oct));
    expect(parseDepth('7 st', attack)).toBe(storedDepth(7 / 12 / oct));
    expect(parseDepth('50%', attack)).toBe(0.5);
    expect(parseDepth('1000 oct', attack)).toBe(DEPTH_MAX);
    expect(parseDepth('nonsense', attack)).toBeNull();
    expect(parseDepth('1/0', attack)).toBeNull();
    const pw = pd('osc', 'pw');
    expect(parseDepth('0.125', pw)).toBe(storedDepth(0.125 / (pw.max - pw.min)));
    // shown back with three significant figures: 1/8 of an octave stays "0.125"
    expect(depthText(attack, parseDepth('1/8', attack)!)).toBe('+0.125 oct');
    const time = pd('delay', 'time');
    expect(parseDepth('0.1 s', time)).toBe(storedDepth(100 / (time.max - time.min)));
  });

  it('keeps a depth up to ±2 in a saved patch', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0);
    o.att = [1.75, -3];
    fixMatrix(o, DEFS.osc);
    expect(o.att).toEqual([1.75, -DEPTH_MAX]);
  });

  it('does not raise the format: every firmware reads the depth unclamped', () => {
    const p = emptyPatch();
    const lfo = addModule(p, DEFS.lfo, 0, 0), o = addModule(p, DEFS.osc, 200, 0), out = addModule(p, DEFS.output, 400, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: o.id, port: 'p1' });
    o.att = [1.5, 1];
    expect(formatOf(p)).toBe(WRITE_FLOOR);
  });
});

/** a patch: an LFO into a filter's p1, which plays cutoff between two ends */
function ranged(bi: boolean): Patch {
  const p = emptyPatch();
  const lfo = addModule(p, DEFS.lfo, 0, 0), f = addModule(p, DEFS.filter, 200, 0), out = addModule(p, DEFS.output, 400, 0);
  connect(p, DEFS, { module: f.id, port: 'lp24' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: f.id, port: 'p1' });
  f.map!.p1 = ['cutoff'];
  f.range = { p1: { cutoff: bi ? [0.2, 0.8, 1] : [0.2, 0.8] } };
  return p;
}

describe('a bipolar macro range (#526)', () => {
  it('spans −1..1 across its ends; a plain one 0..1', () => {
    expect(rangeShare([0, 1, 1], -1)).toBe(0);
    expect(rangeShare([0, 1, 1], 0)).toBe(0.5);
    expect(rangeShare([0, 1, 1], 1)).toBe(1);
    expect(rangeShare([0, 1], 0.25)).toBe(0.25);
  });

  it('is bit 7 of the pin byte and writes format 49; a plain one stays in the older format', () => {
    const plain = encodePatch(ranged(false)), bi = encodePatch(ranged(true));
    expect(plain[1]).toBe(WRITE_FLOOR);
    expect(bi[1]).toBe(FORMAT_1_9);
    // the macro ranges are last: count, module, pin, parameter, low, high
    expect(plain.slice(-6)).toEqual(Uint8Array.from([1, 1, 0, 0, 51, 204]));
    expect(bi.slice(-6)).toEqual(Uint8Array.from([1, 1, RANGE_BIPOLAR, 0, 51, 204]));
  });

  it('survives a save and goes to the FM-1 live with bit 1 of on', () => {
    const p = validatePatch(JSON.parse(JSON.stringify(ranged(true))), DEFS);
    expect(p.modules[1].range).toEqual({ p1: { cutoff: [0.2, 0.8, 1] } });
    expect(parse(rangeFrame(1, 0, 0, [0, 1, 1]))!.payload).toEqual([1, 0, 0, 3, 0, 255]);
    expect(parse(rangeFrame(1, 0, 0, [0, 1]))!.payload).toEqual([1, 0, 0, 1, 0, 255]);
  });

  it('is made bipolar for a source that swings both ways (an LFO), not for an envelope or a pitch', () => {
    const p = emptyPatch();
    const lfo = addModule(p, DEFS.lfo, 0, 0), env = addModule(p, DEFS.adsr, 0, 100), main = addModule(p, DEFS.fm1, 0, 200);
    const to = { module: 99, port: 'p1' };
    expect(swingsBoth(p, { from: { module: lfo.id, port: 'out' }, to })).toBe(true);
    expect(swingsBoth(p, { from: { module: env.id, port: 'env' }, to })).toBe(false);
    expect(swingsBoth(p, { from: { module: main.id, port: 'pitch' }, to })).toBe(false);
    expect(swingsBoth(p, { from: { module: main.id, port: 'bend' }, to })).toBe(true);
  });
});

/** run a Range module over the input values `xs` with these parameters */
function range(xs: number[], p: Record<string, number> = {}): number[] {
  const def = DEFS.range;
  const params = { ...Object.fromEntries(def.params.map((q) => [q.name, q.default])), ...p };
  const out = new Float32Array(xs.length);
  IMPLS.range.process({ sr: 44118, n: xs.length, inp: { in: Float32Array.from(xs), p1: new Float32Array(xs.length), p2: new Float32Array(xs.length) }, out: { out }, connected: { in: true }, p: params, voice: {} as never }, IMPLS.range.init(44118));
  return [...out];
}
const close = (a: number[], b: number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));

describe('the Range module (#526)', () => {
  it('comes after the Comparator, in format 49, with one input and one output', () => {
    expect(TYPE_ORDER.slice(TYPE_ORDER.indexOf('comp'), TYPE_ORDER.indexOf('comp') + 2)).toEqual(['comp', 'range']);
    expect(DEFS.range.since).toBe(FORMAT_1_9);
    expect(DEFS.range.inputs.map((i) => i.name)).toEqual(['in', 'p1', 'p2']);
    expect(DEFS.range.outputs.map((o) => o.name)).toEqual(['out']);
    expect(DEFS.range.params.map((q) => [q.name, q.default])).toEqual([['inlo', -1], ['inhi', 1], ['outlo', 0], ['outhi', 1], ['curve', 0], ['clamp', 0]]);
    expect(outputRange('range', 'out', { outlo: 0, outhi: 1, clamp: 1 })).toMatch(/^0\.\.1/);
  });

  it('maps −1..1 to 0..1 as made, straight', () => close(range([-1, -0.5, 0, 0.5, 1]), [0, 0.25, 0.5, 0.75, 1]));

  it('runs on past the input range with clamp off, and stops at the ends with it on', () => {
    close(range([-3, 3]), [-1, 2]);
    close(range([-3, 3], { clamp: 1 }), [0, 1]);
    close(range([1e6], { inlo: 0, inhi: 0.01 }), [RANGE_T_MAX]);
  });

  it('maps downwards when a pair runs downwards', () => {
    close(range([0, 0.5, 1], { inlo: 0, inhi: 1, outlo: 5, outhi: -5 }), [5, 0, -5]);
    close(range([0, 0.25, 1], { inlo: 1, inhi: 0, outlo: 0, outhi: 1 }), [1, 0.75, 0]);
  });

  it('bends: +1 exponential (t²), −1 logarithmic (2t − t²), straight on with the end\'s slope outside', () => {
    close(range([0, 0.5, 1], { inlo: 0, inhi: 1, curve: 1 }), [0, 0.25, 1]);
    close(range([0, 0.5, 1], { inlo: 0, inhi: 1, curve: -1 }), [0, 0.75, 1]);
    for (const c of [-1, -0.4, 0, 0.6, 1]) {
      for (const t of [0, 1]) expect(rangeCurve(t + 1e-9, c)).toBeCloseTo(rangeCurve(t - 1e-9, c), 6);
      for (let t = -2; t < 3; t += 0.05) expect(rangeCurve(t + 0.05, c)).toBeGreaterThanOrEqual(rangeCurve(t, c) - 1e-12);
    }
  });

  it('gives out low when in low and in high are the same', () => close(range([-1, 0, 1], { inlo: 0.3, inhi: 0.3, outlo: 0.2 }), [0.2, 0.2, 0.2]));

  it('is written in format 49 when it reaches the FM-1\'s patch', () => {
    const p = emptyPatch();
    const lfo = addModule(p, DEFS.lfo, 0, 0), r = addModule(p, DEFS.range, 200, 0), out = addModule(p, DEFS.output, 400, 0);
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: out.id, port: 'l' });
    expect(formatOf(p)).toBe(WRITE_FLOOR);
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: r.id, port: 'in' });
    connect(p, DEFS, { module: r.id, port: 'out' }, { module: out.id, port: 'r' });
    expect(encodePatch(p)[1]).toBe(FORMAT_1_9);
  });
});
