// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// #496: a patch opened in the editor starts on its home device (D-217), whatever device the last patch had in focus. The
// editor sends its focus to the FM-1 after each upload, so a focus carried over (Main is m1 in every patch) moved the FM-1
// off the home page it opened the patch on.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { devicesOf, homeDevice } from './pages';
import { PRESETS } from './presets';

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
