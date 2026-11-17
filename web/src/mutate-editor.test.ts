// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Mutate and Randomize through the editor (#944): one undo step, sent as live parameter changes (the voices keep
// sounding), the FM-1's copy following; locks are undo steps that reload nothing.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { defaultParams, type ModuleInst, type Patch } from './patch';

// (jsdom lacks these; selector.ts makes its ResizeObserver when it loads, so before the imports)
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

const mod = (id: number, type: string, x: number): ModuleInst =>
  ({ id, type, x, y: 40, params: defaultParams(DEFS[type]), ...(DEFS[type].paramInputs ? { att: [1, 1], map: { p1: [], p2: [] } } : {}) }) as ModuleInst;

function rig(extra: Partial<Patch> = {}): { editor: Editor; fm1: Patch; log: string[]; status: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const start: Patch = { version: 2, name: 't', modules: [mod(1, 'osc', 40), mod(2, 'filter', 260), mod(3, 'output', 480)], cables: [], ...extra } as Patch;
  const fm1 = structuredClone(start);
  const log: string[] = [];
  const status: string[] = [];
  const ev: EditorEvents = {
    onStructure() { log.push('structure'); },
    onParam(id, name, value) { log.push('param'); fm1.modules.find((m) => m.id === id)!.params[name] = value; },
    onAtt() {}, onBypass() {}, onRange() {}, onTransport() {},
    onLayout() { log.push('layout'); },
    onError(msg) { status.push(msg); },
    onSaveAssembly() {},
  };
  return { editor: new Editor(document.getElementById('canvas')!, structuredClone(start), ev), fm1, log, status };
}

describe('Editor.mutate', () => {
  it('mutates the selection as one undo step, sent live, and the FM-1 follows', () => {
    const { editor, fm1, log } = rig();
    const before = structuredClone(editor.patch.modules);
    editor.selectAll();
    editor.mutateAmount = 0.5;
    log.length = 0;
    const moved = editor.mutate('mutate');
    expect(moved).toBeGreaterThan(0);
    expect(log).not.toContain('structure');   // (no reload: the voices keep sounding)
    expect(log.filter((x) => x === 'param').length).toBe(moved);
    for (const m of editor.patch.modules) expect(fm1.modules.find((x) => x.id === m.id)!.params).toEqual(m.params);
    expect(editor.patch.modules.find((m) => m.type === 'output')!.params).toEqual(before[2].params);   // (the master level stays)
    editor.undo();
    expect(editor.patch.modules.map((m) => m.params)).toEqual(before.map((m) => m.params));
    editor.redo();
    expect(editor.patch.modules.map((m) => m.params)).not.toEqual(before.map((m) => m.params));
  });

  it('asks for a selection, and reports what is locked', () => {
    const { editor, status } = rig();
    expect(editor.mutate('randomize')).toBe(0);
    expect(status.at(-1)).toMatch(/select the cards/);
    editor.selectAll();
    editor.lockCards(true);
    expect(editor.mutate('randomize')).toBe(0);
    expect(status.at(-1)).toMatch(/nothing to move/);
  });

  it('locks a parameter or a card as an undo step that reloads nothing, and shows the padlock', () => {
    const { editor, log } = rig();
    const osc = editor.patch.modules[0];
    log.length = 0;
    editor.lockParam(osc, 'pw', true);
    expect(log).toEqual(['layout']);
    expect(editor.patch.modules[0].mutateLock).toEqual(['pw']);
    expect(document.querySelectorAll('.param.mutate-locked').length).toBe(1);
    editor.lockCards(true, [editor.patch.modules[1]]);
    expect(editor.patch.modules[1].mutateLockAll).toBe(true);
    editor.undo();
    expect(editor.patch.modules[1].mutateLockAll).toBeUndefined();
    editor.undo();
    expect(editor.patch.modules[0].mutateLock).toBeUndefined();
  });
});

describe('Mutate with a category (#1033)', () => {
  /** an oscillator through a VCA to the Output, an ADSR on the VCA, a second ADSR on nothing */
  const voice = (): Partial<Patch> => ({
    modules: [mod(1, 'osc', 40), mod(2, 'vca', 260), mod(3, 'output', 480), mod(4, 'adsr', 40), mod(5, 'adsr', 260)],
    cables: [{ from: { module: 1, port: 'out' }, to: { module: 2, port: 'in' } }, { from: { module: 2, port: 'out' }, to: { module: 3, port: 'l' } }, { from: { module: 4, port: 'env' }, to: { module: 2, port: 'cv' } }],
  });

  it('puts the loudness envelope in the category\'s range and says so in the status line', () => {
    const { editor, status } = rig(voice());
    editor.selectAll();
    editor.mutateCategory = 'pad';
    editor.mutate('mutate');
    const adsr = editor.patch.modules.find((m) => m.id === 4)!.params;
    expect(adsr.a).toBeGreaterThanOrEqual(0.3);
    expect(adsr.r).toBeGreaterThanOrEqual(0.8);
    expect(status.at(-1)).toMatch(/aimed at pad: 4 envelope, cutoff or glide rows in its ranges/);
  });

  it('locks every envelope row as one undo step: of the selected cards, or of all', () => {
    const { editor, log, status } = rig(voice());
    log.length = 0;
    expect(editor.lockEnvelopes()).toBe(2 * DEFS.adsr.params.length);
    expect(log).toEqual(['layout']);
    expect(status.at(-1)).toMatch(/^Locked 12 rows of 2 envelopes:/);
    for (const id of [4, 5]) expect(editor.patch.modules.find((m) => m.id === id)!.mutateLock).toEqual(DEFS.adsr.params.map((pd) => pd.name));
    editor.selectAll();
    editor.mutateCategory = 'pluck';
    editor.mutate('randomize');
    for (const id of [4, 5]) expect(editor.patch.modules.find((m) => m.id === id)!.params).toEqual(defaultParams(DEFS.adsr));
    editor.undo();   // (the Randomize)
    editor.undo();   // (the lock, as one step)
    for (const id of [4, 5]) expect(editor.patch.modules.find((m) => m.id === id)!.mutateLock).toBeUndefined();
    editor.selectOnly([5]);
    expect(editor.lockEnvelopes()).toBe(DEFS.adsr.params.length);
    expect(editor.patch.modules.find((m) => m.id === 4)!.mutateLock).toBeUndefined();
    editor.selectOnly([1]);
    expect(editor.lockEnvelopes()).toBe(0);
    expect(status.at(-1)).toMatch(/no envelope on the selected cards/);
  });
});
