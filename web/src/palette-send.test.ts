// SPDX-License-Identifier: GPL-3.0-only
// Saved palettes and the FM-1's palette (#1236): Send to FM-1 (a saved palette replaces the FM-1's by add's rules), what
// it left (`from`), Save from FM-1 (capture, linked and offline), and the names an add gives what it makes, against the
// stand-in FM-1 (test-palette-fm1.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly, type AssemblyInst } from './assembly';
import { binLength, type Candidate } from './bank';
import { DeviceLink } from './device';
import { addUserPreset, applyPreset, currentValues, presetsOf, replaceUserPresets, setFactoryPresets, userPresets } from './device-presets';
import { DEFS } from './modules';
import { connect, newPatch, type Patch } from './patch';
import { NO_SAME_STRUCTURE, Palette, PALETTE_FROM, paletteDevices, patchPattern, type PalettePorts } from './palette';
import { CMD, type PaletteEntry } from './protocol';
import type { PaletteSound } from './saved-palettes';
import { rowOrder, structureOf } from './structure';
import { setRows } from './fx-preset';
import { PaletteFm1 } from './test-palette-fm1';

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  setFactoryPresets([]);
});

/** a patch with one engine set to user preset Warm1, and a second preset Bright of the same engine with other values */
function padPatch(name = 'My Pad'): { p: Patch; a: AssemblyInst; structure: string } {
  const p = newPatch(DEFS);
  p.name = name;
  const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 0, 0);
  const out = p.modules.find((m) => m.type === 'output')!;
  connect(p, DEFS, a.outputs[0], { module: out.id, port: DEFS.output.inputs[0].name });
  const s = structureOf(p, a);
  const values = currentValues(p, a);
  addUserPreset(s, 'Warm1', values);
  addUserPreset(s, 'Bright', values.map((v, i) => (i === 0 ? v + 0.25 : v)));
  applyPreset(p, a, presetsOf(p, a).find((x) => x.name === 'Warm1')!);
  return { p, a, structure: s };
}

/** `p` with its engine on preset `name` */
function withPreset(p: Patch, a: AssemblyInst, name: string): Patch {
  const q = structuredClone(p);
  const qa = q.assemblies!.find((x) => x.id === a.id)!;
  applyPreset(q, qa, presetsOf(q, qa).find((x) => x.name === name)!);
  return q;
}

/** `p` with card row `row` of its engine moved by `by` (no preset name: values no preset holds) */
function tweaked(p: Patch, a: AssemblyInst, by: number, row = 1): Patch {
  const q = structuredClone(p);
  const qa = q.assemblies!.find((x) => x.id === a.id)!;
  const rows = rowOrder(q, qa), values = currentValues(q, qa);
  values[row] += by;
  setRows(q, rows, values);
  delete qa.preset;
  return q;
}

/** a pad of another sound (its output level): no slot that holds a pad patch holds it byte for byte (the name is not
 *  in the binary) */
function otherPatch(name: string): Patch {
  const { p } = padPatch(name);
  p.modules.find((m) => m.type === 'output')!.params.level = 0.5;
  return p;
}

const sound = (name: string, patch: Patch, presets: PaletteSound['presets'] = []): PaletteSound => ({ name, patch, presets });
const sentCmds = (fm1: PaletteFm1): number[] => fm1.o.sent.map((f) => f[4]);
const q16 = (values: number[]): number[] => values.map((v) => Math.round(v * 65536));

