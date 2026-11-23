// SPDX-License-Identifier: GPL-3.0-only
// The pattern store over the link (#901, protocol.ts, device.ts): PATS / PAT, PAT_GET / PAT_DATA, PAT_PUT / PAT_STORED,
// PAT_DEL, PAT_LINK_NOW, INFO's feature bit 25 and bytes 15..19, against a stand-in FM-1 with a store.
import { describe, expect, it } from 'vitest';
import { DeviceLink, PatchRefused, storeFullText, type DeviceEvent } from './device';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { deviceBudget, encodePatch, FLAG_LINKS, FLAG_PATTERNS } from './patchbin';
import { encodePayload, fnv, FNV0, payloadHash } from './pattern-store';
import { CMD, FEATURE_PATTERN_STORE, FEATURE25_PATTERNS_STORED, frame, parse, parseInfo, parseLinkNow, parsePatData, parsePatEntry, parsePatStored, PAT_CHUNK, PAT_FULL, PAT_KEPT, PAT_MISSING, PAT_OK, PAT_RANGE, PAT_USED, patDelFrame, patGetFrame, patPutFrames, patsFrame, slotCount, SLOTS_MAX } from './protocol';

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

  it('marks a kept copy with bit 15 of total in every chunk (#1202 P1)', () => {
    const payload = Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    const frames = patPutFrames(0, 'KEEP ME', payload, true).map((f) => parse(f)!);
    expect(PAT_KEPT).toBe(0x8000);
    expect(frames).toHaveLength(2);
    // total 300 | 0x8000 = 0x812C: byte 2 the low byte, byte 3 bit 7 the kept bit
    expect(frames[0].payload.slice(0, 22)).toEqual([0, 0, 0x2c, 0x81, 0, 0, ...name16('KEEP ME')]);
    expect(frames[0].payload.slice(22)).toEqual(payload.slice(0, PAT_CHUNK));
    expect(frames[1].payload.slice(0, 6)).toEqual([0, 0, 0x2c, 0x81, ...u16(256)]);
    expect(frames[1].payload.slice(22)).toEqual(payload.slice(256));
    // (not kept: the bit is clear)
    expect(parse(patPutFrames(0, 'KEEP ME', payload)[0])!.payload[3]).toBe(1);
  });

  it('reads PAT, PAT_DATA, PAT_STORED and PAT_LINK_NOW', () => {
    const entry = [...u16(2), ...u16(5), ...u16(0x101), ...u16(40), ...u32(0xdeadbeef), ...u32(0x12345678), 3, 1, ...name16('DUB PRESSURE')];
    expect(entry).toHaveLength(34);
    expect(parsePatEntry({ cmd: CMD.pat, payload: entry })).toEqual({ k: 2, count: 5, entry: { id: 0x101, len: 40, hash: 0xdeadbeef, layout: 0x12345678, tracks: 3, readOnly: true, kept: false, name: 'DUB PRESSURE' } });
    // (flags bit 1: a kept copy, #1202 G8)
    expect(parsePatEntry({ cmd: CMD.pat, payload: entry.map((x, i) => (i === 17 ? 2 : x)) })?.entry).toMatchObject({ readOnly: false, kept: true });
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
    expect(old.features25).toBe(0);
    const stored = parseInfo({ cmd: CMD.info, payload: [...base, 2, 48, ...u16(9000), ...u16(60000), 0, 0, 0, 0, 0, 2] })!;
    expect(stored.features25 & FEATURE25_PATTERNS_STORED).toBe(FEATURE25_PATTERNS_STORED);
    expect(slotCount(stored)).toBe(48);
  });
});

// ---- DeviceLink against a stand-in FM-1 with a pattern store

type Port = { id: string; name: string; manufacturer: string; state: string; onmidimessage: ((ev: { data: Uint8Array }) => void) | null; send: (d: Uint8Array) => void };

/** an FM-1 whose store holds `entries` (payloads by id); `store`: feature bit 25 on, 60 slots; `every`: firmware 1.26, which
 *  stores every pattern (INFO byte 25 bit 1), 48 slots, `room` payload bytes for new entries, and kept copies (PAT_KEPT:
 *  written over only by a kept put; older firmware refuses the bit) */
