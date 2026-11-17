// SPDX-License-Identifier: GPL-3.0-only
// The Output scope (#1029, D-992): a Scope module's screen and toolbar (scope-view.ts) whose input is what is heard, so
// comparing snapshots needs no Scope card and no cable. It sits at the top of the column at the canvas's right edge, over
// the snapshots (#1038), while
// there is a snapshot, or always once the palette's "Output scope" opened it; its collapse button folds it to its title.
// Its Scope belongs to no patch: nothing about it is saved in the patch or sent to the FM-1; this browser remembers its
// size, its mode, window and scale, and whether it is folded. It streams only while its screen is on show (scope-view.ts).
import { DEFS } from './modules';
import type { ModuleInst } from './patch';
import { scopeTools, type ScreenSpec } from './scope-view';

/** its stream's key (worklet.ts `view` with `output`) */
export const OUTPUT_SCOPE_KEY = 'output-scope';
/** where this browser keeps it */
export const OUTPUT_SCOPE_STORE = 'matryoshka.outputScope';
/** the screen's size in CSS px: the default, the smallest and the largest (the window and the column can make the largest smaller) */
export const SCREEN_DEFAULT = { w: 260, h: 140 };
export const SCREEN_MIN = { w: 200, h: 80 };
export const SCREEN_MAX = { w: 1200, h: 640 };
/** what the largest leaves of the window beside it (the sidebar, the canvas) and of the column under it (the snapshots) */
const ROOM = { w: 520, h: 220, list: 120 };

interface Saved {
  w: number;
  h: number;
  /** the Scope's own parameters: mode, time, scale */
  params: Record<string, number>;
  collapsed: boolean;
  /** opened from the palette: it stays without a snapshot */
  pinned: boolean;
}

