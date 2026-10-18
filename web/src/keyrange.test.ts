// The Voice allocator's channel / low / high: which keys a group takes (patch.ts takesKey), the binary record, the engine.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, MAX_PARTS, polyCfg, takesKey, type Patch } from './patch';
import { encodePatch, GROUP_REC } from './patchbin';
import { deviceView } from './poly';

/** Main keys -> an allocator (one voice) -> osc -> output, with the allocator's settings */
function split(params: Record<string, number>): { p: Patch; alloc: number } {
  const p = emptyPatch('split');
  const main = addModule(p, DEFS.fm1, 0, 0);
  const alloc = addModule(p, DEFS.alloc, 0, 0);
  Object.assign(alloc.params, { voices: 1, ...params });
  const osc = addModule(p, DEFS.osc, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
  connect(p, DEFS, { module: alloc.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
  return { p, alloc: alloc.id };
}

describe('allocator key range', () => {
  it('takesKey: range always, channel for direct keys (none set = the device channel)', () => {
    const cfg = { parts: 1, assign: 0, legato: 0, priority: 0, channel: 2, low: 60, high: 72 };
    expect(takesKey(cfg, 59, 2)).toBe(false);
    expect(takesKey(cfg, 60, 2)).toBe(true);
    expect(takesKey(cfg, 73, 2)).toBe(false);
    expect(takesKey(cfg, 64, 1)).toBe(false);
    expect(takesKey(cfg, 64)).toBe(true); // an arpeggiator's note: the range only
    const any = { parts: 1, assign: 0, legato: 0, priority: 0 };
    expect(takesKey(any, 10, 5)).toBe(true);
    expect(takesKey(any, 10, 5, 3)).toBe(false);
    expect(takesKey(any, 10, 3, 3)).toBe(true);
  });

  it('defaults leave the config as before; a split allocator gets a group of its own', () => {
    const plain = split({});
    expect(polyCfg(plain.p.modules.find((m) => m.id === plain.alloc)!)).toEqual({ parts: 1, assign: 0, legato: 0, priority: 0 });
    expect(deviceView(plain.p).groups).toHaveLength(0);
    const s = split({ channel: 2, low: 48, high: 59 });
    const { groups } = deviceView(s.p);
    expect(groups).toHaveLength(1);
    expect(groups[0].cfg).toMatchObject({ channel: 2, low: 48, high: 59 });
    const bin = encodePatch(s.p);
    expect([...bin.subarray(8 + 5 + 5 * MAX_PARTS, 8 + GROUP_REC)]).toEqual([2, 48, 59]);
  });

  it('the engine plays only the keys the allocator takes', () => {
    const { p, alloc } = split({ channel: 2, low: 60 });
    const e = new Engine(48000);
    e.load(p);
    const l = new Float32Array(128), r = new Float32Array(128);
    const gate = (): number => { e.render(l, r); return e.probe(alloc, 'gate')![0]; };
    e.noteOn(64, 1, 1);
    expect(gate()).toBe(0); // wrong channel
    e.noteOn(50, 1, 2);
    expect(gate()).toBe(0); // below the range
    e.noteOn(64, 1, 2);
    expect(gate()).toBe(1);
    e.noteOff(64, 1);
    expect(gate()).toBe(1); // an off on another channel is not this key's
    e.noteOff(64, 2);
    expect(gate()).toBe(0);
  });

  it('without a channel the allocator follows the device channel', () => {
    const { p, alloc } = split({ high: 100 });
    const e = new Engine(48000);
    e.load(p);
    e.channel = 3;
    const l = new Float32Array(128), r = new Float32Array(128);
    e.noteOn(64, 1, 1);
    e.render(l, r);
    expect(e.probe(alloc, 'gate')![0]).toBe(0);
    e.noteOn(64, 1, 3);
    e.render(l, r);
    expect(e.probe(alloc, 'gate')![0]).toBe(1);
  });
});
