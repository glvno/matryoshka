// SPDX-License-Identifier: GPL-3.0-only
// A one-line message at the bottom of the window with an Undo button: deletions act at once and offer this instead of
// asking first (the app never opens a browser dialog for them). The patch menu's results use a plain one; Connect FM-1
// offers Install Matryoshka in one (showAction); a full palette says so just above its chips (`near`). One toast at a
// time; a new one replaces it.

const SHOW_MS = 8000;
let current: { el: HTMLElement; timer: number } | null = null;

function dismiss(): void {
  if (!current) return;
  clearTimeout(current.timer);
  current.el.remove();
  current = null;
}

/** put toast `el` just above `near`, its right edge on near's (where the user is looking), when near is on screen; else
 *  it stays at the bottom of the window */
function place(el: HTMLElement, near: HTMLElement | undefined): void {
  const r = near?.getBoundingClientRect();
  if (!r?.width || !r.height) return;
  el.classList.add('toast-near');
  el.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`;
  el.style.right = `${Math.round(Math.max(16, innerWidth - r.right))}px`;
}

/** show `text` with an Undo button for a few seconds; `undo` runs at most once. Returns whether this toast still shows */
export function showUndo(text: string, undo: () => void): () => boolean {
  return showAction(text, 'Undo', undo);
}

/** show `text` with one action button (`label`) for a few seconds; `run` runs at most once; `near`: just above that
 *  element. Returns whether this toast still shows */
export function showAction(text: string, label: string, run: () => void, ms = SHOW_MS, near?: HTMLElement): () => boolean {
  dismiss();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = text;
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.onclick = () => {
    dismiss();
    run();
  };
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '×';
  close.title = 'Dismiss';
  close.onclick = dismiss;
  el.append(msg, btn, close);
  document.body.append(el);
  place(el, near);
  current = { el, timer: window.setTimeout(dismiss, ms) };
  return () => current?.el === el;
}

/** show a plain message for a few seconds, with a close button (what a patch menu action did, #152) */
export function showToast(text: string, ms = SHOW_MS / 2): void {
  dismiss();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = text;
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '×';
  close.title = 'Dismiss';
  close.onclick = dismiss;
  el.append(msg, close);
  document.body.append(el);
  current = { el, timer: window.setTimeout(dismiss, ms) };
}
