// SPDX-License-Identifier: GPL-3.0-only
// The palette (#1196): the entry an editor patch makes, the entry applied to a copy, and the editor's side of the link
// against a stand-in FM-1 that keeps a palette as build/palette/spec.md §5 says (test-palette-fm1.ts).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { presetsHPatches } from '../scripts/factory-lz';
import { FACTORY } from './assemblies';
import { insertAssembly, type AssemblyInst } from './assembly';
import { binLength, slotMoves, type Candidate } from './bank';
import { DeviceLink } from './device';
import { addUserPreset, applyPreset, capturePreset, currentValues, presetsOf, replaceUserPresets, setFactoryPresets, userPresets } from './device-presets';
import { drawerScope, setRows } from './fx-preset';
import { drawerPresetInfo } from './fx-preset-format';
import { DEFS } from './modules';
import { connect, newPatch, type Patch } from './patch';
import { moveOrder, Palette, PALETTE_FULL, PALETTE_STORE, repointed, type PalettePorts } from './palette';
import { applyEntry, asSlot, entryOf, NO_SAME_STRUCTURE, paletteDevices, sameBytes } from './preset-fit';
import { encodePatch } from './patchbin';
import { readFromFm1 } from './patch-reader';
import { browserLibrary } from './assembly-match';
import { chipMeta } from './palette-view';
import { FM1_PRESETS } from './presets';
import { invalidatePresetPatterns } from './preset-patterns';
import { CMD, FEATURE25_SLOT_GET, FEATURE5_FX_DRAWERS, PALETTE, type PaletteEntry } from './protocol';
import { rowOrder, structureOf } from './structure';
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
async function linked(o: { features?: number; features25?: number; presetRoom?: number; live?: boolean; candidates?: Candidate[]; current?: () => Patch; onSlot?: () => void; inBank?: (name: string) => boolean } = {}) {
  const fm1 = new PaletteFm1({ features: o.features, features25: o.features25, presetRoom: o.presetRoom });
  const g = globalThis as unknown as { window?: unknown; navigator: { requestMIDIAccess?: unknown } };
  g.window ??= globalThis;
  g.navigator.requestMIDIAccess = async () => ({ inputs: new Map([[fm1.i.id, fm1.i]]), outputs: new Map([[fm1.o.id, fm1.o]]), onstatechange: null });
  const link = new DeviceLink();
  await link.connect();
  const said: string[] = [], opened: { patch: Patch; adopt: boolean; from: string }[] = [], off: string[] = [], full: { text: string; replace: (pos: number) => void }[] = [];
  let live = o.live ?? false, kept = 0;
  const ports: PalettePorts = {
    device: link,
    candidates: () => o.candidates ?? [],
    live: () => live,
    current: o.current ?? (() => newPatch(DEFS)),
    versions: () => [],
    open: (patch, x) => void opened.push({ patch, ...x }),
    kept: () => void kept++,
    liveOff: (why) => { live = false; off.push(why); },
    say: (t) => void said.push(t),
    full: (text, replace) => void full.push({ text, replace }),
    changed: () => {},
    inBank: o.inBank,
  };
  const palette = new Palette(ports, storage);
  link.onEvent = (e) => {
    if (e.kind === 'info') void palette.infoHeard();   // (as main.ts: an INFO not asked for answers another program's HELLO)
    if (e.kind === 'palette') palette.received(e.now);
    if (e.kind === 'slot') { palette.slotNow(); o.onSlot?.(); }   // (as main.ts: then the editor drops its pattern origins)
  };
  await palette.connected();
  return { fm1, link, palette, said, opened, off, full, kept: () => kept, live: () => live };
}

