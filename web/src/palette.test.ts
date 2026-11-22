// SPDX-License-Identifier: GPL-3.0-only
// The palette (#1196): the entry an editor patch makes, the entry applied to a copy, and the editor's side of the link
// against a stand-in FM-1 that keeps a palette as build/palette/spec.md §5 says (test-palette-fm1.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly, type AssemblyInst } from './assembly';
import { binLength, slotMoves, type Candidate } from './bank';
import { DeviceLink } from './device';
import { addUserPreset, applyPreset, currentValues, presetsOf, setFactoryPresets } from './device-presets';
import { DEFS } from './modules';
import { connect, newPatch, type Patch } from './patch';
import { applyEntry, entryOf, moveOrder, Palette, PALETTE_STORE, paletteDevices, repointed, type PalettePorts } from './palette';
import { chipMeta } from './palette-view';
import { PALETTE, type PaletteEntry } from './protocol';
import { structureOf } from './structure';
import { PaletteFm1 } from './test-palette-fm1';

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  setFactoryPresets([]);
});

/** a patch with one engine set to user preset Warm1, and a second preset Bright of the same engine with other values */
function padPatch(name = 'My Pad'): { p: Patch; a: AssemblyInst; structure: number } {
  const p = newPatch(DEFS);
  p.name = name;
  const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 0, 0);
  const out = p.modules.find((m) => m.type === 'output')!;
  connect(p, DEFS, a.outputs[0], { module: out.id, port: DEFS.output.inputs[0].name });   // (heard: the device form keeps it)
  const s = structureOf(p, a);
  const values = currentValues(p, a);
  addUserPreset(s, 'Warm1', values);
  addUserPreset(s, 'Bright', values.map((v, i) => (i === 0 ? v + 0.25 : v)));
  applyPreset(p, a, presetsOf(p, a).find((x) => x.name === 'Warm1')!);
  return { p, a, structure: parseInt(s, 16) >>> 0 };
}

describe('the entry of a patch (#1196)', () => {
  it('keeps each device with a preset name, by its device index and structure, and the selected pattern', () => {
    const { p, structure } = padPatch();
    p.modules.find((m) => m.type === 'fm1')!.seq = { pattern: 2 };
    const devs = paletteDevices(p);
    expect(devs).toHaveLength(1);
    expect(devs[0]).toMatchObject({ structure, pstructure: structure, name: 'Warm1' });
    expect(entryOf(p, 7)).toMatchObject({ slot: 7, pattern: 2, name: 'MY PAD' });
  });
  it('applies the entry to a copy: another preset by name, values only, and its pattern with no song', () => {
    const { p, a, structure } = padPatch();
    const before = currentValues(p, a)[0];
    const entry: PaletteEntry = { slot: 0, pattern: 3, name: 'MY PAD', devices: [{ dev: paletteDevices(p)[0].dev, structure, pstructure: 0, name: 'bright' }] };
    expect(applyEntry(p, entry)).toEqual([]);
    expect(a.preset).toBe('Bright');
    expect(currentValues(p, a)[0]).toBeCloseTo(before + 0.25);
    expect(p.modules.find((m) => m.type === 'fm1')!.seq).toEqual({ pattern: 3 });
  });
  it('leaves a device whose preset name matches as it is, and names the presets this browser has not got', () => {
    const { p, a, structure } = padPatch();
    const dev = paletteDevices(p)[0].dev;
    expect(applyEntry(p, { slot: 0, pattern: 0, name: 'MY PAD', devices: [{ dev, structure, pstructure: 0, name: 'Warm1' }] })).toEqual([]);
    expect(a.preset).toBe('Warm1');
    expect(applyEntry(p, { slot: 0, pattern: 0, name: 'MY PAD', devices: [{ dev, structure, pstructure: 0, name: 'GONE' }, { dev: 9, structure: 1, pstructure: 0, name: 'ELSEWHERE' }] })).toEqual(['GONE', 'ELSEWHERE']);
    expect(a.preset).toBe('Warm1');
    expect(p.modules.find((m) => m.type === 'fm1')!.seq).toBeUndefined();
  });
  it('moves a chip onto an empty position, and swaps it with a full one', () => {
    expect(moveOrder(0, 3)).toEqual([3, 1, 2, 0, 4, 5, 6, 7]);
  });
  it('shows the first preset, +n, and the pattern on a chip', () => {
    expect(chipMeta({ pos: 0, state: 'ok', name: 'X', presets: ['WARM1', 'B', 'C'], pattern: 2, cur: false, next: false, copy: true })).toBe('WARM1 +2 · P03');
    expect(chipMeta({ pos: 0, state: 'ok', name: 'X', presets: [], pattern: 0, cur: false, next: false, copy: true })).toBe('P01');
  });
});

