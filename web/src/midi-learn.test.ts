// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// MIDI learn (#1067): a controller's CC or pitch bend moves a card row, here Briefcase 3's joystick x and y (its page 11,
// on the collapsed card), as the owner's nanoPAD2 X-Y pad would.
import { afterEach, describe, expect, it, vi } from 'vitest';
import BANK from '../factory/bank.json';
import { Editor, type EditorEvents } from './editor';
import { Engine } from './engine';
import { editorCc } from './input';
import { BUTTON_CC, BUTTON_CCS, bindRow, fixMidiLearn, learnableCc, MIDI_LEARN_MAX, MidiLearn, MOVE_GAP_MS, setLearnRange, sourceJob, sourceOf, type MidiBinding } from './midi-learn';
import { DEFS, PANEL_BUTTONS } from './modules';
import { validatePatch, type Patch } from './patch';
import { deviceSection, encodePatch, MAP_BEND, mapRecord, SLIM } from './patchbin';
import { deviceView } from './poly';
import './factory-presets';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

const SR = 44118;
const briefcase = (): Patch => validatePatch(structuredClone((BANK as { name: string; patch: unknown }[]).find((e) => e.name === 'Briefcase 3')!.patch), DEFS);
/** Briefcase 3's joystick rows (its page 11): Offsets' values, −4..4 */
const rowOf = (p: Patch, label: 'x' | 'y') => {
  const a = p.assemblies!.find((x) => x.name === 'Briefcase 3')!;
  const r = a.params.find((q) => q.label === label)!;
  return { module: r.module, param: r.param };
};
const valueOf = (p: Patch, r: { module: number; param: string }) => p.modules.find((m) => m.id === r.module)!.params[r.param];
const cc = (n: number, v: number) => ({ t: 'cc' as const, n, v });
const bend = (raw: number) => ({ t: 'bend' as const, v: (raw - 8192) / 8192 });

function setup(): { editor: Editor; params: [number, string, number][]; status: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div><div id="dock"></div>';
  const params: [number, string, number][] = [];
  const status: string[] = [];
  const ev: EditorEvents = {
    onStructure() {}, onParam: (id, name, v) => void params.push([id, name, v]), onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError: (m) => void status.push(m), onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, briefcase(), ev, document.getElementById('dock'));
  editor.rebuild();
  return { editor, params, status };
}

afterEach(() => vi.useRealTimers());

describe('MIDI learn sources (#1067)', () => {
  it('a CC maps 0..127 over the row, pitch bend has its centre at the middle and its ends at 0 and 1', () => {
    expect(sourceOf(cc(1, 0))).toEqual({ src: 1, u: 0, raw: 0 });
    expect(sourceOf(cc(1, 127))?.u).toBe(1);
    expect(sourceOf(bend(8192))?.u).toBe(0.5);
    expect(sourceOf(bend(0))?.u).toBe(0);
    expect(sourceOf(bend(16383))?.u).toBe(1);
    expect(sourceOf({ t: 'on', note: 60, vel: 1 })).toBeNull();
  });

  it('the patch buttons (80..86), panic (123) and the other channel mode messages cannot be learned', () => {
    expect(BUTTON_CCS).toBe(PANEL_BUTTONS.length);
    for (let n = BUTTON_CC; n < BUTTON_CC + BUTTON_CCS; n++) expect(learnableCc(n)).toBe(false);
    for (const n of [120, 121, 123, 127]) expect(learnableCc(n)).toBe(false);
    for (const n of [0, 1, 16, 22, 64, 79, 87, 119]) expect(learnableCc(n)).toBe(true);
    expect(sourceOf(cc(123, 0))).toBeNull();
  });

  it('names what a source does while no row learned it', () => {
    expect(sourceJob(1)).toBe('Main’s mod wheel');
    expect(sourceJob('bend')).toBe('Main’s pitch bend');
    expect(sourceJob(17)).toBe('Main’s K2');
    expect(sourceJob(74)).toBeNull();
  });
});