/** the editor's link to a stand-in FM-1, and a palette on it with recorded ports (as palette.test.ts) */
async function linked(o: { features25?: number; candidates?: Candidate[] } = {}) {
  const fm1 = new PaletteFm1({ features25: o.features25 });
  const g = globalThis as unknown as { window?: unknown; navigator: { requestMIDIAccess?: unknown } };
  g.window ??= globalThis;
  g.navigator.requestMIDIAccess = async () => ({ inputs: new Map([[fm1.i.id, fm1.i]]), outputs: new Map([[fm1.o.id, fm1.o]]), onstatechange: null });
  const link = new DeviceLink();
  await link.connect();
  const said: string[] = [];
  const ports: PalettePorts = {
    device: link,
    candidates: () => o.candidates ?? [],
    live: () => false,
    current: () => newPatch(DEFS),
    versions: () => [],
    open: () => {},
    kept: () => {},
    liveOff: () => {},
    say: (t) => void said.push(t),
    full: () => {},
    changed: () => {},
  };
  const palette = new Palette(ports, storage);
  link.onEvent = (e) => {
    if (e.kind === 'info') void palette.infoHeard();
    if (e.kind === 'palette') palette.received(e.now);
    if (e.kind === 'slot') palette.slotNow();
  };
  await palette.connected();
  return { fm1, link, palette, said, ports };
}

/** a palette with no FM-1 connected, on the same storage: any call to the device counts (none should happen) */
function offline(o: { candidates?: Candidate[] } = {}) {
  const said: string[] = [];
  let calls = 0;
  const base: Record<string, unknown> = { connected: false, hasPalette: false, readsSlots: false, hasPresets: false };
  const device = new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => { calls++; throw new Error('not connected'); }) }) as unknown as PalettePorts['device'];
  const ports: PalettePorts = {
    device,
    candidates: () => o.candidates ?? [],
    live: () => false,
    current: () => newPatch(DEFS),
    versions: () => [],
    open: () => {},
    kept: () => {},
    liveOff: () => {},
    say: (t) => void said.push(t),
    full: () => {},
    changed: () => {},
  };
  return { palette: new Palette(ports, storage), said, calls: () => calls };
}

