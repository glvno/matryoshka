// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The palette and the editor's candidates (owner 2026-11-24: "when synced, using the fm1 to save a sound to the palette
// nukes all other candidates from the palette and just sets that sound as current"): a real editor with candidates beside
// the patch, the palette wired to it as main.ts wires it, and the stand-in FM-1 (test-palette-fm1.ts). No palette event
// throws the candidates away: a hold-save of the patch the editor plays, whichever candidate it shows, keeps them and the
// current patch as they are; a switch to another entry makes that sound the current patch and keeps the one it replaces
// as a candidate, as Use does (D-971, D-1321).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { DeviceLink } from './device';
import { setFactoryPresets } from './device-presets';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { connect, newPatch, type Patch } from './patch';
import { entryOf, Palette, type PalettePorts } from './palette';
import { binLength, type Candidate } from './bank';
import { FM1_PRESETS } from './presets';
import { PaletteFm1 } from './test-palette-fm1';

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

/** an editor on `start` with the candidates `cands` (B, C…; by default other levels of it), the palette linked to the
 *  stand-in FM-1 under Live, its ports as main.ts makes them; `saved`: this browser's saved patches (the copies a switch
 *  opens) */
async function rig(saved: Candidate[] = [], start = pad('My Pad'), cands = [pad('My Pad', 0.4), pad('My Pad', 0.6)]) {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const ev: EditorEvents = { onStructure: nop, onParam: nop, onAtt: nop, onBypass: nop, onRange: nop, onTrack: nop, onSilence: nop, onTransport: nop, onLayout: nop, onError: nop, onSaveAssembly: nop };
  const editor = new Editor(document.getElementById('canvas')!, structuredClone(start), ev);
  editor.restoreSnapshots(cands.map((c, i) => ({ letter: String.fromCharCode(66 + i), patch: JSON.stringify(c) })));
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
    versions: () => [editor.patch, editor.currentPatch(), ...editor.snaps.list.map((s) => JSON.parse(s.patch) as Patch)],   // (as main.ts)
    live: () => live,
    current: () => editor.patch,   // (as main.ts: the candidate on screen, which Live sends to the FM-1)
    open: (p) => void editor.openKeeping(p),   // (as main.ts's loadNamed with `keep`)
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
  /** the candidates' letters and levels, the stop on screen, and the current patch's level */
  const state = () => ({ list: editor.snaps.list.map((s) => [s.letter, level(JSON.parse(s.patch) as Patch)]), shown: editor.snaps.shown, current: level(editor.currentPatch()) });
  /** the patch grip dragged onto chip `pos` (main.ts patchDragSource: the patch heard) */
  const grip = (pos: number) => palette.add(editor.patch.name.trim() || 'Untitled', structuredClone(editor.patch), { pos });
  /** the level of the patch in the slot that chip `pos` points at */
  const chipLevel = (pos: number): number => [pad('My Pad'), pad('My Pad', 0.4), pad('My Pad', 0.6)].map(level).find((l) => {
    const bin = fm1.bins[fm1.entries[pos]!.slot]!;
    return link.encodeFor(pad('My Pad', l)).every((x, i) => x === bin[i]);
  }) ?? NaN;
  return { editor, fm1, link, palette, off, said, live: () => live, state, grip, chipLevel };
}

