// SPDX-License-Identifier: GPL-3.0-only
// The snapshot sidebar (#1040, D-984): the column at the canvas's right edge that holds the Output scope (output-scope.ts)
// over the snapshots' list (main.ts renderSnapshots). A drag on its left edge sets its width; its fold button folds it to a
// thin strip that shows only the letter of the snapshot on screen (• for the current patch), and a click on the strip opens
// it again. The canvas gives up its width (style.css .snap-column). This browser remembers its width and whether it is
// folded; nothing about it is saved in the patch.

/** where this browser keeps it */
export const SNAP_SIDE_STORE = 'matryoshka.snapSidebar';
/** its width in CSS px: the default, the narrowest and the widest (the window can make the widest narrower) */
export const SIDE_W = { default: 300, min: 200, max: 640 };
/** what the widest leaves of the window beside it (the workspace sidebar, the canvas) */
const ROOM = 520;
/** the folded strip's mark while the current patch is on screen */
export const CURRENT_MARK = '•';

interface Saved {
  w: number;
  folded: boolean;
}

export class SnapSidebar {
  private saved: Saved;
  private mark: HTMLButtonElement;
  private head: HTMLElement;

  constructor(readonly root: HTMLElement, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null) {
    this.saved = { w: SIDE_W.default, folded: false, ...this.load() };
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'snap-side-fold';
    fold.textContent = '»';
    fold.title = 'Fold the snapshots to a strip';
    fold.setAttribute('aria-label', fold.title);
    fold.onclick = () => this.setFolded(true);
    const title = document.createElement('span');
    title.className = 'snap-side-title';
    title.textContent = 'Snapshots';
    this.head = document.createElement('div');
    this.head.className = 'snap-side-head';
    this.head.append(title, fold);
    this.mark = document.createElement('button');
    this.mark.type = 'button';
    this.mark.className = 'snap-side-mark';
    this.mark.onclick = () => this.setFolded(false);
    root.prepend(this.head);
    root.append(this.mark, this.edge());
    this.setWidth(this.saved.w);
    this.show();
    globalThis.addEventListener?.('resize', () => this.setWidth(this.saved.w));
  }

  get width(): number {
    return this.saved.w;
  }

  get folded(): boolean {
    return this.saved.folded;
  }

  /** the width, held between the narrowest and the widest the window allows */
  setWidth(w: number): void {
    const max = Math.max(SIDE_W.min, Math.min(SIDE_W.max, (globalThis.innerWidth || Infinity) - ROOM));
    this.saved.w = Math.round(Math.max(SIDE_W.min, Math.min(max, w)));
    this.root.style.setProperty('--snap-side-w', `${this.saved.w}px`);
  }

  setFolded(on: boolean): void {
    this.saved.folded = on;
    this.save();
    this.show();
  }

  /** what the folded strip shows: the letter of the snapshot on screen, null for the current patch */
  setShown(letter: string | null): void {
    this.mark.textContent = letter ?? CURRENT_MARK;
    this.mark.title = `${letter === null ? 'The current patch' : `Snapshot ${letter}`} is on screen: click to open the snapshots`;
    this.mark.setAttribute('aria-label', this.mark.title);
  }

  private show(): void {
    this.root.classList.toggle('folded', this.saved.folded);
  }

  /** the handle on its left edge: a drag sets its width (it is anchored at its right) */
  private edge(): HTMLElement {
    const g = document.createElement('div');
    g.className = 'snap-side-edge';
    g.title = 'Drag to make the snapshots wider or narrower';
    g.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const from = { x: e.clientX, w: this.saved.w };
      try { g.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
      const move = (ev: PointerEvent): void => this.setWidth(from.w - (ev.clientX - from.x));
      const up = (): void => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        this.save();
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    };
    return g;
  }

  private load(): Partial<Saved> {
    try {
      const v = JSON.parse(this.storage?.getItem(SNAP_SIDE_STORE) ?? 'null') as Partial<Saved> | null;
      if (!v || typeof v !== 'object') return {};
      return { ...(typeof v.w === 'number' && Number.isFinite(v.w) ? { w: v.w } : {}), folded: v.folded === true };
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(SNAP_SIDE_STORE, JSON.stringify(this.saved));
    } catch { /* (storage full or blocked: it is forgotten at the next visit) */ }
  }
}
