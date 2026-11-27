// SPDX-License-Identifier: GPL-3.0-only
// The palettes saved in this browser (saved-palettes.ts, #1236): a sound kept whole, its chip, the default names, the store
// (changes, Recently deleted, write-through, the check on load) and the palette file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly, type AssemblyInst } from './assembly';
import { addUserPreset, applyPreset, currentValues, deletePreset, presetsOf, setFactoryPresets, type Preset } from './device-presets';
import { DEFS } from './modules';
import { connect, newPatch, validatePatch, type Patch } from './patch';
import {
  idbBackend, isPaletteFile, memoryBackend, nextPaletteName, PALETTE_FILE_VERSION, PALETTE_SLOTS, paletteFile, paletteFileName,
  readPaletteFile, SavedPaletteStore, soundChip, soundOf, type PaletteBackend, type PaletteSound, type SavedPalette,
} from './saved-palettes';
import { rowOrder, structureOf } from './structure';

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
let clock = 1_000_000;
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  setFactoryPresets([]);
  // (every change a later time, so the order by change is known)
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});
afterEach(() => vi.restoreAllMocks());

const validate = (p: unknown): Patch => validatePatch(p, DEFS);
const named = (name: string): Patch => {
  const p = newPatch(DEFS);
  p.name = name;
  return p;
};
const sound = (name: string): PaletteSound => ({ name, patch: named(name), presets: [] });
const settle = () => new Promise((r) => setTimeout(r, 20));
/** the sounds as reading checks them (validatePatch fills a new patch's gaps) */
const checked = (sounds: readonly (PaletteSound | null)[]) => sounds.map((s) => s && { ...s, patch: validate(structuredClone(s.patch)) });

/** a patch with one engine set to user preset Warm1 */
function padPatch(name = 'My Pad'): { p: Patch; a: AssemblyInst; structure: string } {
  const p = named(name);
  const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 0, 0);
  const out = p.modules.find((m) => m.type === 'output')!;
  connect(p, DEFS, a.outputs[0], { module: out.id, port: DEFS.output.inputs[0].name });
  const structure = structureOf(p, a);
  addUserPreset(structure, 'Warm1', currentValues(p, a));
  applyPreset(p, a, presetsOf(p, a).find((x) => x.name === 'Warm1')!);
  return { p, a, structure };
}

describe('a sound and its chip', () => {
  it('soundOf keeps a copy: changing the patch afterwards leaves the sound as it was', () => {
    const p = named('Night Bus');
    const s = soundOf('NIGHT BUS B', p);
    p.name = 'changed';
    p.modules.push({ ...p.modules[0], id: 999 });
    expect(s.name).toBe('NIGHT BUS B');
    expect(s.patch.name).toBe('Night Bus');
    expect(s.patch.modules.some((m) => m.id === 999)).toBe(false);
    expect(s.presets).toEqual([]);
  });

  it('soundOf keeps the user presets the devices name, from this browser, with their values', () => {
    const { p, a, structure } = padPatch();
    const s = soundOf('MY PAD', p);
    expect(s.presets).toEqual([{ structure, name: 'Warm1', values: currentValues(p, a) }]);
    // a copy: the browser's preset changing later does not change the sound's
    s.presets[0].values[0] = -1;
    expect(soundOf('MY PAD', p).presets[0].values[0]).not.toBe(-1);
  });

  it('soundOf takes an extra preset a device names that this browser lacks; not one it has, another name or structure', () => {
    const { p, a, structure } = padPatch();
    const values = currentValues(p, a);
    const extra: Preset[] = [
      { structure, name: 'WARM1', values: values.map(() => 0) },          // this browser gives Warm1 already
      { structure, name: 'Other', values },                                 // no device names it
      { structure: 'deadbeef', name: 'Lost', values },                      // another structure
      { structure, name: 'lost', values, factory: true },                   // a factory one: named only
      { structure, name: 'LOST', values },
    ];
    a.preset = 'Lost';
    expect(soundOf('MY PAD', p, extra).presets).toEqual([{ structure, name: 'LOST', values }]);
    a.preset = 'Warm1';
    expect(soundOf('MY PAD', p, extra).presets).toEqual([{ structure, name: 'Warm1', values }]);
  });

  it('soundChip: the name as given, its devices’ preset names, its pattern; an empty position', () => {
    const { p } = padPatch();
    p.modules.find((m) => m.type === 'fm1')!.seq = { pattern: 2 };
    expect(soundChip(soundOf('Night Bus b', p), 3)).toEqual({ pos: 3, state: 'ok', name: 'Night Bus b', presets: ['Warm1'], pattern: 2, cur: false, next: false, copy: true });
    expect(soundChip(null, 0)).toMatchObject({ pos: 0, state: 'empty', presets: [], cur: false, next: false, copy: true });
  });

  it('soundOf drops a card\'s preset name that knob edits made stale, and its preset (D-1226)', () => {
    const { p, a } = padPatch();
    p.modules.find((m) => m.id === rowOrder(p, a)[0].module)!.params[rowOrder(p, a)[0].param] += 0.01;
    const s = soundOf('MY PAD', p);
    expect(s.patch.assemblies!.find((x) => x.id === a.id)!.preset).toBeUndefined();
    expect(s.presets).toEqual([]);
    expect(a.preset).toBe('Warm1');   // (the editor's patch as it was)
  });
});

