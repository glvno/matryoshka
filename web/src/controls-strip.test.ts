// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { BUTTON_ID, CONDITIONS, CONTROLS, HELP_STATE_NAME, HELP_STATES, sheetRows, type Condition, type ControlRow, type HelpState } from './controls';
import { ControlsStrip, conditionHolds, heldButtons, stripView, type StripInput } from './controls-strip';

/** every condition holding (bit c: CONDITIONS[c - 1]) */
const ALL_CONDS = CONDITIONS.reduce((m, _c, i) => m | (1 << (i + 1)), 0);
const cond = (...on: Condition[]): number => on.reduce((m, c) => m | (1 << (CONDITIONS.indexOf(c) + 1)), 0);
const at = (s: HelpState, o: Partial<StripInput> = {}): StripInput => ({ state: HELP_STATES.indexOf(s), held: 0, stepHeld: false, conditions: ALL_CONDS, ...o });
const ids = (rows: ControlRow[]): string[] => rows.map((r) => r.id);
/** the table's rows of a state's tab, in its order, whose condition holds (all conditions on: the positive ones) */
const tableRows = (s: HelpState, tab: 'state' | 'everywhere', conds = ALL_CONDS): string[] =>
  sheetRows(s, tab).filter((r): r is ControlRow => 'gesture' in r).filter((r) => conditionHolds(r.when, conds)).map((r) => r.id);

describe('the controls strip is made from the controls table (#554, controls.ts)', () => {
  it.each(HELP_STATES)('%s: the state\'s rows and its EVERYWHERE rows, in the table\'s order', (s) => {
    const v = stripView(at(s));
    expect(v.state).toBe(s);
    expect(v.name).toBe(HELP_STATE_NAME[s]);
    expect(v.held).toBeNull();
    expect(ids(v.rows)).toEqual(tableRows(s, 'state'));
    expect(ids(v.everywhere)).toEqual(tableRows(s, 'everywhere'));
    expect(v.rows.length, 'every state lists rows').toBeGreaterThan(0);
  });

  it('a row\'s condition decides whether it shows (a device page, a Page button\'s list or not)', () => {
    const list = ids(stripView(at('device', { conditions: cond('list') })).rows);
    expect(list[0], 'HOME leaves the list, first').toBe('list-home');
    expect(list).toContain('list-pages');
    expect(list).not.toContain('device-pages');
    const plain = ids(stripView(at('device', { conditions: 0 })).rows);
    expect(plain).toContain('device-pages');
    expect(plain).not.toContain('list-home');
    expect(plain, 'no presets: no PRESET row').not.toContain('device-presets');
  });

  it('SEL held on the piano roll: the strip shows what SEL + something does there', () => {
    const v = stripView(at('roll', { held: 1 << BUTTON_ID.SEL }));
    expect(v.held).toBe('SEL');
    expect(ids(v.rows)).toEqual(CONTROLS.filter((r) => r.gesture.hold === 'SEL' && r.sheet?.roll !== undefined)
      .sort((a, b) => a.sheet!.roll! - b.sheet!.roll!).map((r) => r.id));
    expect(ids(v.rows)).toEqual(['roll-pitch', 'pen']);
    expect(v.everywhere).toEqual([]);
  });

  it('a held step: its pitch, velocity, chance and locks, with K1..K4 named after them', () => {
    const v = stripView(at('roll', { stepHeld: true }));
    expect(v.held).toBe('step');
    expect(ids(v.rows)).toEqual(['held-pitch', 'held-velocity', 'held-chance', 'lock-pages', 'lock-rows']);
    expect(v.knobs).toEqual(['pitch', 'velocity', 'chance', 'p-lock rows']);
  });

  it('a held button with EVERYWHERE rows (PLAY: tempo), and one with nothing held + it (the state\'s own rows)', () => {
    expect(ids(stripView(at('device', { held: 1 << BUTTON_ID.PLAY })).rows)).toEqual(['tempo']);
    const lfo = stripView(at('device', { held: 1 << BUTTON_ID.LFO }));
    expect(lfo.held).toBeNull();
    expect(ids(lfo.rows)).toEqual(tableRows('device', 'state'));
  });

  it('FX held in step record: the accent its own row holds while the keys play', () => {
    expect(ids(stripView(at('step', { held: 1 << BUTTON_ID.FX })).rows)).toEqual(['sr-accent']);
  });

  it('K1..K4 come from the rows that turn them (step record: K4 moves the cursor)', () => {
    expect(stripView(at('step')).knobs).toEqual(['', '', '', 'move cursor']);
    expect(stripView(at('device')).knobs).toEqual(Array(4).fill('adjust values'));
  });

  it('changing an order number in CONTROLS changes the strip\'s order, with no other change', () => {
    const before = ids(stripView(at('step')).rows);
    const cursor = CONTROLS.find((r) => r.id === 'sr-cursor')!;
    const was = cursor.sheet!.step!;
    try {
      cursor.sheet!.step = 1;
      const after = ids(stripView(at('step')).rows);
      expect(after[0]).toBe('sr-cursor');
      expect(after).not.toEqual(before);
      expect([...after].sort()).toEqual([...before].sort());
    } finally {
      cursor.sheet!.step = was;
    }
    expect(ids(stripView(at('step')).rows)).toEqual(before);
  });

  it('heldButtons names the buttons by matrix id (OCT- and OCT+, not the OCT alias)', () => {
    expect(heldButtons((1 << BUTTON_ID['OCT-']) | (1 << BUTTON_ID['OCT+']) | (1 << BUTTON_ID.REC))).toEqual(['OCT-', 'OCT+', 'REC']);
  });
});

describe('ControlsStrip draws chips as the FM-1\'s sheet does', () => {
  it('the state\'s name, a chip per row, the held cap in gold, and nothing redrawn when nothing changed', () => {
    const s = new ControlsStrip();
    expect(s.el.hidden).toBe(true);
    s.draw(at('step'), 'emu');
    expect(s.el.hidden).toBe(false);
    expect(s.el.querySelector('.cs-name')!.textContent).toBe('STEP RECORD');
    expect([...s.el.querySelectorAll('.cs-rows:not(.cs-everywhere) .cs-chip')].map((c) => (c as HTMLElement).dataset.row)).toEqual(tableRows('step', 'state'));
    expect(s.el.querySelector('.cs-from')!.textContent).toContain('Emu');
    const first = s.el.firstChild;
    s.draw(at('step'), 'emu');
    expect(s.el.firstChild, 'the same state: not redrawn').toBe(first);
    s.draw(at('roll', { held: 1 << BUTTON_ID.SEL }), 'fm1');
    expect(s.el.classList.contains('mod')).toBe(true);
    expect(s.el.querySelector('.cs-name')!.textContent).toBe('SEL +');
    expect(s.el.querySelector('.cs-cap.held')!.textContent).toBe('SEL');
    expect(s.el.querySelector('.cs-everywhere')).toBeNull();
    expect(s.el.querySelector('.cs-from')!.textContent).toContain('your FM-1');
    s.draw(null, 'emu');
    expect(s.el.hidden).toBe(true);
  });
});
