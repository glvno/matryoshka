// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
// The rule every menu and popover in the editor follows (popover.ts, D-1423): one open at a time, on top, closed by
// Escape, a press outside it, a press on what opened it (its opener's own handler) or its ×.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeButton, closeFloat, closeOrphanFloat, floatOpen, openFloat } from './popover';

const el = (cls: string): HTMLElement => {
  const d = document.createElement('div');
  d.className = cls;
  return d;
};
const button = (): HTMLButtonElement => {
  const b = document.createElement('button');
  document.body.append(b);
  return b;
};
const press = (t: EventTarget): void => { t.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); };
const escape = (): void => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); };

describe('the rule of every menu and popover (D-1423)', () => {
  afterEach(() => {
    closeFloat();
    document.body.innerHTML = '';
  });

  it('one at a time: opening another closes the first (its onClose runs once)', () => {
    const closed = vi.fn();
    const a = el('first');
    openFloat(a, { owner: 'a', anchor: button(), onClose: closed });
    expect(a.getAttribute('popover')).toBe('manual');   // (the top layer: above every card, the dock and the panels)
    openFloat(el('second'), { owner: 'b', anchor: button() });
    expect(document.querySelector('.first')).toBeNull();
    expect(document.querySelectorAll('.second')).toHaveLength(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(floatOpen('b')).toBe(true);
  });

  it('Escape closes it and gives the focus back to its opener; the app does not also see that Escape', () => {
    const opener = button();
    const app = vi.fn();
    window.addEventListener('keydown', app);
    openFloat(el('pop'), { owner: 'x', anchor: opener });
    escape();
    window.removeEventListener('keydown', app);
    expect(document.querySelector('.pop')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(app).not.toHaveBeenCalled();
  });

  it('a press outside closes it; a press inside it or on its opener does not (the opener toggles it itself)', () => {
    const opener = button();
    const pop = el('pop');
    pop.append(button());
    openFloat(pop, { owner: 'x', anchor: opener });
    press(pop.querySelector('button')!);
    press(opener);
    expect(floatOpen('x')).toBe(true);
    press(document.body);
    expect(floatOpen('x')).toBe(false);
    expect(document.querySelector('.pop')).toBeNull();
  });

  it('its opener found again after a redraw; keepOn spares a press (the button editor and Alt-click)', () => {
    let opener = button();
    openFloat(el('pop'), { owner: 'x', anchor: () => opener, keepOn: (e) => e.altKey });
    opener.remove();
    opener = button();                       // (the dock redrawn: a new button)
    press(opener);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, altKey: true }));
    closeOrphanFloat();
    expect(floatOpen('x')).toBe(true);
    opener.remove();                         // (its card deleted)
    closeOrphanFloat();
    expect(floatOpen('x')).toBe(false);
  });

  it('its × closes it; a kept one (a details’ content) stays in the page, only closed', () => {
    const pop = el('pop');
    pop.append(closeButton('the thing'));
    openFloat(pop, { owner: 'x', anchor: button() });
    const x = pop.querySelector<HTMLButtonElement>('.float-close')!;
    expect(x.getAttribute('aria-label')).toBe('Close the thing');
    x.click();
    expect(floatOpen('x')).toBe(false);
    const details = document.createElement('details');
    const kept = el('kept');
    details.append(kept);
    document.body.append(details);
    openFloat(kept, { owner: details, anchor: button(), keep: true });
    closeFloat(false, 'someone else');
    expect(floatOpen(details)).toBe(true);
    closeFloat(false, details);
    expect(kept.isConnected).toBe(true);
  });

  it('a closed popover never shows, whatever display its own class gives it (the button editor’s flex kept closed ones on screen)', () => {
    expect(readFileSync('src/style.css', 'utf8')).toMatch(/\[popover\]:not\(:popover-open\)\s*\{\s*display:\s*none\s*!important;\s*\}/);   // (vitest runs in web/)
  });
});
