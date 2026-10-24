// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ClockOut, LOOKAHEAD, clockPeriod, isFm1Out, portLabels, type ClockPort } from './clock-out';

const port = (id: string, name: string, state = 'connected'): ClockPort & { sent: [number[], number][] } => {
  const sent: [number[], number][] = [];
  return { id, name, state, sent, send: (d, t) => void sent.push([d, t ?? 0]) };
};

describe('clock out', () => {
  it('sends 24 clocks a quarter note at the tempo, ahead of time with timestamps', () => {
    let t = 1000;
    const a = port('a', 'FM-1'), c = new ClockOut(() => 120, () => t);
    c.setPorts([a]);
    c.enable(true);
    expect(clockPeriod(120)).toBeCloseTo(500 / 24);
    for (; t < 1000 + 500; t += 25) c.pump();
    const clocks = a.sent.filter(([d]) => d[0] === 0xf8).map(([, at]) => at);
    // a beat later, the clocks up to now + LOOKAHEAD are out, evenly spaced from the moment it was switched on
    expect(clocks.length).toBe(Math.ceil((500 - 25 + LOOKAHEAD) / clockPeriod(120)));
    clocks.forEach((at, i) => expect(at).toBeCloseTo(1000 + i * clockPeriod(120)));
  });

  it('follows a tempo change at the next clock, clamps the tempo as the engines do', () => {
    let t = 0, bpm = 120;
    const a = port('a', 'FM-1'), c = new ClockOut(() => bpm, () => t);
    c.setPorts([a]);
    c.enable(true);
    const n = a.sent.length;
    bpm = 60;
    t = 100;
    c.pump();
    // the clock already sent was spaced at 120 bpm; the ones after it at 60
    const at = a.sent.slice(n - 1).map(([, x]) => x);
    expect(at.length).toBeGreaterThan(2);
    expect(at[1] - at[0]).toBeCloseTo(clockPeriod(120));
    expect(at[2] - at[1]).toBeCloseTo(clockPeriod(60));
    expect(clockPeriod(1000)).toBe(clockPeriod(300));
    expect(clockPeriod(Number.NaN)).toBe(clockPeriod(120));
  });

  it('sends Start / Stop with Play to every ticked, connected port, and nothing while off', () => {
    const t = 0, a = port('a', 'FM-1'), b = port('b', 'FM-1'), gone = port('g', 'FM-1', 'disconnected');
    const c = new ClockOut(() => 120, () => t);
    c.setPorts([a, b, gone]);
    c.transport(true);
    expect(a.sent).toEqual([]);
    c.enable(true);
    c.transport(true);
    c.transport(false);
    for (const p of [a, b]) expect(p.sent.filter(([d]) => d[0] !== 0xf8).map(([d]) => d[0])).toEqual([0xfa, 0xfc]);
    expect(gone.sent).toEqual([]);
    c.enable(false);
    const n = a.sent.length;
    c.pump();
    c.transport(true);
    expect(a.sent.length).toBe(n);
  });

  it('starts again from now after a long stall instead of sending the missed clocks', () => {
    let t = 0;
    const a = port('a', 'FM-1'), c = new ClockOut(() => 120, () => t);
    c.setPorts([a]);
    c.enable(true);
    const n = a.sent.length;
    t = 60000;
    c.pump();
    expect(a.sent.length - n).toBe(Math.ceil(LOOKAHEAD / clockPeriod(120)));
    expect(a.sent[n][1]).toBe(60000);
  });

  it('a port that throws is skipped', () => {
    const bad: ClockPort = { id: 'x', name: 'FM-1', send: () => { throw new Error('gone'); } }, a = port('a', 'FM-1');
    const c = new ClockOut(() => 120, () => 0);
    c.setPorts([bad, a]);
    expect(() => c.enable(true)).not.toThrow();
    expect(a.sent.length).toBeGreaterThan(0);
  });

  it('ticks FM-1 outputs by default, not their update loader, and tells two FM-1s apart', () => {
    expect(isFm1Out('FM-1')).toBe(true);
    expect(isFm1Out('Matryoshka FM-1')).toBe(true);
    expect(isFm1Out('ota-FM-1_700')).toBe(false);
    expect(isFm1Out('IAC Driver Bus 1')).toBe(false);
    expect([...portLabels([port('1', 'FM-1'), port('2', 'FM-1'), port('3', 'Scarlett 2i2 USB')]).values()]).toEqual(['FM-1', 'FM-1 2', 'Scarlett 2i2 USB']);
  });
});