describe('the palette over the link (#1196)', () => {
  it('stores a sound not on the FM-1 into the first free slot, named, then puts it; the chips follow', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'TAKEN' };
    const { p } = padPatch();
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    expect(fm1.slots[1]).toMatchObject({ used: true, name: 'MY PAD', length: binLength(p) });
    expect(fm1.entries[0]).toMatchObject({ slot: 1, name: 'MY PAD', devices: [{ name: 'Warm1' }] });
    expect(palette.chips()[0]).toMatchObject({ state: 'ok', name: 'MY PAD', presets: ['Warm1'] });
    expect(said.at(-1)).toBe(`"My Pad" is palette 1 (stored as a new patch in slot 2, as ${NO_SAME_STRUCTURE}; preset Warm1 sent to the FM-1)`);
    expect(fm1.ops.filter((op) => op === PALETTE.entryGet)).toEqual([]);   // (its hash was known: no ENTRY_GET)
  });
  it('points at a slot that holds the same patch, byte for byte, under the slot\'s own name, and at a dragged FM-1 slot', async () => {
    const { fm1, palette, link } = await linked();
    const { p } = padPatch();
    fm1.slots[5] = { slot: 5, used: true, length: binLength(p), name: 'My Pad' };   // (a factory slot keeps its case)
    fm1.bins[5] = link.encodeFor(p);
    await palette.add('My Pad', p, { pos: 2 });
    fm1.slots[9] = { slot: 9, used: true, length: 50, name: '808 Kit' };
    await palette.add('808 Kit', null, { pos: 3, slot: { slot: 9, name: '808 Kit' } });
    await fm1.quiet();
    expect(fm1.o.sent.some((f) => f[4] === 0x13)).toBe(false);   // (no SLOT: nothing stored)
    expect(fm1.entries[2]).toMatchObject({ slot: 5, name: 'My Pad' });
    expect(fm1.entries[3]).toEqual({ slot: 9, pattern: 0, name: '808 Kit', devices: [] });
  });
  it('says so when the bank is full, and adds nothing', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots = fm1.slots.map((s) => ({ ...s, used: true, length: 1, name: `P${s.slot}` }));
    expect(await palette.add('My Pad', padPatch().p)).toBe(false);
    expect(said.at(-1)).toMatch(/bank is full/);
  });
  it('a full palette: Add to palette adds nothing and says so where the chips are, offering a position to replace (#1258)', async () => {
    const { fm1, palette, full } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 1, name: 'P0' };
    fm1.entries = fm1.entries.map(() => ({ slot: 0, pattern: 0, name: 'P0', devices: [] }));
    fm1.report();
    await fm1.quiet();
    const { p } = padPatch();
    expect(await palette.add('My Pad', p)).toBe(false);
    expect(full.map((f) => f.text)).toEqual([PALETTE_FULL]);
    expect(fm1.entries.every((e) => e?.name === 'P0')).toBe(true);
    // Replace… > position 3: the same sound goes there
    full[0].replace(2);
    await fm1.quiet();
    expect(fm1.entries[2]).toMatchObject({ name: 'MY PAD', devices: [{ name: 'Warm1' }] });
    expect(fm1.entries.filter((e) => e?.name === 'P0')).toHaveLength(7);
  });
  it('reorders with one ORDER, removes with an empty PUT, and reads a newer entry by its hash', async () => {
    const { fm1, palette } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'A' };
    await palette.add('A', null, { pos: 0, slot: { slot: 0, name: 'A' } });
    await palette.move(0, 5);
    await fm1.quiet();
    expect(fm1.entries[5]).toMatchObject({ name: 'A' });
    expect(palette.chips()[5].name).toBe('A');
    fm1.entries[1] = { slot: 0, pattern: 4, name: 'A', devices: [{ dev: 0, structure: 1, pstructure: 0, name: 'X' }] };
    fm1.report();
    await fm1.quiet();
    expect(palette.chips()[1]).toMatchObject({ pattern: 4, presets: ['X'] });
    expect(fm1.ops.filter((op) => op === PALETTE.entryGet)).toHaveLength(1);
    await palette.remove(5);
    await fm1.quiet();
    expect(fm1.entries[5]).toBeNull();
  });
  it('after another program\'s HELLO (its INFO) reads the palette again, so the chips go on following the FM-1', async () => {
    const { fm1, palette } = await linked();
    fm1.hello();   // (a second editor window, a tool: PALETTE_NOW goes out unasked only once asked again)
    await fm1.quiet();
    expect(fm1.asked).toBe(true);
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'A' };
    await palette.add('A', null, { pos: 0, slot: { slot: 0, name: 'A' } });
    await fm1.quiet();
    expect(palette.chips()[0]).toMatchObject({ state: 'ok', name: 'A' });
    fm1.entries[2] = { slot: 0, pattern: 1, name: 'A', devices: [] };   // (a change on the FM-1 itself)
    fm1.report();
    await fm1.quiet();
    expect(palette.chips()[2]).toMatchObject({ state: 'ok', name: 'A', pattern: 1 });
  });
  it('refuses to write while a switch waits for the bar line', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'A' };
    await palette.add('A', null, { pos: 0, slot: { slot: 0, name: 'A' } });
    await fm1.quiet();
    fm1.running = true;
    await palette.click(0);
    await fm1.quiet();
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
    await fm1.quiet();
    await palette.click(0);
    await fm1.quiet();
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
    await fm1.quiet();
    await palette.click(0);   // (under Live: GO only; the editor opens when the FM-1 says it switched)
    await fm1.quiet();
    expect(opened).toEqual([expect.objectContaining({ adopt: true })]);
    expect(fm1.o.sent.some((f) => f[4] === 0x11)).toBe(false);   // (no COMMIT)
    fm1.running = true;
    await palette.click(1);
    fm1.bar();
    await fm1.quiet();
    expect(off).toEqual(['FM-1 switched to palette 2 · STRANGER: no copy in this browser, so Live sync is off']);
    link.sendLiveName('MY PAD');
    await fm1.quiet();
    expect(fm1.liveName).toBe('MY PAD');
  });
  it('under Live, the FM-1 saving the editor\'s patch to the palette (HOME + a key held) keeps Live and the patch (#1244)', async () => {
    // the owner, 1.26.2: "saving to palette seems to disconnect the fm1". The FM-1 plays position 3 after the save, which
    // is no switch: the slot holds the patch the editor has, byte for byte, unsaved in this browser
    const { p } = padPatch('Fresh Idea');
    const { fm1, link, opened, off, kept, live } = await linked({ live: true, current: () => structuredClone(p) });
    fm1.holdSave(2, link.encodeFor(p), 'FRESH IDEA', entryOf(p, 0));
    await fm1.quiet();
    expect(off).toEqual([]);
    expect(live()).toBe(true);
    expect(opened).toEqual([]);
    expect(kept()).toBe(1);
  });
  it('the FM-1 saving the editor\'s patch never opens an older saved copy of the same name and length (#1244)', async () => {
    const { p, a } = padPatch();
    const older = structuredClone(p);
    const oa = older.assemblies!.find((x) => x.id === a.id)!;
    applyPreset(older, oa, presetsOf(older, oa).find((x) => x.name === 'Bright')!);
    oa.preset = 'Warm1';
    expect(binLength(older)).toBe(binLength(p));
    const { fm1, link, opened, off, kept } = await linked({ live: true, candidates: [{ name: 'My Pad', patch: () => structuredClone(older) }], current: () => structuredClone(p) });
    fm1.holdSave(0, link.encodeFor(p), 'MY PAD', entryOf(p, 0));
    await fm1.quiet();
    expect(opened).toEqual([]);
    expect(off).toEqual([]);
    expect(kept()).toBe(1);
  });
  it('the FM-1 saving a patch with factory pattern origins keeps it too, though the editor drops them at SLOT_NOW', async () => {
    const lire = FM1_PRESETS['8 Lire']();
    expect(lire.modules.some((m) => m.type === 'steps' && m.factoryPatterns)).toBe(true);
    let cur = structuredClone(lire);
    const { fm1, link, opened, off, kept } = await linked({ live: true, current: () => cur, onSlot: () => { cur = structuredClone(cur); invalidatePresetPatterns(cur); } });
    fm1.holdSave(1, link.encodeFor(lire), '8 LIRE', entryOf(lire, 0));
    await fm1.quiet();
    expect(link.encodeFor(cur)).not.toEqual(link.encodeFor(lire));   // (the origins went)
    expect([opened, off, kept()]).toEqual([[], [], 1]);
  });
  it('a hold-save while the FM-1 plays a patch the editor is not showing is a switch: its copy opens, or Live goes off', async () => {
    const { p } = padPatch();
    const { p: other, a: oa } = padPatch('Other Pad');
    applyPreset(other, oa, presetsOf(other, oa).find((x) => x.name === 'Bright')!);   // (other values than the editor's)
    const { fm1, link, opened, off, kept } = await linked({ live: true, candidates: [{ name: 'Other Pad', patch: () => structuredClone(other) }], current: () => structuredClone(p) });
    fm1.holdSave(0, link.encodeFor(other), 'OTHER PAD', entryOf(other, 0));
    await fm1.quiet();
    expect(kept()).toBe(0);
    expect(opened).toEqual([expect.objectContaining({ adopt: true, from: 'Other Pad' })]);
    fm1.holdSave(1, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 'STRANGER', { slot: 0, pattern: 0, name: '', devices: [] });
    await fm1.quiet();
    expect(kept()).toBe(0);
    expect(off).toEqual(['FM-1 switched to palette 2 · STRANGER: no copy in this browser, so Live sync is off']);
  });
  it('a switch to a position whose entry sets other presets on the editor\'s own patch still opens it with them', async () => {
    const { p } = padPatch();
    const { fm1, link, palette, opened, kept } = await linked({ live: true, candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }], current: () => structuredClone(p) });
    fm1.slots[3] = { slot: 3, used: true, length: binLength(p), name: 'MY PAD' };
    fm1.bins[3] = link.encodeFor(p);
    fm1.entries[0] = { ...entryOf(p, 3), devices: entryOf(p, 3).devices.map((d) => ({ ...d, name: 'Bright' })) };
    fm1.report();
    await fm1.quiet();
    await palette.click(0);
    await fm1.quiet();
    expect(kept()).toBe(0);
    expect(opened).toEqual([expect.objectContaining({ adopt: true })]);
  });
  it('under Live follows a switch whose report a newer one overtakes while it reads the entry', async () => {
    const { p } = padPatch();
    const { fm1, palette, opened } = await linked({ live: true, candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    fm1.slots[3] = { slot: 3, used: true, length: binLength(p), name: 'MY PAD' };
    fm1.entries[0] = entryOf(p, 3);
    fm1.report();
    await fm1.quiet();
    fm1.entries[0] = { ...entryOf(p, 3), pattern: 1 };   // (changed on the FM-1: the switch's report has a hash to read)
    await palette.click(0);
    fm1.report();   // (another report, the same switch, comes in while the editor reads that entry)
    await fm1.quiet();
    expect(fm1.ops.filter((op) => op === PALETTE.entryGet)).toHaveLength(3);   // (the first read, the switch's, the newer report's)
    expect(opened).toEqual([expect.objectContaining({ adopt: true })]);
  });
  it('keeps the last palette read for when no FM-1 is linked, and with firmware without it sends nothing', async () => {
    const { fm1, palette } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'A' };
    await palette.add('A', null, { pos: 0, slot: { slot: 0, name: 'A' } });
    await fm1.quiet();
    expect(JSON.parse(mem.get(PALETTE_STORE)!).now.positions[0].name).toBe('A');
    const old = await linked({ features: 0 });
    expect(old.palette.linked).toBe(false);
    expect(old.palette.chips()[0].name).toBe('A');   // (the last read)
    expect(await old.palette.add('B', null, { slot: { slot: 0, name: 'B' } })).toBe(false);
    expect(old.said.at(-1)).toMatch(/firmware 1\.26/);
    expect(old.fm1.ops).toEqual([]);
  });
  it('opens a position this browser has no copy of from the FM-1: under Live it adopts the patch read back and Live stays on', async () => {
    const { p } = padPatch('Stranger Pad');
    const bin = encodePatch(p);
    const { fm1, palette, opened, off, said, live } = await linked({ live: true });
    fm1.slots[4] = { slot: 4, used: true, length: bin.length, name: 'STRANGER PAD' };
    fm1.bins[4] = bin;
    fm1.entries[1] = { slot: 4, pattern: 0, name: 'STRANGER PAD', devices: [] };
    fm1.report();
    await fm1.quiet();
    expect(palette.chips()[1]).toMatchObject({ copy: false, fromFm1: true });
    fm1.tap(1);
    await fm1.quiet();
    expect(off).toEqual([]);
    expect(live()).toBe(true);
    expect(opened).toEqual([expect.objectContaining({ adopt: true, from: '' })]);
    expect(opened[0].patch.name).toBe('STRANGER PAD');
    expect(said.at(-1)).toMatch(/^FM-1 switched to palette 2 · STRANGER PAD: Read from the FM-1/);
    expect(sentCmds(fm1)).not.toContain(CMD.slot);   // (nothing sent back: the FM-1 plays it already)
  });
  it('a click without Live opens a position with no copy from the FM-1 too', async () => {
    const { p } = padPatch('Stranger Pad');
    const bin = encodePatch(p);
    const { fm1, palette, opened, said } = await linked();
    fm1.slots[4] = { slot: 4, used: true, length: bin.length, name: 'STRANGER PAD' };
    fm1.bins[4] = bin;
    fm1.entries[0] = { slot: 4, pattern: 0, name: 'STRANGER PAD', devices: [] };
    fm1.report();
    await fm1.quiet();
    await palette.click(0);
    await fm1.quiet();
    expect(opened).toEqual([expect.objectContaining({ adopt: false, from: '' })]);
    expect(said.at(-1)).toMatch(/^Palette 1 · STRANGER PAD: Read from the FM-1/);
  });
  it('a browser copy of the slot\'s name and length still wins over reading the FM-1 (D-605)', async () => {
    const { p } = padPatch('Stranger Pad');
    const { fm1, palette, opened, off, said } = await linked({ live: true, candidates: [{ name: 'Stranger Pad', patch: () => structuredClone(p) }] });
    fm1.slots[4] = { slot: 4, used: true, length: binLength(p), name: 'STRANGER PAD' };
    fm1.bins[4] = encodePatch(p);
    fm1.entries[1] = { slot: 4, pattern: 0, name: 'STRANGER PAD', devices: [] };
    fm1.report();
    await fm1.quiet();
    expect(palette.chips()[1].copy).toBe(true);
    fm1.tap(1);
    await fm1.quiet();
    expect(off).toEqual([]);
    expect(opened).toEqual([expect.objectContaining({ adopt: true, from: 'Stranger Pad' })]);
    expect(said.some((t) => t.includes('Read from the FM-1'))).toBe(false);
  });
  it('sends no unasked PALETTE_NOW before a GET', async () => {
    const fm1 = new PaletteFm1();
    fm1.report();
    expect(fm1.asked).toBe(false);
  });
});