describe('the learn wait (#1067)', () => {
  const host = (bound: MidiBinding[] = []) => {
    const p = { modules: [{ id: 5, type: 'const', params: { value: 0 } }], cables: [], midiLearn: bound } as unknown as Patch;
    const learned: MidiBinding[] = [];
    const moved: number[] = [];
    let t = 0;
    const learn = new MidiLearn({ patch: () => p, setRow: (_m, _p, u) => void moved.push(u), learned: (b) => void learned.push(b), waiting() {}, now: () => t });
    return { learn, learned, moved, tick: (ms: number) => void (t += ms) };
  };

  it('a pad’s touch switch (127 on touch, 0 on release) never binds; the axis that moves does, and both are taken meanwhile', () => {
    const { learn, learned } = host();
    learn.start({ module: 5, param: 'value' });
    for (const v of [127, 0, 127, 0]) expect(learn.take(cc(16, v))).toBe(true);   // (the nanoPAD2's touch CC, say)
    expect(learned).toEqual([]);
    for (const v of [64, 66]) learn.take(cc(1, v));
    expect(learned).toEqual([]);
    learn.take(cc(1, 70));   // (a third value: the pad's axis moves)
    expect(learned).toEqual([{ src: 1, module: 5, param: 'value' }]);
    expect(learn.waitingRow).toBeNull();
  });

  it('a switch row takes a button: two values', () => {
    const { learn, learned } = host();
    learn.start({ module: 5, param: 'value' }, true);
    learn.take(cc(64, 127));
    learn.take(cc(64, 0));
    expect(learned).toEqual([{ src: 64, module: 5, param: 'value' }]);
  });

  it('cancel stops the wait, and a source no row learned is not taken', () => {
    const { learn, learned } = host();
    learn.start({ module: 5, param: 'value' });
    expect(learn.cancel()).toBe(true);
    expect(learn.cancel()).toBe(false);
    for (const v of [1, 2, 3]) expect(learn.take(cc(1, v))).toBe(false);
    expect(learned).toEqual([]);
  });

  it('a learned stream moves its row at most once per MOVE_GAP_MS, the latest value last', () => {
    vi.useFakeTimers();
    const { learn, moved, tick } = host([{ src: 'bend', module: 5, param: 'value' }]);
    expect(learn.take(bend(0))).toBe(true);
    for (const raw of [4000, 8000, 12000, 16383]) { tick(5); learn.take(bend(raw)); }
    expect(moved).toEqual([0]);
    tick(MOVE_GAP_MS);
    vi.advanceTimersByTime(MOVE_GAP_MS);
    expect(moved).toEqual([0, 1]);
  });

  it('a binding whose module is gone gives its source its old job back', () => {
    const { learn } = host([{ src: 1, module: 99, param: 'value' }]);
    expect(learn.take(cc(1, 10))).toBe(false);
  });
});

