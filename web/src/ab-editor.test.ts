// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Snapshots through the editor (#943, the switching rules of #103): switching between a snapshot and the current patch
// plays the stored versions in the browser engine and the FM-1 (Live), the canvas keeps its layout, each switch is one undo
// step that goes back to the stop it left, and no switch, edit, removal or undo loses the current patch or a snapshot.
import { describe, expect, it, vi } from 'vitest';
import { BLOCK, Engine } from './engine';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { MUTATE_SKIP } from './mutate';
import type { ModuleInst, Patch } from './patch';
import { encodePatch } from './patchbin';
import { relocatedPatches } from './community-factory';

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

describe('snapshots in the editor (#943)', () => {
  /** snapshot A is Oracle V; the current patch moves a parameter, a Steps note and an attenuverter */
  function snapshotAndCurrent(structural = false) {
    const r = rig(relocatedPatches['Oracle V']());
    const { editor } = r;
    expect(editor.takeSnapshot().letter).toBe('A');
    const a = copy(editor.patch);
    const p = editor.patch;
    const m = p.modules.find((x) => x.type !== 'fm1' && DEFS[x.type].params.some((d) => d.max > d.min))!;
    const pd = DEFS[m.type].params.find((d) => d.max > d.min)!;
    m.params[pd.name] = (m.params[pd.name] ?? pd.default) === pd.max ? pd.min : pd.max;
    p.modules.find((x) => x.type === 'steps')!.notes = [{ at: 0, len: 2, note: 45, vel: 100 }];
    const routed = p.modules.find((x) => DEFS[x.type].paramInputs)!;
    routed.att = [0.25, -0.5];
    if (structural) p.assemblies![0].label = 'changed';
    p.name = 'current';
    const b = copy(editor.patch);
    return { ...r, a, b, m, pd };
  }
  const steps = (p: Patch): ModuleInst => p.modules.find((x) => x.type === 'steps')!;

  it('one snapshot compares with the current patch: values only switch in place in both engines', () => {
    const { editor, engine, fm1, log, a, b } = snapshotAndCurrent();
    // the canvas is moved before the switch: it stays moved
    editor.patch.modules[0].x += 200;
    const moved = layout(editor.patch);
    log.length = 0;
    expect(editor.cycleSnapshots()).toEqual({});
    expect(editor.snaps.shown).toBe('A');
    expect(log).not.toContain('structure');
    expect(log).toContain('track');
    expect(sound(editor.patch)).toBe(sound(a));
    expect(sound(fm1())).toBe(sound(a));
    expect(listen(engine)).toEqual(listen(fresh(a)));
    expect(layout(editor.patch)).toEqual(moved);
    expect(editor.patch.name).toBe(a.name);
    expect(sound(editor.currentPatch())).toBe(sound(b));   // (what the autosave keeps while A plays)

    editor.cycleSnapshots();
    expect(editor.snaps.shown).toBeNull();
    expect(sound(editor.patch)).toBe(sound(b));
    expect(sound(fm1())).toBe(sound(b));
    expect(editor.patch.name).toBe('current');
    expect(layout(editor.patch)).toEqual(moved);
  });

  it('another overlay (an assembly label): a full load, the layout stays', () => {
    const { editor, fm1, log, a, b } = snapshotAndCurrent(true);
    log.length = 0;
    editor.cycleSnapshots();
    expect(log).toContain('structure');
    expect(sound(fm1())).toBe(sound(a));
    expect(editor.patch.assemblies![0].label).toBe(a.assemblies![0].label);
    editor.cycleSnapshots();
    expect(sound(fm1())).toBe(sound(b));
    expect(layout(editor.patch)).toEqual(layout(b));
  });

  it('letters come in the order taken, and the switch goes through each and back to the current patch', () => {
    const { editor, m, pd } = snapshotAndCurrent();
    const values: number[] = [];
    const value = (): number => editor.patch.modules.find((x) => x.id === m.id)!.params[pd.name];
    values.push(value());   // (the current patch, as B is taken)
    expect(editor.takeSnapshot().letter).toBe('B');
    editor.patch.modules.find((x) => x.id === m.id)!.params[pd.name] = (pd.min + pd.max) / 2;
    const stops: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      editor.cycleSnapshots();
      stops.push(editor.snaps.shown);
    }
    expect(stops).toEqual(['A', 'B', null, 'A']);
    editor.cycleSnapshots(); // B
    expect(value()).toBe(values[0]);
    editor.cycleSnapshots(); // the current patch, with its latest edit
    expect(value()).toBe((pd.min + pd.max) / 2);
    expect(editor.cycleSnapshots(-1)).not.toBeNull();
    expect(editor.snaps.shown).toBe('B');
  });

  it('without a snapshot the switch does nothing', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    expect(editor.cycleSnapshots()).toBeNull();
  });

  it('a switch is one undo step that goes back to the stop it left', () => {
    const { editor, a, b } = snapshotAndCurrent();
    editor.cycleSnapshots(); // current -> A
    expect(sound(editor.patch)).toBe(sound(a));
    editor.undo();
    expect(editor.snaps.shown).toBeNull();
    expect(sound(editor.patch)).toBe(sound(b));
    expect(editor.patch.name).toBe('current');
    editor.redo();
    expect(editor.snaps.shown).toBe('A');
    expect(sound(editor.patch)).toBe(sound(a));
    expect(sound(editor.currentPatch())).toBe(sound(b));
  });

  it('a switch during a REC pass ends the pass first: one undo step for the pass, one for the switch', () => {
    const { editor, a, b } = snapshotAndCurrent();
    const id = steps(editor.patch).id;
    editor.recorded([{ id, loop: 0, note: { at: 3, len: 1, note: 60, vel: 100 } }]);
    const recorded = sound(editor.patch);
    editor.cycleSnapshots(); // the current patch (with the pass) -> A
    expect(sound(editor.patch)).toBe(sound(a));
    editor.undo(); // the switch
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual([null, recorded]);
    editor.undo(); // the pass
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual([null, sound(b)]);
  });

  it('an edit while a snapshot plays changes neither it nor the current patch: switching away keeps it as a new snapshot', () => {
    const { editor, a, b } = snapshotAndCurrent();
    editor.cycleSnapshots(); // on A
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    expect(editor.shownEdited()).toBe(true);
    const edited = sound(editor.patch);
    const r = editor.cycleSnapshots(); // the current patch
    expect(r?.kept?.letter).toBe('B');
    expect(sound(editor.patch)).toBe(sound(b));
    expect(sound(JSON.parse(editor.snaps.get('A')!.patch) as Patch)).toBe(sound(a));
    expect(sound(JSON.parse(editor.snaps.get('B')!.patch) as Patch)).toBe(edited);
    editor.cycleSnapshots(); // A, as taken
    expect(sound(editor.patch)).toBe(sound(a));
    editor.cycleSnapshots(); // B: the edit
    expect(sound(editor.patch)).toBe(edited);
  });

  it('an edit taken back before switching away keeps nothing new', () => {
    const { editor, a } = snapshotAndCurrent();
    editor.cycleSnapshots(); // on A
    const before = steps(editor.patch).notes;
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    steps(editor.patch).notes = before;
    expect(editor.cycleSnapshots()).toEqual({});
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['A']);
    expect(sound(JSON.parse(editor.snaps.get('A')!.patch) as Patch)).toBe(sound(a));
  });

  it('make it the current patch: the snapshot is the current patch, the patch it replaces is kept', () => {
    const { editor, a, b } = snapshotAndCurrent();
    const kept = editor.makeCurrent('A');
    expect(kept?.letter).toBe('B');
    expect(editor.snaps.shown).toBeNull();
    expect(sound(editor.patch)).toBe(sound(a));
    expect(sound(editor.currentPatch())).toBe(sound(a));
    expect(sound(JSON.parse(editor.snaps.get('B')!.patch) as Patch)).toBe(sound(b));
  });

  it('removing the snapshot on screen brings the current patch back; an undo never drops the current patch', () => {
    const { editor, b } = snapshotAndCurrent();
    editor.takeSnapshot(); // B = the current patch
    steps(editor.patch).notes = [{ at: 2, len: 1, note: 52, vel: 80 }];
    const current = sound(editor.patch);
    editor.cycleSnapshots(); // A
    editor.cycleSnapshots(); // B
    editor.removeSnapshot('A');
    expect(editor.snaps.shown).toBe('B');
    editor.undo(); // B -> the step that was A's: now one of the current patch
    editor.undo();
    const kept = editor.snaps.list.map((s) => sound(JSON.parse(s.patch) as Patch));
    expect([...kept, sound(editor.patch)]).toContain(current);
    expect(kept).toContain(sound(b));

    editor.removeSnapshot('B');
    expect(editor.snaps.get('B')).toBeUndefined();
  });

  it('a snapshot is removed after the current patch comes back, with the edits made on it kept', () => {
    const { editor, b } = snapshotAndCurrent();
    editor.cycleSnapshots(); // on A
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    const edited = sound(editor.patch);
    editor.removeSnapshot('A');
    expect(editor.snaps.shown).toBeNull();
    expect(sound(editor.patch)).toBe(sound(b));
    expect(editor.snaps.list.map((s) => [s.letter, sound(JSON.parse(s.patch) as Patch)])).toEqual([['B', edited]]);
  });

  it('opening another patch forgets the snapshots', () => {
    const { editor } = snapshotAndCurrent();
    editor.setPatch(relocatedPatches['Oracle V']());
    expect(editor.snaps.list).toEqual([]);
    expect(editor.snaps.shown).toBeNull();
  });

  it('a run of Mutates keeps the patch before it as one snapshot; an edit between starts a new run', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    const m = editor.patch.modules.find((x) => !MUTATE_SKIP[x.type] && DEFS[x.type].params.some((d) => d.max > d.min && !d.fixed && !d.screen && !d.onScreen))!;
    const scope = { modules: [m.id], assemblies: [] };
    const before = sound(editor.patch);
    expect(editor.mutate('mutate', scope)).toBeGreaterThan(0);
    expect(editor.snaps.list.map((s) => [s.letter, s.name])).toEqual([['A', 'before mutate']]);
    expect(sound(JSON.parse(editor.snaps.get('A')!.patch) as Patch)).toBe(before);
    editor.mutate('mutate', scope);
    editor.mutate('randomize', scope);
    expect(editor.snaps.list).toHaveLength(1);   // (the same run)
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];   // another edit: a new run
    const edited = sound(editor.patch);
    editor.mutate('mutate', scope);
    expect(editor.snaps.list).toHaveLength(2);
    expect(sound(JSON.parse(editor.snaps.get('B')!.patch) as Patch)).toBe(edited);
  });

  it('Mutate on a snapshot keeps no copy of it: the snapshot is the original', () => {
    const { editor } = snapshotAndCurrent();
    const m = editor.patch.modules.find((x) => !MUTATE_SKIP[x.type] && DEFS[x.type].params.some((d) => d.max > d.min && !d.fixed && !d.screen && !d.onScreen))!;
    editor.cycleSnapshots(); // on A
    editor.mutate('mutate', { modules: [m.id], assemblies: [] });
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['A']);
  });
});

