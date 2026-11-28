// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
// Consolidate the FM-1's palette: the one confirmation that lists every change (consolidate-view.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { askConsolidate, type ConsolidateStep, stepLine } from './consolidate-view';
import { closeFloat } from './popover';

const hera: ConsolidateStep = { pos: 1, from: { slot: 23, name: 'HERA 6 PLUCKPAD' }, to: { slot: 22, name: 'HERA 6' }, presets: ['Hera 6 pluckpad'], free: true };
const kept: ConsolidateStep = {
  pos: 4, from: { slot: 30, name: 'MONOLITH DARK' }, to: { slot: 29, name: 'MONOLITH' }, presets: ['Dark', 'Dark drums'], free: false,
  keep: 'palette 6 also uses it', plays: 'tempo',
};
/** a Fold anyway step (owner 2026-11-28: "fold anyway (b)"): the entry takes the base slot's settings no preset holds */
const padding: ConsolidateStep = {
  pos: 4, from: { slot: 21, name: 'PADDING' }, to: { slot: 3, name: 'HERA 6' }, presets: ['PADDING'], free: true,
  adopts: ['Output level 1.00 → 0.39', 'FX button unassigned → gate'],
};

const form = (): HTMLFormElement => document.querySelector<HTMLFormElement>('form.consolidate')!;
const boxes = (): HTMLInputElement[] => [...form().querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
const ok = (): HTMLButtonElement => form().querySelector<HTMLButtonElement>('button.primary')!;
const key = (t: EventTarget, k: string): void => { t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };
const tick = (b: HTMLInputElement, on: boolean): void => {
  b.checked = on;
  b.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('stepLine', () => {
  it('position and slots 1-based, the preset named, the freed slot said', () => {
    expect(stepLine(hera)).toBe('2 · HERA 6 PLUCKPAD → slot 23 · HERA 6 with preset Hera 6 pluckpad; slot 24 freed');
  });
  it('several presets listed; a kept slot is left to its note', () => {
    expect(stepLine(kept)).toBe('5 · MONOLITH DARK → slot 30 · MONOLITH with presets Dark and Dark drums');
    expect(stepLine({ ...kept, presets: ['A', 'B', 'C'] })).toBe('5 · MONOLITH DARK → slot 30 · MONOLITH with presets A, B and C');
    expect(stepLine({ ...hera, presets: [] })).toBe('2 · HERA 6 PLUCKPAD → slot 23 · HERA 6; slot 24 freed');
  });
});

describe('askConsolidate', () => {
  afterEach(() => {
    closeFloat();
    document.body.innerHTML = '';
  });

  it('one row per step, all ticked, with the kept and plays notes; Consolidate takes them all', async () => {
    const got = askConsolidate([hera, kept]);
    expect(form().getAttribute('popover')).toBe('manual');   // (a popover like every other, D-1423)
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
    const rows = [...form().querySelectorAll('.consolidate-step')];
    expect(rows[0].querySelector('.consolidate-line')!.textContent).toBe(stepLine(hera));
    expect(rows[0].querySelectorAll('.consolidate-note')).toHaveLength(0);
    expect([...rows[1].querySelectorAll('.consolidate-note')].map((n) => n.textContent)).toEqual(['slot 31 kept: palette 6 also uses it', "plays slot 30's tempo"]);
    ok().click();
    expect(await got).toEqual([hera, kept]);
    expect(document.querySelector('form.consolidate')).toBeNull();
  });

  it('an unticked step is left out; with none ticked Consolidate is disabled', async () => {
    const got = askConsolidate([hera, kept]);
    tick(boxes()[0], false);
    expect(ok().disabled).toBe(false);
    tick(boxes()[1], false);
    expect(ok().disabled).toBe(true);
    key(boxes()[1], 'Enter');
    expect(form(), 'Enter does nothing with none ticked').not.toBeNull();
    tick(boxes()[1], true);
    key(boxes()[1], 'Enter');
    expect(await got).toEqual([kept]);
  });

  it('a Fold anyway row starts unticked and lists every setting it takes from the slot; ticked, it is taken', async () => {
    const got = askConsolidate([hera, padding]);
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);
    expect(form().querySelector('.consolidate-text')!.textContent).toContain('A Fold anyway entry differs from that slot in settings no preset holds');
    const row = form().querySelectorAll('.consolidate-step')[1];
    expect(row.querySelector('.consolidate-line')!.textContent).toBe('5 · PADDING → slot 4 · HERA 6 with preset PADDING; slot 22 freed');
    expect([...row.querySelectorAll('.consolidate-note')].map((n) => n.textContent)).toEqual(["Fold anyway: it takes slot 4's Output level 1.00 → 0.39; FX button unassigned → gate"]);
    tick(boxes()[1], true);
    ok().click();
    expect(await got).toEqual([hera, padding]);
  });

  it('with only Fold anyway rows nothing is ticked and Consolidate is disabled until one is', async () => {
    const got = askConsolidate([padding]);
    expect(ok().disabled).toBe(true);
    tick(boxes()[0], true);
    expect(ok().disabled).toBe(false);
    ok().click();
    expect(await got).toEqual([padding]);
  });

  it('Escape and Cancel answer null', async () => {
    const a = askConsolidate([hera]);
    key(document.body, 'Escape');
    expect(await a).toBeNull();
    const b = askConsolidate([hera]);
    form().querySelector<HTMLButtonElement>('button:not(.primary)')!.click();
    expect(await b).toBeNull();
  });
});
