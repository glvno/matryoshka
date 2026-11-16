// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The collapsed master FX bus card's stage switches (D-966): each is its stage card's ⏻, without expanding the bus.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAssembly, promote } from './assembly';
import { storePreset } from './device-presets';
import { Editor, type EditorEvents } from './editor';
import { fxBusOf, withFxBus, type FxStageKind } from './fx-bus';
import { setFxStageEnabled } from './fx-preset';
import { DEFS } from './modules';
import { addModule, connect, newPatch, type Patch } from './patch';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!document.fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

/** a stereo synth (one assembly device) into a master FX bus without the omitted stages */
function busPatch(omit: FxStageKind[] = []): Patch {
  const p = newPatch(DEFS, 'FX switches');
  const output = p.modules.find((m) => m.type === 'output')!;
  const left = addModule(p, DEFS.macro, 20, 20);
  const right = addModule(p, DEFS.macro, 340, 20);
  expect(connect(p, DEFS, { module: left.id, port: 'out' }, { module: output.id, port: 'l' })).toBe(true);
  expect(connect(p, DEFS, { module: right.id, port: 'out' }, { module: output.id, port: 'r' })).toBe(true);
  promote(makeAssembly(p, [left.id, right.id], 'Synth'), left.id, 'value', p);
  return withFxBus(p, { omit });
}

function editorOn(p: Patch, log: string[] = []): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass(id, on) { log.push(`${id}:${on}`); }, onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  return new Editor(document.getElementById('canvas')!, p, ev);
}

const switches = () => [...document.querySelectorAll<HTMLButtonElement>('.module.assembly .fx-stages button.fx-stage')];
const switchOf = (asm: number) => document.querySelector<HTMLButtonElement>(`.fx-stages button.fx-stage[data-asm="${asm}"]`)!;
const pressed = () => switches().map((b) => b.getAttribute('aria-pressed'));
const stageId = (p: Patch, kind: FxStageKind) => fxBusOf(p)!.stages.find((s) => s.kind === kind)!.assembly;
const state = (p: Patch) => JSON.stringify({ modules: p.modules.map((m) => [m.id, !!m.bypass]), assemblies: p.assemblies!.map((a) => [a.id, !!a.bypass, a.kept]) });

beforeEach(() => localStorage.clear());

