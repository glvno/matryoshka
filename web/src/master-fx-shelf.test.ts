// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { FACTORY } from './assemblies';
import { allModules, bypassAssembly, insertAssembly, targetsOf, toDef, validateAssemblyDef, type AssemblyInst } from './assembly';
import { Editor, type EditorEvents } from './editor';
import { BLOCK, Engine } from './engine';
import { fxBusOf } from './fx-bus';
import { moduleTitle } from './labels';
import { DEFS } from './modules';
import { addModule, connect, newPatch, validatePatch, type Endpoint, type Patch } from './patch';
import { BYPASS_BIT, encodePatch, FLAG_FX_BUS, formatOf, GROUP_REC, layout, moduleRecordSize, PANEL_BYTES } from './patchbin';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!document.fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

const definition = () => FACTORY.find((d) => d.name === 'master FX')!;
const end = (module: number, port: string): Endpoint => ({ module, port });

function source() {
  const p = newPatch(DEFS, 'Custom stereo patch');
  const output = p.modules.find((m) => m.type === 'output')!;
  output.params.level = 1;
  const left = addModule(p, DEFS.macro, 20, 20);
  const right = addModule(p, DEFS.macro, 340, 20);
  left.params.value = 0.125;
  right.params.value = 0.375;
  return { p, output, left, right };
}

function wire(p: Patch, a: AssemblyInst, left: number, right: number, output: number): void {
  for (const [i, id] of [left, right].entries()) {
    for (const to of targetsOf(a.inputs[i])) expect(connect(p, DEFS, end(id, 'out'), to)).toBe(true);
    for (const from of targetsOf(a.outputs[i])) expect(connect(p, DEFS, from, end(output, i ? 'r' : 'l'))).toBe(true);
  }
}

function render(p: Patch, blocks = 1, compile = false): [Float32Array, Float32Array] {
  const engine = new Engine(48000);
  engine.load(p, compile);
  const left = new Float32Array(BLOCK), right = new Float32Array(BLOCK);
  for (let i = 0; i < blocks; i++) engine.render(left, right);
  return [left, right];
}

function expectDry(p: Patch): void {
  const [left, right] = render(p);
  for (let i = 0; i < BLOCK; i++) {
    expect(left[i]).toBeCloseTo(0.125, 6);
    expect(right[i]).toBeCloseTo(0.375, 6);
  }
}

function editorOn(p: Patch): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
  };
  return new Editor(document.getElementById('canvas')!, p, ev);
}

function drag(from: Endpoint, to: Endpoint): void {
  const jack = (e: Endpoint, dir: string) => document.querySelector<HTMLElement>(`.dot[data-mod="${e.module}"][data-port="${e.port}"][data-dir="${dir}"]`)!;
  const out = jack(from, 'out'), input = jack(to, 'in');
  expect(out).not.toBeNull();
  expect(input).not.toBeNull();
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => input });
  out.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
}