describe('rank and cut (#996)', () => {
  const patchOf = (e: Editor, letter: string): string => sound(JSON.parse(e.snaps.get(letter)!.patch) as Patch);

  it('Make candidates: N mutations of the patch on screen, one undo step, the first shown', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    const current = sound(editor.patch);
    const made = editor.makeCandidates(4);
    expect(made.map((s) => [s.letter, s.from])).toEqual([['A', 'current'], ['B', 'current'], ['C', 'current'], ['D', 'current']]);
    for (const s of made) expect(patchOf(editor, s.letter)).not.toBe(current);
    expect(editor.snaps.shown).toBe('A');
    expect(sound(editor.currentPatch())).toBe(current);
    editor.undo(); // the switch to A
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual([null, current]);
    editor.undo(); // the candidates
    expect(editor.snaps.list).toEqual([]);
    editor.redo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['A', 'B', 'C', 'D']);
    editor.redo();
    expect(editor.snaps.shown).toBe('A');
    // from a snapshot: its candidates say so
    expect(editor.makeCandidates(2).map((s) => [s.letter, s.from])).toEqual([['E', 'A'], ['F', 'A']]);
  });

  it('locks hold: with every card locked there is nothing to make', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    for (const m of editor.patch.modules) m.mutateLockAll = true;
    expect(editor.makeCandidates(4)).toEqual([]);
    expect(editor.snaps.list).toEqual([]);
  });

  it('Alt+K / Alt+X mark the snapshot on screen and go on; the same mark again takes it off; the current patch is never marked', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(3); // on A
    expect(editor.markShown('keep')).toEqual({ letter: 'A', mark: 'keep' });
    expect(editor.snaps.shown).toBe('B');
    expect(editor.markShown('cut')).toEqual({ letter: 'B', mark: 'cut' });
    expect(editor.snaps.shown).toBe('C');
    editor.cycleSnapshots(); // the current patch
    expect(editor.markShown('cut')).toBeNull();
    editor.showSnapshot('B');
    expect(editor.markShown('cut')).toEqual({ letter: 'B', mark: null });
    expect(editor.snaps.shown).toBe('B');
  });

  it('Cut the losers: hand-taken and made candidates alike, one undo step; the current patch comes back when the shown one goes', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    const current = sound(editor.patch);
    editor.takeSnapshot(); // A, by hand
    editor.makeCandidates(2); // B, C; on B
    editor.setMark('A', 'cut');
    editor.setMark('B', 'cut');
    editor.setMark('C', 'keep');
    const b = sound(editor.patch);
    expect(editor.cutLosers().map((s) => s.letter)).toEqual(['A', 'B']);
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['C']);
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual([null, current]);
    editor.undo();
    expect(editor.snaps.list.map((s) => [s.letter, s.mark])).toEqual([['A', 'cut'], ['B', 'cut'], ['C', 'keep']]);
    expect([editor.snaps.shown, sound(editor.patch), sound(editor.currentPatch())]).toEqual(['B', b, current]);
    editor.redo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['C']);
    expect(editor.snaps.shown).toBeNull();
    // the next round from the survivor: new letters, never the cut ones
    editor.showSnapshot('C');
    expect(editor.makeCandidates(2).map((s) => [s.letter, s.from])).toEqual([['D', 'C'], ['E', 'C']]);
  });

  it('cutting the snapshot on screen with changes on it keeps the changes as a new snapshot', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(2); // on A
    editor.setMark('A', 'cut');
    editor.patch.modules.find((x) => x.type === 'steps')!.notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    const edited = sound(editor.patch);
    editor.cutLosers();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['B', 'C']);
    expect(patchOf(editor, 'C')).toBe(edited);
    editor.undo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['A', 'B']);
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual(['A', edited]);
  });
});
