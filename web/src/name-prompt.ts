// SPDX-License-Identifier: GPL-3.0-only
// The name a sound goes into a palette under (owner 2026-11-24: "saving to palette from the web editor, either by dragging
// chip or selecting a menu item, should prompt you to give it a name"): a small popover by what the add came from, its
// field filled with the automatic name and selected. Enter or Add takes the name, Escape, Cancel or a press elsewhere
// cancels the add. One popover at a time, as every menu (popover.ts).
import { closeFloat, openFloat } from './popover';

/** ask for a name: `initial` filled in and selected, `title` above it (what the name is for), shown under `anchor` (the
 *  middle of the window without one). The name typed, trimmed; null when cancelled or left empty */
export function askName(o: { title: string; initial: string; anchor?: HTMLElement | null; ok?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const form = document.createElement('form');
    form.className = 'name-prompt';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-label', o.title);
    const label = document.createElement('label');
    label.className = 'name-prompt-title';
    label.textContent = o.title;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'name-prompt-input';
    input.value = o.initial;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', o.title);
    label.append(input);
    const actions = document.createElement('div');
    actions.className = 'name-prompt-actions';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'primary';
    ok.textContent = o.ok ?? 'Add';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => closeFloat(true, form);
    actions.append(ok, cancel);
    form.append(label, actions);
    form.onsubmit = (e) => {
      e.preventDefault();
      answer = input.value.trim() || null;
      closeFloat(true, form);
    };
    document.body.append(form);
    openFloat(form, { owner: form, anchor: o.anchor ?? null, back: o.anchor ?? undefined, onClose: () => resolve(answer) });
    const r = form.getBoundingClientRect();
    const a = o.anchor?.isConnected ? o.anchor.getBoundingClientRect() : null;
    const left = a ? a.left : (innerWidth - r.width) / 2;
    const top = a ? (a.bottom + 4 + r.height <= innerHeight - 8 ? a.bottom + 4 : a.top - 4 - r.height) : innerHeight / 3;
    Object.assign(form.style, { left: `${Math.max(8, Math.min(left, innerWidth - r.width - 8))}px`, top: `${Math.max(8, top)}px` });
    input.focus();
    input.select();
  });
}
