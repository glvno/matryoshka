// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch } from './patch';
import { makeAssembly, fixAssemblies, keepParams, moveParam, promote, setColumnBreak, setGroupBreak, setHeading } from './assembly';
import { devicesOf, findRow, fixFocus, groupStarts, LABEL_MAX, pageLabel, pageTitle } from './pages';
import { PRESETS } from './presets';
import { demoPatch } from './demo';
import { encodePatch } from './patchbin';

describe('device pages', () => {
  it('a plain module is a device of its parameters, four to a page; Main, Output, Steps and scopes are none', () => {
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 20, 20);
    addModule(p, DEFS.output, 900, 20);
    addModule(p, DEFS.steps, 600, 20);
    addModule(p, DEFS.scope, 600, 400);
    const osc = addModule(p, DEFS.osc, 300, 20);
    const devs = devicesOf(p, DEFS);
    expect(devs.map((d) => d.key)).toEqual([`m${osc.id}`]);
    const names = DEFS.osc.params.map((q) => q.name);
    expect(devs[0].pages.flatMap((pg) => pg.rows.map((r) => r.param))).toEqual(names);
    expect(devs[0].pages.every((pg) => pg.rows.length <= 4)).toBe(true);
    expect(devs[0].pages.map(pageTitle)[0]).toBe(`Oscillator 1/${Math.ceil(names.length / 4)}`);
  });

  it('an assembly is a device of its card: a heading starts a page, a long group spills, an envelope shape lands on its rows', () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 20, 20);
    const env = addModule(p, DEFS.adsr, 20, 400);
    const vca = addModule(p, DEFS.vca, 320, 20);
    connect(p, DEFS, { module: env.id, port: 'env' }, { module: vca.id, port: 'cv' });
    const a = makeAssembly(p, [osc.id, env.id, vca.id], 'voice');
    a.params = [];
    promote(a, osc.id, 'wave');
    promote(a, vca.id, 'gain');
    promote(a, env.id, 'view');
    for (const q of ['a', 'd', 's', 'r']) promote(a, env.id, q);
    promote(a, osc.id, 'level');
    setHeading(a.params, 2, 'amp');
    const [dev] = devicesOf(p, DEFS);
    expect(dev.key).toBe(`a${a.id}`);
    expect(dev.pages.map(pageTitle)).toEqual(['voice', 'amp 1/2', 'amp 2/2']);
    expect(dev.pages[0].rows.map((r) => r.label)).toEqual(['wave', 'gain']);
    expect(dev.pages[1].rows.map((r) => r.param)).toEqual(['a', 'd', 's', 'r']);
    expect(dev.pages[1].display).toBe(env.id);
    expect(dev.pages[2].rows.map((r) => r.param)).toEqual(['level']);
    expect(findRow([dev], env.id, 's')).toEqual({ device: 0, page: 1, row: 2 });
    expect(findRow([dev], env.id, 'nope')).toBeUndefined();
  });

  it('groups fill in fours; a group start, a column break or a heading ends one early; a display stays with the rows under it', () => {
    const k = { knob: true }, d = { knob: false };
    expect(groupStarts([k, k, k, k, k, k])).toEqual([true, false, false, false, true, false]);
    expect(groupStarts([k, { knob: true, group: true }, k, k, k, k])).toEqual([true, true, false, false, false, true]);
    expect(groupStarts([k, k, { knob: true, col: true }, { knob: true, head: 'x' }])).toEqual([true, false, true, true]);
    expect(groupStarts([k, k, k, k, d, k])).toEqual([true, false, false, false, true, false]);
    expect(groupStarts([d, k, k, k, k, k])).toEqual([true, false, false, false, false, true]);
  });

  it('a section\'s groups are its pages: "new group" splits a section, removing rows keeps the flag at its place', () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 20, 20);
    const flt = addModule(p, DEFS.filter, 20, 400);
    const a = makeAssembly(p, [osc.id, flt.id], 'mono');
    a.params = [];
    for (const q of ['wave', 'pw', 'coarse']) promote(a, osc.id, q);
    for (const q of ['cutoff', 'res', 'cvamt', 'track', 'morph']) promote(a, flt.id, q);
    setHeading(a.params, 3, 'filter');
    const titles = (): string[] => devicesOf(p, DEFS)[0].pages.map(pageTitle);
    expect(titles()).toEqual(['mono', 'filter 1/2', 'filter 2/2']);
    setGroupBreak(a.params, 5, true); // cutoff, res | cvamt, track, morph
    expect(devicesOf(p, DEFS)[0].pages.map((pg) => pg.rows.map((r) => r.param))).toEqual([['wave', 'pw', 'coarse'], ['cutoff', 'res'], ['cvamt', 'track', 'morph']]);
    setGroupBreak(a.params, 0, true); // the first row: no flag
    expect(a.params[0].group).toBeUndefined();
    a.params = keepParams(a.params, (r) => r.param !== 'cvamt'); // its flag goes to track
    expect(a.params.find((r) => r.param === 'track')!.group).toBe(true);
    a.params = moveParam(a.params, 0, 5, false); // wave dropped before track takes its place, in its group
    expect(devicesOf(p, DEFS)[0].pages.map((pg) => pg.rows.map((r) => r.param))).toEqual([['pw', 'coarse'], ['cutoff', 'res'], ['wave', 'track', 'morph']]);
    setColumnBreak(a.params, 1, true); // a column ends a group, not the section
    expect(titles()).toEqual(['mono 1/2', 'mono 2/2', 'filter 1/2', 'filter 2/2']);
    expect(() => encodePatch(p)).not.toThrow();
  });

  it('devices come in reading order: columns from the left, each from the top', () => {
    const p = emptyPatch();
    const a = addModule(p, DEFS.lfo, 340, 20);
    const b = addModule(p, DEFS.lfo, 20, 500);
    const c = addModule(p, DEFS.lfo, 20, 20);
    const d = addModule(p, DEFS.lfo, 400, 300); // within half a card of the column at 340
    expect(devicesOf(p, DEFS).map((x) => x.module)).toEqual([c.id, b.id, a.id, d.id]);
  });

  it('a focus that is gone falls back to the first page; one past the end is clamped', () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 20, 20);
    const devs = devicesOf(p, DEFS);
    expect(fixFocus(devs, null)).toEqual({ device: `m${osc.id}`, page: 0 });
    expect(fixFocus(devs, { device: 'a99', page: 3 })).toEqual({ device: `m${osc.id}`, page: 0 });
    expect(fixFocus(devs, { device: `m${osc.id}`, page: 99 })).toEqual({ device: `m${osc.id}`, page: devs[0].pages.length - 1 });
    expect(fixFocus([], null)).toBeNull();
  });
});

