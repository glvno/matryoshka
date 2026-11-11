// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// #496: a patch opened in the editor starts on its home device (D-217), whatever device the last patch had in focus. The
// editor sends its focus to the FM-1 after each upload, so a focus carried over (Main is m1 in every patch) moved the FM-1
// off the home page it opened the patch on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { currentValues, importPresets, PRESETS_FORMAT, presetsOf, setFactoryPresets, type Preset } from './device-presets';
import { allFactoryPresets } from './factory-presets';
import { DEFS } from './modules';
import { devicesOf, homeDevice } from './pages';
import { PRESETS } from './presets';
import { presetPattern } from './preset-patterns';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

function editorOn(name: string): { editor: Editor; focused: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const focused: string[] = [];
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
    onFocus(key, page) { focused.push(`${key}:${page}`); },
  };
  return { editor: new Editor(document.getElementById('canvas')!, PRESETS[name](), ev), focused };
}

const home = (name: string): string => { const d = devicesOf(PRESETS[name](), DEFS); return d[homeDevice(d)].key; };

describe('the focus when another patch opens (#496)', () => {
  it('a device of the last patch whose key the new one has too (Main): the new patch opens on its home device', () => {
    const { editor } = editorOn('Vernon 100');
    const main = editor.devices.find((d) => d.name === 'Main')!;
    editor.focusFrom({ device: main.key, page: 0 });   // (the FM-1 moved to Main: FOCUS_NOW)
    expect(editor.focus).toEqual({ device: main.key, page: 0 });
    editor.setPatch(PRESETS['Silver Box']());
    expect(editor.devices.some((d) => d.key === main.key)).toBe(true);   // (the key the old focus named is in this patch too)
    expect(editor.focus).toEqual({ device: home('Silver Box'), page: 0 });
    expect(editor.focus?.device).not.toBe(main.key);
  });

  it('any device of the last patch: the next opens on its home device, the same each time', () => {
    const { editor } = editorOn('Silver Box');
    for (const d of editor.devices) {
      editor.focusFrom({ device: d.key, page: 0 });
      editor.setPatch(PRESETS['Silver Box']());
      expect(editor.focus, `after ${d.name}`).toEqual({ device: home('Silver Box'), page: 0 });
    }
  });
});

describe('USER presets with a factory sound’s name', () => {
  let storage: [string, string][];
  let body: ChildNode[];
  let factory: Preset[];

  beforeEach(() => {
    storage = Object.entries(localStorage);
    body = [...document.body.childNodes];
    factory = allFactoryPresets();
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    localStorage.clear();
    for (const [key, value] of storage) localStorage.setItem(key, value);
    setFactoryPresets(factory);
    document.body.replaceChildren(...body);
  });

  it.each(['menu', 'previous', 'next'] as const)('%s loads the USER values and preserves notes without factory origin', (action) => {
    const patch = PRESETS['808 Kit']();
    const assembly = patch.assemblies!.find((a) => a.name === '808 kit')!;
    const sounds = presetsOf(patch, assembly);
    const init = sounds.find((p) => p.factory && p.name === 'Init')!;
    const electro = sounds.find((p) => p.factory && p.name === 'Electro Snap')!;
    // Keep both public stepping directions deterministic: Init, factory Electro Snap, USER Electro Snap.
    setFactoryPresets([init, electro]);
    const values = [...init.values];
    expect(values).not.toEqual(electro.values);
    expect(importPresets({ format: PRESETS_FORMAT, presets: [{ structure: electro.structure, name: electro.name, values }] })).toBe(1);
    const { editor } = editorOn('808 Kit');
    const card = editor.patch.assemblies!.find((a) => a.name === '808 kit')!;
    const track = editor.patch.modules.find((m) => m.type === 'steps')!;
    const chipSelector = `[data-asm="${card.id}"] .preset-chip`;
    const choose = (name: string): void => {
      document.querySelector<HTMLButtonElement>(`${chipSelector} .preset-name`)!.click();
      const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const labels = items.map((b) => b.textContent?.replace(/^● /, ''));
      expect(labels).toContain('Electro Snap (factory)');
      expect(labels).toContain('Electro Snap');
      const item = items.find((b) => b.textContent?.replace(/^● /, '') === name);
      expect(item, `preset menu entry ${name}`).toBeDefined();
      item!.click();
    };

    expect(track.factoryPatterns?.ids[0]).toBe(presetPattern(electro.structure, 'Init')!.id);
    if (action === 'next') choose('Electro Snap (factory)');
    const notes = structuredClone(track.notes);
    if (action === 'menu') {
      choose('Electro Snap');
    } else {
      document.querySelector<HTMLButtonElement>(`${chipSelector} [title="${action === 'previous' ? 'Previous' : 'Next'} preset"]`)!.click();
    }

    expect(card.preset).toBe('Electro Snap');
    expect(currentValues(editor.patch, card)).toEqual(values);
    expect(track.notes).toEqual(notes);
    expect(track.factoryPatterns).toBeUndefined();
  });
});
