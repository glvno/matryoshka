// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Candidates through the editor (#943, the switching rules of #103, owner 2026-11-24): every candidate is alike and the one
// heard is the current patch. A switch plays the other version in the browser engine and the FM-1 (Live), keeps the
// canvas layout, takes no undo step and makes nothing; an edit goes into the candidate heard at once; each candidate has its
// own undo, a hidden original that revert brings back, and a place in Recently deleted; opening a patch follows the open
// rules, so a set comes back with its patch (D-970, D-972, D-1425).
import { describe, expect, it, vi } from 'vitest';
import { BLOCK, Engine } from './engine';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { MUTATE_SKIP } from './mutate';
import type { ModuleInst, Patch } from './patch';
import { encodePatch } from './patchbin';
import { relocatedPatches } from './community-factory';
import { CANDIDATE_LIMIT, snapshotKey } from './snapshots';
import { CandidateStore, memoryBackend } from './candidate-store';

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

/** an editor on a fresh canvas, with the browser engine and a model of the FM-1 fed from its events as main.ts feeds them;
 *  the candidates put away go to `store` (main.ts keepSet) */
function rig(start: Patch, store = new CandidateStore(memoryBackend(), (p) => p as Patch)) {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
  const engine = new Engine(SR);
  let fm1 = copy(start);
  const log: string[] = [];
  const said: string[] = [];
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
    onPutAway(set) { store.save(set); },
    onLoad() { log.push('load'); },
    onTransport() {},
    onLayout() { log.push('layout'); },
    onError(m) { said.push(m); },
    onSaveAssembly() {},
  };
  const editor = new Editor(document.getElementById('canvas')!, copy(start), ev);
  engine.load(editor.patch);
  const find = (p: Patch, except: string) => store.find(p, except);
  return { editor, engine, fm1: () => fm1, log, said, store, find };
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
const steps = (p: Patch): ModuleInst => p.modules.find((x) => x.type === 'steps')!;
const letters = (e: Editor): string[] => e.snaps.list.map((s) => s.letter);
/** a module a Mutate moves */
const movable = (p: Patch): ModuleInst => p.modules.find((x) => !MUTATE_SKIP[x.type] && DEFS[x.type].params.some((d) => d.max > d.min && !d.fixed && !d.screen && !d.onScreen))!;