function standIn(store: boolean | 'every', room = Infinity) {
  const entries = new Map<number, { name: string; payload: number[]; kept?: boolean }>();
  const used = new Map<number, number>();
  const sent: { cmd: number; payload: number[] }[] = [];
  let next = 1, put: number[] = [];
  const inp: Port = { id: 'i', name: 'FM-1', manufacturer: '', state: 'connected', onmidimessage: null, send: () => {} };
  const reply = (cmd: number, payload: number[]): void => void setTimeout(() => inp.onmidimessage?.({ data: frame(cmd, payload) }), 0);
  const out: Port = { id: 'o', name: 'FM-1', manufacturer: '', state: 'connected', onmidimessage: null, send: (d) => {
    const p = parse(d)!;
    sent.push(p);
    const x = p.payload, id = x[0] | (x[1] << 8);
    if (p.cmd === CMD.hello) reply(CMD.info, [1, 128, 255, 3, 1, 0, 1, 31, 59, 0, 0, 0, 0, 0, store ? 2 : 0, store === 'every' ? 48 : store ? 60 : 0, ...u16(8000), ...u16(12000), ...(store === 'every' ? [0, 0, 0, 0, 0, 2] : [])]);
    else if (p.cmd === CMD.chunk || p.cmd === CMD.commit || p.cmd === CMD.slot) reply(CMD.ack, [p.cmd, p.cmd === CMD.chunk ? x[0] : p.cmd === CMD.slot ? x[0] : 0, 0, 0]);
    else if (p.cmd === CMD.pats) {
      const list = [...entries].map(([k, e]) => [...u16(k), ...u16(e.payload.length), ...u32(fnv(FNV0, e.payload)), 0, 0, 0, 0, 1, 0, ...name16(e.name)]);
      if (!list.length) reply(CMD.pat, [0, 0, 0, 0]);
      list.forEach((e, k) => reply(CMD.pat, [...u16(k), ...u16(list.length), ...e]));
    } else if (p.cmd === CMD.patGet) {
      const e = entries.get(id), off = x[2] | (x[3] << 8);
      reply(CMD.patData, e ? [...u16(id), ...u16(e.payload.length), ...u16(off), ...e.payload.slice(off, off + PAT_CHUNK)] : [...u16(id), 0xff, 0xff, 0, 0]);
    } else if (p.cmd === CMD.patPut) {
      const kept = !!(x[3] & 0x80), total = (x[2] | (x[3] << 8)) & 0x7fff, off = x[4] | (x[5] << 8);
      if (!off) put = [];
      put.push(...x.slice(22));
      if (put.length < total) return reply(CMD.patStored, [0xff, 0xff, PAT_OK, 0]);
      if (id >= 0xf000 || (kept && store !== 'every')) return reply(CMD.patStored, [...u16(id), PAT_RANGE, 0]);
      if (id && (!entries.has(id) || !!entries.get(id)!.kept !== kept)) return reply(CMD.patStored, [...u16(id), PAT_MISSING, 0]);
      const at = id || next++;
      if (!id && put.length > room) return reply(CMD.patStored, [...u16(0), PAT_FULL, 0]);
      if (!id) room -= put.length;
      entries.set(at, { name: String.fromCharCode(...x.slice(6, 22).filter(Boolean)), payload: put, ...(kept ? { kept } : {}) });
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

  it('keeps a copy with PAT_KEPT on a 1.26 FM-1 and renames it with a kept put; older firmware refuses it (#1202 P1)', async () => {
    const fm1 = standIn('every');
    const link = await linked(fm1);
    const payload = encodePayload(patch(), 1);
    const id = await link.putPattern(0, 'KEPT ONE', payload, true);
    expect(fm1.entries.get(id)).toEqual({ name: 'KEPT ONE', payload: Array.from(payload), kept: true });
    fm1.sent.length = 0;
    expect(await link.putPattern(id, 'RENAMED', payload)).toBe(id);
    // (the plain put is refused as missing, the kept one goes through)
    expect(fm1.sent.filter((s) => s.cmd === CMD.patPut).map((s) => s.payload[3] & 0x80)).toEqual([0, 0x80]);
    expect(fm1.entries.get(id)).toMatchObject({ name: 'RENAMED', kept: true });
    await expect(link.putPattern(99, 'GONE', payload)).rejects.toThrow('no such pattern');
    const old = await linked(standIn(true));
    await expect(old.putPattern(0, 'KEPT ONE', payload, true)).rejects.toThrow('refused');
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
    expect(Array.from(sentBin())).toEqual(Array.from(encodePatch(p, false, 0, 0, link.linkStore)));
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

  const flagsOf = (b: Uint8Array): number => b[6] | (b[7] << 8);
  const cmds = (fm1: ReturnType<typeof standIn>): number[] => fm1.sent.map((s) => s.cmd).filter((c) => c !== CMD.hello);

  it('to an FM-1 that stores every pattern (#1202): the patterns go into its store first, then the patch, which carries references', async () => {
    const fm1 = standIn('every');
    const link = await linked(fm1);
    expect([link.patternsStored, link.budgetStore, link.bankSlots]).toEqual([true, 'every', 48]);
    const p = patch();
    const sent = await link.upload(p);
    expect(sent.inline).toEqual([]);
    expect(cmds(fm1)).toEqual([CMD.pats, CMD.patPut, CMD.chunk, CMD.commit]);
    expect([...fm1.entries.values()].map((e) => [e.name, e.payload])).toEqual([['LINKED P02', Array.from(encodePayload(p, 1))]]);
    const bin = Uint8Array.from(fm1.sent.filter((s) => s.cmd === CMD.chunk).flatMap((s) => s.payload.slice(5)));
    expect(Array.from(bin)).toEqual(Array.from(sent.bin));
    expect(flagsOf(bin) & (FLAG_LINKS | FLAG_PATTERNS)).toBe(FLAG_LINKS);
    expect(Array.from(link.encodeFor(p))).toEqual(Array.from(sent.bin));   // (what the FM-1 holds now: Live sends nothing more)
    // a slot write links the same entry: nothing more is stored. Each patch: its patterns, then its slot
    fm1.sent.length = 0;
    const other = patch();
    other.name = 'OTHER';
    other.modules.find((m) => m.type === 'steps')!.patterns = [null, { notes: [{ at: 2, len: 1, note: 50, vel: 90 }] }];
    await link.uploadSlot(3, 'LINKED', p);
    await link.uploadSlot(4, 'OTHER', other);
    expect(cmds(fm1)).toEqual([CMD.pats, CMD.chunk, CMD.slot, CMD.pats, CMD.patPut, CMD.chunk, CMD.slot]);
    expect(fm1.entries.get(2)?.name).toBe('OTHER P03');
  });

  it('a full store sends that pattern inside the patch and says so; a patch too big then is refused before its slot', async () => {
    const fm1 = standIn('every', 0);
    const link = await linked(fm1);
    const sent = await link.upload(patch());
    expect(sent.inline).toEqual([1]);
    expect(storeFullText('LINKED', sent.inline)).toContain('P02');
    expect(flagsOf(sent.bin) & (FLAG_LINKS | FLAG_PATTERNS)).toBe(FLAG_PATTERNS);
    const big = patch();
    big.modules.find((m) => m.type === 'steps')!.patterns = Array.from({ length: 60 }, (_, i) => ({ notes: Array.from({ length: 16 }, (_, at) => ({ at, len: 1, note: 40 + ((at + i) % 40), vel: 100, chance: 50 })) }));
    expect(deviceBudget(big, 0, 'every').fits).toBe(true);
    expect(deviceBudget(big).fits).toBe(false);
    fm1.sent.length = 0;
    await expect(link.uploadSlot(0, 'BIG', big)).rejects.toThrow(PatchRefused);
    expect(cmds(fm1)).not.toContain(CMD.slot);
    expect(cmds(fm1)).not.toContain(CMD.chunk);
  });
});
