// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addBreak, addHeading, flatten, layoutOf, moveRows, moveSection, pagesOf, removeBreak, removeHeading, removeRows, rowKey, type KnobOf, type Layout } from './arrange';
import type { AssemblyDef, ParamRef } from './assembly';
import { FACTORY } from './assemblies';
import { DEFS } from './modules';
import { groupStarts } from './pages';
import { rowDef } from './patch';

/** rows of module 1, one per name; "*name" is a display, "#head name" opens a section, "|" before a name starts a column */
function rows(...names: string[]): ParamRef[] {
  return names.map((n) => {
    const r: ParamRef = { module: 1, param: '', label: '' };
    let s = n;
    if (s.startsWith('|')) { r.col = true; s = s.slice(1); }
    const m = /^#(.+) (.+)$/.exec(s);
    if (m) { r.head = m[1]; s = m[2]; }
    r.param = s;
    r.label = s;
    return r;
  });
}
const knob: KnobOf = (r) => !r.param.startsWith('*');
/** a layout as text: columns by " || ", sections "head: page / page" */
const show = (l: Layout): string => l.map((c) => c.secs.map((s) => `${s.head ?? '-'}: ${pagesOf(s, knob).map((pg) => pg.map((r) => r.param).join(' ')).join(' / ')}`).join(' ; ')).join(' || ');
const sec = (l: Layout, head: string) => l.flatMap((c) => c.secs).find((s) => s.head === head)!;
const roundTrip = (l: Layout): Layout => { const f = flatten(l); return layoutOf(f.params, f.heads); };

describe('arrange: the layout tree', () => {
  const defKnob = (d: AssemblyDef): KnobOf => (r) => {
    const m = d.modules.find((x) => x.id === r.module);
    const pd = m && rowDef(DEFS[m.type], r.param);
    return !pd || pd.onScreen ? null : !pd.screen;
  };

  it('every factory card (nested ones too) comes back unchanged, and its pages are the FM-1 groups', () => {
    for (const d of FACTORY) {
      for (const card of [d, ...(d.assemblies ?? [])]) {
        const l = layoutOf(card.params, card.heads);
        expect(flatten(l), `${d.name} / ${'label' in card ? card.label : ''}`).toEqual({ params: card.params, heads: [] });
        const k = defKnob(d);
        const drawn = card.params.filter((r) => k(r) !== null);
        const starts = groupStarts(drawn.map((r) => ({ ...r, knob: !!k(r) })));
        const firsts = new Set(l.flatMap((c) => c.secs.flatMap((s) => pagesOf(s, k).map((pg) => rowKey(pg.find((r) => k(r) !== null) ?? pg[0])))));
        expect(drawn.filter((_, i) => starts[i]).map(rowKey), d.name).toEqual(drawn.filter((r) => firsts.has(rowKey(r))).map(rowKey));
      }
    }
  });

  it('cuts sections at headings and columns, and pages at four knobs, a hand-set break or a kept start', () => {
    const p = rows('a', '#osc w', 'x', 'y', 'z', 'q', '|r', '#amp s');
    p[7].group = true;
    expect(show(layoutOf(p))).toBe('-: a ; osc: w x y z / q || -: r ; amp: s');
    p[3].pin = true;
    expect(show(layoutOf(p))).toBe('-: a ; osc: w x / y z q || -: r ; amp: s');
  });

  it('a heading with no rows stays: before the next section, at a column top or at a column end', () => {
    const l = layoutOf(rows('#a a1', '#b b1', '|#c c1'));
    removeRows(l, ['1:b1'], knob);
    expect(show(l)).toBe('a: a1 ; b:  || c: c1');
    addHeading(l, 1, 0, 'top');
    addHeading(l, 1, 2, 'end');
    const f = flatten(l);
    expect(f.heads).toEqual([
      { head: 'b', module: 1, param: 'a1', after: true },
      { head: 'top', module: 1, param: 'c1' },
      { head: 'end', module: 1, param: 'c1', after: true },
    ]);
    expect(show(roundTrip(l))).toBe('a: a1 ; b:  || top:  ; c: c1 ; end: ');
  });
});