describe('re-pointing after Send bank (#1196)', () => {
  it('maps each slot whose patch the sent list holds to its new slot, and re-points only the entries that moved', () => {
    const have = [{ slot: 0, used: true, length: 100, name: 'A' }, { slot: 1, used: true, length: 200, name: 'B' }, { slot: 2, used: true, length: 300, name: 'C' }, { slot: 3, used: false, length: 0, name: '' }];
    const moves = slotMoves(have, [{ name: 'b', length: 200 }, { name: 'A', length: 100 }, { name: 'C', length: 999 }]);
    expect([...moves]).toEqual([[0, 1], [1, 0]]);
    const e = (slot: number, name: string): PaletteEntry => ({ slot, pattern: 0, name, devices: [] });
    const now = { version: 1, cur: null, next: null, edited: false, seq: 0, positions: [1, 1, 1, 0, 0, 0, 0, 0].map((state, i) => ({ state: state as 0 | 1, slot: i, pattern: 0, hash: 0, len: 0, name: '' })) };
    expect(repointed(now, [e(0, 'A'), e(1, 'B'), e(2, 'C'), null, null, null, null, null], moves)).toEqual([{ pos: 0, entry: e(1, 'A') }, { pos: 1, entry: e(0, 'B') }]);
  });
});

/** the editor's link to a stand-in FM-1, and a palette on it with recorded ports */
async function linked(o: { features?: number; live?: boolean; candidates?: Candidate[] } = {}) {
  const fm1 = new PaletteFm1({ features: o.features });
  const g = globalThis as unknown as { window?: unknown; navigator: { requestMIDIAccess?: unknown } };
  g.window ??= globalThis;
  g.navigator.requestMIDIAccess = async () => ({ inputs: new Map([[fm1.i.id, fm1.i]]), outputs: new Map([[fm1.o.id, fm1.o]]), onstatechange: null });
  const link = new DeviceLink();
  await link.connect();
  const said: string[] = [], opened: { patch: Patch; adopt: boolean; from: string }[] = [], off: string[] = [];
  let live = o.live ?? false;
  const ports: PalettePorts = {
    device: link,
    candidates: () => o.candidates ?? [],
    live: () => live,
    open: (patch, x) => void opened.push({ patch, ...x }),
    liveOff: (why) => { live = false; off.push(why); },
    say: (t) => void said.push(t),
    changed: () => {},
  };
  const palette = new Palette(ports, storage);
  link.onEvent = (e) => { if (e.kind === 'palette') palette.received(e.now); };
  await palette.connected();
  return { fm1, link, palette, said, opened, off };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('the palette over the link (#1196)', () => {
  it('stores a sound not on the FM-1 into the first free slot, named, then puts it; the chips follow', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'TAKEN' };
    const { p } = padPatch();
    expect(await palette.add('My Pad', p)).toBe(true);
    await settle();
    expect(fm1.slots[1]).toMatchObject({ used: true, name: 'MY PAD', length: binLength(p) });
    expect(fm1.entries[0]).toMatchObject({ slot: 1, name: 'MY PAD', devices: [{ name: 'Warm1' }] });
    expect(palette.chips()[0]).toMatchObject({ state: 'ok', name: 'MY PAD', presets: ['Warm1'] });
    expect(said.at(-1)).toBe('"My Pad" is palette 1');
    expect(fm1.ops.filter((op) => op === PALETTE.entryGet)).toEqual([]);   // (its hash was known: no ENTRY_GET)
  });
  it('points at a sound the FM-1 holds already (its name and length), and at a dragged FM-1 slot', async () => {
    const { fm1, palette } = await linked();
    const { p } = padPatch();
    fm1.slots[5] = { slot: 5, used: true, length: binLength(p), name: 'MY PAD' };
    await palette.add('My Pad', p, { pos: 2 });
    fm1.slots[9] = { slot: 9, used: true, length: 50, name: 'OTHER' };
    await palette.add('OTHER', null, { pos: 3, slot: 9 });
    await settle();
    expect(fm1.o.sent.some((f) => f[4] === 0x13)).toBe(false);   // (no SLOT: nothing stored)
    expect(fm1.entries[2]).toMatchObject({ slot: 5 });
    expect(fm1.entries[3]).toEqual({ slot: 9, pattern: 0, name: 'OTHER', devices: [] });
  });
  it('says so when the bank or the palette is full, and adds nothing', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots = fm1.slots.map((s) => ({ ...s, used: true, length: 1, name: `P${s.slot}` }));
    expect(await palette.add('My Pad', padPatch().p)).toBe(false);
    expect(said.at(-1)).toMatch(/bank is full/);
    fm1.entries = fm1.entries.map(() => ({ slot: 0, pattern: 0, name: 'P0', devices: [] }));
    fm1.report();
    await settle();
    expect(await palette.add('My Pad', padPatch().p)).toBe(false);
    expect(said.at(-1)).toBe('Palette full: drag onto a chip to replace');
  });
  it('reorders with one ORDER, removes with an empty PUT, and reads a newer entry by its hash', async () => {
    const { fm1, palette } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'A' };
    await palette.add('A', null, { pos: 0, slot: 0 });
    await palette.move(0, 5);
    await settle();
    expect(fm1.entries[5]).toMatchObject({ name: 'A' });
    expect(palette.chips()[5].name).toBe('A');
    fm1.entries[1] = { slot: 0, pattern: 4, name: 'A', devices: [{ dev: 0, structure: 1, pstructure: 0, name: 'X' }] };
    fm1.report();
    await settle();
    expect(palette.chips()[1]).toMatchObject({ pattern: 4, presets: ['X'] });
    expect(fm1.ops.filter((op) => op === PALETTE.entryGet)).toHaveLength(1);
    await palette.remove(5);
    await settle();
    expect(fm1.entries[5]).toBeNull();
  });
  it('refuses to write while a switch waits for the bar line', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'A' };
    await palette.add('A', null, { pos: 0, slot: 0 });
    await settle();
    fm1.running = true;
    await palette.click(0);
    await settle();
    expect(palette.chips()[0].next).toBe(true);
    const ops = fm1.ops.length;
    await palette.remove(0);
    expect(fm1.ops.length).toBe(ops);
    expect(said.at(-1)).toMatch(/waiting to switch/);
  });
  it('a click switches the FM-1 and, without Live, opens the copy with the entry applied', async () => {
    const { p } = padPatch();
    const { fm1, palette, opened } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    fm1.slots[3] = { slot: 3, used: true, length: binLength(p), name: 'MY PAD' };
    await palette.add('My Pad', p, { pos: 0 });
    await settle();
    await palette.click(0);
    await settle();
    expect(fm1.cur).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ adopt: false, from: 'My Pad' });
  });
  it('under Live follows an FM-1 switch: adopts its copy (no upload), or turns Live off without one', async () => {
    const { p } = padPatch();
    const { fm1, palette, opened, off, link } = await linked({ live: true, candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    fm1.slots[3] = { slot: 3, used: true, length: binLength(p), name: 'MY PAD' };
    fm1.slots[4] = { slot: 4, used: true, length: 77, name: 'STRANGER' };
    fm1.entries[0] = entryOf(p, 3);
    fm1.entries[1] = { slot: 4, pattern: 0, name: 'STRANGER', devices: [] };
    fm1.report();
    await settle();
    await palette.click(0);   // (under Live: GO only; the editor opens when the FM-1 says it switched)
    await settle();
    expect(opened).toEqual([expect.objectContaining({ adopt: true })]);
    expect(fm1.o.sent.some((f) => f[4] === 0x11)).toBe(false);   // (no COMMIT)
    fm1.running = true;
    await palette.click(1);
    fm1.bar();
    await settle();
    expect(off).toEqual(['FM-1 switched to palette 2 · STRANGER: no copy in this browser, so Live sync is off']);
    link.sendLiveName('MY PAD');
    await settle();
    expect(fm1.liveName).toBe('MY PAD');
  });
  it('keeps the last palette read for when no FM-1 is linked, and with firmware without it sends nothing', async () => {
    const { fm1, palette } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'A' };
    await palette.add('A', null, { pos: 0, slot: 0 });
    await settle();
    expect(JSON.parse(mem.get(PALETTE_STORE)!).now.positions[0].name).toBe('A');
    const old = await linked({ features: 0 });
    expect(old.palette.linked).toBe(false);
    expect(old.palette.chips()[0].name).toBe('A');   // (the last read)
    expect(await old.palette.add('B', null, { slot: 0 })).toBe(false);
    expect(old.said.at(-1)).toMatch(/firmware 1\.26/);
    expect(old.fm1.ops).toEqual([]);
  });
  it('sends no unasked PALETTE_NOW before a GET', async () => {
    const fm1 = new PaletteFm1();
    fm1.report();
    expect(fm1.asked).toBe(false);
  });
});
