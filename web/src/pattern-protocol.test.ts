// SPDX-License-Identifier: GPL-3.0-only
// The pattern store over the link (#901, protocol.ts, device.ts): PATS / PAT, PAT_GET / PAT_DATA, PAT_PUT / PAT_STORED,
// PAT_DEL, PAT_LINK_NOW, INFO's feature bit 25 and bytes 15..19, against a stand-in FM-1 with a store.
import { describe, expect, it } from 'vitest';
import { DeviceLink, type DeviceEvent } from './device';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { encodePatch, FLAG_LINKS } from './patchbin';
import { encodePayload, fnv, FNV0, payloadHash } from './pattern-store';
import { CMD, FEATURE_PATTERN_STORE, frame, parse, parseInfo, parseLinkNow, parsePatData, parsePatEntry, parsePatStored, PAT_CHUNK, PAT_MISSING, PAT_OK, PAT_RANGE, PAT_USED, patDelFrame, patGetFrame, patPutFrames, patsFrame, slotCount, SLOTS_MAX } from './protocol';

const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const name16 = (s: string): number[] => Array.from({ length: 16 }, (_, i) => s.charCodeAt(i) || 0);

describe('pattern store frames', () => {
  it('asks for the list, a payload piece and a delete', () => {
    expect(parse(patsFrame())).toEqual({ cmd: 0x3b, payload: [] });
    expect(parse(patGetFrame(0x1234, 256))).toEqual({ cmd: 0x3c, payload: [0x34, 0x12, 0, 1] });
    expect(parse(patDelFrame(7, true))).toEqual({ cmd: 0x3e, payload: [7, 0, 1] });
    expect(parse(patDelFrame(7, false))!.payload[2]).toBe(0);
  });

  it('puts a payload in chunks of 256 with the id, total, offset and name', () => {
    const payload = Array.from({ length: 300 }, (_, i) => i & 0xff);
    const frames = patPutFrames(0, 'MY BEAT', payload).map((f) => parse(f)!);
    expect(frames.map((f) => f.cmd)).toEqual([0x3d, 0x3d]);
    expect(frames[0].payload.slice(0, 22)).toEqual([0, 0, ...u16(300), 0, 0, ...name16('MY BEAT')]);
    expect(frames[0].payload.slice(22)).toEqual(payload.slice(0, PAT_CHUNK));
    expect(frames[1].payload.slice(0, 6)).toEqual([0, 0, ...u16(300), ...u16(256)]);
    expect(frames[1].payload.slice(22)).toEqual(payload.slice(256));
    expect(patPutFrames(9, 'X', [1, 2, 3])).toHaveLength(1);
  });

  it('reads PAT, PAT_DATA, PAT_STORED and PAT_LINK_NOW', () => {
    const entry = [...u16(2), ...u16(5), ...u16(0x101), ...u16(40), ...u32(0xdeadbeef), ...u32(0x12345678), 3, 1, ...name16('DUB PRESSURE')];
    expect(entry).toHaveLength(34);
    expect(parsePatEntry({ cmd: CMD.pat, payload: entry })).toEqual({ k: 2, count: 5, entry: { id: 0x101, len: 40, hash: 0xdeadbeef, layout: 0x12345678, tracks: 3, readOnly: true, name: 'DUB PRESSURE' } });
    expect(parsePatEntry({ cmd: CMD.pat, payload: [0, 0, 0, 0] })).toEqual({ k: 0, count: 0, entry: null });
    expect(parsePatEntry({ cmd: CMD.pat, payload: entry.slice(0, 20) })).toBeNull();
    expect(parsePatData({ cmd: CMD.patData, payload: [...u16(3), ...u16(0xffff), 0, 0] })).toEqual({ id: 3, total: null, offset: 0, bytes: [] });
    expect(parsePatData({ cmd: CMD.patData, payload: [...u16(3), ...u16(4), ...u16(2), 9, 8] })).toEqual({ id: 3, total: 4, offset: 2, bytes: [9, 8] });
    expect(parsePatStored({ cmd: CMD.patStored, payload: [...u16(9), PAT_USED, 4] })).toEqual({ id: 9, status: PAT_USED, count: 4 });
    expect(parseLinkNow([3, ...u16(0x2a), ...u32(0xcafef00d)])).toEqual({ pattern: 3, id: 0x2a, hash: 0xcafef00d });
    expect(parseLinkNow([3, 0])).toBeNull();
  });

  it('INFO says the store is on (feature bit 25), the bank\'s slots and the store\'s bytes', () => {
    const base = [1, 128, 255, 3, 1, 0, 0, 31, 59, 0, 0, 0, 0, 0];
    const on = parseInfo({ cmd: CMD.info, payload: [...base, 2, 60, ...u16(9000), ...u16(12000)] })!;
    expect(on.features & FEATURE_PATTERN_STORE).toBe(FEATURE_PATTERN_STORE);
    expect(on.slots).toBe(60);
    expect(on.store).toEqual({ free: 9000, total: 12000 });
    expect(slotCount(on)).toBe(60);
    const old = parseInfo({ cmd: CMD.info, payload: base })!;
    expect(old.features & FEATURE_PATTERN_STORE).toBe(0);
    expect(old.slots).toBeUndefined();
    expect(slotCount(old)).toBe(SLOTS_MAX);
    expect(slotCount(null)).toBe(64);
  });
});