/** a frame's command byte (after F0 and the three prefix bytes) */
const sentCmds = (fm1: PaletteFm1): number[] => fm1.o.sent.map((f) => f[4]);
const q16 = (values: number[]): number[] => values.map((v) => Math.round(v * 65536));

describe('adding to the palette saves what the FM-1 needs to play the sound (owner 2026-11-23)', () => {
  it('points a factory patch at its untouched factory slot: the editor encodes it as the firmware writes it', async () => {
    // (presets.h, the factory region and the firmware tier carry the same binaries in the same order, export-defs.ts; the
    // FM-1 names a factory slot as the region does, case and all; an FM-1 updated from a release holds them byte for byte,
    // D-887. A slot that holds another copy, touched or older, plays another patch and is not pointed at: D-1240)
    const bins = presetsHPatches(readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8'));
    const names = Object.keys(FM1_PRESETS);
    expect(bins.map((b) => b.name)).toEqual(names.map((n) => n.toUpperCase()));
    const { fm1, palette } = await linked();
    names.forEach((name, slot) => {
      fm1.slots[slot] = { slot, used: true, length: bins[slot].bytes.length, name };
      fm1.bins[slot] = bins[slot].bytes;
    });
    for (const [slot, name] of names.entries()) {
      expect(await palette.add(name, FM1_PRESETS[name](), { pos: slot % 8 }), name).toBe(true);
      await fm1.quiet();
      expect(fm1.entries[slot % 8], name).toMatchObject({ slot, name });
    }
    expect(sentCmds(fm1)).not.toContain(CMD.slot);   // (nothing stored)
  });
  it('uploads a preset only this browser has, under its name and structure, before the entry', async () => {
    const { fm1, palette, said } = await linked();
    const { p, a } = padPatch();
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    const s = structureOf(p, a);
    expect(fm1.findPreset(s, 'Warm1')?.q16).toEqual(q16(currentValues(p, a)));
    expect(fm1.entries[0]).toMatchObject({ devices: [{ name: 'Warm1' }] });
    const cmds = sentCmds(fm1);
    expect(cmds.indexOf(CMD.presetPut)).toBeLessThan(cmds.indexOf(PALETTE.cmd, cmds.indexOf(CMD.presetPut)));
    expect(said.at(-1)).toBe(`"My Pad" is palette 1 (stored as a new patch in slot 1, as ${NO_SAME_STRUCTURE}; preset Warm1 sent to the FM-1)`);
  });
  it('replaces an FM-1 preset of that name whose values differ, and leaves one that agrees', async () => {
    const { fm1, palette, said } = await linked();
    const { p, a } = padPatch();
    const s = structureOf(p, a), now = q16(currentValues(p, a));
    fm1.presets.push({ structure: s, name: 'WARM1', q16: now.map((v, i) => (i ? v : v + 65536)) });
    await palette.add('My Pad', p);
    await fm1.quiet();
    expect(fm1.presets).toHaveLength(1);
    expect(fm1.findPreset(s, 'Warm1')?.q16).toEqual(now);
    expect(said.at(-1)).toBe(`"My Pad" is palette 1 (stored as a new patch in slot 1, as ${NO_SAME_STRUCTURE}; preset Warm1 updated on the FM-1)`);
    const puts = sentCmds(fm1).filter((c) => c === CMD.presetPut).length;
    await palette.add('My Pad', p, { pos: 1 });
    await fm1.quiet();
    expect(sentCmds(fm1).filter((c) => c === CMD.presetPut)).toHaveLength(puts);
    expect(said.at(-1)).toBe('"My Pad" is palette 2');
  });
  it('does not send a factory preset: the FM-1 has it', async () => {
    const { fm1, palette } = await linked();
    const { p, a } = padPatch();
    const s = structureOf(p, a);
    setFactoryPresets([{ structure: s, name: 'Lush', values: currentValues(p, a).map((v, i) => (i ? v : v + 0.5)), factory: true }]);
    applyPreset(p, a, presetsOf(p, a).find((x) => x.name === 'Lush')!);
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1)).not.toContain(CMD.presetPut);
    expect(fm1.entries[0]).toMatchObject({ devices: [{ name: 'Lush' }] });
  });
  it('never points at a slot of the patch\'s name and length that holds other values as it is: other card values take a preset, another setting a patch, numbered', async () => {
    const { fm1, palette, said, link } = await linked();
    const { p, a } = padPatch();
    const older = structuredClone(p);
    const oa = older.assemblies!.find((x) => x.id === a.id)!;
    applyPreset(older, oa, presetsOf(older, oa).find((x) => x.name === 'Bright')!);
    oa.preset = 'Warm1';
    fm1.slots[0] = { slot: 0, used: true, length: binLength(older), name: 'MY PAD' };
    fm1.bins[0] = link.encodeFor(older);
    expect(fm1.bins[0].length).toBe(link.encodeFor(p).length);
    // (the slot's device says Warm1, which the FM-1 compares by name alone: the sound's values take a preset of its own)
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    expect(fm1.slots[1].used).toBe(false);
    expect(fm1.entries[0]).toMatchObject({ slot: 0, name: 'MY PAD', devices: [{ name: 'My Pad' }] });
    expect(said.at(-1)).toBe('"My Pad" is palette 1: slot 1 · MY PAD with preset My Pad (preset My Pad sent to the FM-1)');
    older.modules.find((m) => m.type === 'output')!.params.level = 0.33;
    fm1.bins[0] = link.encodeFor(older);
    expect(await palette.add('My Pad', p, { pos: 1 })).toBe(true);
    await fm1.quiet();
    expect(fm1.slots[1]).toMatchObject({ used: true, name: 'MY PAD 2' });
    expect(fm1.bins[1]).toEqual(link.encodeFor(p));
    expect(fm1.entries[1]).toMatchObject({ slot: 1, name: 'MY PAD 2' });
    expect(said.at(-1)).toBe('"My Pad" is palette 2 (stored as a new patch in slot 2, as slot 1 · MY PAD differs from it in settings no device preset holds; preset Warm1 sent to the FM-1; slot 1 holds another "MY PAD", so it is stored as "MY PAD 2")');
  });
  it('finds this browser\'s copy of a numbered slot by the name before the number', async () => {
    const { p } = padPatch();
    const { fm1, palette, opened } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    fm1.slots[0] = { slot: 0, used: true, length: binLength(p), name: 'MY PAD' };
    await palette.add('My Pad', p);
    await fm1.quiet();
    expect(fm1.entries[0]).toMatchObject({ slot: 1, name: 'MY PAD 2' });
    await palette.click(0);
    await fm1.quiet();
    expect(opened).toEqual([expect.objectContaining({ from: 'My Pad' })]);
  });
  it('never takes a different patch in a numbered slot for the copy: only the content the editor stored there', async () => {
    const { p, a } = padPatch();
    let mine = structuredClone(p);
    const { fm1, link, palette, opened, said } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(mine) }] });
    fm1.slots[0] = { slot: 0, used: true, length: binLength(p), name: 'MY PAD' };
    fm1.slots[5] = { slot: 5, used: true, length: binLength(p), name: 'MY PAD 2' };   // (not the editor's: stored elsewhere)
    fm1.entries[1] = { slot: 5, pattern: 0, name: 'MY PAD 2', devices: [] };
    fm1.report();
    await fm1.quiet();
    expect(palette.chips()[1].copy).toBe(false);
    await palette.click(1);
    await fm1.quiet();
    expect(opened).toEqual([]);
    expect(said.at(-1)).toBe('Palette 2 · MY PAD 2: no copy of this patch in this browser');
    await palette.add('My Pad', p);   // (stored as MY PAD 3 in slot 1: the copy is this content)
    await fm1.quiet();
    expect(fm1.entries[0]).toMatchObject({ slot: 1, name: 'MY PAD 3' });
    expect(palette.chips()[0].copy).toBe(true);
    mine = structuredClone(p);
    applyPreset(mine, mine.assemblies!.find((x) => x.id === a.id)!, presetsOf(p, a).find((x) => x.name === 'Bright')!);
    palette.findCopies();
    // (My Pad changed since: no longer what slot 2 holds; the copy this browser kept of what it stored there opens)
    expect(palette.chips()[0].copy).toBe(true);
    await palette.click(0);
    await fm1.quiet();
    expect(opened.map((x) => [x.from, link.encodeFor(x.patch)])).toEqual([['', fm1.bins[1]]]);
  });
  it('with firmware that cannot read a slot back, stores the patch rather than trust a name and length', async () => {
    const { fm1, palette } = await linked({ features25: 0 });
    const { p } = padPatch();
    fm1.slots[4] = { slot: 4, used: true, length: binLength(p), name: 'MY PAD' };
    await palette.add('My Pad', p);
    await fm1.quiet();
    expect(fm1.entries[0]).toMatchObject({ slot: 0, name: 'MY PAD 2' });
  });
  it('with the preset store full, the entry leaves the preset out and the slot carries the sound, and says so', async () => {
    const { fm1, palette, said, link } = await linked({ presetRoom: 0 });
    const { p } = padPatch();
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    expect(fm1.presets).toEqual([]);
    expect(fm1.bins[0]).toEqual(link.encodeFor(p));
    expect(fm1.entries[0]).toMatchObject({ slot: 0, name: 'MY PAD', devices: [] });
    expect(said.at(-1)).toBe(`"My Pad" is palette 1 (stored as a new patch in slot 1, as ${NO_SAME_STRUCTURE}). The FM-1 could not take preset Warm1 (its preset store is full): palette 1 plays the values stored with the patch in slot 1`);
  });
  it('with firmware that keeps no presets, sends none and falls back the same way', async () => {
    const { fm1, palette, said } = await linked({ features: 1 << 31 });
    const { p } = padPatch();
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1).some((c) => c >= CMD.presets && c <= CMD.presetDel)).toBe(false);
    expect(fm1.entries[0]).toMatchObject({ devices: [] });
    expect(said.at(-1)).toBe(`"My Pad" is palette 1 (stored as a new patch in slot 1, as ${NO_SAME_STRUCTURE}). The FM-1 could not take preset Warm1 (update the FM-1 to store presets on it): palette 1 plays the values stored with the patch in slot 1`);
  });
  it('a refused entry takes back the slot it stored and the preset it sent, and says what happened', async () => {
    const { fm1, palette, said } = await linked();
    fm1.refusePut = true;
    expect(await palette.add('My Pad', padPatch().p)).toBe(false);
    await fm1.quiet();
    expect(fm1.presets).toEqual([]);
    expect(fm1.slots.every((s) => !s.used)).toBe(true);
    expect(said.at(-1)).toBe('Adding "My Pad" to the palette failed: FM-1: that slot no longer holds the patch. Nothing was added: what it stored on the FM-1 for it is taken back');
  });
});

