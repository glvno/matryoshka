// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Stereo mode on the canvas (#1141): the card's ST switch, stereo jacks and cables, the L / R / L+R marks, and the old
// drawer Reverb's "classic mix" tag.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAssembly, type AssemblyInst } from './assembly';
import { Editor, type EditorEvents } from './editor';
import { addDrawer, catalogEffectDef, EFFECT_CATALOG, insertEffect } from './fx-drawer';
import { DEFS } from './modules';
import { addModule, connect, newPatch, type Patch } from './patch';
import { setPoly } from './poly';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!document.fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

function editorOn(p: Patch, log: string[] = [], ev: Partial<EditorEvents> = {}): Editor {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const events: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError: (msg) => log.push(msg), onSaveAssembly() {}, ...ev,
  };
  return new Editor(document.getElementById('canvas')!, p, events);
}

/** an oscillator into a filter, the filter into a VCA and into the Output's l */
function rig(): { p: Patch; osc: number; filter: number; vca: number; out: number } {
  const p = newPatch(DEFS, 'Stereo');
  const out = p.modules.find((m) => m.type === 'output')!.id;
  const osc = addModule(p, DEFS.osc, 20, 20), filter = addModule(p, DEFS.filter, 340, 20), vca = addModule(p, DEFS.vca, 660, 20);
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: filter.id, port: 'in' });
  connect(p, DEFS, { module: filter.id, port: 'lp24' }, { module: vca.id, port: 'in' });
  connect(p, DEFS, { module: filter.id, port: 'lp24' }, { module: out, port: 'l' });
  return { p, osc: osc.id, filter: filter.id, vca: vca.id, out };
}

const card = (id: number) => document.querySelector<HTMLElement>(`.module[data-id="${id}"]`)!;
const st = (id: number) => card(id).querySelector<HTMLButtonElement>('.mhead button.st');
const jack = (id: number, port: string, dir: 'in' | 'out') => card(id).querySelector<HTMLElement>(`.dot[data-port="${port}"][data-dir="${dir}"]`)!;
const marks = (): string[] => [...document.querySelectorAll('.cable-mark')].map((t) => t.textContent ?? '');

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('stereo mode on the canvas (#1141)', () => {
  it('ST sits beside ⏻ on an eligible card only; a press is one structural, undoable edit that sends the patch again', () => {
    const { p, osc, filter } = rig();
    let loads = 0;
    const e = editorOn(p, [], { onStructure: () => loads++ });
    expect(st(osc)).toBeNull();
    const b = st(filter)!;
    expect(b.nextElementSibling?.classList.contains('pw')).toBe(true);
    expect(b.getAttribute('aria-pressed')).toBe('false');
    b.click();
    expect(e.patch.modules.find((m) => m.id === filter)!.stereo).toBe(true);
    expect(loads).toBe(1);
    expect(st(filter)!.getAttribute('aria-pressed')).toBe('true');
    e.undo();
    expect(e.patch.modules.find((m) => m.id === filter)!.stereo).toBeUndefined();
    expect(st(filter)!.getAttribute('aria-pressed')).toBe('false');
  });

  it('inside a poly assembly ST is greyed and a press says why, changing nothing', () => {
    const { p, osc, filter } = rig();
    setPoly(p, DEFS, makeAssembly(p, [osc, filter], 'Voice'), true);
    const log: string[] = [];
    const e = editorOn(p, log);
    (e.patch.assemblies!.find((a) => a.label === 'Voice') as AssemblyInst).open = true;
    e.rebuild();
    const b = st(filter)!;
    expect(b.classList.contains('refused')).toBe(true);
    expect(b.title).toMatch(/poly assembly "Voice"/);
    b.click();
    expect(log.at(-1)).toMatch(/poly assembly "Voice"/);
    expect(e.patch.modules.find((m) => m.id === filter)!.stereo).toBeUndefined();
  });

  it('a stereo module has double-ring jacks and double-line cables; L+R where a mono jack averages, none on Output l with r free', () => {
    const { p, filter, vca } = rig();
    p.modules.find((m) => m.id === filter)!.stereo = true;
    editorOn(p).drawCables();
    expect(jack(filter, 'lp24', 'out').classList.contains('stereo')).toBe(true);
    expect(jack(filter, 'in', 'in').classList.contains('stereo')).toBe(true);
    expect(jack(vca, 'in', 'in').classList.contains('stereo')).toBe(false);
    const stereo = [...document.querySelectorAll('path.cable.stereo')];
    expect(stereo).toHaveLength(2);
    expect(document.querySelectorAll('path.cable-core.stereo').length).toBeGreaterThanOrEqual(2);
    expect(marks()).toEqual(['L+R']);
    const mark = document.querySelector('.cable-mark textPath')!;
    const into = document.getElementById(mark.getAttribute('href')!.slice(1))!;
    expect(into.querySelector('title')!.textContent).toMatch(/VCA/);
  });

  it('an open drawer shows the side cables’ L / R marks and a 1.26 Reverb’s "classic mix" tag, a new Reverb none', () => {
    const p = newPatch(DEFS, 'Drawer');
    const out = p.modules.find((m) => m.type === 'output')!;
    const a = addModule(p, DEFS.osc, 20, 20), b = addModule(p, DEFS.osc, 340, 20);
    connect(p, DEFS, { module: a.id, port: 'out' }, { module: out.id, port: 'l' });
    connect(p, DEFS, { module: b.id, port: 'out' }, { module: out.id, port: 'r' });
    const inst = makeAssembly(p, [a.id, b.id], 'Duo');
    const d = addDrawer(p, inst.id);
    const legacy = catalogEffectDef(EFFECT_CATALOG.find((x) => 'type' in x.source && x.source.type === 'reverb')!, { legacy: true });
    const old = insertEffect(p, d, { def: legacy });
    insertEffect(p, d, { type: 'shape' });
    const fresh = insertEffect(p, d, { type: 'reverb' });
    const e = editorOn(p);
    e.setDrawerOpen(d.id, true);
    e.drawCables();
    const tagOf = (id: number) => document.querySelector(`.fx-drawer .module.assembly[data-asm="${id}"] .fx-classic`);
    expect(tagOf(old.id)?.textContent).toBe('classic mix');
    expect(tagOf(fresh.id)).toBeNull();
    expect(marks().filter((m) => m !== 'L+R').sort()).toEqual(['L', 'L', 'R', 'R']);
  });
});