describe('arrange: moving rows', () => {
  it('a row dropped at the end of another page joins it; the other pages stay as they were', () => {
    const l = layoutOf(rows('#v v1', 'v2', 'v3', '#f f1', 'f2', 'f3', 'f4', 'f5', 'f6'));
    addBreak(l, '1:f2', knob);
    expect(show(l)).toBe('v: v1 v2 v3 ; f: f1 / f2 f3 f4 / f5 f6');
    moveRows(l, ['1:v3'], { sec: sec(l, 'f'), after: '1:f1' }, knob);
    expect(show(l)).toBe('v: v1 v2 ; f: f1 v3 / f2 f3 f4 / f5 f6');
    expect(show(roundTrip(l))).toBe(show(l));
  });

  it("a row dropped at a page's start opens it: the page's break moves to it", () => {
    const l = layoutOf(rows('#v v1', 'v2', '#f f1', 'f2', 'f3'));
    addBreak(l, '1:f2', knob);
    moveRows(l, ['1:v2'], { sec: sec(l, 'f'), before: '1:f2', start: true }, knob);
    expect(show(l)).toBe('v: v1 ; f: f1 / v2 f2 f3');
    const f = sec(l, 'f').rows;
    expect([f[1].group, f[2].group]).toEqual([true, undefined]);
  });

  it('a row that started a page hands the start to the next row; moving the last row keeps the heading', () => {
    const l = layoutOf(rows('#f f1', 'f2', 'f3', 'f4', 'f5', 'f6', '#m m1'));
    moveRows(l, ['1:f5'], { sec: sec(l, 'm'), after: '1:m1' }, knob);
    expect(show(l)).toBe('f: f1 f2 f3 f4 / f6 ; m: m1 f5');
    moveRows(l, ['1:m1', '1:f5'], { sec: sec(l, 'f'), after: '1:f6' }, knob);
    expect(show(l)).toBe('f: f1 f2 f3 f4 / f6 m1 f5 ; m: ');
  });

  it('a page moves whole and starts a page where it lands; a hand-set break goes with it', () => {
    const l = layoutOf(rows('#f f1', 'f2', 'f3', '#m m1', 'm2'));
    addBreak(l, '1:f2', knob);
    moveRows(l, ['1:f2', '1:f3'], { sec: sec(l, 'm'), before: '1:m2' }, knob, true);
    expect(show(l)).toBe('f: f1 ; m: m1 / f2 f3 / m2');
    expect(sec(l, 'm').rows.map((r) => r.group ?? r.pin ?? '')).toEqual(['', true, '', true]);
    expect(sec(l, 'm').rows[1].group).toBe(true);
  });
});

describe('arrange: headings and breaks', () => {
  it('a section moves between columns; one without a heading never moves', () => {
    const l = layoutOf(rows('#a a1', '#b b1', '|#c c1'));
    moveSection(l, sec(l, 'b'), { col: 1 });
    expect(show(l)).toBe('a: a1 || c: c1 ; b: b1');
    const m = layoutOf(rows('x', '#a a1'));
    moveSection(m, m[0].secs[0], { col: 0 });
    expect(show(m)).toBe('-: x ; a: a1');
  });

  it('a heading taken off hands its rows to the section above, as a page of their own', () => {
    const l = layoutOf(rows('#a a1', '#b b1', 'b2'));
    removeHeading(l, sec(l, 'b'));
    expect(show(l)).toBe('a: a1 / b1 b2');
    const top = layoutOf(rows('#a a1', '|#b b1'));
    removeHeading(top, sec(top, 'b'));
    expect(show(top)).toBe('a: a1 || -: b1');
  });

  it('a break by hand keeps the pages after it; taking it off joins the two pages', () => {
    const l = layoutOf(rows('#f f1', 'f2', 'f3', 'f4', 'f5', 'f6'));
    addBreak(l, '1:f2', knob);
    expect(show(l)).toBe('f: f1 / f2 f3 f4 / f5 f6');
    removeBreak(l, '1:f2');
    expect(show(l)).toBe('f: f1 f2 f3 f4 / f5 f6');
  });

  it('displays take no knob', () => {
    expect(show(layoutOf(rows('#e *env', 'a', 'd', 's', 'r', 'x')))).toBe('e: *env a d s r / x');
  });
});
