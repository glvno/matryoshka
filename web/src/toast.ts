// SPDX-License-Identifier: GPL-3.0-only
// A one-line message at the bottom of the window with an Undo button: deletions act at once and offer this instead of
// asking first (the app never opens a browser dialog for them). One toast at a time; a new one replaces it.

const SHOW_MS = 8000;
let current: { el: HTMLElement; timer: number } | null = null;

function dismiss(): void {
  if (!current) return;
  clearTimeout(current.timer);
  current.el.remove();
  current = null;
}

/** show `text` with an Undo button for a few seconds; `undo` runs at most once */
export function showUndo(text: string, undo: () => void): void {
  dismiss();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = text;
  const btn = document.createElement('button');
  btn.textContent = 'Undo';
  btn.onclick = () => {
    dismiss();
    undo();
  };
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '×';
  close.title = 'Dismiss';
  close.onclick = dismiss;
  el.append(msg, btn, close);
  document.body.append(el);
  current = { el, timer: window.setTimeout(dismiss, SHOW_MS) };
}
