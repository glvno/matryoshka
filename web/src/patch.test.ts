// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, ensureMain, newPatch, NOTES_MAX, validatePatch, type Patch } from './patch';
import { encodePatch } from './patchbin';

describe('the Main module', () => {
  it('is added to a patch that has none, once, without touching the rest', () => {
    const p: Patch = { version: 2, name: 'no main', modules: [], cables: [] };
    const out = addModule(p, DEFS.output, 0, 0);
    expect(ensureMain(p, DEFS)).toBe(true);
    expect(ensureMain(p, DEFS)).toBe(false);
    expect(p.modules.map((m) => m.type)).toEqual(['output', 'fm1']);
    expect(p.modules[1].id).not.toBe(out.id);
  });

  it('a new patch already has one', () => {
    expect(ensureMain(newPatch(DEFS), DEFS)).toBe(false);
  });
});

describe('the keyboard octave a patch remembers', () => {
  const load = (octave: unknown): number | undefined => validatePatch({ ...newPatch(DEFS), octave }, DEFS).octave;
  it('keeps a whole octave in range, drops 0 (the default) and anything else', () => {
    expect(load(-2)).toBe(-2);
    expect(load(3)).toBe(3);
    for (const bad of [0, 4, -4, 1.5, '1', null, undefined]) expect(load(bad)).toBeUndefined();
  });
});

describe('the notes a patch carries (the share sheet\'s "What\'s going on")', () => {
  const load = (notes: unknown): Patch['notes'] => validatePatch({ ...newPatch(DEFS), notes }, DEFS).notes;
  it('keeps a string, cuts a long one to NOTES_MAX, drops a blank or a non-string', () => {
    expect(load('Play anything in C.')).toBe('Play anything in C.');
    expect(load('x'.repeat(NOTES_MAX + 80))).toHaveLength(NOTES_MAX);
    for (const bad of [undefined, null, 3, { text: 'x' }, ['a'], '', '   ']) expect(load(bad)).toBeUndefined();
  });
  it('leaves the binary format alone', () => {
    const p = newPatch(DEFS);
    expect(encodePatch({ ...p, notes: 'a long story '.repeat(30) })).toEqual(encodePatch(p));
  });
});

describe('the canvas view a patch remembers', () => {
  const load = (view: unknown): Patch['view'] => validatePatch({ ...newPatch(DEFS), view }, DEFS).view;
  it('keeps a zoom and a scroll position, clamps the scroll at the origin, drops anything malformed', () => {
    expect(load({ zoom: 0.6, x: 1200, y: 40 })).toEqual({ zoom: 0.6, x: 1200, y: 40 });
    expect(load({ zoom: 1, x: -5, y: 3 })).toEqual({ zoom: 1, x: 0, y: 3 });
    for (const bad of [null, 3, { zoom: 0, x: 0, y: 0 }, { zoom: 1, x: 'a', y: 0 }, { zoom: Infinity, x: 0, y: 0 }, { x: 0, y: 0 }]) expect(load(bad)).toBeUndefined();
  });
});
