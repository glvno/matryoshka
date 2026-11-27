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

  it('Escape and Cancel answer null', async () => {
    const a = askConsolidate([hera]);
    key(document.body, 'Escape');
    expect(await a).toBeNull();
    const b = askConsolidate([hera]);
    form().querySelector<HTMLButtonElement>('button:not(.primary)')!.click();
    expect(await b).toBeNull();
  });
});
