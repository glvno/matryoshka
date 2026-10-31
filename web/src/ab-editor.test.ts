// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The A/B flip through the editor (#103): after A -> B -> A the browser engine and the FM-1 (Live) play the stored versions,
// the canvas keeps its layout, and each flip is one undo step that goes back to the side it left.
import { describe, expect, it, vi } from 'vitest';
import { BLOCK, Engine } from './engine';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import type { ModuleInst, Patch } from './patch';
import { encodePatch } from './patchbin';
import { PRESETS } from './presets';

// (jsdom lacks these; selector.ts makes its ResizeObserver when it loads, so before the imports)
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});


const SR = 48000;
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const sound = (p: Patch): string => Array.from(encodePatch(p, true)).join(',');

/** an editor on a fresh canvas, with the browser engine and a model of the FM-1 fed from its events as main.ts feeds them */
function rig(start: Patch): { editor: Editor; engine: Engine; fm1: () => Patch; log: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const engine = new Engine(SR);
  let fm1 = copy(start);
  const log: string[] = [];
  const mod = (id: number): ModuleInst => fm1.modules.find((m) => m.id === id)!;
  const ev: EditorEvents = {
    onStructure(p) { log.push('structure'); engine.load(p); fm1 = copy(p); },   // (the FM-1 takes the whole patch: an upload)
    onParam(id, name, value) { log.push('param'); engine.setParam(id, name, value); mod(id).params[name] = value; },
    onAtt(id, index, value) { log.push('att'); engine.setAtt(id, index, value); (mod(id).att ??= [1, 1])[index] = value; },
    onBypass(id, on) { log.push('bypass'); engine.setBypass(id, on); mod(id).bypass = on; },
    onRange(id, index, name, range) {
      log.push('range');
      engine.setRange(id, index, name, range);
      const m = mod(id);
      const s = index ? 'p2' : 'p1';
      const r = ((m.range ??= {})[s] ??= {});
      if (range) r[name] = range;
      else delete r[name];
    },
    onTrack(id, notes, pat) { log.push('track'); engine.setTrack(id, notes, pat); mod(id).notes = notes; },
    onTransport() {},
    onLayout() { log.push('layout'); },
    onError() {},
    onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, copy(start), ev);
  engine.load(editor.patch);
  return { editor, engine, fm1: () => fm1, log };
}

/** a second of the engine with a held note, to compare two engines */
function listen(e: Engine): number[] {
  e.noteOn(48, 0.8);
  const out: number[] = [];
  const [l, r] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let i = 0; i < 40; i++) {
    e.render(l, r);
    out.push(...l.slice(0, 8), ...r.slice(0, 8));
  }
  return out;
}
const fresh = (p: Patch): Engine => {
  const e = new Engine(SR);
  e.load(p);
  return e;
};
const layout = (p: Patch): unknown => [p.modules.map((m) => [m.id, m.x, m.y]), (p.assemblies ?? []).map((a) => [a.id, a.x, a.y, a.open, a.frameSize])];

describe('A/B flip in the editor (#103)', () => {
  /** A is Oracle V; B moves a parameter, a Steps note and an attenuverter, and the cards */
  function twoSides(structural = false) {
    const r = rig(PRESETS['Oracle V']());
    const { editor } = r;
    editor.takeSnapshot('A');
    const a = copy(editor.patch);
    const p = editor.patch;
    const m = p.modules.find((x) => x.type !== 'fm1' && DEFS[x.type].params.some((d) => d.max > d.min))!;
    const pd = DEFS[m.type].params.find((d) => d.max > d.min)!;
    m.params[pd.name] = (m.params[pd.name] ?? pd.default) === pd.max ? pd.min : pd.max;
    p.modules.find((x) => x.type === 'steps')!.notes = [{ at: 0, len: 2, note: 45, vel: 100 }];
    const routed = p.modules.find((x) => DEFS[x.type].paramInputs)!;
    routed.att = [0.25, -0.5];
    if (structural) p.assemblies![0].label = 'changed';
    p.name = 'B';
    editor.takeSnapshot('B');
    const b = copy(editor.patch);
    return { ...r, a, b };
  }

  it('values only: A -> B -> A plays each stored version in both engines, without a reload', () => {
    const { editor, engine, fm1, log, a, b } = twoSides();
    // the canvas is moved on side B before the flip: it stays moved
    editor.patch.modules[0].x += 200;
    const moved = layout(editor.patch);
    log.length = 0;
    expect(editor.toggleAB()).toBe(true);
    expect(editor.side).toBe('A');
    expect(log).not.toContain('structure');
    expect(log).toContain('track');
    expect(sound(editor.patch)).toBe(sound(a));
    expect(sound(fm1())).toBe(sound(a));
    expect(listen(engine)).toEqual(listen(fresh(a)));
    expect(layout(editor.patch)).toEqual(moved);
    expect(editor.patch.name).toBe(a.name);

    editor.toggleAB();
    expect(editor.side).toBe('B');
    expect(sound(editor.patch)).toBe(sound(b));
    expect(sound(fm1())).toBe(sound(b));
    expect(editor.patch.name).toBe('B');
    expect(layout(editor.patch)).toEqual(moved);
  });

  it('another overlay (an assembly label): a full load, the layout stays', () => {
    const { editor, fm1, log, a, b } = twoSides(true);
    log.length = 0;
    editor.toggleAB();
    expect(log).toContain('structure');
    expect(sound(fm1())).toBe(sound(a));
    expect(editor.patch.assemblies![0].label).toBe(a.assemblies![0].label);
    editor.toggleAB();
    expect(sound(fm1())).toBe(sound(b));
    expect(layout(editor.patch)).toEqual(layout(b));
  });

  it('a flip is one undo step that goes back to the side it left', () => {
    const { editor, a, b } = twoSides();
    editor.toggleAB(); // B -> A
    expect(sound(editor.patch)).toBe(sound(a));
    editor.undo();
    expect(editor.side).toBe('B');
    expect(sound(editor.patch)).toBe(sound(b));
    editor.redo();
    expect(editor.side).toBe('A');
    expect(sound(editor.patch)).toBe(sound(a));
  });

  it('a flip during a REC pass ends the pass first: one undo step for the pass, one for the flip', () => {
    const { editor, a, b } = twoSides();
    const id = editor.patch.modules.find((x) => x.type === 'steps')!.id;
    editor.recorded([{ id, loop: 0, note: { at: 3, len: 1, note: 60, vel: 100 } }]);
    const recorded = sound(editor.patch);
    editor.toggleAB(); // B (with the pass) -> A
    expect(sound(editor.patch)).toBe(sound(a));
    editor.undo(); // the flip
    expect([editor.side, sound(editor.patch)]).toEqual(['B', recorded]);
    editor.undo(); // the pass
    expect([editor.side, sound(editor.patch)]).toEqual(['B', sound(b)]);
  });

  it('an edit on a side is kept when it is left and comes back', () => {
    const { editor, b } = twoSides();
    editor.toggleAB(); // on A
    const m = editor.patch.modules.find((x) => x.type === 'steps')!;
    m.notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    const edited = sound(editor.patch);
    editor.toggleAB(); // on B
    expect(sound(editor.patch)).toBe(sound(b));
    editor.toggleAB(); // on A again
    expect(sound(editor.patch)).toBe(edited);
  });
});