describe('MIDI learn in the patch (#1067)', () => {
  it('validatePatch keeps valid bindings, one per source and one per row, the later one winning', () => {
    const p = briefcase();
    const x = rowOf(p, 'x'), y = rowOf(p, 'y');
    const raw = [
      { src: 1, ...x }, { src: 'bend', ...y }, { src: 2, ...x },   // (CC 2 takes x from CC 1)
      { src: 123, ...y }, { src: 81, ...y }, { src: 'pitch', ...y }, { src: 7, module: 9999, param: 'value' }, { src: 7, module: x.module, param: 'nope' },
    ];
    expect(fixMidiLearn(raw, p.modules, DEFS)).toEqual([{ src: 'bend', ...y }, { src: 2, ...x }]);
    const back = validatePatch(JSON.parse(JSON.stringify({ ...p, midiLearn: raw })), DEFS);
    expect(back.midiLearn).toEqual([{ src: 'bend', ...y }, { src: 2, ...x }]);
    expect('midiLearn' in validatePatch(JSON.parse(JSON.stringify({ ...p, midiLearn: [] })), DEFS)).toBe(false);
  });

  it('the FM-1’s binary carries the bindings last, in format 64: the same bytes as without them, then the mapping section', () => {
    const p = briefcase();
    const with_: Patch = { ...p, midiLearn: [{ src: 1, ...rowOf(p, 'x') }, { src: 'bend', ...rowOf(p, 'y'), lo: 51 / 255, hi: 204 / 255 }] };
    const bin = encodePatch(with_), dev = deviceView(with_, true).patch;
    const rec = mapRecord(with_, dev, deviceSection(with_, dev));
    expect(bin[1]).toBe(64);
    expect(rec).toHaveLength(11);
    expect([rec[0], rec[1], rec[6], rec[9], rec[10]]).toEqual([2, 1, MAP_BEND, 51, 204]);
    expect([...bin.slice(-11)]).toEqual(rec);
    expect([...bin.slice(0, -11)]).toEqual([...encodePatch(p, false, SLIM)]);
  });

  it('a patch holds 16 bindings at most; a range end is kept in the binary’s steps of 1/255', () => {
    const p = briefcase();
    const row = rowOf(p, 'x');
    for (let cc = 0; cc < MIDI_LEARN_MAX; cc++) expect(bindRow(p, { src: cc, module: row.module, param: `p${cc}` })).toBe(true);
    expect(bindRow(p, { src: 40, module: row.module, param: 'p99' })).toBe(false);
    expect(bindRow(p, { src: 3, module: row.module, param: 'p99' })).toBe(true);   // (a source learned again: its row moves)
    expect(p.midiLearn).toHaveLength(MIDI_LEARN_MAX);
    expect(setLearnRange(p, { module: row.module, param: 'p99' }, 0.3, 0.9)).toBe(true);
    const b = p.midiLearn!.find((x) => x.param === 'p99')!;
    expect([b.lo! * 255, b.hi! * 255]).toEqual([Math.round(0.3 * 255), Math.round(0.9 * 255)]);
  });
});

