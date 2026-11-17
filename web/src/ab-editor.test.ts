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
import { snapshotKey, snapshotRecord, storedSnapshots } from './snapshots';

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
    onSilence(p) { log.push('silence'); engine.load(p, false, true); },   // (main.ts: host.silence, both engines)
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

describe('candidates in the editor (#943, #1048)', () => {
  /** candidate B is Oracle V; the current patch, A, moves a parameter, a Steps note and an attenuverter */
  function snapshotAndCurrent(structural = false) {
    const r = rig(relocatedPatches['Oracle V']());
    const { editor } = r;
    expect(editor.takeSnapshot().letter).toBe('B');   // (A is the current patch's)
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

  it('one candidate compares with the current patch: values only switch in place in both engines', () => {
    const { editor, engine, fm1, log, a, b } = snapshotAndCurrent();
    // the canvas is moved before the switch: it stays moved
    editor.patch.modules[0].x += 200;
    const moved = layout(editor.patch);
    log.length = 0;
    expect(editor.cycleSnapshots()).toEqual({});
    expect(editor.snaps.shown).toBe('B');
    expect(log).not.toContain('structure');
    expect(log).toContain('track');
    expect(sound(editor.patch)).toBe(sound(a));
    expect(sound(fm1())).toBe(sound(a));
    expect(listen(engine)).toEqual(listen(fresh(a)));
    expect(layout(editor.patch)).toEqual(moved);
    expect(editor.patch.name).toBe(a.name);
    expect(sound(editor.currentPatch())).toBe(sound(b));   // (what the autosave keeps while B plays)

    editor.cycleSnapshots();
    expect(editor.snaps.shown).toBeNull();
    expect(sound(editor.patch)).toBe(sound(b));
    expect(sound(fm1())).toBe(sound(b));
    expect(editor.patch.name).toBe('current');
    expect(layout(editor.patch)).toEqual(moved);
  });

  it('a switch silences first: a reverb tail is zero right after it, while an edit lets it ring', () => {
    const r = rig(relocatedPatches['Canvas']());
    const { editor, engine, log } = r;
    expect(editor.patch.modules.some((m) => m.type === 'reverb')).toBe(true);
    editor.takeSnapshot();
    const m = editor.patch.modules.find((x) => x.type === 'osc')!;
    m.params.fine = (m.params.fine ?? 0) + 0.1;   // (values only: before, this switch played on in place)
    const [l, rr] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const level = (): number => {
      engine.render(l, rr);
      return Math.max(...l.map(Math.abs), ...rr.map(Math.abs));
    };
    /** a note held half a second, then let go for a tenth: the reverb rings */
    const ring = (): void => {
      engine.noteOn(60, 0.8);
      for (let i = 0; i < 0.5 * SR / BLOCK; i++) level();
      engine.noteOff(60);
      for (let i = 0; i < 0.1 * SR / BLOCK; i++) level();
    };
    ring();
    expect(level()).toBeGreaterThan(1e-3);
    log.length = 0;
    editor.cycleSnapshots();
    expect(log[0]).toBe('silence');
    expect(log).not.toContain('structure');
    for (let i = 0; i < 4; i++) expect(level()).toBe(0);
    // Mutate is an edit, not a switch: no silence, the tail goes on
    ring();
    log.length = 0;
    editor.selectAll();
    editor.mutate('mutate');
    expect(log).not.toContain('silence');
    // the other ways to switch silence too: Alt+X (remove and go on), Alt+C (make it the current patch)
    if (editor.snaps.shown === null) editor.cycleSnapshots();
    log.length = 0;
    expect(editor.removeShown()).not.toBeNull();
    expect(log[0]).toBe('silence');
    editor.takeSnapshot();
    if (editor.snaps.shown === null) editor.cycleSnapshots();
    log.length = 0;
    editor.makeCurrent(editor.snaps.shown!);
    expect(log[0]).toBe('silence');
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

  it('A is the current patch and the first stop: letters go on from B in the order taken, and the switch goes from A through each and back (#1048)', () => {
    const { editor, m, pd } = snapshotAndCurrent();
    const values: number[] = [];
    const value = (): number => editor.patch.modules.find((x) => x.id === m.id)!.params[pd.name];
    values.push(value());   // (the current patch, as C is taken)
    expect(editor.takeSnapshot().letter).toBe('C');
    expect(editor.snaps.stops()).toEqual([null, 'B', 'C']);
    expect(editor.snaps.get('A')).toBeUndefined();   // (no stored candidate is ever A)
    editor.patch.modules.find((x) => x.id === m.id)!.params[pd.name] = (pd.min + pd.max) / 2;
    const stops: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      editor.cycleSnapshots();
      stops.push(editor.snaps.shown);
    }
    expect(stops).toEqual(['B', 'C', null, 'B']);
    editor.cycleSnapshots(); // C
    expect(value()).toBe(values[0]);
    editor.cycleSnapshots(); // A, the current patch, with its latest edit
    expect(value()).toBe((pd.min + pd.max) / 2);
    expect(editor.cycleSnapshots(-1)).not.toBeNull();   // (back wraps from A to the last)
    expect(editor.snaps.shown).toBe('C');
  });

  it('without a snapshot the switch does nothing', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    expect(editor.cycleSnapshots()).toBeNull();
  });

  it('a switch is one undo step that goes back to the stop it left', () => {
    const { editor, a, b } = snapshotAndCurrent();
    editor.cycleSnapshots(); // A -> B
    expect(sound(editor.patch)).toBe(sound(a));
    editor.undo();
    expect(editor.snaps.shown).toBeNull();
    expect(sound(editor.patch)).toBe(sound(b));
    expect(editor.patch.name).toBe('current');
    editor.redo();
    expect(editor.snaps.shown).toBe('B');
    expect(sound(editor.patch)).toBe(sound(a));
    expect(sound(editor.currentPatch())).toBe(sound(b));
  });

  it('a switch during a REC pass ends the pass first: one undo step for the pass, one for the switch', () => {
    const { editor, a, b } = snapshotAndCurrent();
    const id = steps(editor.patch).id;
    editor.recorded([{ id, loop: 0, note: { at: 3, len: 1, note: 60, vel: 100 } }]);
    const recorded = sound(editor.patch);
    editor.cycleSnapshots(); // the current patch (with the pass) -> B
    expect(sound(editor.patch)).toBe(sound(a));
    editor.undo(); // the switch
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual([null, recorded]);
    editor.undo(); // the pass
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual([null, sound(b)]);
  });

  it('an edit while a candidate plays changes neither it nor the current patch: switching away keeps it as a new candidate', () => {
    const { editor, a, b } = snapshotAndCurrent();
    editor.cycleSnapshots(); // on B
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    expect(editor.shownEdited()).toBe(true);
    const edited = sound(editor.patch);
    const r = editor.cycleSnapshots(); // the current patch
    expect(r?.kept?.letter).toBe('C');
    expect(sound(editor.patch)).toBe(sound(b));
    expect(sound(JSON.parse(editor.snaps.get('B')!.patch) as Patch)).toBe(sound(a));
    expect(sound(JSON.parse(editor.snaps.get('C')!.patch) as Patch)).toBe(edited);
    editor.cycleSnapshots(); // B, as taken
    expect(sound(editor.patch)).toBe(sound(a));
    editor.cycleSnapshots(); // C: the edit
    expect(sound(editor.patch)).toBe(edited);
  });

  it('an edit taken back before switching away keeps nothing new', () => {
    const { editor, a } = snapshotAndCurrent();
    editor.cycleSnapshots(); // on B
    const before = steps(editor.patch).notes;
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    steps(editor.patch).notes = before;
    expect(editor.cycleSnapshots()).toEqual({});
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['B']);
    expect(sound(JSON.parse(editor.snaps.get('B')!.patch) as Patch)).toBe(sound(a));
  });

  it('Use swaps: the candidate becomes A, the current patch, and the patch it replaces takes its place with a new letter; one undo step (#1040, #1048)', () => {
    const { editor, a } = snapshotAndCurrent();
    editor.takeSnapshot(); // C, then D, each another version than the current patch
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    editor.takeSnapshot();
    steps(editor.patch).notes = [{ at: 2, len: 1, note: 52, vel: 80 }];
    const b = sound(editor.patch);
    editor.moveSnapshot('B', 1);   // C, B, D
    const kept = editor.makeCurrent('B');
    expect([kept?.letter, kept?.from]).toEqual(['E', 'use']);
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['C', 'E', 'D']);   // (B is gone: it is A now; E is where B was)
    expect([editor.snaps.shown, editor.snaps.stops()]).toEqual([null, [null, 'C', 'E', 'D']]);
    expect([sound(editor.patch), sound(editor.currentPatch())]).toEqual([sound(a), sound(a)]);
    expect(sound(JSON.parse(editor.snaps.get('E')!.patch) as Patch)).toBe(b);
    editor.undo();
    expect([editor.snaps.list.map((s) => s.letter), editor.snaps.shown, sound(editor.patch)]).toEqual([['C', 'B', 'D'], null, b]);
    editor.redo();
    expect([editor.snaps.list.map((s) => s.letter), sound(editor.patch)]).toEqual([['C', 'E', 'D'], sound(a)]);
    // from the candidate on screen, the same version as the current patch: nothing is added
    editor.takeSnapshot(); // F = the current patch
    editor.showSnapshot('F');
    expect(editor.makeCurrent('F')).toBeNull();
    expect([editor.snaps.list.map((s) => s.letter), editor.snaps.shown]).toEqual([['C', 'E', 'D'], null]);
  });

  it('removing the candidate on screen brings the current patch back; an undo never drops the current patch', () => {
    const { editor, b } = snapshotAndCurrent();
    editor.takeSnapshot(); // C = the current patch
    steps(editor.patch).notes = [{ at: 2, len: 1, note: 52, vel: 80 }];
    const current = sound(editor.patch);
    editor.cycleSnapshots(); // B
    editor.cycleSnapshots(); // C
    editor.removeSnapshot('B');
    expect(editor.snaps.shown).toBe('C');
    editor.undo(); // C -> the step that was B's: now one of the current patch
    editor.undo();
    const kept = editor.snaps.list.map((s) => sound(JSON.parse(s.patch) as Patch));
    expect([...kept, sound(editor.patch)]).toContain(current);
    expect(kept).toContain(sound(b));

    editor.removeSnapshot('C');
    expect(editor.snaps.get('C')).toBeUndefined();
  });

  it('a candidate is removed after the current patch comes back, with the edits made on it kept', () => {
    const { editor, b } = snapshotAndCurrent();
    editor.cycleSnapshots(); // on B
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    const edited = sound(editor.patch);
    editor.removeSnapshot('B');
    expect(editor.snaps.shown).toBeNull();
    expect(sound(editor.patch)).toBe(sound(b));
    expect(editor.snaps.list.map((s) => [s.letter, sound(JSON.parse(s.patch) as Patch)])).toEqual([['C', edited]]);
  });

  it('opening another patch forgets the candidates', () => {
    const { editor } = snapshotAndCurrent();
    editor.setPatch(relocatedPatches['Oracle V']());
    expect(editor.snaps.list).toEqual([]);
    expect(editor.snaps.shown).toBeNull();
  });

  it('a run of Mutates keeps the patch before it as one candidate, "before mutate"; an edit between starts a new run', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    const m = editor.patch.modules.find((x) => !MUTATE_SKIP[x.type] && DEFS[x.type].params.some((d) => d.max > d.min && !d.fixed && !d.screen && !d.onScreen))!;
    const scope = { modules: [m.id], assemblies: [] };
    const before = sound(editor.patch);
    expect(editor.mutate('mutate', scope)).toBeGreaterThan(0);
    expect(editor.snaps.list.map((s) => [s.letter, s.name, s.from])).toEqual([['B', 'before mutate', 'mutate']]);
    expect(sound(JSON.parse(editor.snaps.get('B')!.patch) as Patch)).toBe(before);
    editor.mutate('mutate', scope);
    editor.mutate('randomize', scope);
    expect(editor.snaps.list).toHaveLength(1);   // (the same run)
    steps(editor.patch).notes = [{ at: 1, len: 1, note: 50, vel: 90 }];   // another edit: a new run
    const edited = sound(editor.patch);
    editor.mutate('mutate', scope);
    expect(editor.snaps.list).toHaveLength(2);
    expect(sound(JSON.parse(editor.snaps.get('C')!.patch) as Patch)).toBe(edited);
  });

  it('Mutate on a candidate keeps no copy of it: the candidate is the original', () => {
    const { editor } = snapshotAndCurrent();
    const m = editor.patch.modules.find((x) => !MUTATE_SKIP[x.type] && DEFS[x.type].params.some((d) => d.max > d.min && !d.fixed && !d.screen && !d.onScreen))!;
    editor.cycleSnapshots(); // on B
    editor.mutate('mutate', { modules: [m.id], assemblies: [] });
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['B']);
  });
});