describe('the master FX assembly in the Effects shelf', () => {
  it('inserts through the editor and wires summed stereo jacks atomically, with undo and cable removal', () => {
    const { p, left, right, output } = source();
    const editor = editorOn(p);
    editor.insert(definition());
    const root = editor.patch.assemblies!.find((a) => a.name === 'master FX')!;
    drag(end(left.id, 'out'), root.inputs[0]);
    drag(end(right.id, 'out'), root.inputs[1]);
    drag(root.outputs[0], end(output.id, 'l'));
    drag(root.outputs[1], end(output.id, 'r'));
    expect(fxBusOf(editor.patch)?.stages).toHaveLength(4);
    expect(formatOf(editor.patch)).toBe(55);
    expectDry(editor.patch);
    // The shared wet endpoint is wired once per channel, never twice through the same bundled jack.
    expect(editor.patch.cables.filter((c) => c.to.module === output.id)).toHaveLength(4);
    editor.undo();
    expect(editor.patch.cables.filter((c) => c.to.module === output.id && c.to.port === 'r')).toHaveLength(0);
    editor.redo();
    expect(fxBusOf(editor.patch)).not.toBeNull();
    editor.drawCables();
    // Remove a visible output bundle, not its internal wet cable alone.
    const sinkLabel = moduleTitle(output, DEFS[output.type].label);
    const outputPaths = [...document.querySelectorAll<SVGPathElement>('path.cable[role="button"]')].filter((path) => path.getAttribute('aria-label')?.includes(`→ ${sinkLabel} `));
    expect(outputPaths).toHaveLength(2);
    outputPaths[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editor.patch.cables.filter((c) => c.to.module === output.id)).toHaveLength(2);
    editor.undo();
    expect(fxBusOf(editor.patch)).not.toBeNull();
  });

  it('starts every child OFF, enables ordinary editable stages, and keeps stereo dry through whole bypass', () => {
    const { p, left, right, output } = source();
    const root = insertAssembly(p, DEFS, definition(), 20, 20);
    wire(p, root, left.id, right.id, output.id);
    const bus = fxBusOf(p)!;
    expect(bus.stages.map((s) => p.assemblies!.find((a) => a.id === s.assembly)!.bypass)).toEqual([true, true, true, true]);
    expectDry(p);
    const drive = p.assemblies!.find((a) => a.id === bus.stages[0].assembly)!;
    for (const id of drive.modules) p.modules.find((m) => m.id === id)!.params.drive = 2;
    bypassAssembly(p, drive, false);
    const driven = render(p);
    expect(Math.abs(driven[0][BLOCK - 1] - 0.125)).toBeGreaterThan(0.01);
    expect(driven[0][BLOCK - 1]).not.toBe(driven[1][BLOCK - 1]);
    bypassAssembly(p, drive, true);
    const reverb = p.assemblies!.find((a) => a.id === bus.stages[3].assembly)!;
    bypassAssembly(p, reverb, false);
    const wet = render(p, 300);
    expect(Math.max(...wet[0].map((v) => Math.abs(v - 0.125)))).toBeGreaterThan(0.0001);
    for (let i = 0; i < BLOCK; i++) expect(wet[1][i] - wet[0][i]).toBeCloseTo(0.25, 5);
    bypassAssembly(p, root, true);
    expectDry(p);
  });

  it('honors individually bypassed wet helpers as ordinary audio instead of granting FX overrides', () => {
    for (const helperKind of ['macro', 'send', 'return']) {
      const { p, left, right, output } = source();
      const root = insertAssembly(p, DEFS, definition(), 20, 20);
      wire(p, root, left.id, right.id, output.id);
      const stage = fxBusOf(p)!.stages.find((s) => s.kind === 'reverb')!;
      const reverb = p.assemblies!.find((a) => a.id === stage.assembly)!;
      bypassAssembly(p, reverb, false);
      const helper = p.modules.find((m) => stage.helpers.includes(m.id) && (helperKind === 'macro'
        ? m.type === 'macro' : m.type === 'math' && m.params.ka === (helperKind === 'send' ? 0.5 : 1)))!;
      helper.bypass = true;
      const saved = structuredClone(p);
      expect(fxBusOf(p)).toBeNull();
      const bin = encodePatch(p, true);
      expect((bin[6] | bin[7] << 8) & FLAG_FX_BUS).toBe(0);
      const { p: dev, groups, keep } = layout(p);
      let at = 8 + GROUP_REC * groups.length + (groups.length ? dev.modules.length : 0) + PANEL_BYTES;
      const flags = new Map<number, number>();
      for (const m of dev.modules) {
        flags.set(m.id, bin[at] & BYPASS_BIT);
        at += moduleRecordSize(m, bin[1], false, keep.get(m.id));
      }
      expect(flags.get(helper.id)).toBe(BYPASS_BIT);
      expect(flags.get(stage.targets[0])).toBe(0);
      for (const compile of [false, true]) {
        const dry = render(p, 300, compile);
        for (let i = 0; i < BLOCK; i++) {
          expect(dry[0][i]).toBeCloseTo(0.125, 6);
          expect(dry[1][i]).toBeCloseTo(0.375, 6);
        }
      }
      expect(p).toEqual(saved);
      delete helper.bypass;
      expect(fxBusOf(p)).not.toBeNull();
      const active = render(p, 300);
      expect(Math.max(...active[0].map((v) => Math.abs(v - 0.125)))).toBeGreaterThan(0.0001);
      for (let i = 0; i < BLOCK; i++) expect(active[1][i] - active[0][i]).toBeCloseTo(0.25, 5);
    }
  });

  it('ignores live bypass messages for a recognized Reverb wet return, so stage OFF spills its tail', () => {
    const { p, left, right, output } = source();
    const root = insertAssembly(p, DEFS, definition(), 20, 20);
    wire(p, root, left.id, right.id, output.id);
    const stage = fxBusOf(p)!.stages.find((s) => s.kind === 'reverb')!;
    bypassAssembly(p, p.assemblies!.find((a) => a.id === stage.assembly)!, false);
    const plain = new Engine(48000), live = new Engine(48000);
    plain.load(p, false);
    live.load(p, false);
    const out = [0, 1].map(() => [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
    for (let i = 0; i < 100; i++) { plain.render(out[0][0], out[0][1]); live.render(out[1][0], out[1][1]); }
    for (const id of stage.helpers) live.setBypass(id, true);   // the editor's stage switch sends every member
    plain.setBypass(stage.targets[0], true);
    live.setBypass(stage.targets[0], true);
    let tail = 0;
    for (let i = 0; i < 20; i++) {
      plain.render(out[0][0], out[0][1]);
      live.render(out[1][0], out[1][1]);
      expect(out[1][0]).toEqual(out[0][0]);
      expect(out[1][1]).toEqual(out[0][1]);
      tail = Math.max(tail, ...out[1][0].map((v) => Math.abs(v - 0.125)));
    }
    expect(tail).toBeGreaterThan(0.0001);
  });

  it('exports and reinserts nested OFF/ON state and bundled ports with fresh IDs, without name authority', () => {
    const { p, left, right, output } = source();
    const root = insertAssembly(p, DEFS, definition(), 20, 20);
    wire(p, root, left.id, right.id, output.id);
    const original = fxBusOf(p)!;
    const drive = p.assemblies!.find((a) => a.id === original.stages[0].assembly)!;
    bypassAssembly(p, drive, false);
    const reverb = p.assemblies!.find((a) => a.id === original.stages[3].assembly)!;
    bypassAssembly(p, reverb, false);
    const ownOff = p.modules.find((m) => reverb.modules.includes(m.id) && m.type === 'macro')!;
    ownOff.bypass = true;
    bypassAssembly(p, reverb, true);
    const saved = validateAssemblyDef(toDef(p, root), DEFS);
    saved.name = 'User rack';
    for (const child of saved.assemblies!) child.name = child.label = 'Custom';
    const next = source();
    // Force unrelated IDs before reinsertion so kept lists and all endpoints must be remapped.
    for (let i = 0; i < 5; i++) addModule(next.p, DEFS.macro, 0, 0);
    const copy = insertAssembly(next.p, DEFS, saved, 40, 40);
    wire(next.p, copy, next.left.id, next.right.id, next.output.id);
    expect(fxBusOf(next.p)).toBeNull();
    const children = next.p.assemblies!.filter((a) => copy.children!.includes(a.id));
    expect(children.map((a) => !!a.bypass)).toEqual([false, true, true, true]);
    const copiedReverb = children.find((a) => a.modules.some((id) => next.p.modules.find((m) => m.id === id)!.type === 'reverb'))!;
    const copiedOwnOff = next.p.modules.find((m) => copiedReverb.modules.includes(m.id) && m.type === 'macro')!;
    expect(copiedReverb.kept).toEqual([copiedOwnOff.id]);
    expect(allModules(next.p, copy)).not.toEqual(allModules(p, root));
    expect(fxBusOf(validatePatch(structuredClone(next.p), DEFS))).toBeNull();
    const copiedDrive = children.find((a) => a.modules.some((id) => next.p.modules.find((m) => m.id === id)!.type === 'shape'))!;
    bypassAssembly(next.p, copiedDrive, true);
    expectDry(next.p);
    bypassAssembly(next.p, copiedReverb, false);
    expect(copiedOwnOff.bypass).toBe(true);
    expect(copiedReverb.kept).toBeUndefined();
    expect(copiedReverb.modules.filter((id) => next.p.modules.find((m) => m.id === id)!.bypass)).toEqual([copiedOwnOff.id]);
    expect(fxBusOf(next.p)).toBeNull();
    expectDry(next.p);
    const stillDry = render(next.p, 300);
    for (let i = 0; i < BLOCK; i++) {
      expect(stillDry[0][i]).toBeCloseTo(0.125, 6);
      expect(stillDry[1][i]).toBeCloseTo(0.375, 6);
    }
    delete copiedOwnOff.bypass;
    expect(fxBusOf(next.p)).not.toBeNull();
    const wet = render(next.p, 300);
    expect(Math.max(...wet[0].map((v) => Math.abs(v - 0.125)))).toBeGreaterThan(0.0001);
    for (let i = 0; i < BLOCK; i++) expect(wet[1][i] - wet[0][i]).toBeCloseTo(0.25, 5);
  });
});
