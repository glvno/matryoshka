// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it, vi } from 'vitest';
import { buildFm1Wasm } from '../scripts/fm1-wasm.mjs';
import { Editor, type EditorEvents } from './editor';
import { BUTTONS, ENCODERS, Fm1Ui } from './fm1-ui';
import { DEFS } from './modules';
import { encodePatch } from './patchbin';
import { deviceView } from './poly';
import { FM1_PRESETS } from './presets';
import { presetPattern } from './preset-patterns';
import { presetsOf } from './device-presets';
import { noteWord } from './track';
import './factory-presets';

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  HTMLElement.prototype.checkVisibility ??= () => true;
  HTMLElement.prototype.scrollTo ??= () => {};
});

let bytes: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  bytes = new Uint8Array(readFileSync(buildFm1Wasm()));
}, 120_000);

async function rig() {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  let source = -1;
  let replay = false;
  const pending = new Set<number>();
  const panels: Fm1Ui[] = [];
  const ev: EditorEvents = {
    onStructure() { for (let i = 0; i < 2; i++) if (i !== source) pending.add(i); },
    onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, FM1_PRESETS['808 Kit'](), ev);
  const track = editor.patch.modules.find((m) => m.type === 'steps')!;
  const card = editor.patch.assemblies!.find((a) => a.name === '808 kit')!;
  const sounds = presetsOf(editor.patch, card);
  const device = editor.devices.findIndex((d) => d.asm === card.id);
  for (let i = 0; i < 2; i++) {
    panels.push(await Fm1Ui.create(bytes, {
      origin(module, pattern, identity) {
        source = i;
        try { editor.originsFromDevice({ kind: 'change', record: { module, pattern, identity } }, replay); }
        finally { source = -1; }
      },
      track(module, notes, pat) {
        if (replay) return;
        editor.trackFromDevice(deviceView(editor.patch, true).patch.modules[module].id, notes, pat);
      },
      param(module, param, value) {
        const m = deviceView(editor.patch, true).patch.modules[module];
        const name = m && DEFS[m.type].params[param]?.name;
        if (name) editor.setParam(m.id, name, value / 65536);
      },
    }));
  }
  const load = (i: number) => {
    expect(panels[i].load(encodePatch(editor.patch), '808 KIT')).toBe(0);
    panels[i].tick(1000);
    panels[i].focus(device, 0);
  };
  panels.forEach((_, i) => load(i));
  pending.clear();
  return {
    editor, track, sounds, panels, load,
    flush() { for (const i of pending) load(i); pending.clear(); },
    store(i: number) {
      panels[i].button(BUTTONS.env, true);
      panels[i].button(BUTTONS.save, true);
      panels[i].button(BUTTONS.save, false);
      panels[i].button(BUTTONS.env, false);
      panels[i].focus(device, 0);
    },
    replay(action: () => void) { replay = true; try { action(); } finally { replay = false; } },
  };
}

it.each([0, 1])('USER store on panel %i preserves the pattern when the other panel selects factory sounds', async (from) => {
  const r = await rig();
  const notes = structuredClone(r.track.notes);
  r.store(from);
  expect(r.track.factoryPatterns).toBeUndefined();
  r.flush();
  r.panels[1 - from].encoder(ENCODERS.preset, 1);
  expect(r.track.notes).toEqual(notes);
  expect(r.track.factoryPatterns).toBeUndefined();
});

it.each([0, 1])('USER load on panel %i preserves the pattern when the other panel selects factory sounds', async (from) => {
  const r = await rig();
  const identity = presetPattern(r.sounds[0].structure, 'Init')!.id;
  r.store(from);
  r.track.factoryPatterns = { version: 1, ids: [identity] };
  r.panels.forEach((_, i) => r.load(i));
  const notes = structuredClone(r.track.notes);
  r.panels[from].encoder(ENCODERS.preset, -1);
  expect(r.track.factoryPatterns).toBeUndefined();
  r.flush();
  r.panels[1 - from].encoder(ENCODERS.preset, 1);
  expect(r.track.notes).toEqual(notes);
});

it('untouched factory patterns continue changing across alternating panels', async () => {
  const r = await rig();
  for (const from of [0, 1]) {
    r.panels[from].encoder(ENCODERS.preset, 1);
    expect(r.track.notes!.map(noteWord)).toEqual(presetPattern(r.sounds[1].structure, r.sounds[1].name)!.notes);
    r.flush();
  }
});

it('SAVE invalidation reloads both panels and a replay cannot restore ownership', async () => {
  const r = await rig();
  const notes = structuredClone(r.track.notes);
  r.editor.clearPatternOrigins();
  r.replay(() => r.panels[1].encoder(ENCODERS.preset, 1));
  expect(r.track.factoryPatterns).toBeUndefined();
  expect(r.track.notes).toEqual(notes);
  r.flush();
  r.panels[1].encoder(ENCODERS.preset, 1);
  expect(r.track.notes).toEqual(notes);
});

it('complete snapshots and invalid snapshots reach the panel binary', async () => {
  const r = await rig();
  const module = deviceView(r.editor.patch, true).patch.modules.findIndex((m) => m.id === r.track.id);
  const identity = parseInt(presetPattern(r.sounds[0].structure, 'Init')!.id, 16);
  r.editor.clearPatternOrigins();
  r.flush();
  expect(r.editor.originsFromDevice({ kind: 'snapshot', records: [{ module, pattern: 0, identity }] })).toBe(true);
  r.flush();
  r.panels[1].encoder(ENCODERS.preset, 1);
  expect(r.track.notes!.map(noteWord)).toEqual(presetPattern(r.sounds[1].structure, r.sounds[1].name)!.notes);
  expect(r.editor.originsFromDevice({ kind: 'snapshot', records: [{ module: 999, pattern: 0, identity }] })).toBe(false);
  r.flush();
  const notes = structuredClone(r.track.notes);
  r.panels[0].encoder(ENCODERS.preset, 1);
  expect(r.track.notes).toEqual(notes);
});