describe('Send to FM-1 (#1236)', () => {
  it('replaces the whole palette: each position its sound, a position left empty emptied, the old entries gone', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots[10] = { slot: 10, used: true, length: 10, name: 'OLD A' };
    fm1.slots[11] = { slot: 11, used: true, length: 10, name: 'OLD B' };
    fm1.entries[0] = { slot: 10, pattern: 0, name: 'OLD A', devices: [] };
    fm1.entries[5] = { slot: 11, pattern: 0, name: 'OLD B', devices: [] };
    fm1.report();
    await fm1.quiet();
    const sounds = [sound('My Pad', padPatch().p), null, sound('Second', otherPatch('Second')), null, null, null, null, null];
    expect(await palette.send(sounds, { id: 'p3', name: 'Palette 3' })).toBe(true);
    await fm1.quiet();
    expect(fm1.entries.map((e) => e?.name ?? null)).toEqual(['MY PAD', null, 'SECOND', null, null, null, null, null]);
    expect(palette.chips().map((c) => c.name)).toEqual(['MY PAD', '', 'SECOND', '', '', '', '', '']);
    expect(said.at(-1)).toMatch(/^Palette 3 is on the FM-1: 2 sounds \(2 stored as new patches, 1 preset sent\) · "My Pad" is palette 1 \(stored as a new patch/);
  });
  it('a sound that differs from a slot\'s patch in card values only goes in as a preset on that slot: no slot written', async () => {
    const { p, a } = padPatch();
    const { fm1, link, palette } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    fm1.slots[5] = { slot: 5, used: true, length: binLength(p), name: 'MY PAD' };
    fm1.bins[5] = link.encodeFor(p);
    expect(await palette.send([sound('My Pad B', withPreset(p, a, 'Bright')), null, null, null, null, null, null, null], { id: 'p1', name: 'Palette 1' })).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1)).not.toContain(CMD.slot);
    expect(sentCmds(fm1)).toContain(CMD.presetPut);
    expect(fm1.findPreset(structureOf(p, a), 'Bright')).toBeTruthy();
    expect(fm1.entries[0]).toMatchObject({ slot: 5, devices: [{ name: 'Bright' }] });
  });
  it('a sound whose tempo or patterns alone differ still uses the slot: no new patch', async () => {
    const { p } = padPatch();
    const { fm1, link, palette, said } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    fm1.slots[5] = { slot: 5, used: true, length: binLength(p), name: 'MY PAD' };
    fm1.bins[5] = link.encodeFor(p);
    const fast = structuredClone(p);
    fast.modules.find((m) => m.type === 'fm1')!.params.tempo = 151;
    expect(await palette.send([sound('Fast', fast), null, null, null, null, null, null, null], { id: 'p1', name: 'Palette 1' })).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1)).not.toContain(CMD.slot);
    expect(fm1.entries[0]).toMatchObject({ slot: 5 });
    expect(said.at(-1)).toMatch(/It plays the tempo of slot 6/);
  });
  it('a sound new to the FM-1 is stored as a patch into a free slot, its reason in the line', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'TAKEN' };
    expect(await palette.send([sound('My Pad', padPatch().p), null, null, null, null, null, null, null], { id: 'p1', name: 'Palette 1' })).toBe(true);
    await fm1.quiet();
    expect(fm1.slots[1]).toMatchObject({ used: true, name: 'MY PAD' });
    expect(fm1.entries[0]).toMatchObject({ slot: 1, name: 'MY PAD' });
    expect(said.at(-1)).toContain(`"My Pad" is palette 1 (stored as a new patch in slot 2, as ${NO_SAME_STRUCTURE}`);
  });
  it('the same sound twice stores one patch', async () => {
    const { fm1, palette } = await linked();
    const { p } = padPatch();
    expect(await palette.send([sound('My Pad', p), sound('My Pad', structuredClone(p)), null, null, null, null, null, null], { id: 'p1', name: 'Palette 1' })).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1).filter((c) => c === CMD.slot)).toHaveLength(1);
    expect(fm1.entries[1]?.slot).toBe(fm1.entries[0]?.slot);
  });
  it('a saved sound\'s own preset, not in this browser, is sent to the FM-1 by its name and joins this browser\'s presets', async () => {
    const { fm1, palette } = await linked();
    const { p, a, structure } = padPatch();
    const warm = userPresets().find((x) => x.name === 'Warm1')!;
    replaceUserPresets(userPresets(), []);
    expect(await palette.send([sound('My Pad', p, [warm]), null, null, null, null, null, null, null], { id: 'p1', name: 'Palette 1' })).toBe(true);
    await fm1.quiet();
    expect(fm1.findPreset(structure, 'Warm1')?.q16).toEqual(q16(currentValues(p, a)));
    expect(fm1.entries[0]).toMatchObject({ devices: [{ name: 'Warm1' }] });
    expect(userPresets().map((x) => x.name)).toEqual(['Warm1']);
  });
  it('the bank full: that position is left empty and the line says so; the others are still sent', async () => {
    const { p } = padPatch();
    const { fm1, link, palette, said } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    fm1.slots = fm1.slots.map((s) => (s.slot === 5 ? { slot: 5, used: true, length: binLength(p), name: 'MY PAD' } : { ...s, used: true, length: 1, name: `P${s.slot}` }));
    fm1.bins[5] = link.encodeFor(p);
    fm1.entries[0] = { slot: 7, pattern: 0, name: 'P7', devices: [] };
    fm1.report();
    await fm1.quiet();
    expect(await palette.send([sound('Other', otherPatch('Other')), sound('My Pad', p), null, null, null, null, null, null], { id: 'p1', name: 'Palette 1' })).toBe(true);
    await fm1.quiet();
    expect(fm1.entries[0]).toBeNull();
    expect(fm1.entries[1]).toMatchObject({ slot: 5 });
    expect(said.at(-1)).toMatch(/^Palette 1 is on the FM-1: 1 sound · 1 failed: The FM-1's bank is full: "Other" was not added/);
  });
  it('blocked (a switch waiting, no FM-1): false, nothing written', async () => {
    const { fm1, palette, said } = await linked();
    fm1.slots[0] = { slot: 0, used: true, length: 10, name: 'A' };
    fm1.entries[0] = { slot: 0, pattern: 0, name: 'A', devices: [] };
    fm1.report();
    await fm1.quiet();
    fm1.running = true;
    await palette.click(0);
    await fm1.quiet();
    const ops = fm1.ops.length, frames = fm1.o.sent.length;
    expect(await palette.send([sound('My Pad', padPatch().p), null, null, null, null, null, null, null], { id: 'p1', name: 'Palette 1' })).toBe(false);
    expect([fm1.ops.length, fm1.o.sent.length]).toEqual([ops, frames]);
    expect(said.at(-1)).toMatch(/waiting to switch/);
    const off = offline();
    expect(await off.palette.send([sound('My Pad', padPatch().p), null, null, null, null, null, null, null], { id: 'p1', name: 'Palette 1' })).toBe(false);
    expect(off.calls()).toBe(0);
    expect(off.said.at(-1)).toMatch(/Connect the FM-1/);
  });
  it('`from`: set after a send, kept for a new page, gone once the palette changes', async () => {
    const { fm1, palette } = await linked();
    expect(palette.from).toBeNull();
    await palette.send([sound('My Pad', padPatch().p), null, null, null, null, null, null, null], { id: 'p3', name: 'Palette 3' });
    await fm1.quiet();
    expect(palette.from).toEqual({ id: 'p3', name: 'Palette 3' });
    expect(JSON.parse(mem.get(PALETTE_FROM)!)).toMatchObject({ id: 'p3', name: 'Palette 3', hashes: expect.any(Array) });
    expect(offline().palette.from).toEqual({ id: 'p3', name: 'Palette 3' });
    fm1.slots[9] = { slot: 9, used: true, length: 10, name: 'B' };
    await palette.add('B', null, { pos: 3, slot: { slot: 9, name: 'B' } });
    await fm1.quiet();
    expect(palette.from).toBeNull();
    expect(JSON.parse(mem.get(PALETTE_FROM)!)).toBeNull();
    expect(offline().palette.from).toBeNull();
  });
});

