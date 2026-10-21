// SPDX-License-Identifier: GPL-3.0-only
// A small menu under a button (the PATCH panel's ⋯ and the mobile bar's Patch ⋯, #152): the cards' ⋯ menu look (.ctx), but
// fixed to the window, so it works outside the canvas. One menu at a time; a press anywhere else, Escape or Tab closes it.

export type MenuItem = { text: string; run: () => void; key?: string; danger?: boolean; rule?: boolean };

let current: { menu: HTMLElement; anchor: HTMLElement; close: (refocus: boolean) => void } | null = null;

/** open `items` under `anchor` (above it when there is no room below); a second call for the same anchor closes it.
 *  The first item takes the focus; the arrows, Home and End move it; Escape closes and gives the focus back to `anchor`. */
export function popMenu(items: MenuItem[], anchor: HTMLElement): void {
  const again = current?.anchor === anchor && current.menu.isConnected; // (a card's menu removes any .ctx)
  current?.close(false);
  document.querySelector('.ctx')?.remove();
  if (again) return;
  const menu = document.createElement('div');
  menu.className = 'ctx ctx-fixed';
  menu.setAttribute('role', 'menu');
  const label = anchor.getAttribute('aria-label');
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
      close(false);
      it.run();
    };
    menu.append(b);
    return b;
  });
  const away = (e: Event): void => {
    const t = e.target as Node;
    if (!menu.contains(t) && !anchor.contains(t)) close(false);
  };
  const close = (refocus: boolean): void => {
    menu.remove();
    window.removeEventListener('pointerdown', away, true);
    anchor.setAttribute('aria-expanded', 'false');
    if (current?.menu === menu) current = null;
    if (refocus) anchor.focus();
  };
  menu.onkeydown = (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const n = buttons.length;
    const to = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      buttons[to].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') close(false);
  };
  document.body.append(menu);
  const a = anchor.getBoundingClientRect();
  const r = menu.getBoundingClientRect();
  const below = a.bottom + 4 + r.height <= innerHeight - 8;
  const top = below ? a.bottom + 4 : Math.max(8, a.top - 4 - r.height);
  const left = Math.max(8, Math.min(a.left, innerWidth - r.width - 8));
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  anchor.setAttribute('aria-expanded', 'true');
  current = { menu, anchor, close };
  setTimeout(() => window.addEventListener('pointerdown', away, true));
  buttons[0]?.focus();
}
