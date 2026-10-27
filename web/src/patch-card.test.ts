// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembliesOf, hiddenAssemblies, hiddenModules } from './assembly';
import { demoPatch } from './demo';
import { DEFS } from './modules';
import { BAR_H, CARD_H, CARD_W, cardLayout, cutLabel, DARK, detailFor, fitLine, HEAD_H, LABEL_CHAR, LABEL_PAD, mapTop, patchFacts, ROW_H, type CardLayout } from './patch-card';
import { PRESETS } from './presets';

const inside = (l: CardLayout): void => {
  for (const b of l.boxes) {
    expect(b.x).toBeGreaterThanOrEqual(l.map.x);
    expect(b.y).toBeGreaterThanOrEqual(l.map.y);
    expect(b.x + b.w).toBeLessThanOrEqual(l.map.x + l.map.w + 1e-6);
    expect(b.y + b.h).toBeLessThanOrEqual(l.map.y + l.map.h + 1e-6);
    // a label never runs past its box
    expect(b.label.length * LABEL_CHAR).toBeLessThanOrEqual(Math.max(0, b.w - 2 * LABEL_PAD) + 1e-6);
    // the pages' rows stay inside their box, under its name
    for (const pg of b.pages ?? []) {
      expect(pg.rows.length).toBeGreaterThan(0);
      expect(pg.x).toBeGreaterThanOrEqual(b.x);
      expect(pg.x + pg.w).toBeLessThanOrEqual(b.x + b.w + 1e-6);
      expect(pg.y).toBeGreaterThanOrEqual(b.y + HEAD_H);
      expect(pg.y + pg.titleH + (pg.rows.length - 1) * ROW_H[l.detail] + BAR_H[l.detail]).toBeLessThanOrEqual(b.y + b.h + 1e-6);
      for (const r of pg.rows) {
        expect(r.u).toBeGreaterThanOrEqual(0);
        expect(r.u).toBeLessThanOrEqual(1);
        expect(r.value).not.toBe('');
      }
    }
  }
  // boxes never run into each other
  const solid = l.boxes.filter((b) => b.kind === 'module' || b.kind === 'assembly');
  for (const a of solid)
    for (const b of solid)
      if (a !== b) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${a.label} / ${b.label}`).toBe(false);
  for (const c of l.lines) for (const pt of [c.from, c.to]) {
    expect(pt.x).toBeGreaterThanOrEqual(0);
    expect(pt.x).toBeLessThanOrEqual(CARD_W);
    expect(pt.y).toBeGreaterThanOrEqual(0);
    expect(pt.y).toBeLessThanOrEqual(CARD_H);
  }
};

describe('the patch card', () => {
  it('lays a factory patch out inside the map: a box per top-level card, the cables between boxes', () => {
    for (const name of ['Init', 'Oracle V', '808 Kit']) {
      const p = PRESETS[name]();
      const l = cardLayout(p, DEFS);
      inside(l);
      const hidden = hiddenModules(p);
      const collapsed = assembliesOf(p).filter((a) => !a.open && !hiddenAssemblies(p).has(a.id)).length;
      expect(l.boxes.filter((b) => b.kind !== 'frame').length).toBe(p.modules.filter((m) => !hidden.has(m.id)).length + collapsed);
      expect(l.lines.length).toBeGreaterThan(0);
      expect(l.lines.length).toBeLessThanOrEqual(p.cables.length);
    }
  });

  it('lays the Demo out inside the map, each box showing less', () => {
    const p = demoPatch();
    expect(p.modules.length).toBeGreaterThan(150);
    const l = cardLayout(p, DEFS);
    inside(l);
    expect(l.detail).toBe('compact');
    expect(l.boxes.filter((b) => b.pages?.length).length).toBeGreaterThan(8);
    expect(l.lines.every((c) => ['signal', 'mod', 'gate', 'keys'].includes(c.role))).toBe(true);
  });

  it('shows an engine’s blurb and every page of its knobs, with their values', () => {
    const l = cardLayout(PRESETS['Oracle V'](), DEFS);
    expect(l.detail).toBe('full');
    const box = l.boxes.find((b) => b.label === 'ORACLE V')!;
    expect(box.blurb).toBe('Prophet-5 type shit');
    expect(box.pages!.map((pg) => pg.title)).toEqual(['voice', 'osc A', 'osc B', 'mixer', 'filter 1/2', 'filter 2/2', 'amp', 'mod 1/2', 'mod 2/2']);
    const row = (title: string, label: string) => box.pages!.find((pg) => pg.title === title)!.rows.find((r) => r.label === label)!;
    expect(row('voice', 'voices').value).toBe('5');
    expect(row('osc A', 'wave').value).toBe('saw');
    expect(row('filter 1/2', 'cutoff').value).toMatch(/Hz$/);
  });

  it('shows a module’s main parameters, without a page title that repeats its name', () => {
    const l = cardLayout(PRESETS.Init(), DEFS);
    const osc = l.boxes.find((b) => b.label === 'OSCILLATOR')!;
    expect(osc.pages![0].title).toBe('');
    expect(osc.pages![0].rows.map((r) => r.label)).toEqual(['wave', 'pulse width', 'coarse tune', 'fine tune']);
    expect(l.boxes.find((b) => b.label === 'ADSR')!.pages![0].rows.map((r) => r.label)).toEqual(['attack', 'decay', 'sustain', 'release']);
    expect(l.boxes.some((b) => b.blurb)).toBe(false);
  });

  it('undisplayed module ports and rows do not hide a neighboring envelope control', () => {
    const p = PRESETS.Init();
    const defs = { ...DEFS, alloc: { ...DEFS.alloc, params: [...DEFS.alloc.params, ...DEFS.alloc.params], outputs: [...DEFS.alloc.outputs, ...DEFS.alloc.outputs] } };
    const l = cardLayout(p, defs);
    inside(l);
    expect(l.boxes.find((b) => b.label === 'ADSR')!.pages![0].rows.map((r) => r.label)).toEqual(['attack', 'decay', 'sustain', 'release']);
  });

  it('shows less per box the more boxes there are', () => {
    expect(detailFor(5)).toBe('full');
    expect(detailFor(30)).toBe('compact');
    expect(detailFor(200)).toBe('names');
  });

  it('leaves out a cable inside one box', () => {
    const p = PRESETS['Oracle V']();
    const l = cardLayout(p, DEFS);
    for (const c of l.lines) expect(c.from.x === c.to.x && c.from.y === c.to.y).toBe(false);
    const inner = p.cables.filter((c) => hiddenModules(p).has(c.from.module) && hiddenModules(p).has(c.to.module));
    if (inner.length) expect(l.lines.length).toBeLessThan(p.cables.length);
  });

  it('puts the Main module in the dock along the map\'s bottom, its cables leaving the dock\'s top edge', () => {
    const l = cardLayout(PRESETS['Oracle V'](), DEFS);
    const dock = l.boxes.filter((b) => b.kind === 'dock');
    expect(dock.length).toBe(1);
    expect(dock[0].y + dock[0].h).toBeLessThanOrEqual(l.map.y + l.map.h);
    for (const b of l.boxes) if (b.kind !== 'dock') expect(b.y + b.h).toBeLessThanOrEqual(dock[0].y);
    expect(l.lines.some((c) => c.dock === 'from' && c.from.y === dock[0].y)).toBe(true);
  });

  it('moves the map down under the notes, at most three lines of them', () => {
    const p = PRESETS.Init();
    expect(cardLayout(p, DEFS).map.y).toBe(mapTop(0));
    expect(cardLayout(p, DEFS, 2).map.y).toBeGreaterThan(mapTop(1));
    expect(mapTop(9)).toBe(mapTop(3));
    expect(mapTop(3)).toBeLessThan(CARD_H / 3);
  });

  it('cuts a label with an ellipsis, or drops it when nothing fits', () => {
    expect(cutLabel('OSCILLATOR', 200)).toBe('OSCILLATOR');
    expect(cutLabel('OSCILLATOR', 5 * LABEL_CHAR)).toBe('OSCI…');
    expect(cutLabel('OSCILLATOR', LABEL_CHAR)).toBe('');
  });

  it('says whether the patch plays on the FM-1, and names its engines', () => {
    const init = patchFacts(PRESETS.Init(), DEFS);
    expect(init.fits).toBe(true);
    expect(fitLine(init)).toMatch(/^Plays on the FM-1 · \d+ %$/);
    const demo = patchFacts(demoPatch(), DEFS);
    expect(fitLine(demo)).toMatch(/^Sandbox/);
    expect(patchFacts(PRESETS['Hera 6'](), DEFS).engines.length).toBeLessThanOrEqual(1);
  });

  it('uses the dark theme\'s token values from tokens.css', () => {
    const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
    const ref = (name: string): string => new RegExp(`--ref-${name}: (#[0-9a-f]{6})`).exec(css)![1];
    const dark = /:root\[data-theme="dark"\] \{([^}]*)\}/.exec(css)![1];
    const tok = (name: string): string => ref(new RegExp(`--${name}: var\\(--ref-([a-z-]+)\\)`).exec(dark)![1]);
    expect(DARK.bg).toBe(tok('bg'));
    expect(DARK.panel).toBe(tok('panel'));
    expect(DARK.ink).toBe(tok('ink'));
    expect(DARK.muted).toBe(tok('muted'));
    expect(DARK.line).toBe(tok('line'));
    expect(DARK.accent).toBe(tok('accent'));
    expect(DARK.secondary).toBe(tok('secondary'));
    expect(DARK.gate).toBe(tok('gate'));
  });
});