/** the screens it is drawn by (scope-view.ts ScopeScreens) */
interface Screens {
  sync(specs: ScreenSpec[]): void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export class OutputScope {
  /** the Scope it shows: in no patch */
  readonly m: ModuleInst;
  private saved: Saved;
  private inPatch = true;
  private snapshots = 0;
  private screen: HTMLElement;
  private fold: HTMLButtonElement;

  constructor(readonly root: HTMLElement, screens: Screens, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null) {
    const defaults = Object.fromEntries(DEFS.scope.params.map((q) => [q.name, q.default]));
    this.saved = { ...SCREEN_DEFAULT, params: {}, collapsed: false, pinned: false, ...this.load() };
    this.saved.params = { ...defaults, ...this.saved.params, voices: 0 };
    this.m = { id: -1, type: 'scope', x: 0, y: 0, params: this.saved.params };
    root.classList.add('output-scope');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Output scope');
    const head = document.createElement('div');
    head.className = 'oscope-head';
    const title = document.createElement('span');
    title.className = 'oscope-title';
    title.textContent = 'Output';
    title.title = 'What you hear: the Output of whichever engine plays, or the signal you listen to on its own (Alt-click)';
    this.fold = document.createElement('button');
    this.fold.type = 'button';
    this.fold.className = 'oscope-fold';
    this.fold.onclick = () => this.setCollapsed(!this.saved.collapsed);
    const tools = scopeTools(this.m, (name, v) => { this.m.params[name] = v; this.save(); }, false);
    head.append(title, tools, this.fold);
    this.screen = document.createElement('div');
    this.screen.className = 'scope-screen oscope-screen';
    const body = document.createElement('div');
    body.className = 'oscope-body';
    body.append(this.screen);
    const grips = (['left', 'bottom', 'corner'] as const).map((edge) => this.grip(edge));
    root.replaceChildren(head, body, ...grips);
    screens.sync([{ m: this.m, el: this.screen, chans: [[{ id: -1, port: 'out', kind: 'audio', label: 'what you hear' }]], key: OUTPUT_SCOPE_KEY, output: true }]);
    this.size(this.saved.w, this.saved.h);
    this.show();
  }

  /** shown at all (open or folded) */
  get visible(): boolean {
    return !this.root.hidden;
  }

  /** shown and open: its screen draws */
  get open(): boolean {
    return this.visible && !this.saved.collapsed;
  }

  /** the screen's size now */
  get screenSize(): { w: number; h: number } {
    return { w: this.saved.w, h: this.saved.h };
  }

  /** where it may show: the patch view on screen (`inPatch`) and how many snapshots there are */
  update(inPatch: boolean, snapshots: number): void {
    this.inPatch = inPatch;
    this.snapshots = snapshots;
    this.show();
  }

  /** the palette's Output scope: open it (it stays without a snapshot), or fold it away when it is open */
  toggle(): void {
    const opening = !this.open;
    this.saved.pinned = opening;
    this.saved.collapsed = !opening;
    this.save();
    this.show();
  }

  /** fold to its title (no snapshot: gone until the palette opens it again), or open */
  setCollapsed(on: boolean): void {
    this.saved.collapsed = on;
    if (on) this.saved.pinned = false;
    this.save();
    this.show();
  }

  /** the screen's size, held between the smallest and the largest the window and the column allow */
  size(w: number, h: number): void {
    const maxW = Math.max(SCREEN_MIN.w, Math.min(SCREEN_MAX.w, (globalThis.innerWidth || Infinity) - ROOM.w));
    const column = this.root.parentElement?.clientHeight || Infinity;
    const maxH = Math.max(SCREEN_MIN.h, Math.min(SCREEN_MAX.h, (globalThis.innerHeight || Infinity) - ROOM.h, column - ROOM.list));
    this.saved.w = Math.round(clamp(w, SCREEN_MIN.w, maxW));
    this.saved.h = Math.round(clamp(h, SCREEN_MIN.h, maxH));
    this.screen.style.width = `${this.saved.w}px`;
    this.screen.style.height = `${this.saved.h}px`;
  }

  private show(): void {
    this.root.hidden = !this.inPatch || (!this.snapshots && !this.saved.pinned);
    this.root.classList.toggle('collapsed', this.saved.collapsed);
    this.fold.textContent = this.saved.collapsed ? '▴' : '▾';
    this.fold.title = this.saved.collapsed ? 'Open the Output scope' : 'Fold the Output scope away (the palette’s Output scope brings it back)';
    this.fold.setAttribute('aria-label', this.fold.title);
    this.fold.setAttribute('aria-expanded', String(!this.saved.collapsed));
  }

  /** a drag handle on its left edge, its bottom edge or its bottom left corner (it is anchored at its top right) */
  private grip(edge: 'left' | 'bottom' | 'corner'): HTMLElement {
    const g = document.createElement('div');
    g.className = `oscope-grip ${edge}`;
    g.setAttribute('aria-hidden', 'true');
    g.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const from = { x: e.clientX, y: e.clientY, ...this.screenSize };
      try { g.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
      const move = (ev: PointerEvent): void => this.size(edge === 'bottom' ? from.w : from.w - (ev.clientX - from.x), edge === 'left' ? from.h : from.h + ev.clientY - from.y);
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
      const v = JSON.parse(this.storage?.getItem(OUTPUT_SCOPE_STORE) ?? 'null') as Partial<Saved> | null;
      if (!v || typeof v !== 'object') return {};
      const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
      const params = Object.fromEntries(Object.entries(v.params ?? {}).filter(([k, x]) => ['mode', 'time', 'scale'].includes(k) && num(x)));
      return { ...(num(v.w) ? { w: v.w } : {}), ...(num(v.h) ? { h: v.h } : {}), params, collapsed: v.collapsed === true, pinned: v.pinned === true };
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(OUTPUT_SCOPE_STORE, JSON.stringify(this.saved));
    } catch { /* (storage full or blocked: it is forgotten at the next visit) */ }
  }
}