describe('Save from FM-1: the FM-1\'s palette as sounds (#1236)', () => {
  it('linked: each copy SLOT_GET verified, the entry\'s presets and pattern applied, a preset only the FM-1 has read back; MISSING and no copy listed', async () => {
    const { p, a, structure } = padPatch();
    const { fm1, link, palette } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    const theirs = currentValues(p, a).map((v, i) => (i === 0 ? v + 0.5 : v));
    fm1.presets.push({ structure, name: 'THEIRS', q16: q16(theirs) });
    fm1.slots[5] = { slot: 5, used: true, length: binLength(p), name: 'MY PAD' };
    fm1.bins[5] = link.encodeFor(p);
    fm1.slots[7] = { slot: 7, used: true, length: 77, name: 'STRANGER' };
    const dev = paletteDevices(p)[0].dev;
    fm1.entries[0] = { slot: 5, pattern: 2, name: 'MY PAD', devices: [{ dev, structure: parseInt(structure, 16) >>> 0, pstructure: 0, name: 'Theirs' }] };
    fm1.entries[1] = { slot: 20, pattern: 0, name: 'GONE', devices: [] };
    fm1.entries[2] = { slot: 7, pattern: 0, name: 'STRANGER', devices: [] };
    fm1.report();
    await fm1.quiet();
    const got = await palette.capture();
    expect(sentCmds(fm1)).toContain(CMD.slotGet);
    expect(sentCmds(fm1)).toContain(CMD.presetGet);
    expect(got!.missed).toEqual(['2 · GONE (MISSING)', '3 · STRANGER (no copy in this browser)']);
    expect(got!.sounds.slice(1)).toEqual([null, null, null, null, null, null, null]);
    const s = got!.sounds[0]!;
    expect(s.name).toBe('MY PAD');
    expect(patchPattern(s.patch)).toBe(2);
    const sa = s.patch.assemblies!.find((x) => x.id === a.id)!;
    expect(sa.preset?.toUpperCase()).toBe('THEIRS');
    expect(currentValues(s.patch, sa)[0]).toBeCloseTo(theirs[0], 4);
    expect(s.presets.map((x) => [x.structure, x.name.toUpperCase()])).toEqual([[structure, 'THEIRS']]);
  });
  it('offline: the copies this browser kept first, then the candidates; the rest in missed', async () => {
    const { p, a } = padPatch();
    const { fm1, palette } = await linked();
    fm1.slots[7] = { slot: 7, used: true, length: 77, name: 'STRANGER' };
    fm1.entries[1] = { slot: 7, pattern: 0, name: 'STRANGER', devices: [] };
    fm1.report();
    await fm1.quiet();
    await palette.add('My Pad', p, { pos: 0 });
    await fm1.quiet();
    // (a candidate of the same name and length with other values: the kept copy wins)
    const older = withPreset(p, a, 'Bright');
    older.assemblies!.find((x) => x.id === a.id)!.preset = 'Warm1';
    expect(binLength(older)).toBe(binLength(p));
    const off = offline({ candidates: [{ name: 'My Pad', patch: () => structuredClone(older) }] });
    const got = await off.palette.capture();
    expect(off.calls()).toBe(0);
    expect(got!.missed).toEqual(['2 · STRANGER (no copy in this browser)']);
    const s = got!.sounds[0]!;
    expect(s.name).toBe('MY PAD');
    expect(currentValues(s.patch, s.patch.assemblies!.find((x) => x.id === a.id)!)).toEqual(currentValues(p, a));
    expect(s.presets.map((x) => x.name)).toEqual(['Warm1']);
  });
  it('a palette never read: null, and says so', async () => {
    const off = offline();
    expect(await off.palette.capture()).toBeNull();
    expect(off.said.at(-1)).toBe("The FM-1's palette was never read in this browser");
  });
});

