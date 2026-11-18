// SPDX-License-Identifier: GPL-3.0-only
// The Limiter (#1019): nothing passes the ceiling, the lookahead lowers the gain before a peak, gr reports it; format 62.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFS, IMPLS, LIMIT_AHEAD } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { encodePatch, formatOf, FORMAT_1_19, lineBudget, LINES } from './patchbin';
import { grDb, grText } from './limit-view';

const SR = 44118;
const BLOCK = 128;

/** run the Limiter on `src` (a function of the sample index), return its outputs */
function limit(src: (i: number) => number, len: number, p: Record<string, number> = {}) {
  const impl = IMPLS.limit, def = DEFS.limit;
  const st = impl.init(SR);
  const params = { ...Object.fromEntries(def.params.map((q) => [q.name, q.default])), ...p };
  const out = new Float32Array(len), gr = new Float32Array(len);
  for (let at = 0; at < len; at += BLOCK) {
    const n = Math.min(BLOCK, len - at);
    const inp = new Float32Array(n);
    for (let i = 0; i < n; i++) inp[i] = src(at + i);
    const o = { out: new Float32Array(n), gr: new Float32Array(n) };
    impl.process({ sr: SR, n, inp: { in: inp }, out: o, connected: { in: true }, p: params, voice: {} as never }, st);
    out.set(o.out, at);
    gr.set(o.gr, at);
  }
  return { out, gr };
}
const db = (x: number): number => Math.pow(10, x / 20);
const peak = (a: Float32Array): number => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** a loud feedback-like signal: a saw at 20 times full scale with sudden spikes of 200 */
const howl = (i: number): number => 20 * (2 * ((i * 97 / SR) % 1) - 1) + (i % 3001 === 1500 ? 200 : 0);

describe('Limiter', () => {
  for (const ahead of [1, 0])
    for (const ceiling of [0, -1, -12, -30])
      it(`never passes a ${ceiling} dB ceiling (lookahead ${ahead ? 'on' : 'off'})`, () => {
        const { out } = limit(howl, SR, { ceiling, ahead, gain: 24, release: 0.01 });
        expect(peak(out)).toBeLessThanOrEqual(db(ceiling) * (1 + 1e-6));
      });

  it('with lookahead, lowers the gain before a peak: a step is held to the ceiling by the gain, not the clip', () => {
    const step = (i: number): number => (i < 4000 ? 0.1 : 4);
    const { out, gr } = limit(step, 8000, { ceiling: -6 });
    // the gain starts down as the step comes in, so the quiet samples still in the line are already quieter
    expect(out[3999 + LIMIT_AHEAD]).toBeLessThan(0.05);
    // the step leaves the line LIMIT_AHEAD samples late, by then the gain is within 0.1 % of what it needs: the step
    // unclipped would pass the ceiling by less than 1 % (0.07 dB)
    expect(4 * (1 - gr[4000 + LIMIT_AHEAD])).toBeLessThan(db(-6) * 1.01);
    expect(out[4000 + LIMIT_AHEAD]).toBeCloseTo(db(-6), 6);
  });

  it('passes a quiet signal unchanged (delayed by the lookahead, or not at all), gr 0', () => {
    const quiet = (i: number): number => 0.25 * Math.sin(i / 10);
    const on = limit(quiet, 2000);
    const off = limit(quiet, 2000, { ahead: 0 });
    for (let i = LIMIT_AHEAD; i < 2000; i += 37) expect(on.out[i]).toBeCloseTo(quiet(i - LIMIT_AHEAD), 6);
    for (let i = 0; i < 2000; i += 37) expect(off.out[i]).toBeCloseTo(quiet(i), 6);
    expect(peak(on.gr)).toBe(0);
    expect(peak(off.gr)).toBe(0);
  });

  it('releases: the gain comes back within the release time after the loud part ends', () => {
    const burst = (i: number): number => (i < 4000 ? 4 * Math.sin(i / 8) : 0.1 * Math.sin(i / 8));
    const { gr } = limit(burst, 4000 + SR / 2, { ceiling: -6, release: 0.1 });
    expect(gr[3900]).toBeGreaterThan(0.8);
    expect(gr[4000 + Math.round(0.1 * SR) + 2 * LIMIT_AHEAD]).toBeLessThan(0.01 * gr[3900]);
  });
});

function limiterPatch(): Patch {
  const p = emptyPatch('Ears');
  addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 0, 0);
  const lim = addModule(p, DEFS.limit, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: lim.id, port: 'in' });
  connect(p, DEFS, { module: lim.id, port: 'out' }, { module: out.id, port: 'l' });
  return p;
}

describe('Limiter on the FM-1', () => {
  it('is format 62 only in a patch that has one', () => {
    const p = limiterPatch();
    expect(formatOf(p)).toBe(FORMAT_1_19);
    expect(encodePatch(p)[1]).toBe(FORMAT_1_19);
    p.modules = p.modules.filter((m) => m.type !== 'limit');
    p.cables = [];
    expect(formatOf(p)).toBeLessThan(FORMAT_1_19);
  });

  it('takes a lookahead line of the FM-1 memory, as engine.c does', () => {
    const defs = readFileSync(new URL('../../firmware/src/defs.h', import.meta.url), 'utf8');
    expect(Number(/#define LIMIT_AHEAD (\d+)/.exec(defs)?.[1])).toBe(LIMIT_AHEAD);
    expect(LINES.limit).toBe(4 * LIMIT_AHEAD);
    const b = lineBudget(limiterPatch());
    expect(b.modules).toEqual([{ id: expect.any(Number), type: 'limit', copies: 1, bytes: LINES.limit }]);
    expect(b.fits).toBe(true);
  });
});

describe('Limiter card readout', () => {
  it('shows the reduction in dB', () => {
    expect(grText(grDb(0))).toBe('0.0');
    expect(grText(grDb(0.5))).toBe('−6.0');
    expect(grText(grDb(0.9))).toBe('−20.0');
  });
});
