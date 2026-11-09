// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { BUTTON_ID, CONDITIONS, CONTROLS, HELP_STATE_NAME, HELP_STATES, sheetRows, stateRows, stripDoes, type Condition, type ControlRow, type HelpState } from './controls';
import { ControlsStrip, conditionHolds, heldButtons, knobsOnlyHeld, MORE_KEY, SHEET_ROWS, stripPatch, stripView, type StripInput } from './controls-strip';
import { setKind, setPages } from './buttons';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { binaryPage } from './patchbin';
import { devicesOf } from './pages';

/** Main, an oscillator into a VCA into the Output; FX a Toggle of the VCA labelled DRIVE, LFO a Gate with no cable (no
 * job), EDIT a Page button, ARP a Gate cabled into the VCA's cv that switches */
function rig(): { p: Patch; osc: number } {
  const p = emptyPatch('t');
  const main = addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 200, 0);
  const vca = addModule(p, DEFS.vca, 400, 0);
  const out = addModule(p, DEFS.output, 600, 0);
  connect(p, DEFS, { module: main.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: vca.id, port: 'in' });
  connect(p, DEFS, { module: vca.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: main.id, port: 'arp' }, { module: vca.id, port: 'cv' });
  setKind(p, 'fx', 'bypass');
  main.panel = { ...main.panel, targets: { fx: { module: vca.id } }, labels: { fx: 'DRIVE' }, toggle: ['arp'] };
  setKind(p, 'lfo', 'gate');
  setKind(p, 'edit', 'page');
  setPages(p, 'edit', [{ device: `m${osc.id}`, page: 0 }]);
  setKind(p, 'arp', 'gate');
  return { p, osc: osc.id };
}

/** every condition holding (bit c: CONDITIONS[c - 1]) */
const ALL_CONDS = CONDITIONS.reduce((m, _c, i) => m | (1 << (i + 1)), 0);
const cond = (...on: Condition[]): number => on.reduce((m, c) => m | (1 << (CONDITIONS.indexOf(c) + 1)), 0);
const at = (s: HelpState, o: Partial<StripInput> = {}): StripInput => ({ state: HELP_STATES.indexOf(s), held: 0, stepHeld: false, conditions: ALL_CONDS, ...o });
const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);
/** the table's rows of a state's tab, in its order, whose condition holds (all conditions on: the positive ones) */
const tableRows = (s: HelpState, tab: 'state' | 'everywhere', conds = ALL_CONDS): string[] =>
  sheetRows(s, tab).filter((r): r is ControlRow => 'gesture' in r).filter((r) => conditionHolds(r.when, conds)).map((r) => r.id);