describe('this browser\'s copy of each sound it put into the palette (owner 2026-11-24: "the fm1 switches to that instrument but the editor does not switch with it")', () => {
  /** the same FM-1 as a link finds it after the page loaded again: its bank and its palette */
  async function reloaded(from: PaletteFm1) {
    const next = await linked();
    next.fm1.slots = from.slots.map((s) => ({ ...s }));
    next.fm1.bins = [...from.bins];
    next.fm1.entries = [...from.entries];
    next.fm1.report();
    await next.fm1.quiet();
    return next;
  }
  it('a sound added with no saved patch and no version of it in the editor opens from the copy kept: an FM-1 switch under Live, a chip click after a reload', async () => {
    const { p } = padPatch();
    const { fm1, link, palette, opened, off } = await linked({ live: true });
    await palette.add('My Pad', p);
    await fm1.quiet();
    expect(palette.chips()[0].copy).toBe(true);
    fm1.tap(0);
    await fm1.quiet();
    expect([off, opened.map((x) => [x.adopt, x.from, link.encodeFor(x.patch)])]).toEqual([[], [[true, '', fm1.bins[0]]]]);
    const again = await reloaded(fm1);
    expect(again.palette.chips()[0].copy).toBe(true);
    await again.palette.click(0);
    await again.fm1.quiet();
    expect(again.opened.map((x) => again.link.encodeFor(x.patch))).toEqual([fm1.bins[0]]);
  });
  it('a hold-save on the FM-1 keeps the patch it stored: a switch back to it, the editor on another patch since, opens it', async () => {
    const { p } = padPatch();
    const other = padPatch('Other').p;
    other.modules.find((m) => m.type === 'output')!.params.level = 0.5;
    let current = p;
    const { fm1, link, opened, off, kept } = await linked({ live: true, current: () => current });
    fm1.holdSave(0, link.encodeFor(p), 'MY PAD', entryOf(p, 0));
    await fm1.quiet();
    current = other;   // (another patch opened and sent under Live, then saved on the FM-1 too)
    fm1.holdSave(1, link.encodeFor(other), 'OTHER', entryOf(other, 0));
    await fm1.quiet();
    expect(kept()).toBe(2);
    fm1.tap(0);
    await fm1.quiet();
    expect([off, opened.map((x) => [x.adopt, link.encodeFor(x.patch)])]).toEqual([[], [[true, fm1.bins[0]]]]);
  });
  it('with firmware that cannot read a slot back, the copy kept opens by its slot, name and length', async () => {
    const { p } = padPatch();
    const { fm1, link, palette, opened } = await linked({ features25: 0 });
    await palette.add('My Pad', p);
    await fm1.quiet();
    await palette.click(0);
    await fm1.quiet();
    expect(opened.map((x) => link.encodeFor(x.patch))).toEqual([fm1.bins[0]]);
  });
  it('the copies follow Send bank to their patches\' new slots', async () => {
    const { p } = padPatch();
    const { fm1, link, palette, opened } = await linked();
    await palette.add('My Pad', p);
    await fm1.quiet();
    fm1.slots[3] = { ...fm1.slots[0], slot: 3 };
    fm1.bins[3] = fm1.bins[0];
    fm1.slots[0] = { slot: 0, used: false, length: 0, name: '' };
    fm1.bins[0] = null;
    await palette.repoint(new Map([[0, 3]]));
    await fm1.quiet();
    expect(fm1.entries[0]).toMatchObject({ slot: 3, name: 'MY PAD' });
    await palette.click(0);
    await fm1.quiet();
    expect(opened.map((x) => link.encodeFor(x.patch))).toEqual([fm1.bins[3]]);
  });
});