describe('candidates in the editor (D-970, D-1425)', () => {
  /** A is Oracle V as opened; B, a Duplicate of it heard now, moves a parameter, a Steps note and an attenuverter */
  function twoCandidates(structural = false) {
    const r = rig(relocatedPatches['Oracle V']());
    const { editor } = r;
    const a = copy(editor.patch);
    expect(editor.duplicate()?.letter).toBe('B');
    expect(editor.snaps.current).toBe('B');
    const p = editor.patch;
    const m = p.modules.find((x) => x.type !== 'fm1' && DEFS[x.type].params.some((d) => d.max > d.min))!;
    const pd = DEFS[m.type].params.find((d) => d.max > d.min)!;
    m.params[pd.name] = (m.params[pd.name] ?? pd.default) === pd.max ? pd.min : pd.max;
    steps(p).notes = [{ at: 0, len: 2, note: 45, vel: 100 }];
    p.modules.find((x) => DEFS[x.type].paramInputs)!.att = [0.25, -0.5];
    if (structural) p.assemblies![0].label = 'changed';
    p.name = 'current';
    const b = copy(editor.patch);
    return { ...r, a, b, m, pd };
  }

  it('a switch to another candidate: values only switch in place in both engines, the layout stays, the edits stay with the one left', () => {
    const { editor, engine, fm1, log, a, b } = twoCandidates();
    editor.patch.modules[0].x += 200;   // (the canvas is moved before the switch: it stays moved)
    const moved = layout(editor.patch);
    log.length = 0;
    expect(editor.showSnapshot('A')).toBe(true);
    expect(editor.snaps.current).toBe('A');
    expect(log).not.toContain('structure');
    expect(log).toContain('track');
    expect([sound(editor.patch), sound(fm1())]).toEqual([sound(a), sound(a)]);
    expect(listen(engine)).toEqual(listen(fresh(a)));
    expect(layout(editor.patch)).toEqual(moved);
    expect(editor.patch.name).toBe(a.name);
    expect(sound(JSON.parse(editor.snaps.get('B')!.patch) as Patch)).toBe(sound(b));   // (B keeps its edits)
    expect(letters(editor)).toEqual(['A', 'B']);   // (nothing is made on leaving)
    editor.showSnapshot('B');
    expect([sound(editor.patch), sound(fm1()), editor.patch.name]).toEqual([sound(b), sound(b), 'current']);
    expect(layout(editor.patch)).toEqual(moved);
  });

  it('a switch silences first: a reverb tail is zero right after it, while an edit lets it ring; Duplicate is no switch', () => {
    const { editor, engine, log } = rig(relocatedPatches['Canvas']());
    expect(editor.patch.modules.some((m) => m.type === 'reverb')).toBe(true);
    editor.duplicate();
    const m = editor.patch.modules.find((x) => x.type === 'osc')!;
    m.params.fine = (m.params.fine ?? 0) + 0.1;   // (values only)
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
    // Mutate is an edit, not a switch: no silence
    ring();
    log.length = 0;
    editor.selectAll();
    editor.mutate('mutate');
    expect(log).not.toContain('silence');
    // deleting the one heard is a switch to the next: silenced
    log.length = 0;
    expect(editor.deleteSnapshot(editor.snaps.current)).not.toBeNull();
    expect(log[0]).toBe('silence');
    // Duplicate keeps the sound: nothing is silenced or sent
    log.length = 0;
    editor.duplicate();
    expect(log.filter((x) => x !== 'layout')).toEqual([]);
  });

  it('another overlay (an assembly label): a full load, the layout stays', () => {
    const { editor, fm1, log, a, b } = twoCandidates(true);
    log.length = 0;
    editor.cycleSnapshots();
    expect(log).toContain('structure');
    expect(sound(fm1())).toBe(sound(a));
    expect(editor.patch.assemblies![0].label).toBe(a.assemblies![0].label);
    editor.cycleSnapshots();
    expect(sound(fm1())).toBe(sound(b));
    expect(layout(editor.patch)).toEqual(layout(b));
  });

  it('every candidate is alike: letters in the order made, the switch goes round the list both ways, A can be deleted', () => {
    const { editor, said } = rig(relocatedPatches['Oracle V']());
    expect(editor.cycleSnapshots()).toBe(false);   // (one candidate: nowhere to go)
    editor.duplicate();   // B, under A
    editor.showSnapshot('A');
    editor.duplicate();   // C, under A
    expect(letters(editor)).toEqual(['A', 'C', 'B']);
    const stops: string[] = [];
    for (let i = 0; i < 4; i++) stops.push((editor.cycleSnapshots(), editor.snaps.current));
    expect(stops).toEqual(['B', 'A', 'C', 'B']);
    editor.cycleSnapshots(-1);
    expect(editor.snaps.current).toBe('C');
    expect(editor.deleteSnapshot('A')?.s.letter).toBe('A');
    expect(letters(editor)).toEqual(['C', 'B']);
    expect(editor.deleteSnapshot('C')).not.toBeNull();
    expect(editor.deleteSnapshot('B')).toBeNull();   // (the last one stays: one is always the current patch)
    expect(said).toEqual([]);
  });

  it('a switch is no undo step, and each candidate has its own undo', () => {
    const { editor, said, a, b } = twoCandidates();
    const out = editor.patch.modules.find((x) => x.type === 'output')!;
    editor.setParam(out.id, 'level', 0.33);   // (a step of B)
    const bEdited = sound(editor.patch);
    editor.showSnapshot('A');
    editor.undo();   // (A has no steps: the switch is not one, and B's are B's)
    expect(said.at(-1)).toBe('nothing to undo on A: each candidate has its own undo');
    expect(sound(editor.patch)).toBe(sound(a));
    editor.setParam(out.id, 'level', 0.77);   // (a step of A)
    const aEdited = sound(editor.patch);
    editor.showSnapshot('B');
    expect(sound(editor.patch)).toBe(bEdited);
    editor.undo();   // (B's last step comes back with B)
    expect(sound(editor.patch)).toBe(sound(b));
    editor.redo();
    expect(sound(editor.patch)).toBe(bEdited);
    editor.showSnapshot('A');
    expect(sound(editor.patch)).toBe(aEdited);
    editor.undo();
    expect(sound(editor.patch)).toBe(sound(a));
  });

  it('a switch during a REC pass ends the pass first: the pass is a step of the candidate left', () => {
    const { editor, said, b } = twoCandidates();
    editor.recorded([{ id: steps(editor.patch).id, loop: 0, note: { at: 3, len: 1, note: 60, vel: 100 } }]);
    const recorded = sound(editor.patch);
    editor.showSnapshot('A');
    editor.undo();
    expect(said.at(-1)).toMatch(/^nothing to undo on A/);
    editor.showSnapshot('B');
    expect(sound(editor.patch)).toBe(recorded);
    editor.undo();   // the pass
    expect(sound(editor.patch)).toBe(sound(b));
  });

  it('an edit goes into the candidate heard at once: "tweaked" against its original, and revert brings the original back as one undo step', () => {
    const { editor, a, b } = twoCandidates();
    const B = editor.snaps.get('B')!;
    expect([editor.tweaked(B), editor.tweaked(editor.snaps.get('A')!)]).toEqual([true, false]);
    expect(sound(JSON.parse(editor.exportSet().list[1].patch) as Patch)).toBe(sound(b));   // (saved with the set as heard)
    editor.patch.modules[0].x += 100;
    editor.showSnapshot('A');
    editor.patch.modules[0].y += 100;   // (moving a card is no tweak)
    expect(editor.tweaked(editor.snaps.get('A')!)).toBe(false);
    editor.showSnapshot('B');
    const moved = layout(editor.patch);
    expect(editor.revert()).toBe(true);
    expect(sound(editor.patch)).toBe(sound({ ...a, name: 'current' }));
    expect([editor.patch.name, layout(editor.patch), editor.tweaked(B)]).toEqual(['current', moved, false]);
    expect(editor.revert()).toBe(false);   // (as made already)
    editor.undo();
    expect(sound(editor.patch)).toBe(sound(b));
  });

  it('delete: the candidate heard hands over to the next, goes to Recently deleted, and comes back at its place', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(3);   // B, C, D; on B
    editor.showSnapshot('C');
    const heard = sound(editor.patch);
    const d = editor.deleteSnapshot('C')!;
    expect([d.s.letter, d.at, editor.snaps.current]).toEqual(['C', 2, 'D']);
    expect(sound(JSON.parse(d.s.patch) as Patch)).toBe(heard);
    editor.deleteSnapshot('D');   // (the last in the list: the one before is heard)
    expect(editor.snaps.current).toBe('B');
    expect(editor.snaps.deleted.map((x) => x.s.letter)).toEqual(['D', 'C']);
    expect(editor.putBack(1)?.letter).toBe('C');
    expect([letters(editor), editor.snaps.current]).toEqual([['A', 'B', 'C'], 'B']);   // (put back, not heard)
    expect(editor.makeCandidates(1)[0].letter).toBe('E');   // (letters are never given twice)
  });

  it('Mutate edits the candidate heard in place, one undo step of it, and keeps no copy (D-975)', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    const before = sound(editor.patch);
    expect(editor.mutate('mutate', { modules: [movable(editor.patch).id], assemblies: [] })).toBeGreaterThan(0);
    expect(letters(editor)).toEqual(['A']);
    expect(editor.tweaked(editor.snaps.shown)).toBe(true);
    editor.undo();
    expect(sound(editor.patch)).toBe(before);
  });

  it('a patch opened goes by the open rules: a candidate holding it, a stored set holding it, the set of its name, or a set of its own (D-972)', () => {
    const night = relocatedPatches['Oracle V']();
    const { editor, store, find } = rig(night);
    editor.makeCandidates(2);   // B, C; on B
    const c = copy(JSON.parse(editor.snaps.get('C')!.patch) as Patch);
    const nightSet = editor.snaps.id;
    // 1. a candidate of the open patch holds it: it is heard
    expect(editor.openPatch(copy(c), find)).toEqual({ how: 'switched', letter: 'C' });
    // 5. another patch: a set of its own, and the one open is put away
    const other = relocatedPatches['Canvas']();
    expect(editor.openPatch(other, find)).toEqual({ how: 'fresh', letter: 'A' });
    expect([letters(editor), store.get(nightSet)?.list.map((s) => s.letter), store.get(nightSet)?.current]).toEqual([['A'], ['A', 'B', 'C'], 'C']);
    // 2. a stored set holds it: that set comes back with that candidate heard
    expect(editor.openPatch(copy(night), find)).toEqual({ how: 'reopened', letter: 'A' });
    expect([editor.snaps.id, letters(editor), sound(editor.patch)]).toEqual([nightSet, ['A', 'B', 'C'], sound(night)]);
    // 3. its name, another version: it joins the open patch's candidates, heard
    const tweakedNight = copy(night);
    tweakedNight.modules.find((m) => m.type === 'output')!.params.level = 0.42;
    expect(editor.openPatch(tweakedNight, find)).toEqual({ how: 'added', letter: 'D' });
    expect(editor.snaps.get('D')?.from).toBe('opened');
    // 4. another patch's name, another version: it joins that stored set
    editor.openPatch(other, find);   // (Canvas's own set again: nothing stored for it, so a fresh one)
    const tweakedOther = copy(other);
    tweakedOther.modules.find((m) => m.type === 'output')!.params.level = 0.11;
    editor.openPatch(tweakedOther, find);   // (joins Canvas's set: B)
    editor.openPatch(copy(night), find);    // (back to the night set)
    const tweakedAgain = copy(other);
    tweakedAgain.modules.find((m) => m.type === 'output')!.params.level = 0.12;
    expect(editor.openPatch(tweakedAgain, find)).toEqual({ how: 'added', letter: 'C' });
    expect(editor.snaps.name).toBe(other.name);
    expect(store.get(nightSet)?.list.map((s) => s.letter)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('an open of the candidate heard, or of another of the open set, loads as every open does: home device, a whole upload; the set and undo kept (D-217, #496)', () => {
    const night = relocatedPatches['Oracle V']();
    const { editor, log, find } = rig(night);
    editor.makeCandidates(2);   // B, C; on B
    const b = copy(editor.patch);
    editor.mutate('mutate', { modules: [movable(editor.patch).id], assemblies: [] });   // (an undo step of B)
    const edited = copy(editor.patch);
    editor.focus = { device: 'm1', page: 0 };   // (Main in focus, as the FM-1 shows TEMPO)
    log.length = 0;
    expect(editor.openPatch(copy(edited), find)).toEqual({ how: 'switched', letter: 'B' });
    expect([log, editor.focus?.device, letters(editor), editor.snaps.current]).toEqual([['load', 'structure'], 'a2', ['A', 'B', 'C'], 'B']);   // (its own engine, not Main)
    editor.undo();   // (B's step kept)
    expect(sound(editor.patch)).toBe(sound(b));
    log.length = 0;
    expect(editor.openPatch(copy(JSON.parse(editor.snaps.get('C')!.patch) as Patch), find)).toEqual({ how: 'switched', letter: 'C' });
    expect([log, editor.snaps.current]).toEqual([['load', 'structure'], 'C']);
    // a palette switch (follow): the FM-1 already plays it, so it switches as the candidates' switch does
    log.length = 0;
    editor.focus = { device: 'm1', page: 0 };
    expect(editor.openPatch(copy(JSON.parse(editor.snaps.get('A')!.patch) as Patch), find, true)).toEqual({ how: 'switched', letter: 'A' });
    expect([log.includes('load'), editor.focus]).toEqual([false, { device: 'm1', page: 0 }]);
  });
});

describe('Generate and Breed (D-987)', () => {
  const patchOf = (e: Editor, letter: string): string => sound(JSON.parse(e.snaps.get(letter)!.patch) as Patch);

  it('Generate: N mutations of the one heard at the end, the first heard; no undo step', () => {
    const { editor, said } = rig(relocatedPatches['Oracle V']());
    const opened = sound(editor.patch);
    const made = editor.makeCandidates(4);
    expect(made.map((s) => [s.letter, s.from])).toEqual([['B', 'A'], ['C', 'A'], ['D', 'A'], ['E', 'A']]);
    for (const s of made) expect(patchOf(editor, s.letter)).not.toBe(opened);
    expect(editor.snaps.current).toBe('B');
    editor.undo();
    expect(said.at(-1)).toMatch(/^nothing to undo on B/);
    expect(editor.makeCandidates(2).map((s) => [s.letter, s.from])).toEqual([['F', 'B'], ['G', 'B']]);
  });

  it('picked parents: one is varied, two or more are bred, whatever is heard', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(3);   // B, C, D; on B
    expect(editor.makeCandidates(1, ['D']).map((s) => s.from)).toEqual(['D']);
    expect(editor.makeCandidates(2, ['B', 'D']).map((s) => [s.letter, s.from])).toEqual([['F', 'B+D'], ['G', 'B+D']]);
    expect(editor.makeCandidates(1, ['Z']).map((s) => s.from)).toEqual(['F']);   // (a pick that is gone: the one heard)
  });

  it('locks hold: with every card locked there is nothing to make', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    for (const m of editor.patch.modules) m.mutateLockAll = true;
    expect(editor.makeCandidates(4)).toEqual([]);
    expect(letters(editor)).toEqual(['A']);
  });

  it(`up to ${CANDIDATE_LIMIT}: Generate makes what fits, then asks to delete some; Duplicate too`, () => {
    const { editor, said } = rig(relocatedPatches['Oracle V']());
    while (editor.snaps.list.length < CANDIDATE_LIMIT - 2) editor.duplicate();
    expect(editor.makeCandidates(4)).toHaveLength(2);
    expect(editor.makeCandidates(4)).toEqual([]);
    expect(said.at(-1)).toBe(`Generate: ${CANDIDATE_LIMIT} candidates is the most for one patch, delete some first`);
    expect(editor.duplicate()).toBeNull();
    expect(editor.snaps.list).toHaveLength(CANDIDATE_LIMIT);
  });

  /** a candidate key pressed (snapshots.ts snapshotKey), run as main.ts runs it */
  const press = (editor: Editor, code: string, shiftKey = false): unknown => {
    const k = snapshotKey({ altKey: true, shiftKey, ctrlKey: false, metaKey: false, code, key: '' });
    return k === 'next' ? editor.cycleSnapshots(1) : k === 'previous' ? editor.cycleSnapshots(-1) : k === 'remove' ? editor.deleteSnapshot(editor.snaps.current) : k === 'duplicate' ? editor.duplicate() : null;
  };
  const stops = (editor: Editor, code: string, n: number): string[] => Array.from({ length: n }, () => (press(editor, code), editor.snaps.current));

  it('Alt+J and Alt+K go round the list both ways, Alt+X deletes the one heard and goes on, Shift+Alt+B duplicates (D-984)', () => {
    const { editor } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(3);   // B, C, D; on B
    expect(stops(editor, 'KeyJ', 5)).toEqual(['C', 'D', 'A', 'B', 'C']);
    expect(stops(editor, 'KeyK', 3)).toEqual(['B', 'A', 'D']);
    press(editor, 'KeyX');   // D goes: the one before is heard (D was last)
    expect([letters(editor), editor.snaps.current]).toEqual([['A', 'B', 'C'], 'C']);
    press(editor, 'KeyB', true);
    expect([letters(editor), editor.snaps.current]).toEqual([['A', 'B', 'C', 'E'], 'E']);
  });

  it('a drag puts a candidate elsewhere in the list: the keys follow the new order, letters stay, nothing switches or loads (#1040)', () => {
    const { editor, log } = rig(relocatedPatches['Oracle V']());
    editor.makeCandidates(3);   // B, C, D; on B
    const loads = log.filter((x) => x === 'structure').length;
    expect(editor.moveSnapshot('D', 0)).toBe(true);
    expect(editor.moveSnapshot('A', 3)).toBe(true);
    expect(editor.moveSnapshot('A', 3)).toBe(false);   // (already there)
    expect(letters(editor)).toEqual(['D', 'B', 'C', 'A']);
    expect([editor.snaps.current, log.filter((x) => x === 'structure').length]).toEqual(['B', loads]);
    expect(editor.exportSet().list.map((s) => s.letter)).toEqual(['D', 'B', 'C', 'A']);   // (the order is kept with the set)
    expect(stops(editor, 'KeyJ', 3)).toEqual(['C', 'A', 'D']);
  });
});