describe('rank and cut (#996)', () => {
  const patchOf = (e: Editor, letter: string): string => sound(JSON.parse(e.snaps.get(letter)!.patch) as Patch);

  it('Generate: N mutations of the patch on screen, from B on, one undo step, the first shown', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    const current = sound(editor.patch);
    const made = editor.makeCandidates(4);
    expect(made.map((s) => [s.letter, s.from])).toEqual([['B', 'A'], ['C', 'A'], ['D', 'A'], ['E', 'A']]);   // (from A, the current patch)
    for (const s of made) expect(patchOf(editor, s.letter)).not.toBe(current);
    expect(editor.snaps.shown).toBe('B');
    expect(sound(editor.currentPatch())).toBe(current);
    editor.undo(); // the switch to B
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual([null, current]);
    editor.undo(); // the candidates
    expect(editor.snaps.list).toEqual([]);
    editor.redo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['B', 'C', 'D', 'E']);
    editor.redo();
    expect(editor.snaps.shown).toBe('B');
    // from a candidate: its candidates say so
    expect(editor.makeCandidates(2).map((s) => [s.letter, s.from])).toEqual([['F', 'B'], ['G', 'B']]);
  });

  it('with two or more kept, Generate breeds from them and says so', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(3); // B, C, D
    editor.setKeep('B', true);
    expect(editor.makeCandidates(1).map((s) => s.from)).toEqual(['B']);   // (one keep: a Mutate of the candidate on screen)
    editor.setKeep('D', true);
    expect(editor.makeCandidates(2).map((s) => [s.letter, s.from])).toEqual([['F', 'B+D'], ['G', 'B+D']]);
  });

  it('locks hold: with every card locked there is nothing to make', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    for (const m of editor.patch.modules) m.mutateLockAll = true;
    expect(editor.makeCandidates(4)).toEqual([]);
    expect(editor.snaps.list).toEqual([]);
  });

  /** a candidate key pressed (snapshots.ts snapshotKey), run as main.ts runs it */
  const press = (editor: Editor, code: string): unknown => {
    const k = snapshotKey({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, code, key: '' });
    return k === 'next' ? editor.cycleSnapshots(1) : k === 'previous' ? editor.cycleSnapshots(-1) : k === 'remove' ? editor.removeShown() : null;
  };
  /** the stop on screen after each of `n` presses */
  const stops = (editor: Editor, code: string, n: number): (string | null)[] => Array.from({ length: n }, () => (press(editor, code), editor.snaps.shown));

  it('going through the candidates never stops at A: Alt+J and Alt+K go round both ways through A, Alt+X removes and goes on (#1028, #1048)', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    const current = sound(editor.patch);
    editor.makeCandidates(3); // B, C, D; on B
    expect(stops(editor, 'KeyJ', 8)).toEqual(['C', 'D', null, 'B', 'C', 'D', null, 'B']);
    expect(stops(editor, 'KeyK', 5)).toEqual([null, 'D', 'C', 'B', null]);
    expect(stops(editor, 'KeyJ', 2)).toEqual(['B', 'C']);
    expect(press(editor, 'KeyX')).toEqual({ removed: expect.objectContaining({ letter: 'C' }) });
    expect(editor.snaps.shown).toBe('D');
    press(editor, 'KeyX'); // D goes: the next stop is A, the current patch
    expect([editor.snaps.list.map((s) => s.letter), editor.snaps.shown, sound(editor.patch)]).toEqual([['B'], null, current]);
    expect(press(editor, 'KeyX')).toBeNull();   // (A, the current patch, is never removed)
    expect(stops(editor, 'KeyJ', 3)).toEqual(['B', null, 'B']);
    expect(stops(editor, 'KeyK', 2)).toEqual([null, 'B']);
  });

  it('Alt+X is one undo step; changes made to the candidate on screen are kept as a new candidate first', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    const current = sound(editor.patch);
    editor.takeSnapshot(); // B, nominated
    editor.makeCandidates(2); // C, D; on C
    editor.patch.modules.find((x) => x.type === 'steps')!.notes = [{ at: 1, len: 1, note: 50, vel: 90 }];
    const edited = sound(editor.patch);
    expect(editor.removeShown()).toEqual({ removed: expect.objectContaining({ letter: 'C' }), kept: expect.objectContaining({ letter: 'E' }) });
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['B', 'D', 'E']);
    expect(patchOf(editor, 'E')).toBe(edited);
    expect([editor.snaps.shown, sound(editor.patch), sound(editor.currentPatch())]).toEqual(['D', patchOf(editor, 'D'), current]);
    editor.undo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['B', 'C', 'D']);
    expect([editor.snaps.shown, sound(editor.patch), sound(editor.currentPatch())]).toEqual(['C', edited, current]);
    editor.redo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['B', 'D', 'E']);
    expect([editor.snaps.shown, sound(editor.patch)]).toEqual(['D', patchOf(editor, 'D')]);
    // the next round from a survivor: new letters, never a removed one's
    expect(editor.makeCandidates(1).map((s) => [s.letter, s.from])).toEqual([['F', 'D']]);
  });

  it('the keep mark: set and taken off from the row, its menu or the palette, kept with the candidate', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(2); // on B
    editor.setKeep('C', true);
    expect(editor.snaps.list.map((s) => s.mark)).toEqual([undefined, 'keep']);
    editor.setKeep('C', false);
    expect(editor.snaps.list.map((s) => s.mark)).toEqual([undefined, undefined]);
    expect(editor.snaps.shown).toBe('B');
  });

  it('a drag puts a candidate elsewhere in the list: the keys follow the new order, letters stay, A stays first, one undo step (#1040)', () => {
    const { editor, log } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(4); // B, C, D, E; on B
    expect(editor.moveSnapshot('E', 0)).toBe(true);
    expect(editor.moveSnapshot('B', 2)).toBe(true);
    expect(editor.moveSnapshot('B', 2)).toBe(false);   // (already there)
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['E', 'C', 'B', 'D']);
    expect(editor.snaps.shown).toBe('B');   // (a drag never switches)
    expect(editor.moveSnapshot('D', 99)).toBe(false);   // (past the end is the last place: D is there already)
    // the order is kept with the candidates, so a reload brings it back
    const text = JSON.stringify(editor.currentPatch());
    expect(storedSnapshots(snapshotRecord(text, editor.snaps.list), text).map((s) => s.letter)).toEqual(['E', 'C', 'B', 'D']);
    // undo puts the order back one drag at a time and loads nothing again
    const loads = log.filter((x) => x === 'structure').length;
    editor.undo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['E', 'B', 'C', 'D']);
    editor.undo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['B', 'C', 'D', 'E']);
    editor.redo();
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['E', 'B', 'C', 'D']);
    expect([editor.snaps.shown, log.filter((x) => x === 'structure').length]).toEqual(['B', loads]);
    // the keys go from A down the list, then A (always the first stop) again
    expect(stops(editor, 'KeyJ', 5)).toEqual(['C', 'D', null, 'E', 'B']);
    expect(stops(editor, 'KeyK', 5)).toEqual(['E', null, 'D', 'C', 'B']);
    expect(editor.takeSnapshot().letter).toBe('F');   // (a new one goes to the end, with the next letter)
    expect(editor.snaps.list.map((s) => s.letter)).toEqual(['E', 'B', 'C', 'D', 'F']);
  });
});