describe('a sound the FM-1 reaches with device presets takes no new slot (owner 2026-11-24: "adding a candidate to palette should only send a patch to the fm1 if the current sound doesn\'t fit as a preset on an instrument the fm1 already has")', () => {
  /** the FM-1 with factory Monolith D in slot 1 as the firmware writes it, its presets and FX drawer presets, and this
   *  browser's factory copy of it */
  async function monolith(o: { features?: number; presetRoom?: number } = {}) {
    const factory = (): Patch => FM1_PRESETS['Monolith D']();
    const r = await linked({ ...o, features25: FEATURE25_SLOT_GET | FEATURE5_FX_DRAWERS, candidates: [{ name: 'Monolith D', patch: factory, factory: true }] });
    const held = factory(), bin = r.link.encodeFor(held);
    r.fm1.slots[0] = { slot: 0, used: true, length: bin.length, name: 'Monolith D' };
    r.fm1.bins[0] = bin;
    const synth = (p: Patch): AssemblyInst => p.assemblies!.find((a) => a.name === 'Monolith D')!;
    return { ...r, held, synth, puts: () => sentCmds(r.fm1).filter((c) => c === CMD.presetPut).length, slotWrites: () => sentCmds(r.fm1).filter((c) => c === CMD.slot).length };
  }
  /** card row `row` of assembly `a` of `p` moved by a step, as the card moves it (with every parameter the row sets) */
  function tweak(p: Patch, a: AssemblyInst, row = 0): void {
    const rows = rowOrder(p, a), values = currentValues(p, a), r = rows[row];
    const pd = DEFS[p.modules.find((x) => x.id === r.module)!.type].params.find((x) => x.name === r.param)!;
    const by = pd.step ?? (pd.max - pd.min) / 10;
    values[row] += values[row] + by <= pd.max ? by : -by;
    setRows(p, rows, values);
  }
  /** the patch the FM-1 plays for palette position `pos`: its slot's patch with the entry applied */
  const plays = (held: Patch, entry: PaletteEntry): Patch => { const p = structuredClone(held); applyEntry(p, entry); return p; };

  it('a tweak of Monolith D: one preset (the instrument with its drawer) uploaded and kept here, the entry on its slot, no slot written', async () => {
    const { fm1, link, palette, said, held, synth, puts, slotWrites, opened } = await monolith();
    const sound = structuredClone(held);
    tweak(sound, synth(sound));
    expect(await palette.add('Monolith D C', sound)).toBe(true);
    await fm1.quiet();
    expect([puts(), slotWrites(), fm1.slots[1].used]).toEqual([1, 0, false]);
    const scope = drawerScope(sound, synth(sound))!;
    expect(fm1.presets).toEqual([{ structure: scope.structure, name: 'Monolith D C', q16: q16(capturePreset(sound, synth(sound), '').values) }]);
    expect(fm1.entries[0]).toMatchObject({ slot: 0, name: 'Monolith D', devices: [{ name: 'Monolith D C' }] });
    expect(userPresets().map((x) => [x.structure, x.name, !!drawerPresetInfo(x)])).toEqual([[scope.structure, 'Monolith D C', true]]);
    expect(said.at(-1)).toBe('"Monolith D C" is palette 1: slot 1 · Monolith D with preset Monolith D C (preset Monolith D C sent to the FM-1)');
    // (what the FM-1 plays is the sound, its device under the preset's name; a click opens the same)
    const named = structuredClone(sound);
    synth(named).preset = 'Monolith D C';
    expect(link.encodeFor(plays(held, fm1.entries[0]!))).toEqual(link.encodeFor(named));
    await palette.click(0);
    await fm1.quiet();
    expect(opened.map((x) => link.encodeFor(x.patch))).toEqual([link.encodeFor(named)]);
  });
  it('the same tweak added twice reuses the preset it made', async () => {
    const { fm1, palette, held, synth, puts, slotWrites, said } = await monolith();
    const sound = structuredClone(held);
    tweak(sound, synth(sound));
    await palette.add('Monolith D C', sound);
    await fm1.quiet();
    await palette.add('Monolith D E', sound, { pos: 1 });
    await fm1.quiet();
    expect([puts(), slotWrites(), userPresets().length]).toEqual([1, 0, 1]);
    expect(fm1.entries[1]).toMatchObject({ slot: 0, devices: [{ name: 'Monolith D C' }] });
    expect(said.at(-1)).toBe('"Monolith D E" is palette 2: slot 1 · Monolith D with preset Monolith D C');
  });
  it('a sound equal to a preset there already uploads nothing: a factory one, the user\'s, one only the FM-1 has', async () => {
    const { fm1, palette, held, synth, puts, slotWrites } = await monolith();
    const at = (row: number): Patch => { const s = structuredClone(held); tweak(s, synth(s), row); return s; };
    const [lead, mine, theirs] = [at(0), at(1), at(2)];
    const base = drawerScope(held, synth(held))!.base;
    setFactoryPresets([], (b) => (b === base ? [{ ...capturePreset(lead, synth(lead), 'Lead'), factory: true }] : []));
    replaceUserPresets([], [capturePreset(mine, synth(mine), 'Mine 1')]);
    const t = capturePreset(theirs, synth(theirs), '');
    fm1.presets.push({ structure: t.structure, name: 'THEIRS', q16: q16(t.values) });
    fm1.presets.push({ structure: t.structure, name: 'MINE 1', q16: q16(capturePreset(mine, synth(mine), '').values) });
    for (const [pos, s] of [lead, mine, theirs].entries()) expect(await palette.add(`Monolith D ${pos}`, s, { pos })).toBe(true);
    await fm1.quiet();
    expect([puts(), slotWrites()]).toEqual([0, 0]);
    expect(fm1.entries.slice(0, 3).map((e) => [e?.slot, e?.devices.map((x) => x.name)])).toEqual([[0, ['Lead']], [0, ['Mine 1']], [0, ['THEIRS']]]);
    expect(userPresets().map((x) => x.name).sort()).toEqual(['Mine 1', 'THEIRS']);   // (the FM-1's own joins this browser's)
  });
  it('a tweak of a drawer effect makes one preset of the instrument with its drawer', async () => {
    const { fm1, palette, held, synth, puts } = await monolith();
    const sound = structuredClone(held);
    const scope = drawerScope(sound, synth(sound))!;
    tweak(sound, scope.effects.find((e) => e.name === 'Delay')!);
    expect(await palette.add('Monolith D B', sound)).toBe(true);
    await fm1.quiet();
    expect(puts()).toBe(1);
    expect(fm1.presets.map((x) => [x.structure, x.name, x.q16.length])).toEqual([[scope.structure, 'Monolith D B', capturePreset(sound, synth(sound), '').values.length]]);
    expect(fm1.entries[0]).toMatchObject({ slot: 0, devices: [{ name: 'Monolith D B' }] });
  });
  it('a tempo or pattern change alone takes no patch: the entry plays the slot\'s, with the sound\'s pattern number, and says so', async () => {
    const { fm1, palette, held, said, puts, slotWrites } = await monolith();
    const fast = structuredClone(held);
    fast.modules.find((m) => m.type === 'fm1')!.params.tempo = 151;
    expect(await palette.add('Monolith D B', fast)).toBe(true);
    await fm1.quiet();
    expect(said.at(-1)).toBe('"Monolith D B" is palette 1. It plays the tempo of slot 1');
    const notes = structuredClone(held);
    const steps = notes.modules.find((m) => m.type === 'steps')!;
    steps.params.len = steps.params.len === 8 ? 16 : 8;
    notes.modules.find((m) => m.type === 'fm1')!.seq = { pattern: 2 };
    expect(await palette.add('Monolith D C', notes)).toBe(true);
    await fm1.quiet();
    expect(said.at(-1)).toBe('"Monolith D C" is palette 2. It plays the patterns of slot 1');
    expect([puts(), slotWrites()]).toEqual([0, 0]);
    expect(fm1.entries.slice(0, 2)).toMatchObject([{ slot: 0, pattern: 0, devices: [] }, { slot: 0, pattern: 2, devices: [] }]);
  });
  it('a tweak saved under another name is recognised by its structure: a preset on the slot that holds its patch (D-1227)', async () => {
    const { fm1, palette, held, synth, said, puts, slotWrites } = await monolith();
    const sound = structuredClone(held);
    sound.name = 'My Mono';
    tweak(sound, synth(sound));
    expect(await palette.add('My Mono', sound)).toBe(true);
    await fm1.quiet();
    expect([fm1.entries[0]?.slot, fm1.slots[1].used, puts(), slotWrites()]).toEqual([0, false, 1, 0]);
    expect(said.at(-1)).toBe('"My Mono" is palette 1: slot 1 · Monolith D with preset My Mono (preset My Mono sent to the FM-1)');
  });
  it('an instrument with a drawer whose card names a preset of the instrument alone with exactly its values: the entry names it (D-1226)', async () => {
    const { fm1, palette, held, synth, slotWrites } = await monolith();
    const sound = structuredClone(held);
    sound.name = 'Mono Mine';
    addUserPreset(structureOf(sound, synth(sound)), 'Mine', currentValues(sound, synth(sound)));
    synth(sound).preset = 'Mine';
    expect(await palette.add('Mono Mine', sound)).toBe(true);
    await fm1.quiet();
    expect([fm1.entries[0]?.slot, fm1.entries[0]?.devices.map((x) => x.name), slotWrites(), fm1.presets.map((x) => x.name)]).toEqual([0, ['Mine'], 0, ['Mine']]);
  });
  it('a cable or module change stores a patch, and says why', async () => {
    const { fm1, palette, held, said, puts } = await monolith();
    const sound = structuredClone(held);
    sound.cables.pop();
    expect(await palette.add('Monolith D B', sound)).toBe(true);
    await fm1.quiet();
    expect(fm1.slots[1]).toMatchObject({ used: true, name: 'MONOLITH D B' });
    expect(fm1.entries[0]).toMatchObject({ slot: 1 });
    expect(puts()).toBe(0);
    expect(said.at(-1)).toBe(`"Monolith D B" is palette 1 (stored as a new patch in slot 2, as ${NO_SAME_STRUCTURE})`);
  });
  it('a setting outside the device presets stores a patch, and names it', async () => {
    const { fm1, palette, held, said } = await monolith();
    const sound = structuredClone(held);
    sound.modules.find((m) => m.type === 'output')!.params.level = 0.33;
    expect(await palette.add('Monolith D B', sound)).toBe(true);
    await fm1.quiet();
    expect(fm1.entries[0]).toMatchObject({ slot: 1, name: 'MONOLITH D B' });
    expect(said.at(-1)).toBe('"Monolith D B" is palette 1 (stored as a new patch in slot 2, as it changes Output settings no device preset holds)');
  });
  it('with the preset store full, a tweak stores a patch, and says why', async () => {
    const { fm1, palette, held, synth, said } = await monolith({ presetRoom: 0 });
    const sound = structuredClone(held);
    tweak(sound, synth(sound));
    expect(await palette.add('Monolith D C', sound)).toBe(true);
    await fm1.quiet();
    expect([fm1.presets, userPresets()]).toEqual([[], []]);
    expect(fm1.entries[0]).toMatchObject({ slot: 1, name: 'MONOLITH D C', devices: [] });
    expect(said.at(-1)).toBe('"Monolith D C" is palette 1 (stored as a new patch in slot 2, as the FM-1 could not take preset Monolith D C (its preset store is full))');
  });
  it('with firmware that keeps no presets, a tweak stores a patch, and says why', async () => {
    const { fm1, palette, held, synth, said } = await monolith({ features: 1 << 31 });
    const sound = structuredClone(held);
    tweak(sound, synth(sound));
    expect(await palette.add('Monolith D C', sound)).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1).some((c) => c >= CMD.presets && c <= CMD.presetDel)).toBe(false);
    expect(fm1.entries[0]).toMatchObject({ slot: 1, devices: [] });
    expect(said.at(-1)).toBe('"Monolith D C" is palette 1 (stored as a new patch in slot 2, as the FM-1 could not take preset Monolith D C (update the FM-1 to store presets on it))');
  });
  it('the entry keeps working after the page loads again: its preset is in this browser, its slot\'s copy found', async () => {
    const { fm1, link, held, synth, palette } = await monolith();
    const sound = structuredClone(held);
    tweak(sound, synth(sound));
    await palette.add('Monolith D C', sound);
    await fm1.quiet();
    const again = await linked({ candidates: [{ name: 'Monolith D', patch: () => FM1_PRESETS['Monolith D'](), factory: true }] });
    again.fm1.slots = fm1.slots.map((s) => ({ ...s }));
    again.fm1.bins = [...fm1.bins];
    again.fm1.entries = [...fm1.entries];
    again.fm1.report();
    await again.fm1.quiet();
    await again.palette.click(0);
    await again.fm1.quiet();
    synth(sound).preset = 'Monolith D C';
    expect(again.opened.map((x) => link.encodeFor(x.patch))).toEqual([link.encodeFor(sound)]);
  });
});

