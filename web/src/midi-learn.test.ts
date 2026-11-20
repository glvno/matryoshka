// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// MIDI learn (#1067): a controller's CC or pitch bend moves a card row, here Briefcase 3's joystick x and y (its page 11,
// on the collapsed card), as the owner's nanoPAD2 X-Y pad would.
import { afterEach, describe, expect, it, vi } from 'vitest';
import BANK from '../factory/bank.json';
import { Editor, type EditorEvents } from './editor';
import { Engine } from './engine';
import { editorCc } from './input';
import { alsoSentText, BUTTON_CC, BUTTON_CCS, bindRow, fixMidiLearn, learnableCc, learnFirst, MIDI_LEARN_MAX, MidiLearn, MOVE_GAP_MS, setLearnRange, sourceJob, sourceName, sourceNote, sourceOf, type MidiBinding } from './midi-learn';
import { DEFS, PANEL_BUTTONS } from './modules';
import { validatePatch, type Patch } from './patch';
import { deviceSection, encodePatch, FORMAT_1_23, MAP_BEND, MAP_NOTE, mapRecord, mapSource, SLIM } from './patchbin';
import type { HostMsg } from './worklet';
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
    expect(sourceOf({ t: 'at', v: 1 })).toBeNull();
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

  it('a note-on is a source with its velocity over 127; a note-off (or velocity 0) moves nothing; C4 = 60, so 36 is C2', () => {
    expect(sourceOf({ t: 'on', note: 36, vel: 1 })).toEqual({ src: 'note:36', u: 1, raw: 127 });
    expect(sourceOf({ t: 'on', note: 36, vel: 64 / 127 })).toEqual({ src: 'note:36', u: 64 / 127, raw: 64 });
    expect(sourceOf({ t: 'off', note: 36 })).toEqual({ src: 'note:36', u: 0, raw: 0, off: true });
    expect(sourceOf({ t: 'on', note: 36, vel: 0 })?.off).toBe(true);
    expect([sourceName('note:36'), sourceName('note:61'), sourceName('note:0'), sourceName(1), sourceName('bend')]).toEqual(['NOTE C2', 'NOTE C#4', 'NOTE C-1', 'CC 1', 'pitch bend']);
    expect(['note:0', 'note:127', 'note:128', 'note:036', 'note:-1', 'note:x', 36].map(sourceNote)).toEqual([0, 127, null, null, null, null, null]);
    expect(sourceJob('note:36')).toBeNull();
  });

  it('the "also sent" warning names the fixed-job CCs in the contract’s words', () => {
    expect(alsoSentText([16])).toBe('CC 16 also sent: turns K1');
    expect(alsoSentText([1, 2, 19, 22, 64, 65, 74])).toBe('CC 1 also sent: mod wheel; CC 2 also sent: breath; CC 19 also sent: turns K4; CC 22 also sent: morph; CC 64 also sent: sustain; CC 65 also sent: foot');
    expect(alsoSentText([74])).toBe('');
  });
});

