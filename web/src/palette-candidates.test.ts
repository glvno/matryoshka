// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The palette and the editor's candidates (owner 2026-11-24: "when synced, using the fm1 to save a sound to the palette
// nukes all other candidates from the palette and just sets that sound as current"; candidates all alike, D-970, D-1425): a
// real editor with candidates of the patch, the palette wired to it as main.ts wires it, the candidate sets kept as
// main.ts keeps them, and the stand-in FM-1 (test-palette-fm1.ts). No palette event throws a candidate away: a hold-save
// of the patch the editor plays, whichever candidate it is, changes nothing; a switch makes that sound the current patch by
// the open rules (D-972, D-1321): the candidate that holds it is heard, or it joins its patch's set, and a set put away
// comes back with its patch. Adds take the candidate heard, named after it (D-1319).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { DeviceLink } from './device';
import { currentValues, setFactoryPresets } from './device-presets';
import { setRows } from './fx-preset';
import { rowOrder } from './structure';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { connect, newPatch, type Patch } from './patch';
import { entryOf, Palette, type PalettePorts } from './palette';
import { binLength, type Candidate } from './bank';
import { FM1_PRESETS } from './presets';
import { PaletteFm1 } from './test-palette-fm1';
import { paletteName } from './snapshots';
import { CandidateStore, memoryBackend } from './candidate-store';

// (jsdom lacks these; selector.ts makes its ResizeObserver when it loads, so before the imports)
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

beforeEach(() => {
  localStorage.clear();
  setFactoryPresets([]);
});

const nop = (): void => {};

/** a patch with one engine, heard, its output at `level` (a value the FM-1 keeps: another level is another version of
 *  the same length) */
function pad(name: string, level = 0.15): Patch {
  const p = newPatch(DEFS);
  p.name = name;
  const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 0, 0);
  const out = p.modules.find((m) => m.type === 'output')!;
  connect(p, DEFS, a.outputs[0], { module: out.id, port: DEFS.output.inputs[0].name });
  out.params.level = level;
  return p;
}
const level = (p: Patch): number => p.modules.find((m) => m.type === 'output')!.params.level as number;

/** an editor on `start` (A) with the candidates `cands` (B, C…; by default other levels of it), the palette linked to the
 *  stand-in FM-1 under Live, its ports as main.ts makes them; `saved`: this browser's saved patches (the copies a switch
 *  opens) */
async function rig(saved: Candidate[] = [], start = pad('My Pad'), cands = [pad('My Pad', 0.4), pad('My Pad', 0.6)]) {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const store = new CandidateStore(memoryBackend(), (p) => p as Patch);
  const ev: EditorEvents = { onStructure: nop, onParam: nop, onAtt: nop, onBypass: nop, onRange: nop, onTrack: nop, onSilence: nop, onTransport: nop, onLayout: nop, onError: nop, onSaveAssembly: nop, onPutAway: (set) => void store.save(set) };
  const editor = new Editor(document.getElementById('canvas')!, structuredClone(start), ev);
  for (const c of cands) editor.snaps.take(c);
  const fm1 = new PaletteFm1();
  const g = globalThis as unknown as { navigator: { requestMIDIAccess?: unknown } };
  g.navigator.requestMIDIAccess = async () => ({ inputs: new Map([[fm1.i.id, fm1.i]]), outputs: new Map([[fm1.o.id, fm1.o]]), onstatechange: null });
  const link = new DeviceLink();
  await link.connect();
  let live = true;
  const off: string[] = [], said: string[] = [];
  const ports: PalettePorts = {
    device: link,
    candidates: () => saved,
    versions: () => editor.snaps.list.map((s) => editor.snapshotVersion(s)),   // (as main.ts)
    live: () => live,
    current: () => editor.patch,   // (as main.ts: the candidate heard, which Live sends to the FM-1)
    open: (p) => { editor.openPatch(p, (q, except) => store.find(q, except), true); store.save(editor.exportSet(), { opened: true }); },   // (as main.ts's loadNamed for a palette switch)
    kept: nop,
    liveOff: (why) => { live = false; off.push(why); },
    say: (t) => void said.push(t),
    full: (t) => void said.push(t),
    changed: nop,
  };
  const palette = new Palette(ports, localStorage);
  link.onEvent = (e) => {
    if (e.kind === 'palette') palette.received(e.now);
    if (e.kind === 'slot') palette.slotNow();
  };
  await palette.connected();
  /** the candidates' letters and levels, the one heard, and its level */
  const state = () => ({ list: editor.snaps.list.map((s) => [s.letter, level(editor.snapshotVersion(s))]), current: editor.snaps.current, level: level(editor.patch) });
  /** the patch grip dragged onto chip `pos` (main.ts patchDragSource: the candidate heard, under its palette name) */
  const grip = (pos: number) => palette.add(paletteName(editor.patch.name, editor.snaps.shown, editor.snaps.list.length), structuredClone(editor.patch), { pos });
  /** the level of the patch in the slot that chip `pos` points at */
  const chipLevel = (pos: number): number => [pad('My Pad'), pad('My Pad', 0.4), pad('My Pad', 0.6)].map(level).find((l) => {
    const bin = fm1.bins[fm1.entries[pos]!.slot]!;
    return link.encodeFor(pad('My Pad', l)).every((x, i) => x === bin[i]);
  }) ?? NaN;
  return { editor, fm1, link, palette, store, off, said, live: () => live, state, grip, chipLevel };
}