describe('a slot whose patch this browser has no copy of (owner 2026-11-27: "adding a sound to the palette is still getting added as an additional patch instead of a preset unless i add it using the fm1 key combination")', () => {
  // (his slot "HERA 6" held what an earlier add or an FM-1 hold-save stored: its card values, tempo or patterns other than
  // any patch this browser keeps, so no copy matched it byte for byte and every add stored a new patch, "as no patch of
  // its name with its modules and cables is on the FM-1". The slot is read back and compared as the sound's structure)
  const hera = (): Patch => FM1_PRESETS['Hera 6']();
  /** Hera 6's instrument (with its FX drawer) */
  const synth = (p: Patch): AssemblyInst => p.assemblies!.find((a) => a.name === 'Hera 4')!;
  /** card row `row` of the instrument of `p` moved by `by` of its range */
  function moved(p: Patch, row: number, by = 0.1): Patch {
    const a = synth(p);
    const rows = rowOrder(p, a), values = currentValues(p, a);
    const pd = DEFS[p.modules.find((x) => x.id === rows[row].module)!.type].params.find((x) => x.name === rows[row].param)!;
    const step = (pd.max - pd.min) * by;
    values[row] += values[row] + step <= pd.max ? step : -step;
    setRows(p, rows, values);
    return p;
  }
  /** the FM-1 with `held` (a Hera 6 this browser keeps no copy of) in slot 23 under `name`, this browser's factory copy */
  async function stored(held: Patch, name = 'HERA 6') {
    const r = await linked({ features25: FEATURE25_SLOT_GET | FEATURE5_FX_DRAWERS, candidates: [{ name: 'Hera 6', patch: hera, factory: true }] });
    const bin = r.link.encodeFor(held);
    r.fm1.slots[22] = { slot: 22, used: true, length: bin.length, name };
    r.fm1.bins[22] = bin;
    return { ...r, bin, puts: () => sentCmds(r.fm1).filter((c) => c === CMD.presetPut).length, slotWrites: () => sentCmds(r.fm1).filter((c) => c === CMD.slot).length };
  }

  it('a tweak of Hera 6 named at the prompt goes in as a preset of that name on the slot, which keeps its values', async () => {
    const { fm1, link, palette, said, bin, puts, slotWrites, opened } = await stored(moved(hera(), 1, 0.2));
    const sound = moved(hera(), 0);
    expect(await palette.add('Hera 6 pluckpad', sound)).toBe(true);
    await fm1.quiet();
    expect([puts(), slotWrites(), fm1.slots[23].used]).toEqual([1, 0, false]);
    expect(fm1.entries[0]).toMatchObject({ slot: 22, name: 'HERA 6', devices: [{ name: 'Hera 6 pluckpad' }] });
    expect(said.at(-1)).toBe('"Hera 6 pluckpad" is palette 1: slot 23 · HERA 6 with preset Hera 6 pluckpad (preset Hera 6 pluckpad sent to the FM-1)');
    expect(fm1.bins[22]).toEqual(bin);   // (the slot as it was)
    // (the FM-1 plays the sound, its device under the preset's name; the copy kept is the slot's patch, so a click opens it)
    await palette.click(0);
    await fm1.quiet();
    const named = structuredClone(sound);
    synth(named).preset = 'Hera 6 pluckpad';
    expect(opened.map((x) => link.encodeFor(x.patch))).toEqual([link.encodeFor(named)]);
  });
  it('the slot\'s own tempo and patterns never force a patch: the entry plays them, and says so', async () => {
    const held = moved(hera(), 1, 0.2);
    held.modules.find((m) => m.type === 'fm1')!.params.tempo = 97;
    const steps = held.modules.find((m) => m.type === 'steps')!;
    steps.params.len = steps.params.len === 8 ? 16 : 8;
    const { fm1, palette, said, slotWrites } = await stored(held);
    expect(await palette.add('Hera 6 B', moved(hera(), 0))).toBe(true);
    await fm1.quiet();
    expect([slotWrites(), fm1.entries[0]?.slot]).toEqual([0, 22]);
    expect(said.at(-1)).toMatch(/\. It plays the tempo and patterns of slot 23$/);
  });
  it('a slot that differs in a setting no device preset holds still takes a patch, and the line says which slot', async () => {
    const held = hera();
    held.modules.find((m) => m.type === 'output')!.params.level = 0.33;
    const { fm1, palette, said, puts } = await stored(held);
    expect(await palette.add('Hera 6 B', moved(hera(), 0))).toBe(true);
    await fm1.quiet();
    expect([fm1.entries[0]?.slot, puts()]).toEqual([0, 0]);
    expect(said.at(-1)).toBe('"Hera 6 B" is palette 1 (stored as a new patch in slot 1, as slot 23 · HERA 6 differs from it in settings no device preset holds)');
  });
  it('a slot of another name that holds the structure is that patch (D-1227): the sound goes in as a preset on it', async () => {
    const { fm1, palette, said, slotWrites } = await stored(moved(hera(), 1, 0.2), 'MY HERA');
    expect(await palette.add('Hera 6 B', moved(hera(), 0))).toBe(true);
    await fm1.quiet();
    expect([fm1.entries[0]?.slot, slotWrites()]).toEqual([22, 0]);
    expect(said.at(-1)).toBe('"Hera 6 B" is palette 1: slot 23 · MY HERA with preset Hera 6 B (preset Hera 6 B sent to the FM-1)');
  });
  it('a sound saved as an extra patch (the old bug) goes in on its real base patch, a slot of its patch\'s name first (owner 2026-11-27: "recognize the actual patch it belongs to rather than the patch it\'s saved with")', async () => {
    const sound = moved(hera(), 0);   // (the patch is Hera 6; the user named the sound "Hera 6 pluckpad")
    const { fm1, link, palette, slotWrites } = await stored(moved(hera(), 1, 0.2));
    const bin = link.encodeFor(sound);
    fm1.slots[23] = { slot: 23, used: true, length: bin.length, name: 'HERA 6 PLUCKPAD' };   // (what the old bug stored)
    fm1.bins[23] = bin;
    expect(await palette.add('Hera 6 pluckpad', sound)).toBe(true);
    await fm1.quiet();
    expect([fm1.entries[0]?.slot, fm1.entries[0]?.devices.map((x) => x.name), slotWrites()]).toEqual([22, ['Hera 6 pluckpad'], 0]);
  });
  it('reads a slot back only as needed: a later add reads again only the slots whose structure may be the sound\'s', async () => {
    const r = await stored(moved(hera(), 1, 0.2), 'MY HERA');
    for (const [i, name] of ['Monolith D', 'Silver Box', '8 Lire'].entries()) {
      const bin = r.link.encodeFor(FM1_PRESETS[name]());
      r.fm1.slots[i] = { slot: i, used: true, length: bin.length, name: name.toUpperCase() };
      r.fm1.bins[i] = bin;
    }
    const read = (from: number): number[] => [...new Set(r.fm1.o.sent.slice(from).filter((f) => f[4] === CMD.slotGet).map((f) => f[5]))].sort((a, b) => a - b);
    let mark = r.fm1.o.sent.length;
    expect(await r.palette.add('Hera 6 B', moved(hera(), 0))).toBe(true);
    await r.fm1.quiet();
    expect(read(mark)).toEqual([0, 1, 2, 22]);
    mark = r.fm1.o.sent.length;
    expect(await r.palette.add('Hera 6 C', moved(hera(), 0, 0.3), { pos: 1 })).toBe(true);
    await r.fm1.quiet();
    expect(read(mark)).toEqual([22]);
    expect([r.fm1.entries[0]?.slot, r.fm1.entries[1]?.slot]).toEqual([22, 22]);
  });
  it('every factory patch read back from its slot is the editor\'s patch as asSlot takes it: the same bytes, each drawer preset the same, effects off included', () => {
    const off: string[] = [];
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const bin = encodePatch(make());
      const read = readFromFm1(bin, { name: name.toUpperCase(), library: browserLibrary() })!;
      const held = asSlot(make(), read.patch);
      if (!held || !sameBytes(encodePatch(held), bin)) off.push(`${name}: ${held ? 'other bytes' : 'other devices'}`);
      const p = make();
      for (const a of p.assemblies ?? []) {
        const t = read.patch.assemblies?.find((x) => x.name === a.name && !x.chain && !x.drawer);
        if (!a.chain && !a.drawer && t && drawerScope(p, a) && JSON.stringify(q16(capturePreset(p, a, '').values)) !== JSON.stringify(q16(capturePreset(read.patch, t, '').values))) off.push(`${name} ${a.name}: drawer preset`);
      }
    }
    expect(off).toEqual([]);
  });
});

