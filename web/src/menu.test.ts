// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { popMenu, type MenuItem } from './menu';

const anchor = (): HTMLButtonElement => {
  const b = document.createElement('button');
  b.setAttribute('aria-label', 'Patch actions');
  document.body.append(b);
  return b;
};
const key = (k: string): void => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
};
const items = (): MenuItem[] => [
  { text: 'Share link', run: vi.fn() },
  { text: 'Save as .json', run: vi.fn() },
  { text: 'Delete', run: vi.fn(), danger: true, rule: true },
];
const menu = (): HTMLElement | null => document.querySelector('.ctx');

describe('the patch menu (popMenu, #152)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens under its button as a menu, the first item focused', () => {
    const a = anchor();
    popMenu(items(), a);
    expect(menu()?.getAttribute('role')).toBe('menu');
    expect(menu()?.getAttribute('aria-label')).toBe('Patch actions');
    expect([...menu()!.querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toEqual(['Share link', 'Save as .json', 'Delete']);
    expect(menu()!.querySelector('.danger.rule')?.textContent).toBe('Delete');
    expect(document.activeElement?.textContent).toBe('Share link');
    expect(a.getAttribute('aria-expanded')).toBe('true');
  });

  it('the arrows, Home and End move the focus, round the ends', () => {
    popMenu(items(), anchor());
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Save as .json');
    key('ArrowUp');
    key('ArrowUp');
    expect(document.activeElement?.textContent).toBe('Delete');
    key('Home');
    expect(document.activeElement?.textContent).toBe('Share link');
    key('End');
    expect(document.activeElement?.textContent).toBe('Delete');
  });

  it('Escape closes it and puts the focus back on its button', () => {
    const a = anchor();
    popMenu(items(), a);
    key('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(a);
    expect(a.getAttribute('aria-expanded')).toBe('false');
  });

  it('an item runs its action once and closes the menu', () => {
    const list = items();
    popMenu(list, anchor());
    (menu()!.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[1]).click();
    expect(list[1].run).toHaveBeenCalledTimes(1);
    expect(list[0].run).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it('a second press on its button closes it; a press elsewhere closes it', async () => {
    const a = anchor();
    popMenu(items(), a);
    popMenu(items(), a);
    expect(menu()).toBeNull();
    popMenu(items(), a);
    await new Promise((r) => setTimeout(r));
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu()).toBeNull();
    expect(a.getAttribute('aria-expanded')).toBe('false');
  });
});
