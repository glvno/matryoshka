// SPDX-License-Identifier: GPL-3.0-only
// The Output scope (#1029, D-992): a Scope module's screen and toolbar (scope-view.ts) whose input is what is heard, so
// comparing candidates needs no Scope card and no cable. It sits at the top of the Sound design sidebar at the canvas's
// right edge (snap-side.ts, #1040, #1048), over the candidates, whenever the patch view shows; its collapse button (and
// Commands' "Output scope") folds it to its title and opens it again. Its screen is as wide as the sidebar; the divider
// under it sets its height. Its Scope belongs to no patch: nothing about it is saved in the patch or sent to the FM-1; this
// browser remembers its height, its mode, window and scale, and whether it is folded. It streams only while its screen is
// on show (scope-view.ts), so not while the sidebar is folded.
import { DEFS } from './modules';
import type { ModuleInst } from './patch';
import { scopeTools, type ScreenSpec } from './scope-view';

/** its stream's key (worklet.ts `view` with `output`) */
export const OUTPUT_SCOPE_KEY = 'output-scope';
/** where this browser keeps it */
export const OUTPUT_SCOPE_STORE = 'matryoshka.outputScope';
/** the screen's height in CSS px: the default, the smallest and the largest (the window and the sidebar can make the largest smaller) */
export const SCREEN_H = { default: 140, min: 80, max: 640 };
/** what the tallest leaves of the window (the bar above, the deck under it) and of the sidebar (its head, the scope's own
 *  toolbar and frame, the candidates' head, at least 120 CSS px of the list and the footer under it) */
const ROOM = { h: 220, list: 300 };

interface Saved {
  /** the screen's height */
  h: number;
  /** the Scope's own parameters: mode, time, scale */
  params: Record<string, number>;
  collapsed: boolean;
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
  private shownIn = true;
  private screen: HTMLElement;
  private fold: HTMLButtonElement;

  constructor(readonly root: HTMLElement, screens: Screens, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null) {
    const defaults = Object.fromEntries(DEFS.scope.params.map((q) => [q.name, q.default]));
    this.saved = { h: SCREEN_H.default, params: {}, collapsed: false, ...this.load() };
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
    root.replaceChildren(head, body, this.divider());
    screens.sync([{ m: this.m, el: this.screen, chans: [[{ id: -1, port: 'out', kind: 'audio', label: 'what you hear' }]], key: OUTPUT_SCOPE_KEY, output: true }]);
    this.size(this.saved.h);
    this.show();
    globalThis.addEventListener?.('resize', () => this.size(this.saved.h));
  }

  /** shown at all (open or folded) */
  get visible(): boolean {
    return !this.root.hidden;
  }

  /** shown and open: its screen draws */
  get open(): boolean {
    return this.visible && !this.saved.collapsed;
  }

  /** the screen's height now */
  get screenHeight(): number {
    return this.saved.h;
  }

  /** where it may show: the patch view on screen */
  update(inPatch: boolean): void {
    this.shownIn = inPatch;
    this.show();
  }

  /** Commands' Output scope: open it, or fold it to its title when it is open */
  toggle(): void {
    this.setCollapsed(this.open);
  }

  /** fold to its title, or open */
  setCollapsed(on: boolean): void {
    this.saved.collapsed = on;
    this.save();
    this.show();
  }

  /** the screen's height, held between the smallest and the largest the window and the sidebar allow (the candidates
   *  under it keep some of the sidebar) */
  size(h: number): void {
    const side = this.root.parentElement?.clientHeight || Infinity;
    const maxH = Math.max(SCREEN_H.min, Math.min(SCREEN_H.max, (globalThis.innerHeight || Infinity) - ROOM.h, side - ROOM.list));
    this.saved.h = Math.round(clamp(h, SCREEN_H.min, maxH));
    this.screen.style.height = `${this.saved.h}px`;
  }

  private show(): void {
    this.root.hidden = !this.shownIn;
    this.root.classList.toggle('collapsed', this.saved.collapsed);
    this.fold.textContent = this.saved.collapsed ? '▴' : '▾';
    this.fold.title = this.saved.collapsed ? 'Open the Output scope' : 'Fold the Output scope to its title';
    this.fold.setAttribute('aria-label', this.fold.title);
    this.fold.setAttribute('aria-expanded', String(!this.saved.collapsed));
  }

  /** the divider between it and the candidates under it: a drag sets the screen's height */
  private divider(): HTMLElement {
    const g = document.createElement('div');
    g.className = 'oscope-divider';
    g.title = 'Drag to make the Output scope taller or shorter';
    g.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const from = { y: e.clientY, h: this.saved.h };
      try { g.setPointerCapture(e.pointerId); } catch { /* (a synthetic pointer) */ }
      const move = (ev: PointerEvent): void => this.size(from.h + ev.clientY - from.y);
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
      return { ...(num(v.h) ? { h: v.h } : {}), params, collapsed: v.collapsed === true };
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