describe('a palette entry names a preset only while the device plays it (owner 2026-11-27: "agree with your proposal", D-1226)', () => {
  const hera = (): Patch => FM1_PRESETS['Hera 6']();
  const synth = (p: Patch): AssemblyInst => p.assemblies!.find((a) => a.name === 'Hera 4')!;
  /** card row 0 of `a` moved, as the card moves it */
  function edit(p: Patch, a: AssemblyInst): void {
    const rows = rowOrder(p, a), values = currentValues(p, a);
    const pd = DEFS[p.modules.find((x) => x.id === rows[0].module)!.type].params.find((x) => x.name === rows[0].param)!;
    const step = (pd.max - pd.min) * 0.1;
    values[0] += values[0] + step <= pd.max ? step : -step;
    setRows(p, rows, values);
  }
  /** the FM-1 with `held` in slot 23 as HERA 6, which this browser keeps no copy of */
  async function stored(held: Patch) {
    const r = await linked({ features25: FEATURE25_SLOT_GET | FEATURE5_FX_DRAWERS, candidates: [{ name: 'Hera 6', patch: hera, factory: true }] });
    const bin = r.link.encodeFor(held);
    r.fm1.slots[22] = { slot: 22, used: true, length: bin.length, name: 'HERA 6' };
    r.fm1.bins[22] = bin;
    return r;
  }

  it('a patch stored whole leaves out a card\'s preset name that knob edits made stale, and sends no preset for it', async () => {
    const { fm1, palette, said } = await linked();
    const { p, a } = padPatch();
    edit(p, a);
    expect(a.preset).toBe('Warm1');   // (the card still says so)
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    expect(fm1.entries[0]).toMatchObject({ slot: 0, name: 'MY PAD', devices: [] });
    expect(fm1.presets).toEqual([]);
    expect(palette.chips()[0].presets).toEqual([]);
    expect(said.at(-1)).not.toMatch(/preset/);
  });
  it('a device the add reaches with a preset keeps the slot\'s preset name only while its values are that preset\'s', async () => {
    const held = hera();
    synth(held).preset = 'Glass';   // (a name its card showed before edits)
    const sound = structuredClone(held);
    sound.modules.find((m) => m.type === 'fm1')!.params.tempo = 97;   // (the entry plays the slot's tempo)
    const stale = await stored(held);
    expect(await stale.palette.add('Hera 6 fast', sound)).toBe(true);
    await stale.fm1.quiet();
    expect(stale.fm1.entries[0]).toMatchObject({ slot: 22, devices: [] });
    replaceUserPresets([], [capturePreset(held, synth(held), 'Glass')]);
    const kept = await stored(held);
    expect(await kept.palette.add('Hera 6 fast', sound)).toBe(true);
    await kept.fm1.quiet();
    expect(kept.fm1.entries[0]).toMatchObject({ slot: 22, devices: [{ name: 'Glass' }] });
  });
  it('a device that keeps the slot\'s values but whose card names another preset that has them: the entry names that preset, sent', async () => {
    const held = hera();
    const sound = hera();
    replaceUserPresets([], [capturePreset(sound, synth(sound), 'Mine')]);
    synth(sound).preset = 'Mine';
    const { fm1, palette } = await stored(held);
    expect(await palette.add('Hera 6', sound)).toBe(true);
    await fm1.quiet();
    expect(fm1.entries[0]).toMatchObject({ slot: 22, devices: [{ name: 'Mine' }] });
    expect(fm1.presets.map((p) => p.name)).toEqual(['Mine']);
  });
});