describe('learning Briefcase 3’s joystick on its collapsed card (#1067)', () => {
  it('learns x from CC 1 and y from pitch bend; they move the rows over their range and the sound changes', () => {
    vi.useFakeTimers();
    const { editor, params, status } = setup();
    const x = rowOf(editor.patch, 'x'), y = rowOf(editor.patch, 'y');
    expect(editor.patch.assemblies!.find((a) => a.name === 'Briefcase 3')!.open).toBeFalsy();
    const before = editor.patch.modules.map((m) => ({ ...m.params }));

    editor.startLearn(x);
    expect(document.querySelector(`.param.learning[data-mod="${x.module}"][data-param="value"]`)).not.toBeNull();
    for (const v of [60, 64, 70]) editor.learn.take(cc(1, v));
    expect(status.at(-1)).toMatch(/^CC 1 now moves Briefcase 3 › x\. While it is learned, it no longer moves Main’s mod wheel\./);
    editor.startLearn(y);
    for (const raw of [8192, 9000, 10000]) editor.learn.take(bend(raw));
    expect(editor.patch.midiLearn).toEqual([{ src: 1, ...x }, { src: 'bend', ...y }]);
    expect(editor.patch.modules.map((m) => m.params)).toEqual(before);   // (learning moves nothing)
    // the learned mark, its source in the tooltip
    expect(document.querySelector(`.param[data-mod="${x.module}"][data-param="value"] .midi-learned`)?.getAttribute('title')).toMatch(/CC 1 moves this row, and no longer Main’s mod wheel/);

    // the page in focus is another one: x and y move anyway, over −4..4, the bend's centre in the middle
    expect(editor.learn.take(cc(1, 127))).toBe(true);
    expect(valueOf(editor.patch, x)).toBe(4);
    vi.advanceTimersByTime(MOVE_GAP_MS);
    expect(editor.learn.take(cc(1, 0))).toBe(true);
    vi.advanceTimersByTime(MOVE_GAP_MS);
    expect(valueOf(editor.patch, x)).toBe(-4);
    editor.learn.take(bend(16383));
    expect(valueOf(editor.patch, y)).toBe(4);
    vi.advanceTimersByTime(MOVE_GAP_MS);
    editor.learn.take(bend(8192));
    vi.advanceTimersByTime(MOVE_GAP_MS);
    expect(valueOf(editor.patch, y)).toBe(0);
    expect(params.some(([id, name]) => id === x.module && name === 'value')).toBe(true);   // (Live sends these, as an edit's)
    // (the classic patch sets no pin of the stick: stick x into the filter's frequency, N15, and stick y into oscillator
    // 1's, I16, on their Matrix tiles)
    editor.setParam(editor.patch.modules.find((m) => m.name === 'AENP 13-16')!.id, 'i3o3', 1);
    editor.setParam(editor.patch.modules.find((m) => m.name === 'IJLM 13-16')!.id, 'i4o1', 1);
    const before2 = render(editor.patch);   // (x at −4, y centred)
    vi.advanceTimersByTime(MOVE_GAP_MS);
    editor.learn.take(cc(1, 127));
    editor.learn.take(bend(16383));
    expect(valueOf(editor.patch, x)).toBe(4);
    expect(valueOf(editor.patch, y)).toBe(4);
    expect(render(editor.patch)).not.toEqual(before2);
    // CC 16..19 not learned: still the knobs (editorCc), and an unlearned CC goes on to the engines
    expect(editor.learn.take(cc(2, 30))).toBe(false);
    expect(editorCc(cc(2, 30), editor)).toBe(false);
  });

  it('a second learn on the same source moves it; unlearn and undo work; the bindings survive a save and reload', () => {
    vi.useFakeTimers();
    const { editor } = setup();
    const x = rowOf(editor.patch, 'x'), y = rowOf(editor.patch, 'y');
    const learn = (r: typeof x, msgs: { t: 'cc'; n: number; v: number }[]) => {
      editor.startLearn(r);
      for (const m of msgs) editor.learn.take(m);
      vi.advanceTimersByTime(700);   // (the gesture ends)
    };
    learn(x, [cc(1, 1), cc(1, 2), cc(1, 3)]);
    learn(y, [cc(1, 1), cc(1, 2), cc(1, 3)]);
    expect(editor.patch.midiLearn).toEqual([{ src: 1, ...y }]);
    const saved = validatePatch(JSON.parse(JSON.stringify(editor.patch)), DEFS);
    expect(saved.midiLearn).toEqual([{ src: 1, ...y }]);
    editor.undo();
    expect(editor.patch.midiLearn).toEqual([{ src: 1, ...x }]);
    editor.redo();
    editor.unlearn(y);
    expect(editor.patch.midiLearn).toBeUndefined();
    editor.undo();
    expect(editor.patch.midiLearn).toEqual([{ src: 1, ...y }]);
    editor.removeBinding(1);
    expect(editor.patch.midiLearn).toBeUndefined();
  });

  it('a stream of moves is one undo step', () => {
    vi.useFakeTimers();
    const { editor } = setup();
    const x = rowOf(editor.patch, 'x');
    editor.startLearn(x);
    for (const v of [1, 2, 3]) editor.learn.take(cc(1, v));
    vi.advanceTimersByTime(700);
    for (let v = 0; v <= 127; v += 8) { editor.learn.take(cc(1, v)); vi.advanceTimersByTime(30); }
    vi.advanceTimersByTime(700);
    expect(valueOf(editor.patch, x)).toBe(3.56);
    editor.undo();
    expect(valueOf(editor.patch, x)).toBe(0);
    expect(editor.patch.midiLearn).toEqual([{ src: 1, ...x }]);
  });
});

function render(p: Patch): number[] {
  const e = new Engine(SR);
  e.load(JSON.parse(JSON.stringify(p)) as Patch);
  e.noteOn(48);
  const l = new Float32Array(SR), r = new Float32Array(SR);
  e.render(l, r);
  return [...l.subarray(SR - 2048)];
}