describe('the learn wait (#1067)', () => {
  /** `sw`: the row's position when it is a switch row (switchAt), null for a continuous one */
  const host = (bound: MidiBinding[] = [], sw: () => number | null = () => null) => {
    const p = { modules: [{ id: 5, type: 'const', params: { value: 0 } }], cables: [], midiLearn: bound } as unknown as Patch;
    const learned: MidiBinding[] = [];
    const also: number[][] = [];
    const moved: number[] = [];
    let t = 0;
    const learn = new MidiLearn({ patch: () => p, setRow: (_m, _p, u) => void moved.push(u), switchAt: sw, learned: (b, a) => void (learned.push(b), also.push(a)), waiting() {}, now: () => t });
    return { learn, learned, also, moved, tick: (ms: number) => void (t += ms) };
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

  it('a note-on is learned at once, on a switch row or not; a note-off goes on unless its note is learned', () => {
    for (const sw of [false, true]) {
      const { learn, learned } = host();
      learn.start({ module: 5, param: 'value' }, sw);
      expect(learn.take({ t: 'off', note: 40 })).toBe(false);   // (a key let go that was held before: it reaches the keys)
      expect(learn.take({ t: 'on', note: 36, vel: 0.5 })).toBe(true);
      expect(learned).toEqual([{ src: 'note:36', module: 5, param: 'value' }]);
      expect(learn.waitingRow).toBeNull();
    }
  });

  it('a learned note puts a continuous row at its velocity between the ends; its note-off is swallowed and moves nothing', () => {
    const { learn, moved } = host([{ src: 'note:36', module: 5, param: 'value', lo: 51 / 255, hi: 204 / 255 }]);
    expect(learn.take({ t: 'on', note: 36, vel: 1 })).toBe(true);
    expect(learn.take({ t: 'off', note: 36 })).toBe(true);
    expect(learn.take({ t: 'on', note: 36, vel: 0 })).toBe(true);
    expect(learn.take({ t: 'on', note: 36, vel: 64 / 127 })).toBe(true);   // (no throttle: every note-on moves)
    expect(moved).toHaveLength(2);
    expect(moved[0]).toBeCloseTo(204 / 255, 12);
    expect(moved[1]).toBeCloseTo(51 / 255 + (153 / 255) * (64 / 127), 12);
    expect(learn.take({ t: 'on', note: 37, vel: 1 })).toBe(false);
  });

  it('a learned note flips a switch row to the end farther from where it is (hi on a tie), whatever its velocity', () => {
    let at = 0;
    const { learn, moved } = host([{ src: 'note:36', module: 5, param: 'value' }], () => at);
    learn.take({ t: 'on', note: 36, vel: 0.1 });
    at = 1;
    learn.take({ t: 'on', note: 36, vel: 1 });
    expect(moved).toEqual([1, 0]);
    const r = host([{ src: 'note:36', module: 5, param: 'value', lo: 0.2, hi: 0.8 }], () => 0.5);
    r.learn.take({ t: 'on', note: 36, vel: 1 });
    expect(r.moved).toEqual([0.8]);
  });

  it('remembers the fixed-job CCs the learned control’s input also sent while the row waited', () => {
    const { learn, also } = host([{ src: 17, module: 5, param: 'other' }]);
    learn.start({ module: 5, param: 'value' });
    learn.take(cc(16, 10), 'pad');
    learn.take(cc(64, 127), 'keys');   // (another input)
    learn.take(cc(17, 3), 'pad');   // (learned by another row: it does that row's job, not K2)
    learn.take(cc(22, 3), 'pad');
    for (const v of [1, 2, 3]) learn.take(cc(74, v), 'pad');
    expect(also).toEqual([[16, 22]]);
    learn.start({ module: 5, param: 'value' });   // (a new wait forgets them)
    learn.take({ t: 'on', note: 36, vel: 1 }, 'pad');
    expect(also.at(-1)).toEqual([]);
  });

  it('a learned note never reaches the note sink; other notes, an FM-1’s and those without their input do', () => {
    const { learn } = host([{ src: 'note:36', module: 5, param: 'value' }]);
    const sink: HostMsg[] = [];
    const send = learnFirst<string>(learn, (from) => from === 'fm1', (m) => void sink.push(m));
    send({ t: 'on', note: 36, vel: 1, ch: 1 }, 'pads');
    send({ t: 'off', note: 36, ch: 1 }, 'pads');
    expect(sink).toEqual([]);
    send({ t: 'on', note: 37, vel: 1, ch: 1 }, 'pads');
    send({ t: 'on', note: 36, vel: 1 }, 'fm1');
    send({ t: 'on', note: 36, vel: 1 });
    expect(sink.map((m) => m.t === 'on' && m.note)).toEqual([37, 36, 36]);
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

  it('a note source is kept as `note:N` (0..127), one row per source and one source per row', () => {
    const p = briefcase();
    const x = rowOf(p, 'x'), y = rowOf(p, 'y');
    const raw = [{ src: 'note:36', ...x }, { src: 'note:128', ...y }, { src: 'note:-1', ...y }, { src: 'note:3.5', ...y }, { src: 36, ...y }, { src: 'note:36', ...y }];
    expect(fixMidiLearn(raw, p.modules, DEFS)).toEqual([{ src: 'note:36', ...y }]);   // (the later note:36 leaves x and takes y from CC 36)
    expect(fixMidiLearn([{ src: 'note:36', ...x }, { src: 'note:127', ...y }], p.modules, DEFS)).toEqual([{ src: 'note:36', ...x }, { src: 'note:127', ...y }]);
  });

  it('the FM-1’s binary carries the bindings last, in format 65: format 64’s bytes but the format byte, then the mapping section', () => {
    const p = briefcase();
    const with_: Patch = { ...p, midiLearn: [{ src: 1, ...rowOf(p, 'x') }, { src: 'bend', ...rowOf(p, 'y'), lo: 51 / 255, hi: 204 / 255 }] };
    const bin = encodePatch(with_), dev = deviceView(with_, true).patch, slim = encodePatch(p, false, SLIM);
    const rec = mapRecord(with_, dev, deviceSection(with_, dev));
    expect([bin[1], slim[1]]).toEqual([FORMAT_1_23, SLIM]);
    expect(rec).toHaveLength(11);
    expect([rec[0], rec[1], rec[6], rec[9], rec[10]]).toEqual([2, 1, MAP_BEND, 51, 204]);
    expect([...bin.slice(-11)]).toEqual(rec);
    expect([bin[0], ...bin.slice(2, -11)]).toEqual([slim[0], ...slim.slice(2)]);
  });

  it('a note source goes into the binary as 128 + its note and comes back from the byte', () => {
    const p = briefcase();
    const with_: Patch = { ...p, midiLearn: [{ src: 'note:36', ...rowOf(p, 'x') }, { src: 'note:127', ...rowOf(p, 'y') }] };
    const dev = deviceView(with_, true).patch, rec = mapRecord(with_, dev, deviceSection(with_, dev));
    expect([rec[0], rec[1], rec[6]]).toEqual([2, MAP_NOTE + 36, MAP_NOTE + 127]);
    expect([...encodePatch(with_).slice(-11)]).toEqual(rec);
    expect([mapSource(rec[1]), mapSource(rec[6]), mapSource(MAP_BEND), mapSource(74)]).toEqual(['note:36', 'note:127', 'bend', 74]);
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

  it('learns a note at once and names it NOTE C2; the warning of a fixed-job CC from the same input stays beside it', () => {
    vi.useFakeTimers();
    const { editor, status } = setup();
    const x = rowOf(editor.patch, 'x');
    editor.startLearn(x);
    editor.learn.take(cc(16, 5), 'pads');
    editor.learn.take({ t: 'on', note: 36, vel: 1 }, 'pads');
    expect(status.at(-1)).toMatch(/^NOTE C2 now moves Briefcase 3 › x\. While it is learned, it plays no note in this patch\. CC 16 also sent: turns K1\. /);
    expect(editor.patch.midiLearn).toEqual([{ src: 'note:36', ...x }]);
    expect(editor.bindings().map((b) => [b.source, b.also])).toEqual([['NOTE C2', 'CC 16 also sent: turns K1']]);
    expect(document.querySelector(`.param[data-mod="${x.module}"][data-param="value"] .midi-learned`)?.getAttribute('title')).toMatch(/NOTE C2 moves this row/);
    expect(validatePatch(JSON.parse(JSON.stringify(editor.patch)), DEFS).midiLearn).toEqual([{ src: 'note:36', ...x }]);
    // the velocity puts x (−4..4) between its ends; the note-off moves nothing
    expect(editor.learn.take({ t: 'on', note: 36, vel: 1 }, 'pads')).toBe(true);
    expect(valueOf(editor.patch, x)).toBe(4);
    expect(editor.learn.take({ t: 'off', note: 36 }, 'pads')).toBe(true);
    expect(valueOf(editor.patch, x)).toBe(4);
    editor.learn.take({ t: 'on', note: 36, vel: 1 / 127 }, 'pads');
    expect(valueOf(editor.patch, x)).toBeLessThan(-3.8);
    // learning it again without the CC forgets the warning
    editor.startLearn(x);
    editor.learn.take({ t: 'on', note: 36, vel: 1 }, 'pads');
    expect(editor.bindings()[0].also).toBe('');
  });

  it('a note flips a switch row each time it is played', () => {
    const { editor } = setup();
    const m = editor.patch.modules.find((q) => DEFS[q.type].params.some((d) => d.toggle && !d.screen))!;
    const param = DEFS[m.type].params.find((d) => d.toggle && !d.screen)!.name;
    editor.patch.midiLearn = [{ src: 'note:50', module: m.id, param }];
    const was = m.params[param];
    editor.learn.take({ t: 'on', note: 50, vel: 0.2 }, 'pads');
    expect(editor.patch.modules.find((q) => q.id === m.id)!.params[param]).toBe(was ? 0 : 1);
    editor.learn.take({ t: 'on', note: 50, vel: 1 }, 'pads');
    expect(editor.patch.modules.find((q) => q.id === m.id)!.params[param]).toBe(was ? 1 : 0);
  });

  it('takes the FM-1’s note mapping (128 + n) and its "also sent" tail from MAP_NOW', () => {
    const { editor } = setup();
    const y = rowOf(editor.patch, 'y');
    const p = { ...editor.patch, midiLearn: [{ src: 'note:40' as const, ...y }] };
    const dev = deviceView(p, true).patch, rec = mapRecord(p, dev, deviceSection(p, dev));
    expect(rec[1]).toBe(MAP_NOTE + 40);
    editor.takeDeviceMaps([{ src: rec[1], module: rec[2], param: rec[3], lo: rec[4], hi: rec[5] }], { src: rec[1], ccs: [17, 74] });
    expect(editor.patch.midiLearn).toEqual([{ src: 'note:40', ...y }]);
    expect(editor.bindings().map((b) => [b.source, b.also])).toEqual([['NOTE E2', 'CC 17 also sent: turns K2']]);
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
