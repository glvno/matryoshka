// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The closed FX drawer's tab (fxsound design C, D-1341): where it goes on the card's edge, which rows fit round the window
// of a free jack between the chain's jacks, what its mini bars show, and its level meter.
import { describe, expect, it } from 'vitest';
import { makeAssembly, promote } from './assembly';
import { FxMeters, meterLevel } from './fx-meter';
import { effectAmount, planTab, TAB_CLEAR, TAB_FOOT, TAB_HEAD, TAB_ROW } from './fx-tab';
import { DEFS } from './modules';
import { addModule, newPatch } from './patch';
import type { HostMsg } from './worklet';

/** the jacks' centres down a card's edge: 44 px for the first, 24 px apart (an instrument card's outputs) */
const jack = (i: number): number => 44 + 24 * i;

describe('planTab', () => {
  it('reaches up beside the header and down past the chain’s jacks and its rows, never over the free jack below', () => {
    const plan = planTab([jack(0), jack(1)], [jack(2), jack(3)], 210, 3);
    expect(plan.top).toBe(3);
    expect(plan.win).toBeNull();
    expect(plan.rows).toEqual([TAB_HEAD, TAB_HEAD + TAB_ROW, TAB_HEAD + 2 * TAB_ROW]);
    expect(plan.shown).toBe(3);
    expect(plan.top + plan.h).toBeGreaterThanOrEqual(jack(1) + 15);
    expect(plan.top + plan.h).toBeLessThanOrEqual(jack(2) - TAB_CLEAR);
  });

  it('turns the rows that do not fit above the next free jack into “+N”', () => {
    const plan = planTab([jack(0), jack(1)], [jack(2)], 210, 6);
    expect(plan.shown).toBe(2);
    expect(plan.rows).toHaveLength(3);   // (two effects, then "+4 more")
    expect(plan.top + plan.rows[2] + TAB_ROW + TAB_FOOT).toBeLessThanOrEqual(jack(2) - TAB_CLEAR);
  });

  it('starts below a free jack above the chain’s jacks', () => {
    const plan = planTab([jack(2), jack(3)], [jack(0), jack(1)], 210, 2);
    expect(plan.top).toBe(jack(1) + TAB_CLEAR);
    expect(plan.top).toBeLessThanOrEqual(jack(2) - 15);
  });

  it('keeps the window round a free jack between the chain’s jacks (D-1341), and no row covers it', () => {
    const plan = planTab([jack(0), jack(2)], [jack(1), jack(3)], 210, 2);
    expect(plan.win).toEqual([jack(0) + 13 - plan.top, jack(2) - 13 - plan.top]);
    const [w0, w1] = plan.win!;
    expect(jack(1) - plan.top).toBeGreaterThan(w0);
    expect(jack(1) - plan.top).toBeLessThan(w1);
    for (const y of plan.rows) expect(y + TAB_ROW <= w0 || y >= w1).toBe(true);
    expect(plan.rows).toEqual([TAB_HEAD, plan.win![1] + 1]);
    expect(plan.shown).toBe(2);
    expect(plan.top + plan.h).toBeLessThanOrEqual(jack(3) - TAB_CLEAR);
  });

  it('an empty drawer has one row, for “drop effects here”', () => {
    expect(planTab([jack(0), jack(1)], [], 120, 0)).toMatchObject({ shown: 0, rows: [TAB_HEAD] });
  });
});

describe('effectAmount', () => {
  it('is an effect’s mix as a share of its range, else its amount, else its first row', () => {
    const p = newPatch(DEFS, 'Amount');
    const chorus = addModule(p, DEFS.chorus, 0, 0);
    const a = makeAssembly(p, [chorus.id], 'Chorus');
    for (const pd of DEFS.chorus.params) promote(a, chorus.id, pd.name, p);
    const range = (name: string) => DEFS.chorus.params.find((pd) => pd.name === name)!;
    chorus.params.mix = range('mix').min + (range('mix').max - range('mix').min) / 4;
    expect(effectAmount(p, a)).toBeCloseTo(0.25);
    a.params = a.params.filter((r) => r.param !== 'mix');
    chorus.params.depth = range('depth').max;
    expect(effectAmount(p, a)).toBe(1);
    a.params = a.params.filter((r) => r.param !== 'depth');
    chorus.params[a.params[0].param] = range(a.params[0].param).min;
    expect(effectAmount(p, a)).toBe(0);
    a.params = [];
    expect(effectAmount(p, a)).toBeNull();
  });
});

describe('the tab’s level meter', () => {
  it('shows a peak on a 48 dB scale', () => {
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(10 ** (-24 / 20))).toBeCloseTo(0.5);
    expect(meterLevel(1e-4)).toBe(0);
    expect(meterLevel(0)).toBe(0);
  });

  it('streams each drawer’s outputs once, sets --lv from what comes back and falls back slowly; a meter gone stops its stream', () => {
    const sent: HostMsg[] = [];
    const meters = new FxMeters((m) => sent.push(m));
    const el = document.createElement('span');
    const chans = [[{ id: 3, port: 'out' }], [{ id: 4, port: 'out' }]];
    meters.sync([{ key: 'fxmeter:1', el, chans }]);
    meters.sync([{ key: 'fxmeter:1', el, chans }]);
    expect(sent).toEqual([{ t: 'view', key: 'fxmeter:1', chans, samples: 1024 }]);
    expect(meters.receive('fxmeter:1', [{ raw: new Float32Array([0, 0.5, -1]) }, { raw: new Float32Array(3) }])).toBe(true);
    expect(el.style.getPropertyValue('--lv')).toBe('100.0%');
    meters.receive('fxmeter:1', [{ raw: new Float32Array(3) }, { raw: new Float32Array(3) }]);
    expect(el.style.getPropertyValue('--lv')).toBe('96.0%');
    expect(meters.receive('scope:9', [])).toBe(false);
    meters.sync([]);
    expect(sent.at(-1)).toEqual({ t: 'unview', key: 'fxmeter:1' });
  });
});
