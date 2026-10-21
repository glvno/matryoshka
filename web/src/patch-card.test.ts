// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembliesOf, hiddenAssemblies, hiddenModules } from './assembly';
import { demoPatch } from './demo';
import { DEFS } from './modules';
import { CARD_H, CARD_W, cardLayout, cutLabel, DARK, fitLine, LABEL_CHAR, LABEL_PAD, mapTop, patchFacts, type CardLayout } from './patch-card';
import { PRESETS } from './presets';

const inside = (l: CardLayout): void => {
  for (const b of l.boxes) {
    expect(b.x).toBeGreaterThanOrEqual(l.map.x);
    expect(b.y).toBeGreaterThanOrEqual(l.map.y);
    expect(b.x + b.w).toBeLessThanOrEqual(l.map.x + l.map.w + 1e-6);
    expect(b.y + b.h).toBeLessThanOrEqual(l.map.y + l.map.h + 1e-6);
    // a label never runs past its box
    expect(b.label.length * LABEL_CHAR).toBeLessThanOrEqual(Math.max(0, b.w - 2 * LABEL_PAD) + 1e-6);
  }
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

  it('lays the Demo out inside the map, its labels cut short', () => {
    const p = demoPatch();
    expect(p.modules.length).toBeGreaterThan(150);
    const l = cardLayout(p, DEFS);
    inside(l);
    expect(l.boxes.some((b) => b.label.endsWith('…'))).toBe(true);
    expect(l.lines.every((c) => ['signal', 'mod', 'gate', 'keys'].includes(c.role))).toBe(true);
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
    expect(fitLine(demo)).toMatch(/^Browser only/);
    expect(patchFacts(PRESETS['Hera 6'](), DEFS).engines.length).toBeLessThanOrEqual(1);
  });

  it('uses the dark theme\'s token values from style.css', () => {
    const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
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
