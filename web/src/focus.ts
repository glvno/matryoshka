// SPDX-License-Identifier: GPL-3.0-only
// Focus policy: a mouse or touch interaction must not leave keyboard focus on the control it touched, or the next
// Space / Enter / arrow key goes to that control (re-ticking a check box, re-pressing a button, nudging a slider)
// instead of the app (Space = arpeggiator, arrows = nudge the selection, Delete = remove it). After a pointer
// interaction the focus is released back to the page. Keyboard users are unaffected: focus that was reached with
// Tab stays, with its :focus-visible ring. Typing fields keep their focus, as do controls inside an open dialog or menu.
// A region marked `data-keep-focus` (the Sound design sidebar, #1048, where ↑ ↓ go through the candidates) keeps it:
// the region itself takes it back from a button in it, so Space and Enter still reach the app.
import { isTextEntry } from './input';

export function releaseFocusAfterPointer(): void {
  let pointer = false;
  window.addEventListener('pointerdown', () => { pointer = true; }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Tab') pointer = false; }, true);
  const keeps = (el: HTMLElement): boolean => isTextEntry(el) || !!el.closest('dialog[open], [role=menu]');
  const release = (): void => {
    if (!pointer) return;
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body || keeps(el)) return;
    if (el.tagName === 'SELECT') return; // released on change: earlier would close the list it just opened
    const region = el.closest<HTMLElement>('[data-keep-focus]');
    if (!region) el.blur();
    else if (el.closest('button')) region.focus({ preventScroll: true });
  };
  // after the click that follows the pointerup (a check box toggles on click, a button acts on click)
  window.addEventListener('pointerup', () => requestAnimationFrame(release));
  window.addEventListener('pointercancel', () => requestAnimationFrame(release));
  window.addEventListener('change', (e) => {
    const t = e.target;
    if (pointer && t instanceof HTMLSelectElement && !keeps(t)) t.blur();
  }, true);
}