describe('a palette event keeps the editor\'s candidates (owner 2026-11-24)', () => {
  it('a hold-save on the FM-1 while the editor shows A keeps the candidates and A', async () => {
    const { editor, fm1, link, off, live, state } = await rig([{ name: 'My Pad', patch: () => pad('My Pad') }]);
    fm1.holdSave(2, link.encodeFor(editor.patch), 'MY PAD', entryOf(editor.patch, 0));
    await fm1.quiet();
    expect(state()).toEqual({ list: [['B', 0.4], ['C', 0.6]], shown: null, current: 0.15 });
    expect([off, live()]).toEqual([[], true]);
  });
  it('a hold-save on the FM-1 while the editor shows candidate B keeps the candidates, A, and B on screen', async () => {
    const { editor, fm1, link, off, live, state } = await rig([{ name: 'My Pad', patch: () => pad('My Pad') }]);
    editor.showSnapshot('B');
    expect(level(editor.patch)).toBe(0.4);   // (under Live the FM-1 plays B)
    fm1.holdSave(2, link.encodeFor(editor.patch), 'MY PAD', entryOf(editor.patch, 0));
    await fm1.quiet();
    expect(state()).toEqual({ list: [['B', 0.4], ['C', 0.6]], shown: 'B', current: 0.15 });
    expect(level(editor.patch)).toBe(0.4);
    expect([off, live()]).toEqual([[], true]);
  });
  it('a switch to another entry (an FM-1 tap, a chip click) makes it the current patch; A stays as a candidate', async () => {
    const other = pad('Other Pad', 0.9);
    const saved: Candidate[] = [{ name: 'Other Pad', patch: () => structuredClone(other) }];
    const { editor, fm1, link, palette, state } = await rig(saved);
    fm1.slots[5] = { slot: 5, used: true, length: binLength(other), name: 'OTHER PAD' };
    fm1.bins[5] = link.encodeFor(other);
    fm1.entries[0] = entryOf(other, 5);
    fm1.tap(0);
    await fm1.quiet();
    expect(editor.patch.name).toBe('Other Pad');
    expect(state()).toEqual({ list: [['B', 0.4], ['C', 0.6], ['D', 0.15]], shown: null, current: 0.9 });
    expect(editor.snaps.get('D')!.from).toBe('use');
    // back to the entry of the old A from the chips, with B on screen: the candidate that holds it becomes A again, and
    // the sound it replaces joins the list
    fm1.slots[6] = { slot: 6, used: true, length: binLength(pad('My Pad')), name: 'MY PAD' };
    fm1.bins[6] = link.encodeFor(pad('My Pad'));
    fm1.entries[1] = entryOf(pad('My Pad'), 6);
    fm1.report();
    await fm1.quiet();
    editor.showSnapshot('B');
    saved.push({ name: 'My Pad', patch: () => pad('My Pad') });
    await palette.click(1);
    await fm1.quiet();
    expect(editor.patch.name).toBe('My Pad');
    expect(state()).toEqual({ list: [['B', 0.4], ['C', 0.6], ['E', 0.9]], shown: null, current: 0.15 });
  });
});

