// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chipOf, chipOfBudget, sandboxCardDue, sandboxWords, showSandboxCard } from './sandbox';
import { PRESETS } from './presets';

const budget = (cpu: number, memory: number) => ({ cpu: { use: cpu } as never, memory });

describe('sandbox patches', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  it('reads a chip: FM-1 and how full, or SANDBOX', () => {
    expect(chipOfBudget({ fits: true, use: 0.844 })).toEqual({ fits: true, text: 'FM-1 · 84 %' });
    expect(chipOfBudget({ fits: false, use: 2.66 })).toEqual({ fits: false, text: 'SANDBOX' });
    expect(chipOf(PRESETS.Init()).text).toMatch(/^FM-1 · \d+ %$/);
  });

  it('says how far over the FM-1 a sandbox patch is, rounded up so it never reads 1.0×', () => {
    expect(sandboxWords(budget(2.66, 2.05))).toBe('Plays here, with no FM-1 limits: 2.7× its CPU, 2.1× its memory.');
    expect(sandboxWords(budget(0.5, 1.01))).toBe('Plays here, with no FM-1 limits: 1.1× its memory.');
    expect(sandboxWords({ ...budget(0.5, 0.4), over: [{ key: 'browser', label: 'Delay over 520 ms: browser only', used: 1, max: 0 }] })).toBe('Plays here, with no FM-1 limits: Delay over 520 ms.');
    expect(sandboxWords(budget(1.3, 0.9))).toBe('Plays here, with no FM-1 limits: 1.3× its CPU.');
    expect(sandboxWords(budget(0.5, 0.5))).toBe('Plays here, with no FM-1 limits.');
  });

  it('shows the first-time card once per browser; What costs most opens the breakdown', () => {
    expect(sandboxCardDue()).toBe(true);
    const costs = vi.fn();
    showSandboxCard({ costs });
    expect(sandboxCardDue()).toBe(false);
    const card = document.querySelector('.sandbox-card')!;
    expect(card.textContent).toContain('No limits here');
    expect(card.textContent).toContain('Your FM-1 is the controller.');
    [...card.querySelectorAll('button')].find((b) => b.textContent === 'What costs most')!.click();
    expect(costs).toHaveBeenCalledOnce();
    expect(document.querySelector('.sandbox-card')).toBeNull();
    showSandboxCard({ costs }); // from the pill, any time
    [...document.querySelectorAll('.sandbox-card button')].find((b) => b.textContent === 'Got it')!.dispatchEvent(new MouseEvent('click'));
    expect(document.querySelector('.sandbox-card')).toBeNull();
  });
});
