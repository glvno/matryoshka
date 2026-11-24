// SPDX-License-Identifier: GPL-3.0-only
// Dragging a patch onto a drop target (#1196): the palette's chips take a patch dragged from Library > Patches, Library >
// Community, or the canvas's current patch (the grip beside the patch name). Pointer events, not HTML5 drag-and-drop (as
// the candidates' reorder, main.ts dragSnapshot): a label follows the pointer once it moved a few pixels, the target
// under it lights up, and a release over one hands it the patch. A press that never moved stays a click.
import type { Patch } from './patch';

/** what a drag carries: the patch's name, the patch itself (made on drop: a factory or community patch is built then;
 *  null when this browser has no copy of an FM-1 slot's patch), and the FM-1 slot it already sits in with that slot's own
 *  name (the FM-1 checks an entry by it, case and all: a factory slot is `808 Kit`) when it came from the FM-1 column */
export interface PatchDragItem { name: string; patch: () => Patch | null; slot?: { slot: number; name: string } }

/** an element that takes a dropped patch */
type Drop = (item: PatchDragItem) => void;
const drops = new WeakMap<Element, Drop>();

/** the pixels a press moves before it is a drag */
export const DRAG_START_PX = 5;

/** `el` takes dropped patches (a chip): `drop` runs on a release over it; null stops it taking them */
export function patchDropTarget(el: HTMLElement, drop: Drop | null): void {
  if (drop) {
    drops.set(el, drop);
    el.dataset.patchDrop = '';
  } else {
    drops.delete(el);
    delete el.dataset.patchDrop;
  }
}

/** the drop target at a point of the window, if any (the dragged label lets the pointer through) */
const targetAt = (x: number, y: number): HTMLElement | null =>
  (document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-patch-drop]') ?? null);

/** `el` starts a patch drag (`item`: what it carries, null none just now); a click on it still works */
export function patchDragSource(el: HTMLElement, item: () => PatchDragItem | null): void {
  el.classList.add('patch-drag-source');
  el.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const it = item();
    if (it) startPatchDrag(e, it);
  };
}

/** follow the pointer from this press: a drag once it moved DRAG_START_PX */
export function startPatchDrag(e: PointerEvent, item: PatchDragItem): void {
  const x0 = e.clientX, y0 = e.clientY;
  let label: HTMLElement | null = null;
  let over: HTMLElement | null = null;
  const light = (t: HTMLElement | null): void => {
    if (t === over) return;
    over?.classList.remove('patch-drop-over');
    over = t;
    over?.classList.add('patch-drop-over');
  };
  const move = (ev: PointerEvent): void => {
    if (!label && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
    if (!label) {
      label = document.createElement('div');
      label.className = 'patch-drag-label';
      label.textContent = item.name;
      document.body.append(label);
      document.body.classList.add('patch-dragging');
    }
    label.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
    light(targetAt(ev.clientX, ev.clientY));
    ev.preventDefault();
  };
  const end = (ev: PointerEvent | KeyboardEvent): void => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    removeEventListener('keydown', key, true);
    const target = over;
    light(null);
    if (!label) return;
    label.remove();
    document.body.classList.remove('patch-dragging');
    // (the release ends a drag, not a click on what was pressed: the click it makes, if any, comes before the timeout. The
    // drop runs after it, so a name prompt the drop opens takes the next click, Enter's on its button too, #1236)
    const swallow = (c: MouseEvent): void => { c.stopPropagation(); c.preventDefault(); };
    addEventListener('click', swallow, true);
    setTimeout(() => {
      removeEventListener('click', swallow, true);
      if (ev.type === 'pointerup' && target) drops.get(target)?.(item);
    });
  };
  const key = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    light(null);
    ev.stopPropagation();
    end(ev);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  addEventListener('keydown', key, true);
}