// ---- DeviceLink against a stand-in FM-1 with a pattern store

type Port = { id: string; name: string; manufacturer: string; state: string; onmidimessage: ((ev: { data: Uint8Array }) => void) | null; send: (d: Uint8Array) => void };

/** an FM-1 whose store holds `entries` (payloads by id); `store`: feature bit 25 on, 60 slots */
function standIn(store: boolean) {
  const entries = new Map<number, { name: string; payload: number[] }>();
  const used = new Map<number, number>();
  const sent: { cmd: number; payload: number[] }[] = [];
  let next = 1, put: number[] = [];
  const inp: Port = { id: 'i', name: 'FM-1', manufacturer: '', state: 'connected', onmidimessage: null, send: () => {} };
  const reply = (cmd: number, payload: number[]): void => void setTimeout(() => inp.onmidimessage?.({ data: frame(cmd, payload) }), 0);
  const out: Port = { id: 'o', name: 'FM-1', manufacturer: '', state: 'connected', onmidimessage: null, send: (d) => {
    const p = parse(d)!;
    sent.push(p);
    const x = p.payload, id = x[0] | (x[1] << 8);
    if (p.cmd === CMD.hello) reply(CMD.info, [1, 128, 255, 3, 1, 0, 1, 31, 59, 0, 0, 0, 0, 0, store ? 2 : 0, store ? 60 : 0, ...u16(8000), ...u16(12000)]);
    else if (p.cmd === CMD.chunk || p.cmd === CMD.commit || p.cmd === CMD.slot) reply(CMD.ack, [p.cmd, p.cmd === CMD.chunk ? x[0] : p.cmd === CMD.slot ? x[0] : 0, 0, 0]);
    else if (p.cmd === CMD.pats) {
      const list = [...entries].map(([k, e]) => [...u16(k), ...u16(e.payload.length), ...u32(fnv(FNV0, e.payload)), 0, 0, 0, 0, 1, 0, ...name16(e.name)]);
      if (!list.length) reply(CMD.pat, [0, 0, 0, 0]);
      list.forEach((e, k) => reply(CMD.pat, [...u16(k), ...u16(list.length), ...e]));
    } else if (p.cmd === CMD.patGet) {
      const e = entries.get(id), off = x[2] | (x[3] << 8);
      reply(CMD.patData, e ? [...u16(id), ...u16(e.payload.length), ...u16(off), ...e.payload.slice(off, off + PAT_CHUNK)] : [...u16(id), 0xff, 0xff, 0, 0]);
    } else if (p.cmd === CMD.patPut) {
      const total = x[2] | (x[3] << 8), off = x[4] | (x[5] << 8);
      if (!off) put = [];
      put.push(...x.slice(22));
      if (put.length < total) return reply(CMD.patStored, [0xff, 0xff, PAT_OK, 0]);
      if (id >= 0xf000) return reply(CMD.patStored, [...u16(id), PAT_RANGE, 0]);
      if (id && !entries.has(id)) return reply(CMD.patStored, [...u16(id), PAT_MISSING, 0]);
      const at = id || next++;
      entries.set(at, { name: String.fromCharCode(...x.slice(6, 22).filter(Boolean)), payload: put });
      reply(CMD.patStored, [...u16(at), PAT_OK, 0]);
    } else if (p.cmd === CMD.patDel) {
      if (!entries.has(id)) return reply(CMD.patStored, [...u16(id), PAT_MISSING, 0]);
      if (!x[2] && used.get(id)) return reply(CMD.patStored, [...u16(id), PAT_USED, used.get(id)!]);
      entries.delete(id);
      reply(CMD.patStored, [...u16(id), PAT_OK, 0]);
    }
  } };
  return { inp, out, entries, used, sent, linkNow: (pattern: number, id: number, hash: number) => inp.onmidimessage?.({ data: frame(CMD.patLinkNow, [pattern, ...u16(id), ...u32(hash)]) }) };
}

