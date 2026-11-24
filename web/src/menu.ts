// SPDX-License-Identifier: GPL-3.0-only
// A small menu: the PATCH panel's ⋯, the mobile bar's Patch ⋯ (#152), and every card's ⋯ and right-click menu. The cards'
// .ctx look, fixed to the window in the top layer, under the rule every menu and popover follows (popover.ts openFloat):
// one at a time, a press anywhere else, Escape or Tab closes it.

import { closeFloat, floatOpen, openFloat } from './popover';

export type MenuItem = { text: string; run: () => void; key?: string; danger?: boolean; rule?: boolean };

/** open `items` under `anchor` (above it when there is no room below), or at a point of the window (`at`: a right-click's;
 *  `end`: the menu's right edge there). A second call for the same anchor closes it. The first item takes the focus; the
 *  arrows, Home and End move it; Escape closes and gives the focus back to `anchor`. */
export function popMenu(items: MenuItem[], anchor: HTMLElement | null, at?: { x: number; y: number; end?: boolean }): void {
  const again = !!anchor && floatOpen(anchor);
  closeFloat();
  if (again) return;
  const menu = document.createElement('div');
  menu.className = 'ctx ctx-fixed';
  menu.setAttribute('role', 'menu');
  const label = anchor?.getAttribute('aria-label');
  if (label) menu.setAttribute('aria-label', label);
  const buttons = items.map((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.className = (it.danger ? 'danger' : '') + (it.rule ? ' rule' : '');
    const text = document.createElement('span');
    text.textContent = it.text;
    b.append(text);
    if (it.key) {
      const k = document.createElement('kbd');
      k.textContent = it.key;
      b.append(k);
    }
    b.onclick = (e) => {
      e.stopPropagation();
      closeFloat();
      it.run();
    };
    menu.append(b);
    return b;
  });
  menu.onkeydown = (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const n = buttons.length;
    const to = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      buttons[to].focus();
    } else if (e.key === 'Tab') closeFloat();
  };
  // (inside a modal dialog, such as Add effect, the menu goes into it: the page under a modal takes no clicks)
  (anchor?.closest('dialog[open]') ?? document.body).append(menu);
  openFloat(menu, { owner: anchor ?? menu, anchor, onClose: () => anchor?.setAttribute('aria-expanded', 'false') });
  const r = menu.getBoundingClientRect();
  const left = at ? (at.end ? at.x - r.width : at.x) : anchor!.getBoundingClientRect().left;
  // under its button (or the point), else above it, on the side with more room; scrolling when taller than that room, so it
  // never covers its button
  const a = anchor && (!at || at.end) ? anchor.getBoundingClientRect() : { top: at!.y, bottom: at!.y - 4 };
  const below = innerHeight - 8 - (a.bottom + 4), above = a.top - 4 - 8;
  const down = r.height <= below || below >= above;
  const room = down ? below : above;
  if (r.height > room) menu.style.maxHeight = `${room}px`;
  const top = down ? a.bottom + 4 : a.top - 4 - Math.min(r.height, room);
  Object.assign(menu.style, { left: `${Math.max(8, Math.min(left, innerWidth - r.width - 8))}px`, top: `${Math.max(8, top)}px` });
  anchor?.setAttribute('aria-expanded', 'true');
  buttons[0]?.focus();
}