describe('palette names', () => {
  it('the lowest free Palette N, trimmed and case aside', () => {
    expect(nextPaletteName([])).toBe('Palette 1');
    expect(nextPaletteName(['Palette 1'])).toBe('Palette 2');
    expect(nextPaletteName(['Palette 1', 'Palette 3'])).toBe('Palette 2');
    expect(nextPaletteName([' palette 1 ', 'PALETTE 2', 'Pads'])).toBe('Palette 3');
  });

  it('the file name: unsafe characters dropped, spaces as -, palette when nothing is left', () => {
    expect(paletteFileName('Palette 3')).toBe('Palette-3.palette.json');
    expect(paletteFileName(' Night/Bus: B_2-x ')).toBe('NightBus-B_2-x.palette.json');
    expect(paletteFileName('***')).toBe('palette.palette.json');
  });
});

describe('the saved palettes', () => {
  it('create: Palette 1, 2…, a gap filled; a name given; sounds copied and padded or cut to 8', async () => {
    const store = new SavedPaletteStore(memoryBackend(), validate);
    await store.ready;
    expect(store.create().name).toBe('Palette 1');
    const two = store.create();
    expect(two.name).toBe('Palette 2');
    expect(store.create('  Pads  ').name).toBe('Pads');
    store.rename(two.id, 'Bass');
    expect(store.create('   ').name).toBe('Palette 2');
    const s = sound('A');
    const p = store.create(undefined, [s]);
    expect(p.name).toBe('Palette 3');
    expect(p.sounds).toHaveLength(PALETTE_SLOTS);
    expect(p.sounds.slice(1).every((x) => x === null)).toBe(true);
    s.name = 'changed';
    expect(store.get(p.id)!.sounds[0]!.name).toBe('A');
    const full = store.create('Full', Array.from({ length: 10 }, (_, i) => sound(`S${i}`)));
    expect(full.sounds.map((x) => x?.name)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    expect(full.made).toBe(full.changed);
    expect(store.all()[0].id).toBe(full.id);
  });

  it('rename: trimmed; an empty name keeps the old; most recently changed first', async () => {
    const store = new SavedPaletteStore(memoryBackend(), validate);
    await store.ready;
    const a = store.create(), b = store.create();
    expect(store.all().map((p) => p.id)).toEqual([b.id, a.id]);
    expect(store.rename(a.id, '  Night  ')).toBe(true);
    expect(store.get(a.id)!.name).toBe('Night');
    expect(store.all().map((p) => p.id)).toEqual([a.id, b.id]);
    expect(store.rename(a.id, '   ')).toBe(false);
    expect(store.get(a.id)!.name).toBe('Night');
    expect(store.rename('nobody', 'X')).toBe(false);
  });

  it('setSound, addSound into the first empty position (null when full), move onto empty and swap onto full', async () => {
    const store = new SavedPaletteStore(memoryBackend(), validate);
    await store.ready;
    const p = store.create();
    const s = sound('A');
    expect(store.setSound(p.id, 2, s)).toBe(true);
    s.name = 'changed';
    expect(store.get(p.id)!.sounds[2]!.name).toBe('A');
    expect(store.addSound(p.id, sound('B'))).toBe(0);
    expect(store.addSound(p.id, sound('C'))).toBe(1);
    expect(store.addSound(p.id, sound('D'))).toBe(3);
    expect(store.setSound(p.id, 1, null)).toBe(true);
    expect(store.addSound(p.id, sound('E'))).toBe(1);
    const names = () => store.get(p.id)!.sounds.map((x) => x?.name ?? null);
    expect(names()).toEqual(['B', 'E', 'A', 'D', null, null, null, null]);
    store.move(p.id, 0, 6);
    expect(names()).toEqual([null, 'E', 'A', 'D', null, null, 'B', null]);
    store.move(p.id, 2, 6);
    expect(names()).toEqual([null, 'E', 'B', 'D', null, null, 'A', null]);
    for (let i = 0; i < 4; i++) store.addSound(p.id, sound(`F${i}`));
    expect(store.addSound(p.id, sound('G'))).toBeNull();
    expect(store.addSound('nobody', sound('G'))).toBeNull();
  });

  it('remove: to Recently deleted, newest first, up to 32; putBack brings it back with its own changed, written', async () => {
    const backend = memoryBackend();
    const store = new SavedPaletteStore(backend, validate);
    await store.ready;
    const list = Array.from({ length: 34 }, () => store.create());
    for (const p of list) expect(store.remove(p.id)).toBe(true);
    expect(store.all()).toEqual([]);
    expect(store.deleted()).toHaveLength(32);
    expect(store.deleted()[0].palette.id).toBe(list[33].id);
    expect(store.deleted().at(-1)!.palette.id).toBe(list[2].id);
    expect(store.putBack(list[0].id)).toBe(false);   // gone past the 32
    const back = list[20];
    expect(store.putBack(back.id)).toBe(true);
    expect(store.deleted().some((d) => d.palette.id === back.id)).toBe(false);
    expect(store.all().map((p) => p.id)).toEqual([back.id]);
    expect(store.get(back.id)!.changed).toBe(back.changed);
    await settle();
    const again = new SavedPaletteStore(backend, validate);
    await again.ready;
    expect(again.all().map((p) => p.id)).toEqual([back.id]);
    expect(again.get(back.id)!.changed).toBe(back.changed);
    // Recently deleted is this session's only
    expect(again.deleted()).toEqual([]);
  });

  it('writes through: a new store on the same backend has the same palettes; onChange after each change and the load', async () => {
    const backend = memoryBackend();
    const store = new SavedPaletteStore(backend, validate);
    let said = 0;
    store.onChange = () => said++;
    await store.ready;
    expect(said).toBe(1);
    const a = store.create('Pads', [sound('A')]);
    const b = store.create();
    store.addSound(b.id, soundOf('MY PAD', padPatch().p));
    store.move(a.id, 0, 5);
    store.rename(b.id, 'Leads');
    expect(said).toBe(6);
    await settle();
    const again = new SavedPaletteStore(backend, validate);
    await again.ready;
    expect(again.all()).toEqual(store.all().map((p) => ({ ...p, sounds: checked(p.sounds) })));
  });

  it('writes the palettes of each id in order', async () => {
    const landed: string[] = [];
    let n = 0;
    const backend: PaletteBackend = {
      load: async () => [],
      put: (p) => new Promise((r) => setTimeout(() => { landed.push(`put ${p.name}`); r(); }, n++ === 0 ? 30 : 1)),
      delete: (id) => new Promise((r) => setTimeout(() => { landed.push(`delete ${id}`); r(); }, n++ === 0 ? 30 : 1)),
    };
    const store = new SavedPaletteStore(backend, validate);
    await store.ready;
    const p = store.create('One');
    store.rename(p.id, 'Two');
    store.remove(p.id);
    await new Promise((r) => setTimeout(r, 80));
    expect(landed).toEqual(['put One', 'put Two', `delete ${p.id}`]);
  });

  it('a palette removed before the load lands stays removed', async () => {
    const seed: SavedPalette = { id: 'old', name: 'Old', sounds: Array(PALETTE_SLOTS).fill(null), made: 1, changed: 1 };
    const store = new SavedPaletteStore(memoryBackend([seed]), validate);
    store.remove('old');
    await store.ready;
    expect(store.get('old')).toBeUndefined();
    expect(store.all()).toEqual([]);
  });

  it('the check on load: a sound whose patch fails is empty, bad presets dropped, sounds padded or cut, no palette dropped', async () => {
    const good = named('Good');
    const raw = [
      { id: 'a', name: ' Pads ', made: 1, changed: 2, presetNames: 'true', sounds: [
        { name: 'BAD', patch: { not: 'a patch' }, presets: [] },
        { name: 'GOOD', patch: good, presets: [{ structure: 'deadbeef', name: 'Ok', values: [1, 2] }, { structure: 'deadbeef', values: [1] }, 'x'] },
      ] },
      { id: 'b', name: 'Long', made: 1, changed: 1, presetNames: 'true', sounds: Array.from({ length: 10 }, () => ({ name: 'S', patch: good, presets: [] })) },
      { id: 'c', sounds: [] },
      { name: 'No id', sounds: [] },
      'junk',
    ] as unknown as SavedPalette[];
    const store = new SavedPaletteStore(memoryBackend(raw), validate);
    await store.ready;
    expect(store.all().map((p) => p.id)).toEqual(['a', 'b']);
    const a = store.get('a')!;
    expect(a.name).toBe('Pads');
    expect(a.sounds).toHaveLength(PALETTE_SLOTS);
    expect(a.sounds[0]).toBeNull();
    expect(a.sounds[1]).toMatchObject({ name: 'GOOD', patch: { name: 'Good' }, presets: [{ structure: 'deadbeef', name: 'Ok', values: [1, 2] }] });
    expect(a.sounds[1]!.presets).toHaveLength(1);
    expect(store.get('b')!.sounds).toHaveLength(PALETTE_SLOTS);
  });

  it('a palette kept before D-1226 has its preset names worked out again once, silently: stale ones and their presets go, true ones stay, nothing else changes', async () => {
    const { p, a, structure } = padPatch();
    const stale = structuredClone(p);
    const row = rowOrder(stale, a)[0];
    stale.modules.find((m) => m.id === row.module)!.params[row.param] += 0.01;
    // (a name only the sound's own preset holds is true too: another browser's preset)
    const theirs = structuredClone(p);
    theirs.assemblies!.find((x) => x.id === a.id)!.preset = 'Theirs';
    const own: Preset = { structure, name: 'Theirs', values: currentValues(p, a) };
    const warm: Preset = { structure, name: 'Warm1', values: currentValues(p, a) };
    const seed = { id: 'old', name: 'Old', made: 5, changed: 6, sounds: [
      { name: 'STALE', patch: stale, presets: [warm] }, { name: 'TRUE', patch: p, presets: [warm] }, { name: 'THEIRS', patch: theirs, presets: [own] },
    ] } as unknown as SavedPalette;
    const backend = memoryBackend([seed]);
    const store = new SavedPaletteStore(backend, validate);
    await store.ready;
    const got = store.get('old')!;
    const presetOf = (s: PaletteSound | null): string | undefined => s!.patch.assemblies!.find((x) => x.id === a.id)!.preset;
    expect(got.sounds.slice(0, 3).map(presetOf)).toEqual([undefined, 'Warm1', 'Theirs']);
    expect(got.sounds.slice(0, 3).map((s) => s!.presets.map((x) => x.name))).toEqual([[], ['Warm1'], ['Theirs']]);
    expect(got.sounds.map((s) => s?.name ?? null)).toEqual(['STALE', 'TRUE', 'THEIRS', null, null, null, null, null]);
    expect([got.name, got.made, got.changed, got.presetNames]).toEqual(['Old', 5, 6, 'true']);
    await settle();
    const [written] = await backend.load();
    expect(written.presetNames).toBe('true');
    expect(written.changed).toBe(6);
    expect(presetOf(written.sounds[0])).toBeUndefined();
    // (once: a later load leaves the names alone, whatever this browser's presets are by then)
    deletePreset(structure, 'Warm1');
    const again = new SavedPaletteStore(backend, validate);
    await again.ready;
    expect(presetOf(again.get('old')!.sounds[1])).toBe('Warm1');
  });

  it('a palette file an older editor wrote is read with true preset names only', () => {
    const { p, a } = padPatch();
    const row = rowOrder(p, a)[0];
    p.modules.find((m) => m.id === row.module)!.params[row.param] += 0.01;
    const file = JSON.parse(JSON.stringify({ format: 'matryoshka-palette', version: 1, name: 'Old', sounds: [{ name: 'MY PAD', patch: p, presets: [] }] }));
    const got = readPaletteFile(file, validate);
    expect(got.sounds[0]!.patch.assemblies!.find((x) => x.id === a.id)!.preset).toBeUndefined();
  });

  it('without a backend the palettes live in memory; idbBackend is null without IndexedDB', async () => {
    const store = new SavedPaletteStore(null, validate);
    await store.ready;
    const p = store.create();
    expect(store.get(p.id)).toBeDefined();
    expect(idbBackend(undefined)).toBeNull();
  });
});

describe('the palette file', () => {
  it('round trip: the file read back gives the name and the sounds', async () => {
    const store = new SavedPaletteStore(null, validate);
    await store.ready;
    const p = store.create('Palette 3', [soundOf('NIGHT BUS B', padPatch().p), null, sound('Two')]);
    const text = paletteFile(p);
    expect(text).toContain('\n  "format": "matryoshka-palette"');
    const raw = JSON.parse(text);
    expect(raw).toMatchObject({ format: 'matryoshka-palette', version: PALETTE_FILE_VERSION, name: 'Palette 3' });
    expect(isPaletteFile(raw)).toBe(true);
    expect(readPaletteFile(raw, validate)).toEqual({ name: 'Palette 3', sounds: checked(p.sounds), dropped: 0 });
  });

  it('no palette file, or one a newer editor made, says so', () => {
    expect(isPaletteFile({ version: 2, modules: [] })).toBe(false);
    expect(isPaletteFile(null)).toBe(false);
    expect(() => readPaletteFile({ version: 2, modules: [], cables: [] }, validate)).toThrow('not a palette file');
    expect(() => readPaletteFile('junk', validate)).toThrow('not a palette file');
    expect(() => readPaletteFile({ format: 'matryoshka-palette', version: 1 }, validate)).toThrow('not a palette file');
    expect(() => readPaletteFile({ format: 'matryoshka-palette', version: 2, name: 'X', sounds: [] }, validate)).toThrow('made by a newer editor: update this page');
  });

  it('a sound whose patch fails is empty and counted; sounds padded or cut to 8', () => {
    const good = named('Good');
    const r = readPaletteFile({
      format: 'matryoshka-palette', version: 1, name: ' Night ',
      sounds: [{ name: 'A', patch: good, presets: [] }, null, { name: 'B', patch: { bad: true }, presets: [] }, 'junk', ...Array(8).fill({ name: 'C', patch: good, presets: [] })],
    }, validate);
    expect(r.name).toBe('Night');
    expect(r.dropped).toBe(2);
    expect(r.sounds).toHaveLength(PALETTE_SLOTS);
    expect(r.sounds.map((s) => s?.name ?? null)).toEqual(['A', null, null, null, 'C', 'C', 'C', 'C']);
  });
});