async function linked(fm1: ReturnType<typeof standIn>): Promise<DeviceLink> {
  const g = globalThis as unknown as { window?: unknown; navigator: { requestMIDIAccess?: unknown } };
  g.window ??= globalThis;
  g.navigator.requestMIDIAccess = async () => ({ inputs: new Map([['i', fm1.inp]]), outputs: new Map([['o', fm1.out]]), onstatechange: null });
  const link = new DeviceLink();
  await link.connect();
  return link;
}

function patch(): Patch {
  const p = emptyPatch('LINKED');
  addModule(p, DEFS.fm1, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  const st = addModule(p, DEFS.steps, 0, 0);
  connect(p, DEFS, { module: st.id, port: 'pitch' }, { module: out.id, port: 'l' });
  st.notes = [{ at: 0, len: 1, note: 36, vel: 100 }];
  st.patterns = [{ notes: [{ at: 1, len: 1, note: 38, vel: 127 }, { at: 3, len: 1, note: 40, vel: 100 }] }];
  return p;
}

describe('DeviceLink and the pattern store', () => {
  it('lists, gets, puts, renames and deletes stored patterns, and knows the bank\'s slots', async () => {
    const fm1 = standIn(true);
    const link = await linked(fm1);
    expect(link.hasPatternStore).toBe(true);
    expect(link.bankSlots).toBe(60);
    expect(link.linkStore).toBe('unknown');
    expect(await link.listPatterns()).toEqual([]);
    expect(link.linkStore).toEqual(new Map());
    const long = Uint8Array.from({ length: 600 }, (_, i) => i & 0xff);
    const id = await link.putPattern(0, 'LONG ONE', long);
    expect(id).toBe(1);
    expect(fm1.sent.filter((s) => s.cmd === CMD.patPut)).toHaveLength(3);
    expect(Array.from((await link.getPattern(id))!)).toEqual(Array.from(long));
    expect(await link.getPattern(99)).toBeNull();
    expect(link.linkStore).toEqual(new Map([[1, fnv(FNV0, long)]]));
    await link.putPattern(id, 'RENAMED', long);
    const list = await link.listPatterns();
    expect(list.map((e) => [e.id, e.name, e.len])).toEqual([[1, 'RENAMED', 600]]);
    await expect(link.putPattern(0xff01, 'X', long)).rejects.toThrow('read-only');
    fm1.used.set(1, 3);
    expect(await link.deletePattern(1, false)).toEqual({ deleted: false, used: 3 });
    expect(await link.deletePattern(1, true)).toEqual({ deleted: true, used: 0 });
    expect(link.linkStore).toEqual(new Map());
    await expect(link.deletePattern(1, true)).rejects.toThrow('no such pattern');
  });

  it('sends a clean link as a reference to an FM-1 that holds it, the pattern whole otherwise, and no links without a store', async () => {
    const p = patch();
    const main = p.modules.find((m) => m.type === 'fm1')!;
    const fm1 = standIn(true);
    const link = await linked(fm1);
    const id = await link.putPattern(0, 'P2', encodePayload(p, 1));
    main.seq = { links: { 1: { id, hash: payloadHash(p, 1) } } };
    expect(link.linkStore).toBe('unknown');   // (the list not read yet: the pattern would go whole, with its reference)
    await link.listPatterns();
    await link.upload(p);
    const sentBin = (): Uint8Array => Uint8Array.from(fm1.sent.filter((s) => s.cmd === CMD.chunk).flatMap((s) => s.payload.slice(5)));
    expect(Array.from(sentBin())).toEqual(Array.from(encodePatch(p, false, false, 0, link.linkStore)));
    expect(Array.from(sentBin())).toEqual(Array.from(encodePatch(p)));   // (the store holds it as the link says: a reference)
    const old = standIn(false);
    const plain = await linked(old);
    expect(plain.linkStore).toBe('none');
    expect(plain.bankSlots).toBe(64);
    await plain.upload(p);
    const bin = Uint8Array.from(old.sent.filter((s) => s.cmd === CMD.chunk).flatMap((s) => s.payload.slice(5)));
    expect((bin[6] | (bin[7] << 8)) & FLAG_LINKS).toBe(0);
  });

  it('reports a link changed on the FM-1 and learns what its store holds', async () => {
    const fm1 = standIn(true);
    const link = await linked(fm1);
    await link.listPatterns();
    const events: DeviceEvent[] = [];
    link.onEvent = (e) => events.push(e);
    fm1.linkNow(2, 5, 0x1234);
    expect(events).toEqual([{ kind: 'link', pattern: 2, id: 5, hash: 0x1234 }]);
    expect(link.linkStore).toEqual(new Map([[5, 0x1234]]));
  });
});