describe('a sound added to the palette from a candidate (owner 2026-11-24: "FM-1 switched to palette 3 · …: no copy in this browser")', () => {
  it('the patch grip takes the candidate heard: A, B and C dragged onto chips 1-3 are three sounds', async () => {
    const { editor, fm1, grip, chipLevel } = await rig();
    await grip(0);
    editor.showSnapshot('B');
    await grip(1);
    editor.showSnapshot('C');
    await grip(2);
    await fm1.quiet();
    expect([0, 1, 2].map(chipLevel)).toEqual([0.15, 0.4, 0.6]);
    expect([0, 1, 2].map((pos) => fm1.entries[pos]!.name)).toEqual(['MY PAD', 'MY PAD 2', 'MY PAD 3']);
  });
  it('a switch to a chip added from a candidate opens that candidate as the current patch, Live on, none saved', async () => {
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
    expect(state()).toEqual({ list: [['C', 0.6], ['D', 0.15]], shown: null, current: 0.4 });
  });
  it('Add to palette from candidate C changes no candidate and not A; the switch to that chip after makes C\'s sound A (1.26.3 qualification)', async () => {
    // (Release1263's run on the emulator: Generate, C heard, Add to palette, B heard, chip 1 clicked; then A showed C's
    // sound, not the opened patch's. The add leaves A and every candidate as they were; the switch is what makes the sound
    // on that chip A, and the patch it replaces joins the list as a new candidate, as Use does: D-971, D-1321)
    const { editor, fm1, palette, off, live, state, grip } = await rig(undefined, pad('My Pad'), [pad('My Pad', 0.4), pad('My Pad', 0.6), pad('My Pad', 0.8)]);
    editor.showSnapshot('C');
    expect(await grip(0)).toBe(true);   // (main.ts addCurrentToPalette: the patch heard into the first empty position)
    await fm1.quiet();
    expect(state()).toEqual({ list: [['B', 0.4], ['C', 0.6], ['D', 0.8]], shown: 'C', current: 0.15 });
    editor.showSnapshot(null);   // (A clicked after the add: the opened patch's values)
    expect(level(editor.patch)).toBe(0.15);
    editor.showSnapshot('B');
    await palette.click(0);   // (chip 1 while B plays: the FM-1 switches, the editor follows under Live)
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state()).toEqual({ list: [['B', 0.4], ['D', 0.8], ['E', 0.15]], shown: null, current: 0.6 });
    expect(editor.snaps.get('E')!.from).toBe('use');
  });
  it('the same after Use on each candidate before its drag: the chips hold candidates, and each opens', async () => {
    const { editor, fm1, off, live, state, grip } = await rig();
    await grip(0);
    editor.makeCurrent('B');
    await grip(1);
    editor.makeCurrent('C');
    await grip(2);
    await fm1.quiet();
    expect(state()).toEqual({ list: [['D', 0.15], ['E', 0.4]], shown: null, current: 0.6 });
    fm1.tap(1);
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state()).toEqual({ list: [['D', 0.15], ['F', 0.6]], shown: null, current: 0.4 });
    fm1.tap(0);
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state().current).toBe(0.15);
  });
});

describe('the owner\'s palette of 2026-11-24 (his v1.26.3 test editor\'s storage, build/palette-repro)', () => {
  it('Hera 6: palette 1 the factory patch, 2-8 dragged from candidates; switches to 1, then 3, keep Live and the candidates', async () => {
    // (what his browser kept: palette 1 → slot 22 "HERA 6"; palettes 2-8 all → slot 23 "HERA 6 2", one sound however many
    // candidates he chose; no candidates left, no saved patches; then "FM-1 switched to palette 3 · HERA 6 2: no copy in
    // this browser, so Live sync is off")
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
    expect(fm1.entries[0]).toMatchObject({ slot: 22, name: 'HERA 6' });
    // Mutate: the patch before it is kept as candidate D, and A changes
    editor.takeSnapshot(undefined, 'mutate');
    editor.setParam(editor.patch.modules.find((m) => m.type === 'output')!.id, 'level', 0.23);
    // a candidate chosen, then the grip dragged onto palettes 2-8
    for (const [pos, stop] of (['B', 'C', 'D', 'B', 'C', 'D', null] as const).entries()) {
      editor.showSnapshot(stop);
      await grip(pos + 1);
      await fm1.quiet();
    }
    expect([said.filter((t) => !t.startsWith('Storing') && !/is palette/.test(t)), fm1.entries.map((e) => e && [e.slot, e.name])]).toEqual([[], [[22, 'HERA 6'], [23, 'HERA 6 2'], [24, 'HERA 6 3'], [22, 'HERA 6'], [23, 'HERA 6 2'], [24, 'HERA 6 3'], [22, 'HERA 6'], [25, 'HERA 6 4']]]);
    fm1.tap(0);   // (palette 1 on the FM-1: the factory Hera 6, which candidate D holds)
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state().current).toBe(level(hera));
    expect(state().list.map(([, l]) => l)).toEqual(expect.arrayContaining([0.31, 0.47, 0.23]));
    fm1.tap(2);   // (palette 3: candidate C)
    await fm1.quiet();
    expect([off, live()]).toEqual([[], true]);
    expect(state().current).toBe(0.47);
    expect(state().list.map(([, l]) => l)).toEqual(expect.arrayContaining([0.31, 0.23, level(hera)]));
  });
});