describe('knob migration', () => {
  it('cables from Main\'s old knob outputs come from a Macros assembly, the first device, with the knobs\' labels and positions', () => {
    const old = {
      version: 2, name: 'old',
      modules: [
        { id: 1, type: 'fm1', x: 20, y: 20, params: { k1: 0.25, k2: 0.5, k3: 0.5, k4: 0.5, morph: 0, tempo: 120 }, panel: { labels: { k1: 'CUTOFF', fx: 'HOLD' } } },
        { id: 2, type: 'filter', x: 20, y: 300, params: {}, map: { p1: ['cutoff'], p2: ['res'] } },
        { id: 3, type: 'output', x: 700, y: 20, params: {} },
      ],
      cables: [{ from: { module: 1, port: 'k1' }, to: { module: 2, port: 'p1' } }, { from: { module: 2, port: 'lp12' }, to: { module: 3, port: 'l' } }],
    };
    const p = validatePatch(old, DEFS);
    fixAssemblies(p, DEFS);
    const main = p.modules.find((m) => m.type === 'fm1')!;
    expect(Object.keys(main.params).sort()).toEqual(['morph', 'tempo']);
    expect(main.panel).toEqual({ labels: { fx: 'HOLD' } });
    const macro = p.modules.find((m) => m.type === 'macro')!;
    expect(macro.params.value).toBe(0.25);
    expect(p.cables.some((c) => c.from.module === macro.id && c.to.module === 2 && c.to.port === 'p1')).toBe(true);
    const flt = p.modules.find((m) => m.type === 'filter')!;
    expect(flt.x).toBeGreaterThan(300); // moved aside for the Macros card
    const devs = devicesOf(p, DEFS);
    expect(devs[0].name).toBe('Macros');
    expect(devs[0].pages[0].rows).toEqual([{ module: macro.id, param: 'value', label: 'cutoff' }]);
    expect(() => encodePatch(p)).not.toThrow();
  });

  it('the page picker never repeats the device name: a heading, else the knob names, else "page 2/3" (#154)', () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 20, 20);
    const vca = addModule(p, DEFS.vca, 320, 20);
    const a = makeAssembly(p, [osc.id, vca.id], 'voice');
    a.params = [];
    promote(a, osc.id, 'wave');
    promote(a, vca.id, 'gain');
    promote(a, osc.id, 'level');
    setHeading(a.params, 2, 'amp');
    const [dev] = devicesOf(p, DEFS);
    expect(dev.pages.map((_, i) => pageLabel(dev, i))).toEqual(['wave \u00b7 gain', 'amp']);
    // a plain module: its pages before any heading, named after it; long knob names give way to "page 2/3"
    const q = emptyPatch();
    addModule(q, DEFS.osc, 20, 20);
    const [mod] = devicesOf(q, DEFS);
    const labels = mod.pages.map((_, i) => pageLabel(mod, i));
    labels.forEach((l, i) => {
      const names = mod.pages[i].rows.map((r) => r.label).join(' \u00b7 ');
      expect(l).toBe(names.length <= LABEL_MAX ? names : `page ${i + 1}/${mod.pages.length}`);
    });
  });

  it('across the factory patches and the Demo, no page label equals its device name or another page\'s of the device (#154)', () => {
    for (const [name, make] of [...Object.entries(PRESETS), ['Demo', demoPatch] as const]) {
      for (const dev of devicesOf(make(), DEFS)) {
        const labels = dev.pages.map((_, i) => pageLabel(dev, i));
        for (const l of labels) expect(l, `${name}: ${dev.name}`).not.toBe(dev.name);
        expect(new Set(labels).size, `${name}: ${dev.name} ${labels.join(' | ')}`).toBe(labels.length);
      }
    }
  });
});