describe('Consolidate the FM-1\'s palette (owner 2026-11-27: "agree with everything you said about the palette", D-1441)', () => {
  const hera = (): Patch => FM1_PRESETS['Hera 6']();
  const synth = (p: Patch): AssemblyInst => p.assemblies!.find((a) => a.name === 'Hera 4')!;
  function moved(p: Patch, row: number, by = 0.1): Patch {
    const a = synth(p), rows = rowOrder(p, a), values = currentValues(p, a);
    const pd = DEFS[p.modules.find((x) => x.id === rows[row].module)!.type].params.find((x) => x.name === rows[row].param)!;
    const step = (pd.max - pd.min) * by;
    values[row] += values[row] + step <= pd.max ? step : -step;
    setRows(p, rows, values);
    return p;
  }
  /** slot 23 HERA 6 (other values than the factory's), slot 24 HERA 6 PLUCKPAD (a tweak an older editor stored whole),
   *  palette 1 on slot 24 as that editor left it */
  async function bug(o: { inBank?: (name: string) => boolean; extra?: (p: Patch) => void } = {}) {
    const r = await linked({ features25: FEATURE25_SLOT_GET | FEATURE5_FX_DRAWERS, inBank: o.inBank });
    const held = moved(hera(), 1, 0.2), sound = moved(hera(), 0);
    o.extra?.(sound);
    for (const [slot, name, p] of [[22, 'HERA 6', held], [23, 'HERA 6 PLUCKPAD', sound]] as const) {
      const bin = r.link.encodeFor(p);
      r.fm1.slots[slot] = { slot, used: true, length: bin.length, name };
      r.fm1.bins[slot] = bin;
    }
    r.fm1.entries[0] = entryOf(sound, 23, 'HERA 6 PLUCKPAD');
    return { ...r, held, sound, bin: r.fm1.bins[23]! };
  }

  it('offers palette 1 as a preset on slot 23, frees slot 24, and Undo puts everything back', async () => {
    const { fm1, link, palette, held, sound, bin } = await bug();
    const was = fm1.entries[0];
    const plan = await palette.planConsolidate();
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.items.map((i) => i.step)).toEqual([{ pos: 0, from: { slot: 23, name: 'HERA 6 PLUCKPAD' }, to: { slot: 22, name: 'HERA 6' }, presets: ['HERA 6 PLUCKPAD'], free: true }]);
    expect([fm1.presets.length, fm1.slots[23].used]).toEqual([0, true]);   // (planning writes nothing)
    const r = await palette.consolidate(plan.items);
    await fm1.quiet();
    expect(r.line).toBe('Consolidated 1 onto slot 23 · HERA 6; slot 24 freed');
    expect([fm1.entries[0]?.slot, fm1.entries[0]?.devices.map((x) => x.name), fm1.slots[23].used, fm1.presets.map((x) => x.name)]).toEqual([22, ['HERA 6 PLUCKPAD'], false, ['HERA 6 PLUCKPAD']]);
    // (the FM-1 plays the same sound as before: slot 23's patch with the preset, the preset under its name)
    const plays = structuredClone(held);
    applyEntry(plays, fm1.entries[0]!);
    const named = structuredClone(sound);
    synth(named).preset = 'HERA 6 PLUCKPAD';
    expect(link.encodeFor(plays)).toEqual(link.encodeFor(named));
    expect(await r.undo!()).toBe('Consolidate undone: each entry is back on its own slot');
    await fm1.quiet();
    expect([fm1.slots[23], fm1.bins[23], fm1.entries[0], fm1.presets]).toEqual([{ slot: 23, used: true, length: bin.length, name: 'HERA 6 PLUCKPAD' }, bin, was, []]);
  });
  it('never offers the base slot\'s own entry, and keeps a slot the bank list needs', async () => {
    const { fm1, palette } = await bug({ inBank: (n) => n === 'HERA 6 PLUCKPAD' });
    fm1.entries[1] = { slot: 22, pattern: 0, name: 'HERA 6', devices: [] };
    const plan = await palette.planConsolidate();
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.items.map((i) => [i.step.pos, i.step.free, i.step.keep])).toEqual([[0, false, 'it is in your bank list']]);
    await palette.consolidate(plan.items);
    await fm1.quiet();
    expect([fm1.entries[0]?.slot, fm1.slots[23].used, fm1.entries[1]?.slot]).toEqual([22, true, 22]);
  });
  it('leaves an entry whose slot differs from its base in a setting no preset holds, and says why', async () => {
    const { palette } = await bug({ extra: (p) => { p.modules.find((m) => m.type === 'output')!.params.level = 0.33; } });
    const plan = await palette.planConsolidate();
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual(['1 · HERA 6 PLUCKPAD (slot 23 · HERA 6 differs from it in settings no device preset holds)']);
  });
});
