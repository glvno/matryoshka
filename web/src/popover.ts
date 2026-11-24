// SPDX-License-Identifier: GPL-3.0-only
// The editor's one rule for its menus and popovers (D-1423): one open at a time, opening another closes it; it sits in the
// top layer, above every card, drawer, the dock and the side panels; Escape, a press outside it, a press on what opened
// it, or a panel's × closes it. Every menu and popover opens through `openFloat`.

const anchors = new WeakMap<HTMLElement, HTMLElement>();

interface Float {
  el: HTMLElement;
  owner: unknown;
  anchor: () => Element | null | undefined;
  onClose?: () => void;
  /** where the focus goes back to when Escape closes it */
  back?: HTMLElement;
  /** stays in the page when it closes (a details' content, made once): only hidden */
  keep?: boolean;
  /** a press outside it that leaves it open (the button editor's Alt-click on a card row) */
  keepOn?: (e: PointerEvent) => boolean;
}
let current: Float | null = null;

/** the menu or popover open now is `owner`'s */
export const floatOpen = (owner: unknown): boolean => !!current && current.owner === owner;

const away = (e: PointerEvent): void => {
  const t = e.target as Node;
  if (!current || current.el.contains(t) || current.anchor()?.contains(t) || current.keepOn?.(e)) return;   // (its opener toggles it itself)
  closeFloat();
};
const escape = (e: KeyboardEvent): void => {
  if (e.key !== 'Escape' || !current) return;
  e.preventDefault();
  e.stopPropagation();   // (not also the app's Escape: one press closes one thing)
  closeFloat(true);
};

/**
 * Open `el` as the menu or popover: whatever was open closes first, `el` goes in the top layer (a manual popover: this
 * file does the dismissing), and Escape, a press outside it and its anchor, or `closeFloat` closes it. `owner` names it
 * for `floatOpen` (a button that opened it closes it on its next press); `anchor` is what opened it (a press there is
 * left to its handler), a function when a redraw replaces it; `onClose` runs once when it closes, however it closes. It is
 * taken out of the page when it closes unless `keep`.
 */
export function openFloat(el: HTMLElement, o: Omit<Float, 'el' | 'anchor'> & { anchor?: Element | null | (() => Element | null | undefined) }): void {
  closeFloat();
  if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
  if (!el.isConnected) document.body.append(el);
  if (typeof el.showPopover === 'function' && !el.matches(':popover-open')) el.showPopover();
  const a = o.anchor;
  current = { ...o, el, anchor: typeof a === 'function' ? a : () => a };
  window.addEventListener('pointerdown', away, true);
  window.addEventListener('keydown', escape, true);
}

/** close the menu or popover open now (if `owner` is given, only that one's); `refocus`: the focus goes back to its opener */
export function closeFloat(refocus = false, owner?: unknown): void {
  const f = current;
  if (!f || (owner !== undefined && f.owner !== owner)) return;
  current = null;
  window.removeEventListener('pointerdown', away, true);
  window.removeEventListener('keydown', escape, true);
  if (typeof f.el.hidePopover === 'function' && f.el.matches(':popover-open')) f.el.hidePopover();
  if (!f.keep) f.el.remove();
  f.onClose?.();
  if (refocus) (f.back ?? (f.anchor() as HTMLElement | null | undefined))?.focus?.();
}

/** after a redraw: close the menu or popover open if what opened it is gone from the page (its card was rebuilt or
 *  deleted; one kept across redraws names its anchor by a function that finds the new one) */
export function closeOrphanFloat(): void {
  if (current && !current.anchor()?.isConnected) closeFloat();
}

/** a panel's × (the button editor's, a step's locks'): closes the popover it is in */
export function closeButton(what: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'float-close';
  b.textContent = '×';
  b.title = `Close ${what} (Esc)`;
  b.setAttribute('aria-label', `Close ${what}`);
  b.onclick = (e) => {
    e.stopPropagation();
    closeFloat(true);
  };
  return b;
}

/** Keep a top-layer menu on screen, including inside a scrolled or zoomed patch. */
export function positionPopover(panel: HTMLElement, anchor: HTMLElement): void {
  anchors.set(panel, anchor);
  const a = anchor.getBoundingClientRect();
  const margin = 12;
  panel.style.maxHeight = `${Math.max(120, window.innerHeight - margin * 2)}px`;
  const r = panel.getBoundingClientRect();
  const left = Math.max(margin, Math.min(a.right - r.width, window.innerWidth - r.width - margin));
  const below = a.bottom + 6;
  const top = below + r.height <= window.innerHeight - margin ? below : Math.max(margin, a.top - r.height - 6);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/** Reposition open parameter menus after viewport changes. */
export function setupPopoverPositioning(): void {
  const reposition = (): void => {
    for (const panel of document.querySelectorAll<HTMLElement>('[popover]:popover-open')) {
      const anchor = anchors.get(panel);
      if (anchor?.isConnected) positionPopover(panel, anchor);
    }
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
}