const mine = [['A', 0.15], ['B', 0.4], ['C', 0.6]];

describe('a palette event keeps the editor\'s candidates (owner 2026-11-24)', () => {
  it('a hold-save on the FM-1 while the editor plays A keeps every candidate and A heard', async () => {
    const { editor, fm1, link, off, live, state } = await rig([{ name: 'My Pad', patch: () => pad('My Pad') }]);
    fm1.holdSave(2, link.encodeFor(editor.patch), 'MY PAD', entryOf(editor.patch, 0));
    await fm1.quiet();
    expect(state()).toEqual({ list: mine, current: 'A', level: 0.15 });
    expect([off, live()]).toEqual([[], true]);
  });
  it('a hold-save on the FM-1 while the editor plays candidate B keeps every candidate and B heard', async () => {
    const { editor, fm1, link, off, live, state } = await rig([{ name: 'My Pad', patch: () => pad('My Pad') }]);
    editor.showSnapshot('B');
    expect(level(editor.patch)).toBe(0.4);   // (under Live the FM-1 plays B)
    fm1.holdSave(2, link.encodeFor(editor.patch), 'MY PAD', entryOf(editor.patch, 0));
    await fm1.quiet();
    expect(state()).toEqual({ list: mine, current: 'B', level: 0.4 });
    expect([off, live()]).toEqual([[], true]);
  });
  it('a switch to another patch\'s entry opens it with a set of its own and puts this one away; a switch back brings it back', async () => {
    const other = pad('Other Pad', 0.9);
    const saved: Candidate[] = [{ name: 'Other Pad', patch: () => structuredClone(other) }];
    const { editor, fm1, link, palette, store, state } = await rig(saved);
    const mySet = editor.snaps.id;
    editor.showSnapshot('C');
    fm1.slots[5] = { slot: 5, used: true, length: binLength(other), name: 'OTHER PAD' };
    fm1.bins[5] = link.encodeFor(other);
    fm1.entries[0] = entryOf(other, 5);
    fm1.tap(0);
    await fm1.quiet();
    expect(editor.patch.name).toBe('Other Pad');
    expect(state()).toEqual({ list: [['A', 0.9]], current: 'A', level: 0.9 });
    expect(store.get(mySet)?.list.map((s) => [s.letter, level(JSON.parse(s.patch) as Patch)])).toEqual(mine);   // (put away, whole)
    // back to the entry of My Pad from the chips: its set comes back, the candidate that holds the sound heard
    fm1.slots[6] = { slot: 6, used: true, length: binLength(pad('My Pad')), name: 'MY PAD' };
    fm1.bins[6] = link.encodeFor(pad('My Pad'));
    fm1.entries[1] = entryOf(pad('My Pad'), 6);
    fm1.report();
    await fm1.quiet();
    saved.push({ name: 'My Pad', patch: () => pad('My Pad') });
    await palette.click(1);
    await fm1.quiet();
    expect([editor.snaps.id, editor.patch.name]).toEqual([mySet, 'My Pad']);
    expect(state()).toEqual({ list: mine, current: 'A', level: 0.15 });
  });
  it('a switch to an entry of this patch that no candidate holds: it joins the candidates, heard; none is dropped', async () => {
    const tweaked = pad('My Pad', 0.8);
    const { editor, fm1, link, state } = await rig([{ name: 'My Pad', patch: () => structuredClone(tweaked) }]);
    editor.showSnapshot('B');
    fm1.slots[5] = { slot: 5, used: true, length: binLength(tweaked), name: 'MY PAD' };
    fm1.bins[5] = link.encodeFor(tweaked);
    fm1.entries[0] = entryOf(tweaked, 5);
    fm1.tap(0);
    await fm1.quiet();
    expect(state()).toEqual({ list: [...mine, ['D', 0.8]], current: 'D', level: 0.8 });
    expect(editor.snaps.get('D')!.from).toBe('opened');
  });
});

