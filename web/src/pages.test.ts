// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, rowDef, validatePatch } from './patch';
import { assembliesOf, makeAssembly, fixAssemblies, keepParams, promote, removeMember, setColumnBreak, setHeading } from './assembly';
import { layoutOf, moveRows, moveSection, setLayout, type KnobOf, type Layout } from './arrange';
import { devicesOf, patternDriver, findRow, fixFocus, homeDevice, groupStarts, LABEL_MAX, pageLabel, pageTitle } from './pages';
import { PRESETS } from './presets';
import { demoPatch } from './demo';
import { binaryPage, encodePatch } from './patchbin';

describe('device pages', () => {
  it('control-only Steps grouping survives for poly engines without granting pattern permission', () => {
    const p = emptyPatch();
    const track = addModule(p, DEFS.steps, 0, 0);
    const alloc = addModule(p, DEFS.alloc, 300, 0);
    const filter = addModule(p, DEFS.filter, 600, 0);
    const a = makeAssembly(p, [alloc.id, filter.id], 'poly control');
    promote(a, filter.id, 'cutoff');
    connect(p, DEFS, { module: track.id, port: 'pitch' }, { module: filter.id, port: 'p1' });
    expect(devicesOf(p, DEFS).find((d) => d.asm === a.id)!.track).toBe(track.id);
    expect(patternDriver(p, a, DEFS)).toBeUndefined();
  });
  it('808: the kit card with DRUMS and its Drum maps inside is DRUMS\' device (#1202 K2); a Drum map outside follows it, and DRUMS outside comes first', () => {
    const p = PRESETS['808 Kit']();
    // (an effect of an FX drawer is its own device, D-945: 'fx')
    const kinds = (): string[] => devicesOf(p, DEFS).slice(0, 7).map((d) => d.asm === undefined ? p.modules.find((m) => m.id === d.module)!.type
      : assembliesOf(p).find((a) => a.id === d.asm)?.chain ? 'fx' : 'kit');
    const card = assembliesOf(p).find((a) => a.name === '808 kit')!;
    const drums = p.modules.find((m) => m.type === 'steps')!;
    expect(kinds()).toEqual(['fm1', 'kit', 'fx', 'fx', 'output']);   // (the kit card, then its converted master FX bus's two effects, D-945)
    expect(devicesOf(p, DEFS)[1].track).toBe(drums.id);
    expect(homeDevice(devicesOf(p, DEFS))).toBe(1);   // (where a patch opens: the kit)
    for (const m of p.modules.filter((x) => x.type === 'drummap')) removeMember(p, card, m.id);
    expect(kinds()).toEqual(['fm1', 'kit', 'fx', 'fx', 'drummap', 'drummap', 'output']);   // (the kit's effects right after it, before the maps its track also drives: D-945)
    removeMember(p, card, drums.id);
    expect(kinds()).toEqual(['fm1', 'steps', 'drummap', 'drummap', 'kit', 'fx', 'fx']);
    expect(devicesOf(p, DEFS).find((d) => d.asm === card.id)!.track).toBe(drums.id);   // (driven by DRUMS through the maps, as before #1202)
  });

  it('a plain module is a device of its parameters, four to a page; scopes are none', () => {
    const p = emptyPatch();
    addModule(p, DEFS.scope, 600, 400);
    const osc = addModule(p, DEFS.osc, 300, 20);
    const devs = devicesOf(p, DEFS);
    expect(devs.map((d) => d.key)).toEqual([`m${osc.id}`]);
    const names = DEFS.osc.params.map((q) => q.name);
    expect(devs[0].pages.flatMap((pg) => pg.rows.map((r) => r.param))).toEqual(names);
    expect(devs[0].pages.every((pg) => pg.rows.length <= 4)).toBe(true);
    expect(devs[0].pages.map(pageTitle)[0]).toBe(`Oscillator 1/${Math.ceil(names.length / 4)}`);
  });

  it('the environment\'s grouped order (#196): Main, each Steps track and what it drives, the rest, the Output', () => {
    const p = emptyPatch();
    const out = addModule(p, DEFS.output, 20, 20); // first on the canvas, last in the list
    const lfo = addModule(p, DEFS.lfo, 100, 20);
    const st = addModule(p, DEFS.steps, 600, 20);
    st.name = 'DRUMS';
    const main = addModule(p, DEFS.fm1, 900, 20);
    const osc = addModule(p, DEFS.osc, 300, 20);
    connect(p, DEFS, { module: st.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
    const devs = devicesOf(p, DEFS);
    expect(devs.map((d) => d.module)).toEqual([main.id, st.id, osc.id, lfo.id, out.id]);
    expect(devs.map((d) => d.kind ?? '')).toEqual(['main', 'steps', '', '', 'output']);
    expect(devs[1].name).toBe('DRUMS');
    expect(devs[1].pages[0].rows.map((r) => r.param)).toEqual(['len', 'rate', 'swing', 'gate']);
    expect(devs[2].track).toBe(st.id);
    expect(devs[3].track).toBeUndefined();
    expect(homeDevice(devs)).toBe(2); // a fresh patch's focus: the first that is not Main, a track or the Output
    expect(fixFocus(devs, null)).toEqual({ device: `m${osc.id}`, page: 0 });
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

  it("a section's groups are its pages: a hand-set break or a kept start splits one; removing rows keeps the flag at its place", () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 20, 20);
    const flt = addModule(p, DEFS.filter, 20, 400);
    const a = makeAssembly(p, [osc.id, flt.id], 'mono');
    a.params = [];
    for (const q of ['wave', 'pw', 'coarse']) promote(a, osc.id, q);
    for (const q of ['cutoff', 'res', 'cvamt', 'track', 'morph']) promote(a, flt.id, q);
    setHeading(a.params, 3, 'filter');
    const titles = (): string[] => devicesOf(p, DEFS)[0].pages.map(pageTitle);
    const rows = (): string[][] => devicesOf(p, DEFS)[0].pages.map((pg) => pg.rows.map((r) => r.param));
    expect(titles()).toEqual(['mono', 'filter 1/2', 'filter 2/2']);
    a.params[5].group = true; // cutoff, res | cvamt, track, morph
    expect(rows()).toEqual([['wave', 'pw', 'coarse'], ['cutoff', 'res'], ['cvamt', 'track', 'morph']]);
    delete a.params[5].group;
    a.params[5].pin = true; // a kept start splits the same way
    expect(rows()).toEqual([['wave', 'pw', 'coarse'], ['cutoff', 'res'], ['cvamt', 'track', 'morph']]);
    a.params = keepParams(a.params, (r) => r.param !== 'cvamt'); // its flag goes to track
    expect(a.params.find((r) => r.param === 'track')!.pin).toBe(true);
    setColumnBreak(a.params, 1, true); // a column ends a group, not the section
    expect(titles()).toEqual(['mono 1/2', 'mono 2/2', 'filter 1/2', 'filter 2/2']);
    expect(() => encodePatch(p)).not.toThrow();
  });

  it('Arrange moves rows, pages and sections on the device too (#186): every page around a move stays whole', () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 20, 20);
    const flt = addModule(p, DEFS.filter, 20, 400);
    const env = addModule(p, DEFS.adsr, 320, 20);
    const a = makeAssembly(p, [osc.id, flt.id, env.id], 'mono');
    a.params = [];
    for (const q of ['wave', 'pw', 'coarse']) promote(a, osc.id, q);
    promote(a, env.id, 'view'); // a display: no knob, rides with its group
    for (const q of ['a', 'd', 's', 'r']) promote(a, env.id, q);
    for (const q of ['cutoff', 'res', 'cvamt', 'track', 'morph']) promote(a, flt.id, q);
    setHeading(a.params, 3, 'amp');
    setHeading(a.params, 8, 'filter');
    const knob: KnobOf = (r) => {
      const m = p.modules.find((x) => x.id === r.module)!;
      const pd = rowDef(DEFS[m.type], r.param)!;
      return pd.onScreen ? null : !pd.screen;
    };
    const pages = (): string[] => devicesOf(p, DEFS)[0].pages.map((pg) => `${pageTitle(pg)}: ${pg.rows.map((r) => r.param).join(' ')}`);
    const k = (m: number, q: string): string => `${m}:${q}`;
    const edit = (fn: (l: Layout) => void): void => { const l = layoutOf(a.params, a.heads); fn(l); setLayout(a, l); };
    const sec = (l: Layout, head: string) => l.flatMap((c) => c.secs).find((x) => x.head === head)!;
    expect(pages()).toEqual(['mono: wave pw coarse', 'amp: a d s r', 'filter 1/2: cutoff res cvamt track', 'filter 2/2: morph']);
    // a loose block: pw and res at the end of the filter's second page
    edit((l) => moveRows(l, [k(osc.id, 'pw'), k(flt.id, 'res')], { sec: sec(l, 'filter'), after: k(flt.id, 'morph') }, knob));
    expect(pages()).toEqual(['mono: wave coarse', 'amp: a d s r', 'filter 1/2: cutoff cvamt track', 'filter 2/2: morph pw res']);
    // the filter section before amp: its heading and pages go with it
    edit((l) => moveSection(l, sec(l, 'filter'), { col: 0, before: sec(l, 'amp') }));
    expect(pages()).toEqual(['mono: wave coarse', 'filter 1/2: cutoff cvamt track', 'filter 2/2: morph pw res', 'amp: a d s r']);
    // the filter's second page to the end of amp: a page of its own there, with the envelope's display staying on amp's first
    edit((l) => moveRows(l, [k(flt.id, 'morph'), k(osc.id, 'pw'), k(flt.id, 'res')], { sec: sec(l, 'amp') }, knob, true));
    expect(pages()).toEqual(['mono: wave coarse', 'filter: cutoff cvamt track', 'amp 1/2: a d s r', 'amp 2/2: morph pw res']);
    expect(devicesOf(p, DEFS)[0].pages.filter((pg) => pg.display === env.id)).toHaveLength(1);
    // every row of filter moved away: its heading stays, with no page on the device
    edit((l) => moveRows(l, [k(flt.id, 'cutoff'), k(flt.id, 'cvamt'), k(flt.id, 'track')], { sec: sec(l, 'amp'), after: k(flt.id, 'res') }, knob));
    expect(a.heads).toEqual([{ head: 'filter', module: env.id, param: 'view' }]);
    expect(pages()).toEqual(['mono: wave coarse', 'amp 1/3: a d s r', 'amp 2/3: morph pw res cutoff', 'amp 3/3: cvamt track']);
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
    const devs = devicesOf(p, DEFS).filter((d) => !d.kind); // (Main first, the Output last)
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

describe('a DX7\'s pages (#1338, pages_ui.c dx7_page and pages_dx7_cards)', () => {
  it('a DX7 of its own: 13 pages, its parameters then its voice rows, as the FM-1 makes them', () => {
    const p = emptyPatch();
    const dx = addModule(p, DEFS.dx7, 0, 0);
    connect(p, DEFS, { module: dx.id, port: 'out' }, { module: addModule(p, DEFS.output, 300, 0).id, port: 'l' });
    const dev = devicesOf(p, DEFS).find((d) => d.module === dx.id)!;
    expect(dev.pages.map((pg) => `${pageTitle(pg)}: ${pg.rows.map((r) => r.param).join(' ')}`)).toEqual([
      'DX7 1/2: level tune mod ops', 'DX7 2/2: range dest voice.alg voice.fb',
      'operator 1/6: voice.op voice.level voice.coarse voice.fine', 'operator 2/6: voice.mode voice.detune voice.vel voice.ams',
      'operator 3/6: voice.r1 voice.r2 voice.r3 voice.r4', 'operator 4/6: voice.l1 voice.l2 voice.l3 voice.l4',
      'operator 5/6: voice.bp voice.ld voice.rd voice.lc', 'operator 6/6: voice.rc voice.rs',
      'pitch eg 1/2: voice.pr1 voice.pr2 voice.pr3 voice.pr4', 'pitch eg 2/2: voice.pl1 voice.pl2 voice.pl3 voice.pl4',
      'lfo 1/2: voice.wave voice.speed voice.delay voice.sync', 'lfo 2/2: voice.pmd voice.amd voice.pms voice.oks', 'voice: voice.transpose']);
    expect(binaryPage(p, dev.key, 12)?.[1]).toBe(12);   // (FOCUS: the FM-1's page 12)
  });
  it('a card holding one DX7 (a poly DX7): the voice pages after its own, not in the binary\'s list; two DX7s: none', () => {
    const p = emptyPatch();
    const alloc = addModule(p, DEFS.alloc, 0, 0);
    const dx = addModule(p, DEFS.dx7, 300, 0);
    connect(p, DEFS, { module: dx.id, port: 'out' }, { module: addModule(p, DEFS.output, 900, 0).id, port: 'l' });
    const a = makeAssembly(p, [alloc.id, dx.id], 'piano');
    promote(a, dx.id, 'level');
    const dev = devicesOf(p, DEFS).find((d) => d.asm === a.id)!;
    const own = dev.pages.filter((pg) => !pg.voice).length;
    expect(dev.pages.length).toBe(own + 12);
    expect(dev.pages.slice(own).map(pageTitle)).toEqual(['dx7', 'operator 1/6', 'operator 2/6', 'operator 3/6', 'operator 4/6', 'operator 5/6',
      'operator 6/6', 'pitch eg 1/2', 'pitch eg 2/2', 'lfo 1/2', 'lfo 2/2', 'voice']);
    expect(dev.pages[own].rows.map((r) => [r.module, r.param])).toEqual([[dx.id, 'voice.alg'], [dx.id, 'voice.fb']]);
    expect(binaryPage(p, dev.key, own + 11)?.[1]).toBe(own + 11);
    expect(() => encodePatch(p, true)).not.toThrow();   // (the voice pages are not written: the FM-1 adds them)
    const dx2 = addModule(p, DEFS.dx7, 600, 0);
    a.modules.push(dx2.id);
    expect(devicesOf(p, DEFS).find((x) => x.asm === a.id)!.pages.some((pg) => pg.voice)).toBe(false);
  });
});
