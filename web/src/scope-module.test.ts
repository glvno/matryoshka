// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { encodePatch, TYPE_ORDER, deviceBudget } from './patchbin';
import { deviceView } from './poly';
import { Engine } from './engine';
import { ROLL_COLS, ViewStream, VoiceStreams, voiceSums } from './scope-stream';
import { trigger } from './scope-view';
import { deviceIndex } from './device';

/** Main -> osc -> output, plus a Scope watching the oscillator and Main's gate when `scoped` */
function patch(scoped: boolean): Patch {
  const p = emptyPatch('s');
  const kb = addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
  if (scoped) {
    const sc = addModule(p, DEFS.scope, 0, 0);
    expect(connect(p, DEFS, { module: osc.id, port: 'out' }, { module: sc.id, port: 'a' })).toBe(true);
    expect(connect(p, DEFS, { module: kb.id, port: 'gate' }, { module: sc.id, port: 'b' })).toBe(true);
    expect(connect(p, DEFS, { module: kb.id, port: 'keys' }, { module: sc.id, port: 'a' })).toBe(false); // keys are not a signal
  }
  return p;
}

describe('Scope module', () => {
  it('is editor only: no type index, dropped from the device form with its cables, the binary and budget unchanged', () => {
    expect(TYPE_ORDER).not.toContain('scope');
    const p = patch(true);
    const dv = deviceView(p).patch;
    expect(dv.modules.some((m) => m.type === 'scope')).toBe(false);
    expect(dv.cables).toHaveLength(2);
    expect(encodePatch(p)).toEqual(encodePatch(patch(false)));
    const plain = deviceBudget(patch(false));
    const scoped = deviceBudget(p);
    expect(scoped.cpu).toEqual(plain.cpu);
    expect(scoped.items).toEqual(plain.items);
  });

  it('live edits address the module the FM-1 has at that index, past a Scope', () => {
    const p = patch(false);
    const sc = addModule(p, DEFS.scope, 0, 0);
    p.modules.unshift(p.modules.pop()!); // the Scope first in the editor's list
    const out = p.modules.find((m) => m.type === 'output')!;
    expect(deviceIndex(p, out.id)).toBe(2);
    expect(deviceIndex(p, sc.id)).toBe(-1);
  });

  it('does not change the sound', () => {
    const render = (p: Patch): Float32Array => {
      const e = new Engine(48000);
      e.load(p);
      e.noteOn(60);
      const l = new Float32Array(2048);
      e.render(l, new Float32Array(2048));
      return l;
    };
    expect(render(patch(true))).toEqual(render(patch(false)));
  });

  it('keeps raw samples for a short window and min / max columns for a long one, oldest first', () => {
    const short = new ViewStream(100);
    const ramp = Float32Array.from({ length: 300 }, (_, i) => i);
    short.push(ramp, 300);
    const d = short.data();
    expect('raw' in d && d.raw.length).toBe(256);
    if ('raw' in d) expect(d.raw[255]).toBe(299);
    const long = new ViewStream(ROLL_COLS * 10);
    const sig = Float32Array.from({ length: ROLL_COLS * 10 }, (_, i) => (i % 10 === 3 ? 1 : i % 10 === 7 ? -1 : 0));
    long.push(sig, sig.length);
    const r = long.data();
    expect('min' in r).toBe(true);
    if ('min' in r) {
      expect([...r.max].every((v) => v === 1)).toBe(true);
      expect([...r.min].every((v) => v === -1)).toBe(true);
    }
  });

  it('triggers on the latest rising crossing through the middle that leaves a whole window', () => {
    const d = Float32Array.from({ length: 400 }, (_, i) => Math.sin((2 * Math.PI * i) / 100) * 0.5 + 0.2);
    const at = trigger(d, 150);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThanOrEqual(250);
    expect(d[at - 1]).toBeLessThan(0.2);
    expect(d[at]).toBeGreaterThanOrEqual(0.2);
    expect(trigger(new Float32Array(400), 150)).toBe(-1); // flat: free running
  });

  it('per-voice streams (#54): a history per voice, dropped without voices; a sum per voice only when every source has voices', () => {
    const v = (x: number): Float32Array => new Float32Array(128).fill(x);
    const vs = new VoiceStreams(100);
    expect(vs.data()).toBeNull();
    vs.push([v(0.25), v(-0.5)], 128);
    const d = vs.data()!;
    expect(d).toHaveLength(2);
    expect('raw' in d[0] && d[0].raw.at(-1)).toBe(0.25);
    expect('raw' in d[1] && d[1].raw.at(-1)).toBe(-0.5);
    vs.push([v(1), v(1), v(1)], 128); // the voice count changed (a reload): fresh histories
    expect(vs.data()!.map((x) => ('raw' in x ? x.raw[0] : NaN))).toEqual([0, 0, 0]);
    vs.push(null, 128);
    expect(vs.data()).toBeNull();
    const scratch: Float32Array[] = [];
    expect(voiceSums([], 128, scratch)).toBeNull();
    expect(voiceSums([[v(1)], null], 128, scratch)).toBeNull(); // one source runs once
    const sums = voiceSums([[v(1), v(2)], [v(10), v(20), v(30)]], 128, scratch)!;
    expect(sums.map((b) => b[5])).toEqual([11, 22, 30]);
  });
});