describe('a sound added to the palette from a candidate (owner 2026-11-24: "FM-1 switched to palette 3 · …: no copy in this browser")', () => {
  it('the patch grip takes the candidate heard, named after it: A, B and C dragged onto chips 1-3 are three sounds', async () => {
    const { editor, fm1, grip, chipLevel } = await rig();
    await grip(0);
    editor.showSnapshot('B');
    await grip(1);
    editor.showSnapshot('C');
    await grip(2);
    await fm1.quiet();
    expect([0, 1, 2].map(chipLevel)).toEqual([0.15, 0.4, 0.6]);
    expect([0, 1, 2].map((pos) => fm1.entries[pos]!.name)).toEqual(['MY PAD A', 'MY PAD B', 'MY PAD C']);
  });
  it('a candidate with a name gives the slot its name ("MY PAD BRIGHT")', async () => {
    const { editor, fm1, grip } = await rig();
    editor.renameSnapshot('A', 'Bright');
    await grip(0);
    await fm1.quiet();
    expect(fm1.entries[0]!.name).toBe('MY PAD BRIGHT');
  });
  it('a switch to a chip added from a candidate makes that candidate heard, Live on, every candidate kept', async () => {
    const { editor, fm1, off, live, state, grip } = await rig();
    await grip(0);
    editor.showSnapshot('B');
    await grip(1);
    editor.showSnapshot('C');
    await grip(2);
    await fm1.quiet();
    fm1.tap(1);   // (the FM-1 switches to palette 2 while the editor plays C)
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state()).toEqual({ list: mine, current: 'B', level: 0.4 });
    fm1.tap(0);
    await fm1.quiet();
    expect(state()).toEqual({ list: mine, current: 'A', level: 0.15 });
    fm1.tap(2);
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state()).toEqual({ list: mine, current: 'C', level: 0.6 });
  });
  it('Add to palette from candidate C changes no candidate; the switch to that chip after makes C heard (1.26.3 qualification)', async () => {
    // (Release1263's run on the emulator: Generate, C heard, Add to palette, B heard, chip 1 clicked; then A showed C's
    // sound, not the opened patch's. The add leaves every candidate as it was; the switch is what makes the sound on that
    // chip heard: the candidate that holds it, D-972, D-1321)
    const { editor, fm1, palette, off, live, state, grip } = await rig(undefined, pad('My Pad'), [pad('My Pad', 0.4), pad('My Pad', 0.6), pad('My Pad', 0.8)]);
    const all = [...mine, ['D', 0.8]];
    editor.showSnapshot('C');
    expect(await grip(0)).toBe(true);   // (main.ts addCurrentToPalette: the candidate heard into the first empty position)
    await fm1.quiet();
    expect(state()).toEqual({ list: all, current: 'C', level: 0.6 });
    editor.showSnapshot('A');
    expect(level(editor.patch)).toBe(0.15);
    editor.showSnapshot('B');
    await palette.click(0);   // (chip 1 while B plays: the FM-1 switches, the editor follows under Live)
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state()).toEqual({ list: all, current: 'C', level: 0.6 });
  });
  it('an edit made after the add stays in the candidate: the chip then opens the copy this browser kept as a new candidate, Live on', async () => {
    const { editor, fm1, off, live, state, grip } = await rig();
    editor.showSnapshot('B');
    await grip(0);
    await fm1.quiet();
    editor.setParam(editor.patch.modules.find((m) => m.type === 'output')!.id, 'level', 0.45);
    editor.showSnapshot('A');
    fm1.tap(0);
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state()).toEqual({ list: [['A', 0.15], ['B', 0.45], ['C', 0.6], ['D', 0.4]], current: 'D', level: 0.4 });
  });
  it('candidates that are Monolith D tweaks go in on its slot with presets; a switch to each makes that candidate heard (owner 2026-11-24)', async () => {
    const mono = FM1_PRESETS['Monolith D'];
    /** Monolith D with card row `row` of its instrument moved, as the card moves it */
    const tweaked = (row: number): Patch => {
      const p = mono(), a = p.assemblies!.find((x) => x.name === 'Monolith D')!;
      const rows = rowOrder(p, a), values = currentValues(p, a);
      values[row] += values[row] >= 0.5 ? -0.1 : 0.1;
      setRows(p, rows, values);
      return p;
    };
    const { editor, fm1, link, palette, off, live, grip } = await rig([{ name: 'Monolith D', patch: mono, factory: true }], mono(), [tweaked(4), tweaked(5)]);
    fm1.bins[0] = link.encodeFor(mono());
    fm1.slots[0] = { slot: 0, used: true, length: fm1.bins[0].length, name: 'Monolith D' };
    const values = (): number[] => editor.snaps.list.map((s) => currentValues(editor.snapshotVersion(s), editor.snapshotVersion(s).assemblies!.find((x) => x.name === 'Monolith D')!)[4]);
    const before = values();
    editor.showSnapshot('C');
    expect(await grip(0)).toBe(true);
    editor.showSnapshot('B');
    expect(await grip(1)).toBe(true);
    await fm1.quiet();
    expect(fm1.entries.slice(0, 2)).toMatchObject([{ slot: 0, devices: [{ name: 'Monolith D C' }] }, { slot: 0, devices: [{ name: 'Monolith D B' }] }]);
    expect(fm1.slots[1].used).toBe(false);
    editor.showSnapshot('A');
    await palette.click(0);
    await fm1.quiet();
    expect([editor.snaps.current, editor.snaps.list.length, off, live()]).toEqual(['C', 3, [], true]);
    fm1.tap(1);
    await fm1.quiet();
    expect([editor.snaps.current, editor.snaps.list.length, values(), off, live()]).toEqual(['B', 3, before, [], true]);
  });
});

