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
import { addUserPreset, applyPreset, currentValues, presetsOf, setFactoryPresets } from './device-presets';
import { DEFS } from './modules';
import { connect, newPatch, type Patch } from './patch';
import { applyEntry, entryOf, moveOrder, Palette, PALETTE_STORE, paletteDevices, repointed, type PalettePorts } from './palette';
import { chipMeta } from './palette-view';
import { FM1_PRESETS } from './presets';
import { invalidatePresetPatterns } from './preset-patterns';
import { CMD, PALETTE, type PaletteEntry } from './protocol';
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
async function linked(o: { features?: number; features25?: number; presetRoom?: number; live?: boolean; candidates?: Candidate[]; current?: () => Patch; onSlot?: () => void } = {}) {
  const fm1 = new PaletteFm1({ features: o.features, features25: o.features25, presetRoom: o.presetRoom });
  const g = globalThis as unknown as { window?: unknown; navigator: { requestMIDIAccess?: unknown } };
  g.window ??= globalThis;
  g.navigator.requestMIDIAccess = async () => ({ inputs: new Map([[fm1.i.id, fm1.i]]), outputs: new Map([[fm1.o.id, fm1.o]]), onstatechange: null });
  const link = new DeviceLink();
  await link.connect();
  const said: string[] = [], opened: { patch: Patch; adopt: boolean; from: string }[] = [], off: string[] = [];
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
    changed: () => {},
  };
  const palette = new Palette(ports, storage);
  link.onEvent = (e) => {
    if (e.kind === 'info') void palette.infoHeard();   // (as main.ts: an INFO not asked for answers another program's HELLO)
    if (e.kind === 'palette') palette.received(e.now);
    if (e.kind === 'slot') { palette.slotNow(); o.onSlot?.(); }   // (as main.ts: then the editor drops its pattern origins)
  };
  await palette.connected();
  return { fm1, link, palette, said, opened, off, kept: () => kept, live: () => live };
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
    expect(said.at(-1)).toBe('"My Pad" is palette 1 (preset Warm1 sent to the FM-1)');
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
  it('says so when the bank or the palette is full, and adds nothing', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots = fm1.slots.map((s) => ({ ...s, used: true, length: 1, name: `P${s.slot}` }));
    expect(await palette.add('My Pad', padPatch().p)).toBe(false);
    expect(said.at(-1)).toMatch(/bank is full/);
    fm1.entries = fm1.entries.map(() => ({ slot: 0, pattern: 0, name: 'P0', devices: [] }));
    fm1.report();
    await fm1.quiet();
    expect(await palette.add('My Pad', padPatch().p)).toBe(false);
    expect(said.at(-1)).toBe('Palette full: drag onto a chip to replace');
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
    expect(said.at(-1)).toBe('"My Pad" is palette 1 (preset Warm1 sent to the FM-1)');
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
    expect(said.at(-1)).toBe('"My Pad" is palette 1 (preset Warm1 updated on the FM-1)');
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
  it('does not point at a slot of the patch\'s name and length that holds other values: stores the patch, numbered', async () => {
    const { fm1, palette, said, link } = await linked();
    const { p, a } = padPatch();
    const older = structuredClone(p);
    const oa = older.assemblies!.find((x) => x.id === a.id)!;
    applyPreset(older, oa, presetsOf(older, oa).find((x) => x.name === 'Bright')!);
    oa.preset = 'Warm1';
    fm1.slots[0] = { slot: 0, used: true, length: binLength(older), name: 'MY PAD' };
    fm1.bins[0] = link.encodeFor(older);
    expect(fm1.bins[0].length).toBe(link.encodeFor(p).length);
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    expect(fm1.slots[1]).toMatchObject({ used: true, name: 'MY PAD 2' });
    expect(fm1.bins[1]).toEqual(link.encodeFor(p));
    expect(fm1.entries[0]).toMatchObject({ slot: 1, name: 'MY PAD 2' });
    expect(said.at(-1)).toBe('"My Pad" is palette 1 (preset Warm1 sent to the FM-1; slot 1 holds another "MY PAD", so it is stored as "MY PAD 2" in slot 2)');
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
    const { fm1, palette, opened, said } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(mine) }] });
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
    expect(palette.chips()[0].copy).toBe(false);   // (My Pad changed since: no longer what slot 2 holds)
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
    expect(said.at(-1)).toBe('"My Pad" is palette 1. The FM-1 could not take preset Warm1 (its preset store is full): palette 1 plays the values stored with the patch in slot 1');
  });
  it('with firmware that keeps no presets, sends none and falls back the same way', async () => {
    const { fm1, palette, said } = await linked({ features: 1 << 31 });
    const { p } = padPatch();
    expect(await palette.add('My Pad', p)).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1).some((c) => c >= CMD.presets && c <= CMD.presetDel)).toBe(false);
    expect(fm1.entries[0]).toMatchObject({ devices: [] });
    expect(said.at(-1)).toBe('"My Pad" is palette 1. The FM-1 could not take preset Warm1 (update the FM-1 to store presets on it): palette 1 plays the values stored with the patch in slot 1');
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