describe('the name an add is given names what it makes (owner 2026-11-24)', () => {
  it('a card-value tweak makes a preset of that name, a second tweak the name numbered', async () => {
    const { p, a } = padPatch();
    const { fm1, link, palette } = await linked({ candidates: [{ name: 'My Pad', patch: () => structuredClone(p) }] });
    fm1.slots[5] = { slot: 5, used: true, length: binLength(p), name: 'MY PAD' };
    fm1.bins[5] = link.encodeFor(p);
    expect(await palette.add('My Name', tweaked(p, a, 0.01))).toBe(true);
    await fm1.quiet();
    expect(await palette.add('My Name', tweaked(p, a, 0.02), { pos: 1 })).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1)).not.toContain(CMD.slot);
    expect(fm1.entries.slice(0, 2)).toMatchObject([{ slot: 5, devices: [{ name: 'My Name' }] }, { slot: 5, devices: [{ name: 'My Name 2' }] }]);
    expect(fm1.presets.map((x) => x.name)).toEqual(['My Name', 'My Name 2']);
  });
  it('a new patch goes to a slot of that name, numbered when a slot of that name holds another patch', async () => {
    const { fm1, palette } = await linked();
    expect(await palette.add('Lead X', padPatch('Lead X').p)).toBe(true);
    await fm1.quiet();
    expect(fm1.slots[0]).toMatchObject({ used: true, name: 'LEAD X' });
    const other = padPatch('Lead X').p;
    other.modules.find((m) => m.type === 'output')!.params.level = 0.5;
    expect(await palette.add('Lead X', other, { pos: 1 })).toBe(true);
    await fm1.quiet();
    expect(fm1.slots[1]).toMatchObject({ used: true, name: 'LEAD X 2' });
    expect(fm1.entries.slice(0, 2)).toMatchObject([{ slot: 0, name: 'LEAD X' }, { slot: 1, name: 'LEAD X 2' }]);
  });
});