describe('the owner\'s palette of 2026-11-24 (his v1.26.3 test editor\'s storage, build/palette-repro)', () => {
  it('Hera 6: palette 1 the factory patch, 2-7 dragged from candidates; switches to 1, then 3, keep Live and the candidates', async () => {
    // (what his browser kept: palette 1 → slot 22 "HERA 6"; palettes 2-8 all → slot 23 "HERA 6 2", one sound however many
    // candidates he chose; then "FM-1 switched to palette 3 · HERA 6 2: no copy in this browser, so Live sync is off")
    const hera = FM1_PRESETS['Hera 6']();
    const at = (v: number): Patch => {
      const p = structuredClone(hera);
      p.modules.find((m) => m.type === 'output')!.params.level = v;
      return p;
    };
    const { editor, fm1, link, off, said, live, state, grip } = await rig([{ name: 'Hera 6', patch: () => FM1_PRESETS['Hera 6'](), factory: true }], hera, [at(0.31), at(0.47)]);
    for (let slot = 0; slot < 22; slot++) fm1.slots[slot] = { slot, used: true, length: 100, name: `P${slot}` };
    fm1.bins[22] = link.encodeFor(hera);
    fm1.slots[22] = { slot: 22, used: true, length: fm1.bins[22].length, name: 'HERA 6' };   // (the factory slot, untouched)
    expect(fm1.bins[22].length).toBe(2315);
    await grip(0);
    await fm1.quiet();
    expect(fm1.entries[0]).toMatchObject({ slot: 22 });
    // Mutate edits A in place (D-975): A changes, the factory sound is only A's original now
    editor.setParam(editor.patch.modules.find((m) => m.type === 'output')!.id, 'level', 0.23);
    // a candidate chosen, then the grip dragged onto palettes 2-7
    for (const [pos, letter] of (['B', 'C', 'A', 'B', 'C', 'A'] as const).entries()) {
      editor.showSnapshot(letter);
      await grip(pos + 1);
      await fm1.quiet();
    }
    expect(said.filter((t) => !t.startsWith('Storing') && !/is palette/.test(t))).toEqual([]);
    expect(fm1.entries.slice(1, 7).map((e) => e && e.slot)).toEqual([23, 24, 25, 23, 24, 25]);   // (each candidate its own sound)
    expect(fm1.entries.slice(1, 4).map((e) => e && e.name)).toEqual(['HERA 6 B', 'HERA 6 C', 'HERA 6 A']);
    fm1.tap(0);   // (palette 1 on the FM-1: the factory Hera 6, which no candidate holds now: it joins them)
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state()).toMatchObject({ current: 'D', level: level(hera) });
    expect(state().list.map(([, l]) => l)).toEqual([0.23, 0.31, 0.47, level(hera)]);
    fm1.tap(2);   // (palette 3: candidate C)
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state()).toMatchObject({ current: 'C', level: 0.47 });
    expect(state().list.map(([, l]) => l)).toEqual([0.23, 0.31, 0.47, level(hera)]);
  });
});