describe('the collapsed master FX bus card', () => {
  it('has one switch per present stage, named as its stage card, off as the stages start', () => {
    const p = busPatch(['drive']);
    editorOn(p);
    const bus = fxBusOf(p)!;
    expect(p.assemblies!.find((a) => a.id === bus.assembly)!.open).toBeFalsy();
    expect(switches().map((b) => b.textContent)).toEqual(['Chorus', 'Delay', 'Reverb']);
    expect(switches().map((b) => Number(b.dataset.asm))).toEqual(bus.stages.map((s) => s.assembly));
    expect(pressed()).toEqual(['false', 'false', 'false']);
    // no other card gets them
    expect(document.querySelectorAll('.fx-stages')).toHaveLength(1);
  });

  it('flips a stage exactly as the expanded card’s ⏻: same patch, same live messages, one undo step', () => {
    for (const kind of ['drive', 'chorus', 'delay', 'reverb'] as const) {
      // the expanded card's ⏻ on the stage card
      const viaCard: string[] = [];
      const a = busPatch();
      const cardEditor = editorOn(a, viaCard);
      a.assemblies!.find((x) => x.id === fxBusOf(a)!.assembly)!.open = true;
      cardEditor.rebuild();
      expect(switches()).toHaveLength(0);
      document.querySelector<HTMLButtonElement>(`.module.assembly[data-asm="${stageId(a, kind)}"] .mhead button.pw`)!.click();
      const expected = state(cardEditor.patch);

      const viaSwitch: string[] = [];
      const b = busPatch();
      const before = state(b);
      const editor = editorOn(b, viaSwitch);
      const root = b.assemblies!.find((x) => x.id === fxBusOf(b)!.assembly)!;
      const at = [root.x, root.y];
      const button = switchOf(stageId(b, kind));
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
      button.click();
      expect(state(editor.patch)).toBe(expected);
      expect(viaSwitch).toEqual(viaCard);
      expect(viaSwitch.length).toBeGreaterThan(0);
      expect(fxBusOf(editor.patch)).not.toBeNull();
      // neither expanded nor moved, and the redrawn switch shows it on and keeps the keyboard focus
      expect(root.open).toBeFalsy();
      expect([root.x, root.y]).toEqual(at);
      expect(switchOf(stageId(b, kind)).getAttribute('aria-pressed')).toBe('true');
      expect(switchOf(stageId(b, kind)).classList.contains('on')).toBe(true);
      expect(document.activeElement).toBe(switchOf(stageId(b, kind)));
      editor.endGesture();
      editor.undo();
      expect(state(editor.patch)).toBe(before);
      expect(switchOf(stageId(editor.patch, kind)).getAttribute('aria-pressed')).toBe('false');
      editor.redo();
      expect(state(editor.patch)).toBe(expected);
    }
  });

  it('turns a stage back off with a second press', () => {
    const p = busPatch();
    const editor = editorOn(p);
    const delay = stageId(p, 'delay');
    switchOf(delay).click();
    switchOf(delay).click();
    expect(editor.patch.assemblies!.find((a) => a.id === delay)!.bypass).toBe(true);
    expect(pressed()).toEqual(['false', 'false', 'false', 'false']);
  });

  it('dims the rows and heading of each stage that is off, and only those', () => {
    const p = busPatch();
    const editor = editorOn(p);
    const bus = fxBusOf(p)!;
    const card = () => document.querySelector<HTMLElement>(`.module.assembly[data-asm="${bus.assembly}"]`)!;
    // a row's stage: the stage whose assembly holds its module
    const kindOf = (row: HTMLElement) => bus.stages.find((s) => editor.patch.assemblies!.find((a) => a.id === s.assembly)!.modules.includes(Number(row.dataset.mod)))!.kind;
    const dimmed = () => [...new Set([...card().querySelectorAll<HTMLElement>('.param[data-mod]')].filter((r) => r.classList.contains('stage-off')).map(kindOf))];
    const rows = [...card().querySelectorAll<HTMLElement>('.param[data-mod]')];
    expect(new Set(rows.map(kindOf))).toEqual(new Set(['drive', 'chorus', 'delay', 'reverb']));
    expect(rows.every((r) => r.classList.contains('stage-off'))).toBe(true);   // every stage starts off
    expect(card().querySelectorAll('.stage-off:not(.param)').length).toBe(4);  // and each stage's heading
    switchOf(stageId(p, 'delay')).click();
    switchOf(stageId(p, 'reverb')).click();
    expect(dimmed()).toEqual(['drive', 'chorus']);
    // the Reverb's mix row lives on its helper macro: it follows the stage too
    const mix = bus.stages.find((s) => s.kind === 'reverb')!.helpers;
    expect([...card().querySelectorAll<HTMLElement>('.param[data-mod]')].some((r) => mix.includes(Number(r.dataset.mod)) && !r.classList.contains('stage-off'))).toBe(true);
    // turned off on the FM-1 (main.ts applies it and redraws)
    setFxStageEnabled(editor.patch, fxBusOf(editor.patch)!.stages.find((s) => s.kind === 'delay')!, false);
    editor.rebuild();
    expect(dimmed()).toEqual(['drive', 'chorus', 'delay']);
    // no other card is dimmed
    expect(document.querySelectorAll(`.module:not([data-asm="${bus.assembly}"]) .stage-off`)).toHaveLength(0);
  });

  it('follows the expanded card, the FM-1’s FX page and a preset load', () => {
    const p = busPatch();
    const editor = editorOn(p);
    const reverb = stageId(p, 'reverb');
    // the expanded card's ⏻, then collapsed again
    const root = p.assemblies!.find((a) => a.id === fxBusOf(p)!.assembly)!;
    root.open = true;
    editor.rebuild();
    document.querySelector<HTMLButtonElement>(`.module.assembly[data-asm="${stageId(p, 'chorus')}"] .mhead button.pw`)!.click();
    root.open = false;
    editor.rebuild();
    expect(pressed()).toEqual(['false', 'true', 'false', 'false']);
    // the FM-1's FX page toggles a stage: main.ts applies the report with setFxStageEnabled and redraws
    setFxStageEnabled(editor.patch, fxBusOf(editor.patch)!.stages.find((s) => s.kind === 'reverb')!, true);
    editor.rebuild();
    expect(switchOf(reverb).getAttribute('aria-pressed')).toBe('true');
    // a preset that carries the FX stages' state
    const synth = editor.patch.assemblies!.find((a) => a.label === 'Synth')!;
    storePreset(editor.patch, synth, 'Wet');
    setFxStageEnabled(editor.patch, fxBusOf(editor.patch)!.stages.find((s) => s.kind === 'reverb')!, false);
    setFxStageEnabled(editor.patch, fxBusOf(editor.patch)!.stages.find((s) => s.kind === 'chorus')!, false);
    delete synth.preset;
    editor.rebuild();
    expect(pressed()).toEqual(['false', 'false', 'false', 'false']);
    document.querySelector<HTMLButtonElement>(`.module.assembly[data-asm="${synth.id}"] .preset-step:last-child`)!.click();
    expect(pressed()).toEqual(['false', 'true', 'false', 'true']);
    // a patch loaded in its place
    const other = busPatch(['chorus']);
    setFxStageEnabled(other, fxBusOf(other)!.stages[0], true);
    editor.setPatch(other);
    expect(switches().map((b) => b.textContent)).toEqual(['Drive', 'Delay', 'Reverb']);
    expect(pressed()).toEqual(['true', 'false', 'false']);
  });
});
