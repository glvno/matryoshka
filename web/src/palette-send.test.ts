// SPDX-License-Identifier: GPL-3.0-only
// Saved palettes and the FM-1's palette (#1236): Send to FM-1 (a saved palette replaces the FM-1's by add's rules), what
// it left (`from`), Save from FM-1 (capture, linked and offline), and the names an add gives what it makes, against the
// stand-in FM-1 (test-palette-fm1.ts).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { drawers, effectsOf, insertAssembly, type AssemblyInst } from './assembly';
import { binLength, deviceName, readFm1Bin, type Candidate } from './bank';
import { DeviceLink } from './device';
import { addUserPreset, applyPreset, currentValues, presetsOf, replaceUserPresets, setFactoryPresets, userPresets } from './device-presets';
import { DEFS } from './modules';
import { connect, newPatch, validatePatch, type Patch } from './patch';
import { Palette, PALETTE_FROM, type PalettePorts } from './palette';
import { applyEntry, entryOf, narrowTo, NO_SAME_STRUCTURE, paletteDevices, patchPattern, takeTempoAndPatterns, unheldChanges } from './preset-fit';
import { FM1_PRESETS } from './presets';
import { CMD, FEATURE25_SLOT_GET, FEATURE5_FX_DRAWERS, type PaletteEntry } from './protocol';
import { readPaletteFile, type PaletteSound } from './saved-palettes';
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
  it('`from` outlives a report older than the Send (a write during it, arriving late)', async () => {
    const { fm1, palette } = await linked();
    await palette.send([sound('My Pad', padPatch().p), null, null, null, null, null, null, null], { id: 'p3', name: 'Palette 3' });
    await fm1.quiet();
    const now = palette.now!;
    palette.received({ ...now, seq: (now.seq - 1) & 0xffff, positions: now.positions.map((p, i) => (i ? p : { ...p, state: 0 as const, hash: 0 })) });
    await fm1.quiet();
    expect(JSON.parse(mem.get(PALETTE_FROM)!)).toMatchObject({ id: 'p3' });
    palette.received(now);
    await fm1.quiet();
    expect(palette.from).toEqual({ id: 'p3', name: 'Palette 3' });
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

/** the sounds of a Library > Palettes file in test-fixtures (`stem`.palette.json) */
const savedPalette = (stem: string): PaletteSound[] =>
  readPaletteFile(JSON.parse(readFileSync(new URL(`./test-fixtures/${stem}.palette.json`, import.meta.url), 'utf8')), (p) => validatePatch(p, DEFS)).sounds.filter((s) => !!s);
const NAMES = Object.keys(FM1_PRESETS);
/** the FM-1 after a factory reset: each factory patch in its slot, as the 1.30 editor encodes it, which it knows */
async function reset() {
  const r = await linked({ features25: FEATURE25_SLOT_GET | FEATURE5_FX_DRAWERS, candidates: NAMES.map((name) => ({ name, patch: FM1_PRESETS[name], factory: true })) });
  NAMES.forEach((name, slot) => {
    const bin = r.link.encodeFor(FM1_PRESETS[name]());
    r.fm1.slots[slot] = { slot, used: true, length: bin.length, name: deviceName(name) };
    r.fm1.bins[slot] = bin;
  });
  return r;
}

describe('a palette saved before 1.30, sent to a factory-reset 1.30 FM-1 (owner 2026-11-28: "7 of them were stored as new patches")', () => {
  // (Library > Palettes files written by the 1.26.6, 1.28.0 and 1.29.0 editors: Hera 6, Algo Four, Shush 101, Wanderer,
  // Oracle V and Canvas each with a card value moved, Monolith D and Sallen 20 as they were. The 1.30 factory patches sit
  // where Tidy puts them, which changed the page order of Hera 6, Algo Four, Shush 101, Wanderer, Monolith D and Oracle V,
  // D-1458)
  const FIXTURES = ['1.26.6', '1.28.0', '1.29.0'];
  const saved = (version: string): PaletteSound[] => savedPalette(`palette-4-${version}`);
  const factoryOf = (s: PaletteSound): string => s.name.replace(/ T$/, '');

  for (const version of FIXTURES) {
    it(`saved by ${version}: every sound goes in on its factory slot, no patch stored`, async () => {
      const sounds = saved(version);
      const { fm1, palette, said } = await reset();
      expect(await palette.send(sounds, { id: 'p4', name: 'Palette 4' })).toBe(true);
      await fm1.quiet();
      expect(sentCmds(fm1)).not.toContain(CMD.slot);
      expect(fm1.entries.map((e) => e?.slot)).toEqual(sounds.map((s) => NAMES.indexOf(factoryOf(s))));
      expect(said.at(-1)).not.toMatch(/new patch/);
    });
  }
  it('a slot this browser has no copy of, read back: the sound saved in the old page order still takes it', async () => {
    const hera = saved('1.29.0').find((s) => factoryOf(s) === 'Hera 6')!;
    const { fm1, link, palette } = await linked({ features25: FEATURE25_SLOT_GET | FEATURE5_FX_DRAWERS });
    const bin = link.encodeFor(FM1_PRESETS['Hera 6']());
    fm1.slots[30] = { slot: 30, used: true, length: bin.length, name: 'MY HERA' };
    fm1.bins[30] = bin;
    expect(await palette.send([hera, null, null, null, null, null, null, null], { id: 'p4', name: 'Palette 4' })).toBe(true);
    await fm1.quiet();
    expect(sentCmds(fm1)).not.toContain(CMD.slot);
    expect(fm1.entries[0]).toMatchObject({ slot: 30, devices: [{ name: 'Hera 6 T' }] });
  });
  it('Consolidate folds a patch 1.30.0 stored for such a sound back onto its factory slot', async () => {
    const hera = saved('1.29.0').find((s) => factoryOf(s) === 'Hera 6')!;
    const { fm1, link, palette } = await reset();
    // (as 1.30.0 left it: the sound stored whole as HERA 6 2, palette 1 on it)
    const bin = link.encodeFor(hera.patch);
    fm1.slots[40] = { slot: 40, used: true, length: bin.length, name: 'HERA 6 2' };
    fm1.bins[40] = bin;
    fm1.entries[0] = entryOf(hera.patch, 40, 'HERA 6 2');
    const plan = await palette.planConsolidate();
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.items.map((i) => i.step)).toEqual([{ pos: 0, from: { slot: 40, name: 'HERA 6 2' }, to: { slot: 3, name: 'HERA 6' }, presets: ['HERA 6 2'], free: true }]);
    const r = await palette.consolidate(plan.items);
    await fm1.quiet();
    expect(r.line).toBe('Consolidated 1 onto slot 4 · HERA 6; slot 41 freed');
    expect([fm1.entries[0]?.slot, fm1.slots[40].used]).toEqual([3, false]);
  });
});

describe('FX drawer effects switched, in a palette saved before 1.30 (owner 2026-11-28: "patches with fx rack effects toggled on/off differently")', () => {
  // (a Library > Palettes file written by the 1.29.0 editor: Hera 6 with its Delay on; Oracle V with its Chorus on in its
  // drawer switched off; Briefcase 3 with its Chorus on; Monolith D with its Reverb on and moved first; and the owner's
  // four sounds that stayed patches after Consolidate, as his FM-1 holds them: Padding (Hera 6 with its effects on, its
  // Output at full and its FX button unassigned), Gauze (Hera 6 with its Drive taken out), Workhorse (Verona Drum 1 with
  // a drawer holding a Drive) and Stub (Algo Four with its Harmonizer switched on))
  const sounds = (): PaletteSound[] => savedPalette('palette-fx-1.29.0');

  it('Send: a switched effect goes in as a preset on its factory slot, so does a sound lacking an effect its slot has (that one switched off); a patch no preset reaches is stored, and the line says why', async () => {
    const { fm1, palette, said } = await reset();
    expect(await palette.send(sounds(), { id: 'fx', name: 'Palette FX' })).toBe(true);
    await fm1.quiet();
    expect(fm1.entries.map((e) => e && fm1.slots[e.slot].name)).toEqual(['HERA 6', 'ORACLE V', 'BRIEFCASE 3', 'MONOLITH D MV', 'PADDING', 'HERA 6', 'WORKHORSE', 'STUB']);
    expect(said.at(-1)).toBe('Palette FX is on the FM-1: 8 sounds (4 stored as new patches, 2 presets sent) · '
      + '"Hera 6 DL" is palette 1: slot 4 · HERA 6 with preset Hera 6 DL (preset Hera 6 DL sent to the FM-1) · '
      + '"Oracle V CO" is palette 2 · '
      + '"Briefcase 3 B" is palette 3: slot 10 · BRIEFCASE 3 with preset Briefcase 3 B (preset Briefcase 3 B sent to the FM-1) · '
      + '"Monolith D MV" is palette 4 (stored as a new patch in slot 22, as its FX drawer holds Reverb, Drive, Chorus, Delay and slot 1 · MONOLITH D\'s holds Drive, Chorus, Delay, Reverb: a preset cannot add or move an effect) · '
      + '"Padding" is palette 5 (stored as a new patch in slot 23, as it changes settings no device preset holds: the FX button, Output level) · '
      // (Gauze plays Hera 6 DL's values: its Delay on, the Drive it lacks off)
      + '"Gauze" is palette 6: slot 4 · HERA 6 with preset Hera 6 DL (Drive switched off, not in this sound) · '
      + '"Workhorse" is palette 7 (stored as a new patch in slot 24, as its FX drawer holds Drive and slot 20 · VERONA DRUM 1 has none: a preset cannot add or move an effect) · '
      + '"Stub" is palette 8 (stored as a new patch in slot 25, as it changes settings no device preset holds: Harmonizer switched on)');
  });

  /** the FM-1 after a factory reset with each sound stored whole as 1.30.0's Send stored it, the palette on them */
  async function stored() {
    const list = sounds();
    const r = await reset();
    list.forEach((s, pos) => {
      const slot = NAMES.length + pos, name = deviceName(s.name), bin = r.link.encodeFor(s.patch);
      r.fm1.slots[slot] = { slot, used: true, length: bin.length, name };
      r.fm1.bins[slot] = bin;
      r.fm1.entries[pos] = entryOf(s.patch, slot, name);
    });
    return { ...r, list };
  }

  it('Consolidate, each stored whole as 1.30.0 sent it: folds the switched effects and a sound lacking an effect its base has, offers Fold anyway only for settings no preset holds, and says why each other one stays', async () => {
    const { fm1, link, palette, list } = await stored();
    const plan = await palette.planConsolidate();
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.items.map(({ step }) => [step.pos + 1, step.to.name, step.presets, step.adopts, step.off])).toEqual([
      [1, 'HERA 6', ['HERA 6 DL'], undefined, undefined], [2, 'ORACLE V', [], undefined, undefined], [3, 'BRIEFCASE 3', ['BRIEFCASE 3 B'], undefined, undefined],
      [5, 'HERA 6', ['PADDING'], ['FX button unassigned → gate', 'Output level 1.00 → 0.39'], undefined],
      [6, 'HERA 6', ['GAUZE'], undefined, ['Drive']],
      [8, 'ALGO FOUR', ['STUB'], ['Harmonizer on → off'], undefined],
    ]);
    expect(plan.skipped).toEqual([
      '4 · MONOLITH D MV (its FX drawer holds Reverb, Drive, Chorus, Delay and slot 1 · MONOLITH D\'s holds Drive, Chorus, Delay, Reverb: a preset cannot add or move an effect)',
      '7 · WORKHORSE (its FX drawer holds Drive and slot 20 · VERONA DRUM 1 has none: a preset cannot add or move an effect)',
    ]);
    // (as the confirmation leaves them: the Fold anyway rows unticked)
    const r = await palette.consolidate(plan.items.filter((i) => !i.step.adopts));
    await fm1.quiet();
    expect(r.line).toBe('Consolidated 1 onto slot 4 · HERA 6, 2 onto slot 2 · ORACLE V, 3 onto slot 10 · BRIEFCASE 3, 6 onto slot 4 · HERA 6; slots 22, 23, 24, 27 freed');
    expect(fm1.entries.map((e) => e?.slot)).toEqual([3, 1, 9, 24, 25, 3, 27, 28]);
    // (Gauze plays its own sound: Hera 6 with its entry has the Drive off, and without the Drive it is Gauze, value for
    // value; a switched-off effect passes its input through, sample for sample in both engines)
    const plays = FM1_PRESETS['Hera 6']();
    applyEntry(plays, fm1.entries[5]!);
    expect(effectsOf(plays, drawers(plays)[0]).find((e) => e.name === 'Drive')?.bypass).toBe(true);
    const read = async (p: Patch): Promise<Patch> => (await readFm1Bin({ getPattern: async () => null }, link.encodeFor(p), 'X'))!.patch;
    const narrowed = await read(narrowTo(list[5].patch, plays)!.patch), gauze = await read(list[5].patch);
    takeTempoAndPatterns(gauze, narrowed);
    expect(unheldChanges(narrowed, gauze)).toEqual([]);
  });

  it('Fold anyway, ticked: Padding and Stub become presets on their factory slots and play its settings; Undo puts them back', async () => {
    const { fm1, palette, list } = await stored();
    const was = structuredClone(fm1.entries), bins = fm1.bins.slice();
    const plan = await palette.planConsolidate();
    if (typeof plan === 'string') throw new Error(plan);
    const r = await palette.consolidate(plan.items.filter((i) => i.step.adopts));
    await fm1.quiet();
    expect(r.line).toBe('Consolidated 5 onto slot 4 · HERA 6, 8 onto slot 7 · ALGO FOUR; slots 26, 29 freed');
    // (each plays its factory slot with its preset: the sound with the slot's Output level and FX button, or Harmonizer,
    // and the slot's tempo and patterns, which an entry always plays)
    const padding = structuredClone(list[4].patch), stub = structuredClone(list[7].patch);
    padding.modules.find((m) => m.type === 'output')!.params.level = FM1_PRESETS['Hera 6']().modules.find((m) => m.type === 'output')!.params.level;
    delete padding.modules.find((m) => m.type === 'fm1')!.panel!.kinds!.fx;
    stub.modules.find((m) => m.type === 'harm')!.bypass = true;
    for (const [pos, factory, sound] of [[4, 'Hera 6', padding], [7, 'Algo Four', stub]] as const) {
      const plays = FM1_PRESETS[factory]();
      applyEntry(plays, fm1.entries[pos]!);
      takeTempoAndPatterns(sound, plays);
      expect([fm1.entries[pos]?.slot, unheldChanges(plays, sound)], list[pos].name).toEqual([NAMES.indexOf(factory), []]);
    }
    expect(await r.undo!()).toBe('Consolidate undone: each entry is back on its own slot');
    await fm1.quiet();
    expect([fm1.entries, fm1.bins.slice(0, bins.length)]).toEqual([was, bins]);
  });

  it('the owner\'s GAUZE (no Drive, and its Output level and FX button as PADDING\'s): Fold anyway, the Drive switched off too; ticked, it folds and Undo puts it back', async () => {
    const { fm1, link, palette } = await stored();
    // (as his FM-1 holds it: the sound saved with the old "+ FX" bus, its Output at full and its FX button unassigned)
    const gauze = savedPalette('palette-fx-1.29.0')[5].patch;
    gauze.modules.find((m) => m.type === 'output')!.params.level = 1;
    gauze.modules.find((m) => m.type === 'fm1')!.panel!.kinds!.fx = 'nothing';
    const bin = link.encodeFor(gauze);
    fm1.slots[26] = { slot: 26, used: true, length: bin.length, name: 'GAUZE' };
    fm1.bins[26] = bin;
    fm1.entries[5] = entryOf(gauze, 26, 'GAUZE');
    const was = structuredClone(fm1.entries);
    const plan = await palette.planConsolidate();
    if (typeof plan === 'string') throw new Error(plan);
    const step = plan.items.find((i) => i.step.pos === 5)!;
    expect(step.step).toMatchObject({ to: { slot: 3, name: 'HERA 6' }, adopts: ['FX button unassigned → gate', 'Output level 1.00 → 0.39'], off: ['Drive'] });
    const r = await palette.consolidate([step]);
    await fm1.quiet();
    expect([r.line, fm1.entries[5]?.slot, fm1.slots[26].used]).toEqual(['Consolidated 6 onto slot 4 · HERA 6; slot 27 freed', 3, false]);
    expect(await r.undo!()).toBe('Consolidate undone: each entry is back on its own slot');
    await fm1.quiet();
    expect([fm1.entries, fm1.bins[26]]).toEqual([was, bin]);
  });
});