describe('a switch to a sound of another instrument (owner 2026-11-24: "the fm1 switches to that instrument but the editor does not switch with it")', () => {
  /** a factory patch at output level `v`: no saved patch and no factory slot holds its bytes */
  const edited = (name: string, v: number): Patch => {
    const p = FM1_PRESETS[name]();
    p.modules.find((m) => m.type === 'output')!.params.level = v;
    return p;
  };
  /** the candidates' patch names */
  const names = (editor: Editor): string[] => editor.snaps.list.map((s) => (JSON.parse(s.patch) as Patch).name);
  it('Monolith D, Silver Box and Hera 6 added, other patches opened since: an FM-1 tap and a chip click follow to each, Live on, each set kept', async () => {
    // (the sound added from a patch the editor left: opening another patch puts its set away, D-972, so the current set's
    // versions no longer hold it, and no saved patch does; the copy this browser kept when it added it opens it, through
    // the open rules, so a set that holds it comes back)
    const mono = edited('Monolith D', 0.31), box = edited('Silver Box', 0.32), hera = edited('Hera 6', 0.33);
    const { editor, fm1, palette, store, off, live, grip } = await rig([], mono, []);
    const open = (p: Patch): void => { editor.openPatch(p, (q, except) => store.find(q, except)); void store.save(editor.exportSet(), { opened: true }); };   // (as main.ts's loadNamed)
    expect(await grip(0)).toBe(true);
    open(structuredClone(box));
    expect(await grip(1)).toBe(true);
    open(structuredClone(hera));
    editor.duplicate();   // (Hera 6's set: two candidates, B heard)
    editor.showSnapshot('A');
    expect(await grip(2)).toBe(true);
    await fm1.quiet();
    fm1.tap(0);   // (HOME + black key 1 on the FM-1: Monolith D)
    await fm1.quiet();
    expect([editor.patch.name, level(editor.patch), off, live()]).toEqual(['Monolith D', 0.31, [], true]);
    expect(names(editor)).toEqual(['Monolith D']);
    await palette.click(1);   // (chip 2: Silver Box)
    await fm1.quiet();
    expect([editor.patch.name, level(editor.patch), off, live()]).toEqual(['Silver Box', 0.32, [], true]);
    fm1.tap(2);   // (Hera 6: its set comes back, both candidates, A heard)
    await fm1.quiet();
    expect([editor.patch.name, level(editor.patch), off, live()]).toEqual(['Hera 6', 0.33, [], true]);
    expect([names(editor), editor.snaps.current]).toEqual([['Hera 6', 'Hera 6'], 'A']);
  });
  it('a hold-save of a kit on the FM-1, then Hera 6 opened and saved there too: a switch back opens the kit', async () => {
    const kit = edited('808 Kit', 0.32), hera = edited('Hera 6', 0.33);
    const { editor, fm1, link, palette, store, off, live } = await rig([], kit, []);
    fm1.holdSave(0, link.encodeFor(editor.patch), '808 KIT', entryOf(editor.patch, 0));
    await fm1.quiet();
    editor.openPatch(structuredClone(hera), (q, except) => store.find(q, except));
    fm1.holdSave(1, link.encodeFor(editor.patch), 'HERA 6', entryOf(editor.patch, 0));
    await fm1.quiet();
    expect([editor.patch.name, off, live()]).toEqual(['Hera 6', [], true]);
    await palette.click(0);
    await fm1.quiet();
    expect([editor.patch.name, level(editor.patch), off, live()]).toEqual(['808 Kit', 0.32, [], true]);
    expect(names(editor)).toEqual(['808 Kit']);
  });
  it('a position this browser has no copy of (a slot another program stored): Live goes off and says so, the editor keeps its patch', async () => {
    const { editor, fm1, link, off, live } = await rig([], edited('Hera 6', 0.33), []);
    const kit = edited('808 Kit', 0.32);
    fm1.bins[9] = link.encodeFor(kit);
    fm1.slots[9] = { slot: 9, used: true, length: fm1.bins[9]!.length, name: 'STRANGER' };
    fm1.entries[4] = entryOf(kit, 9, 'STRANGER');
    fm1.report();
    await fm1.quiet();
    fm1.tap(4);
    await fm1.quiet();
    expect([editor.patch.name, off, live()]).toEqual(['Hera 6', ['FM-1 switched to palette 5 · STRANGER: no copy in this browser, so Live sync is off'], false]);
  });
});