describe('the controls strip is made from the controls table (#554, controls.ts)', () => {
  it.each(HELP_STATES)('%s: the state\'s rows and its EVERYWHERE rows, in the table\'s order', (s) => {
    const v = stripView(at(s));
    expect(v.state).toBe(s);
    expect(v.name).toBe(HELP_STATE_NAME[s]);
    expect(v.held).toBeNull();
    expect(ids([...v.rows, ...v.more])).toEqual(tableRows(s, 'state'));
    expect(v.rows.length, 'the sheet\'s first screen').toBe(Math.min(SHEET_ROWS, tableRows(s, 'state').length));
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

  it('a held drum step: velocity, chance and locks, with K1..K4 named after them', () => {
    const v = stripView(at('drum', { stepHeld: true }));
    expect(v.held).toBe('step');
    expect(ids(v.rows)).toEqual(['held-velocity', 'held-chance-select', 'lock-pages', 'lock-rows']);
    expect(v.knobs).toEqual(['p-lock rows', 'velocity', 'p-lock rows', 'p-lock rows']);
  });

  it('a held button with EVERYWHERE rows (PLAY: tempo), and one with nothing held + it (the state\'s own rows)', () => {
    expect(ids(stripView(at('device', { held: 1 << BUTTON_ID.PLAY })).rows)).toEqual(['tempo']);
    const lfo = stripView(at('device', { held: 1 << BUTTON_ID.LFO }));
    expect(lfo.held).toBeNull();
    expect(ids([...lfo.rows, ...lfo.more])).toEqual(tableRows('device', 'state'));   // (a busy DEVICE tab: past SHEET_ROWS behind "+N more", D-917)
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

  it('a long state: the sheet\'s first 8 rows, the rest behind "+N more" (the patch buttons count, as on the sheet)', () => {
    const sp = stripPatch(rig().p);
    const v = stripView(at('device'), sp);
    const all = sheetRows('device', 'state').flatMap((r) => ('gesture' in r ? (conditionHolds(r.when, ALL_CONDS) ? [r.id] : []) : sp.buttons.map((b) => b.id)));
    expect(ids([...v.rows, ...v.more])).toEqual(all);
    expect(v.rows).toHaveLength(SHEET_ROWS);
    expect(v.more.length).toBe(all.length - SHEET_ROWS);
    expect(ids(v.everywhere), 'EVERYWHERE as now: never cut').toEqual(tableRows('device', 'everywhere'));
  });

  it('the patch buttons with a job, worded as the sheet lists them (help_ui.c help_patch_rows), where PATCH_BUTTONS sits', () => {
    const sp = stripPatch(rig().p);
    expect(sp.buttons).toEqual([
      { id: 'patch-fx', button: 'FX', does: 'drive on/off' },
      { id: 'patch-edit', button: 'EDIT', does: 'edit pages' },
      { id: 'patch-arp', button: 'ARP', does: 'arp on/off' },
    ]);
    const plain = stripView(at('device', { conditions: 0 }), sp);
    const order = ids([...plain.rows, ...plain.more]);
    expect(order.slice(-3), 'last on the device tab (PATCH_BUTTONS: 100)').toEqual(['patch-fx', 'patch-edit', 'patch-arp']);
    expect(ids([...stripView(at('roll'), sp).rows, ...stripView(at('roll'), sp).more])).not.toContain('patch-fx');
    expect(stripPatch(emptyPatch('none')).buttons, 'no Main: no patch buttons').toEqual([]);
  });

  it('a device page: K1..K4 named after the rows of the page in focus; without the patch, the table\'s words', () => {
    const { p, osc } = rig();
    const sp = stripPatch(p);
    const [d, pg] = binaryPage(p, `m${osc}`, 0)!;
    const want = devicesOf(p, DEFS).find((x) => x.key === `m${osc}`)!.pages[0].rows.slice(0, 4).map((r) => r.label);
    const v = stripView(at('device', { device: d, devicePage: pg }), sp);
    expect(v.knobs).toEqual([0, 1, 2, 3].map((k) => want[k] ?? ''));
    expect(v.knobs!.filter(Boolean).length).toBeGreaterThan(0);
    expect(stripView(at('device', { device: d, devicePage: pg }, ), null).knobs).toEqual(Array(4).fill('adjust values'));
    expect(stripView(at('device', { device: d, devicePage: pg, held: 1 << BUTTON_ID.HOME }), sp).knobs, 'HOME held: fine turns of the same rows').toEqual(v.knobs);
    expect(stripView(at('env', { device: d, devicePage: pg }), sp).knobs, 'elsewhere: the table').toEqual(Array(4).fill('device pg.1 params'));
  });

  it('the piano roll has no step knobs; a held drum step has its editing knobs', () => {
    expect(['roll', 'drum'].filter((s) => knobsOnlyHeld(s as HelpState))).toEqual(['drum']);
    expect(HELP_STATES.filter(knobsOnlyHeld)).toEqual(['drum']);
    expect(stripView(at('roll')).knobs).toBeNull();
    expect(stripView(at('drum')).knobs).toBeNull();
    expect(stripView(at('roll', { stepHeld: true })).knobs).toBeNull();
    expect(stripView(at('drum', { stepHeld: true })).knobs).toEqual(['p-lock rows', 'velocity', 'p-lock rows', 'p-lock rows']);
    expect(stripView(at('step')).knobs, 'step record: K4 the cursor, no step to hold').toEqual(['', '', '', 'move cursor']);
  });

  it('heldButtons names the buttons by matrix id (OCT- and OCT+, not the OCT alias)', () => {
    expect(heldButtons((1 << BUTTON_ID['OCT-']) | (1 << BUTTON_ID['OCT+']) | (1 << BUTTON_ID.REC))).toEqual(['OCT-', 'OCT+', 'REC']);
  });
});

describe('ControlsStrip draws chips as the FM-1\'s sheet does', () => {
  it('the state\'s name, a chip per row, the held cap in gold, and nothing redrawn when nothing changed', () => {
    localStorage.removeItem(MORE_KEY);
    const s = new ControlsStrip();
    expect(s.el.hidden).toBe(true);
    s.draw(at('step'), 'emu');
    expect(s.el.hidden).toBe(false);
    expect(s.el.querySelector('.cs-name')!.textContent).toBe('STEP RECORD');
    expect([...s.el.querySelectorAll('.cs-rows:not(.cs-everywhere) .cs-chip')].map((c) => (c as HTMLElement).dataset.row)).toEqual(tableRows('step', 'state').slice(0, SHEET_ROWS));
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

  it('a chip says what the row does in the strip\'s own words (`strip`, `stripIn` by state), not the sheet\'s short ones', () => {
    localStorage.setItem(MORE_KEY, '1');
    const words = (s: ControlsStrip, id: string): string | null | undefined => s.el.querySelector(`[data-row="${id}"] .cs-does`)?.textContent;
    const s = new ControlsStrip();
    s.draw(at('roll'), 'emu');
    expect(words(s, 'roll-keys')).toBe('play each key’s own note without changing the pattern');
    expect(words(s, 'step')).toBeUndefined();
    expect(words(s, 'step-record-there')).toBe('step record starting from that step');
    expect(words(s, 'home'), 'EVERYWHERE too').toBe('go back one step');
    s.draw(at('drum'), 'emu');
    expect(words(s, 'step'), 'stripIn: the drum grid\'s own').toBe('turn the selected sound on or off at that step');
    s.draw(at('device', { conditions: cond('list') }), 'emu');
    expect(words(s, 'list-home'), '{list}: the Page button').toBe("leave the Page button's pages, back where you were");
    // a row without them: its words off the sheet (plain), then the sheet's
    const row = CONTROLS.find((r) => r.id === 'roll-keys')!;
    const was = row.strip;
    try {
      delete row.strip;
      s.draw(at('roll', { held: 1 }), 'emu');
      s.draw(at('roll'), 'emu');
      expect(words(s, 'roll-keys')).toBe(row.does);
    } finally { row.strip = was; }
    localStorage.removeItem(MORE_KEY);
  });

  it('every row the strip can show has its own words, 3 words or more', () => {
    for (const s of HELP_STATES) for (const r of [...stateRows(s), ...sheetRows(s, 'everywhere', true).filter((x): x is ControlRow => 'gesture' in x)]) {
      expect(r.strip, `${s}: ${r.id}`).toBeTruthy();
      expect(stripDoes(r, s).split(' ').length, `${s}: ${r.id}: ${stripDoes(r, s)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('"+N more" shows every row and back; the choice is kept for this viewer', () => {
    localStorage.removeItem(MORE_KEY);
    const sp = stripPatch(rig().p);
    const s = new ControlsStrip();
    s.draw(at('device'), 'emu', sp);
    const chips = (x: ControlsStrip): number => x.el.querySelectorAll('.cs-rows:not(.cs-everywhere) .cs-chip').length;
    const v = stripView(at('device'), sp);
    expect(chips(s)).toBe(SHEET_ROWS);
    const more = s.el.querySelector<HTMLButtonElement>('.cs-more')!;
    expect(more.textContent).toBe(`+${v.more.length} more`);
    more.click();
    expect(chips(s)).toBe(SHEET_ROWS + v.more.length);
    expect(s.el.querySelector('.cs-more')!.textContent).toBe('fewer');
    expect(s.el.querySelectorAll('.cs-chip.patch').length).toBe(3);
    expect(localStorage.getItem(MORE_KEY)).toBe('1');
    const again = new ControlsStrip();
    again.draw(at('device'), 'emu', sp);
    expect(chips(again), 'a new visit: still expanded').toBe(SHEET_ROWS + v.more.length);
    again.el.querySelector<HTMLButtonElement>('.cs-more')!.click();
    expect(chips(again)).toBe(SHEET_ROWS);
    expect(localStorage.getItem(MORE_KEY)).toBe('0');
    s.draw(at('sandbox'), 'emu', sp);
    expect(s.el.querySelector('.cs-more'), 'a state that fits: no toggle').toBeNull();
  });

  it('the K1..K4 column: hidden on the piano roll, the page\'s names on a device page', () => {
    const { p, osc } = rig();
    const sp = stripPatch(p);
    const s = new ControlsStrip();
    s.draw(at('roll'), 'emu', sp);
    expect(s.el.querySelector('.cs-kmap')).toBeNull();
    expect(s.el.classList.contains('no-kmap')).toBe(true);
    s.draw(at('roll', { stepHeld: true }), 'emu', sp);
    expect(s.el.querySelector('.cs-kmap')).toBeNull();
    const [d, pg] = binaryPage(p, `m${osc}`, 0)!;
    s.draw(at('device', { device: d, devicePage: pg }), 'emu', sp);
    expect(s.el.classList.contains('no-kmap')).toBe(false);
    expect([...s.el.querySelectorAll('.cs-kmap > div')].map((k) => k.lastChild!.textContent)).toEqual(stripView(at('device', { device: d, devicePage: pg }), sp).knobs!.map((t) => t || '–'));
  });
});
