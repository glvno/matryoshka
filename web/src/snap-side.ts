// SPDX-License-Identifier: GPL-3.0-only
// The Sound design sidebar (#1040, #1048, D-984): the panel at the canvas's right edge. Its head says "Sound design" and
// holds the ⋯ menu and the fold; under it the Output scope (output-scope.ts), the candidates' list with the Mutate
// category's Aim chip, a progress line while a Generate round renders, and the footer's Generate and Duplicate. The
// candidates are all alike (owner 2026-11-24): the one you hear is the current patch. A drag on the panel's left edge sets
// its width; » folds it to a 52 px rail that keeps the audition loop playable: the letter heard, where it is in the list,
// one dot per candidate, previous and next, play, Save preset, Add to palette, delete and Generate. It starts open at its
// narrowest width. It runs the window's whole height, and the workspace beside it (the canvas, the deck, Connect FM-1, ?)
// gives up its width (style.css .snap-column). This browser remembers the width and the fold; nothing about it is
// saved in the patch. main.ts fills it (renderSnapshots) through renderList, renderRail and renderProgress.
import { CANDIDATE_LIMIT, fitText, originText, type Deleted, type Snapshot } from './snapshots';

/** where this browser keeps it */
export const SNAP_SIDE_STORE = 'matryoshka.snapSidebar';
/** its width in CSS px: the default, the narrowest and the widest (the window can make the widest narrower) */
export const SIDE_W = { default: 300, min: 300, max: 640 };
/** what the widest leaves of the window beside it: the room the workspace needs (the left sidebar, the canvas and the
 *  deck with Main's K1..K4 unclipped), measured at 1280 CSS px windows (#1048) */
export const WORKSPACE_MIN = 980;

interface Saved {
  w: number;
  /** folded or open by the user's own choice; none: open */
  folded?: boolean;
}

export class SnapSidebar {
  private saved: Saved;
  /** the rail's contents under its open button (renderRail) */
  readonly rail: HTMLElement;

  constructor(readonly root: HTMLElement, onMenu: (anchor: HTMLElement) => void, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null) {
    this.saved = { w: SIDE_W.default, ...this.load() };
    const button = (cls: string, text: string, title: string, run: (b: HTMLButtonElement) => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.onclick = () => run(b);
      return b;
    };
    const title = document.createElement('span');
    title.className = 'snap-side-title';
    title.textContent = 'Sound design';
    const head = document.createElement('div');
    head.className = 'snap-side-head';
    head.append(title,
      button('snap-side-menu', '⋯', 'Mutate, Randomize, Lock envelopes, the Mutate settings, candidates per round, storing and saving', (b) => onMenu(b)),
      button('snap-side-fold', '»', 'Fold the sidebar to a rail', () => this.setFolded(true)));
    this.rail = document.createElement('div');
    this.rail.className = 'snap-rail-body';
    const rail = document.createElement('div');
    rail.className = 'snap-rail';
    rail.append(button('snap-rail-open', '«', 'Open the Sound design sidebar', () => this.setFolded(false)), this.rail);
    root.prepend(head);
    root.append(rail, this.edge());
    // a click anywhere in it gives it the focus, so ↑ ↓ go through the candidates there (main.ts; focus.ts lets it keep
    // the focus after a click); not a Tab stop itself
    root.tabIndex = -1;
    root.dataset.keepFocus = '';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Sound design');
    this.apply();
    this.show();
    globalThis.addEventListener?.('resize', () => this.apply());
  }

  /** its width now: the one the user set, held to what the window allows (a narrower window never forgets it) */
  get width(): number {
    return Math.round(Math.max(SIDE_W.min, Math.min(this.widest(), this.saved.w)));
  }

  /** folded to the rail, as the user chose (open at first) */
  get folded(): boolean {
    return this.saved.folded ?? false;
  }

  /** set the width, held between the narrowest and the widest the window allows */
  setWidth(w: number): void {
    this.saved.w = Math.round(Math.max(SIDE_W.min, Math.min(this.widest(), w)));
    this.apply();
  }

  /** the widest the window allows */
  private widest(): number {
    return Math.max(SIDE_W.min, Math.min(SIDE_W.max, (globalThis.innerWidth || Infinity) - WORKSPACE_MIN));
  }

  private apply(): void {
    this.root.style.setProperty('--snap-side-w', `${this.width}px`);
  }

  /** fold or open, as the user chose (remembered) */
  setFolded(on: boolean): void {
    this.saved.folded = on;
    this.save();
    this.show();
  }

  /** the step ↑ or ↓ takes while the open sidebar has the focus (#1048): -1 the candidate before, 1 the one after, as
   *  Alt+K and Alt+J; null for any other key, with a modifier, while folded, in a text field or outside it (the key then
   *  does what it does everywhere else) */
  arrowStep(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'target'>): 1 | -1 | null {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || this.folded) return null;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !this.root.contains(t) || t.closest('input, textarea, select, [contenteditable]')) return null;
    return e.key === 'ArrowUp' ? -1 : 1;
  }

  private show(): void {
    this.root.classList.toggle('folded', this.folded);
  }

  /** the handle on its left edge: a drag sets its width (it is anchored at its right) */
  private edge(): HTMLElement {
    const g = document.createElement('div');
    g.className = 'snap-side-edge';
    g.title = 'Drag to make the sidebar wider or narrower';
    g.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const from = { x: e.clientX, w: this.width };
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
      return { ...(typeof v.w === 'number' && Number.isFinite(v.w) ? { w: v.w } : {}), ...(typeof v.folded === 'boolean' ? { folded: v.folded } : {}) };
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

/** what the sidebar shows: the candidates, the one heard and the picks */
export interface SideView {
  readonly list: readonly Snapshot[];
  /** the letter heard: the current candidate, the current patch */
  current: string;
  /** its version differs from its original ("tweaked") */
  tweaked(s: Snapshot): boolean;
  /** how many settings it differs by from the one heard */
  changes(s: Snapshot): number;
  /** the rows picked as parents (⌘/Ctrl/Shift-click), in pick order */
  picks: readonly string[];
  /** Recently deleted, newest first */
  deleted: readonly Deleted[];
  /** the engines Save preset lists (0: no Save preset button; 1: it opens the Store dialog, no ▾) */
  engines: number;
  /** a Generate round that renders by ear (a category, #1033): found so far of the round's count, and how many were
   *  rendered of the most it renders; null when none runs */
  round: { found: number; of: number; rendered: number; most: number } | null;
  /** candidates per round */
  count: number;
  /** the Listen block's phrase plays */
  playing: boolean;
}

/** what the sidebar's controls do */
export interface SideActions {
  /** make a candidate the current patch */
  hear(letter: string): void;
  /** toggle a pick (⌘, Ctrl or Shift held on a row click) */
  pick(letter: string): void;
  /** ✕ */
  remove(letter: string): void;
  /** Recently deleted's ith back */
  putBack(i: number): void;
  /** the 'revert' link next to 'tweaked' (on any tweaked row; the integrator makes that candidate current, then reverts) */
  revert(letter: string): void;
  savePreset(anchor: HTMLElement): void;
  /** Add to palette: the default (the FM-1's palette when one is linked, else the choice) by `anchor` */
  addToPalette(anchor: HTMLElement): void;
  /** ▾ beside it: the choice of the FM-1's palette or a saved palette */
  paletteChoice(anchor: HTMLElement): void;
  /** the candidate's menu (right-click, double-click, ⋯) */
  more(s: Snapshot, anchor: HTMLElement): void;
  /** a pointer down on a candidate's row: maybe a drag to reorder */
  drag(e: PointerEvent, row: HTMLElement, letter: string): void;
  step(dir: 1 | -1): void;
  generate(): void;
  /** play or stop the test phrase (Q) */
  play(): void;
}

/** the footer's Generate button (D5): Generate with no pick, "Generate from D" with one, "Breed B × D" with two or more */
export function generateText(picks: readonly string[]): string {
  return picks.length === 0 ? 'Generate' : picks.length === 1 ? `Generate from ${picks[0]}` : `Breed ${picks.join(' × ')}`;
}

/** the head's count: "N of 32" (a set holds up to CANDIDATE_LIMIT) */
export const countText = (n: number): string => `${n} of ${CANDIDATE_LIMIT}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** a candidate's title: its letter and its name */
export const candidateTitle = (letter: string, name?: string): string => (name ? `${letter} “${name}”` : letter);

/** a click with ⌘, Ctrl or Shift picks a parent (D5) instead of switching, on a row and on a rail dot alike */
const picking = (e: MouseEvent): boolean => e.metaKey || e.ctrlKey || e.shiftKey;

const ONLY_ONE = 'The only candidate: one is always the current patch';

/** the list: the candidates in the order the user set, all alike, then the candidate being judged while an aimed round
 *  renders, then Recently deleted. The row heard has a teal letter and edge bar and is the only one with Save preset ·
 *  Add to palette · ⋯ · ✕; the others show their change count and a ✕ on hover. Picked rows have a coral ring */
export function renderList(strip: HTMLElement, v: SideView, act: SideActions): void {
  const button = (cls: string, text: string, title: string, run: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      run(b);
    };
    b.ondblclick = (e) => e.stopPropagation();
    b.onpointerdown = (e) => e.stopPropagation();   // (no drag from a button)
    return b;
  };
  const only = v.list.length < 2;
  const items: HTMLElement[] = v.list.map((s) => {
    const shown = v.current === s.letter;
    const picked = v.picks.includes(s.letter);
    const tweaked = v.tweaked(s);
    const fit = fitText(s);
    const n = v.changes(s);
    const r = el('div', 'snap');
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    r.dataset.letter = s.letter;
    r.classList.toggle('shown', shown);
    r.classList.toggle('picked', picked);
    r.setAttribute('aria-current', String(shown));
    r.title = `${candidateTitle(s.letter, s.name)}: ${originText(s)}${fit ? `, ${fit}` : ''}${tweaked ? ', tweaked since it was made' : ''}${picked ? ', picked as a parent' : ''}. `
      + (shown ? 'The current patch, the one you hear (Alt+J / Alt+K: the next / the one before)' : `${n ? `${plural(n, 'setting')} differ from the one you hear` : 'The same as the one you hear'}; click to make it the current patch`)
      + '; ⌘ or Shift-click to pick it as a parent for Generate; drag it up or down to change the order; right-click or double-click for more';
    const body = el('div', 'snap-body');
    const meta = el('div', 'snap-meta');
    const parts: HTMLElement[] = [];
    if (s.name) parts.push(el('span', 'src', originText(s)));
    if (fit) parts.push(el('span', s.aim!.fits ? 'fit' : 'miss', fit));
    if (tweaked) {
      const t = el('span', 'snap-tweaked', 'tweaked');
      t.append(' ', button('snap-revert', 'revert', 'Back to how it was made (Ctrl/Cmd+Z undoes it)', () => act.revert(s.letter)));
      parts.push(t);
    }
    parts.forEach((x, i) => meta.append(...(i ? [' · '] : []), x));
    body.append(el('div', `snap-name${s.name ? '' : ' dim'}`, s.name ?? originText(s)), meta);
    r.append(el('span', 'snap-let', s.letter), body);
    r.onclick = (e) => (picking(e) ? act.pick(s.letter) : act.hear(s.letter));
    r.onkeydown = (e) => { if (e.key === 'Enter' && e.target === r) act.hear(s.letter); };
    r.onpointerdown = (e) => act.drag(e, r, s.letter);
    const more = (e: Event): void => { e.preventDefault(); act.more(s, r); };
    r.oncontextmenu = more;
    r.ondblclick = more;
    const remove = (cls: string, title: string): HTMLButtonElement => {
      const x = button(cls, '✕', only ? ONLY_ONE : title, () => act.remove(s.letter));
      x.disabled = only;
      return x;
    };
    if (shown) {
      const acts = el('div', 'snap-acts');
      if (v.engines > 0) {
        acts.append(button('snap-preset main', v.engines === 1 ? 'Save preset' : 'Save preset ▾',
          v.engines === 1 ? 'Save its instrument, with its FX drawer, as a preset' : 'Save one of its instruments, with its FX drawer, as a preset', (b) => act.savePreset(b)));
      }
      acts.append(button('snap-palette main', 'Add to palette', 'Add it to the FM-1’s palette (with no FM-1: choose a saved palette)', (b) => act.addToPalette(b)),
        button('snap-palette-choice main', '▾', 'Add it to the FM-1’s palette or to a saved palette', (b) => act.paletteChoice(b)),
        button('snap-more', '⋯', 'More: also on a right-click or double-click of a row', (b) => act.more(s, b)),
        remove('snap-remove', 'Delete it (Alt+X)'));
      r.append(acts);
    } else {
      const right = el('div', 'snap-right');
      const ch = el('span', 'snap-ch', n ? String(n) : '=');
      ch.title = n ? `${plural(n, 'setting')} differ from the one you hear` : 'The same as the one you hear';
      right.append(ch, remove('snap-x', `Delete ${s.letter}`));
      r.append(right);
    }
    return r;
  });
  if (v.round) {
    const p = el('div', 'snap pending');
    p.title = 'Being judged: rendered silently with the test phrase; it joins the list if it fits, or the nearest fill the round at its end';
    const body = el('div', 'snap-body');
    body.append(el('div', 'snap-name dim', 'listening…'), el('div', 'snap-meta', `candidate ${Math.min(v.round.rendered + 1, v.round.most)} of up to ${v.round.most}`));
    p.append(el('span', 'snap-let', '·'), body);
    items.push(p);
  }
  if (v.deleted.length) {
    // (open or closed as the user left it, across redraws)
    const box = el('details', 'snap-deleted');
    box.open = strip.querySelector<HTMLDetailsElement>('.snap-deleted')?.open ?? false;
    box.append(el('summary', '', `Recently deleted (${v.deleted.length})`));
    // opened by the user (not drawn open again): its entries come into view of the list (only the list scrolls)
    const was = box.open;
    box.ontoggle = () => { if (box.open && !was) strip.scrollTop = Math.max(strip.scrollTop, box.offsetTop + box.offsetHeight - strip.clientHeight); };
    v.deleted.forEach((d, i) => {
      const line = el('div', 'snap-deleted-item');
      line.append(el('span', 'snap-deleted-name', candidateTitle(d.s.letter, d.s.name)));
      if (!d.s.name) line.append(' ', el('span', 'dim', originText(d.s)));
      line.append(' · ', button('snap-put-back', 'put back', `Put ${d.s.letter} back where it was`, () => act.putBack(i)));
      box.append(line);
    });
    items.push(box);
  }
  const focused = strip.contains(document.activeElement);
  strip.replaceChildren(...items);
  // the list had the focus (a row clicked, or ↑ ↓ pressed in it): the row heard takes it, so the keys stay in the sidebar
  if (focused) strip.querySelector<HTMLElement>('.snap.shown')?.focus({ preventScroll: true });
  // the row heard stays in view of the list when it scrolls; only the list scrolls (scrollIntoView could scroll the page)
  const on = strip.querySelector<HTMLElement>('.snap.shown');
  if (on && on.offsetTop < strip.scrollTop) strip.scrollTop = on.offsetTop;
  else if (on && on.offsetTop + on.offsetHeight > strip.scrollTop + strip.clientHeight) strip.scrollTop = on.offsetTop + on.offsetHeight - strip.clientHeight;
}

/** the folded rail: the letter heard, its place in the list, play, ▲, one dot per candidate (coral for picked, dashed while
 *  being judged; a click makes it current, ⌘ or Shift-click picks it), ▼, then Save preset, Add to palette, delete and
 *  Generate (+N) */
export function renderRail(body: HTMLElement, v: SideView, act: SideActions): void {
  const button = (cls: string, text: string, title: string, run: (b: HTMLButtonElement, e: MouseEvent) => void, disabled = false): HTMLButtonElement => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = disabled;
    b.onclick = (e) => run(b, e);
    return b;
  };
  // (a set is never empty)
  const s = v.list.find((x) => x.letter === v.current) ?? v.list[0];
  const at = v.list.indexOf(s) + 1;
  const tile = el('div', 'snap-rail-tile', s.letter);
  tile.title = `Hearing ${candidateTitle(s.letter, s.name)}: the current patch`;
  const pos = el('span', 'snap-rail-pos', `${at} / ${v.list.length}`);
  pos.title = `Candidate ${at} of ${v.list.length}`;
  const dots = el('div', 'snap-rail-dots');
  dots.append(...v.list.map((x) => {
    const picked = v.picks.includes(x.letter);
    return button(`snap-dot${picked ? ' picked' : ''}${x === s ? ' shown' : ''}`, '',
      `${candidateTitle(x.letter, x.name)}${x === s ? ', the one you hear' : ''}${picked ? ', picked as a parent' : ''}: click to make it the current patch; ⌘ or Shift-click to pick it as a parent`,
      (_b, e) => (picking(e) ? act.pick(x.letter) : act.hear(x.letter)));
  }));
  if (v.round) {
    const d = el('span', 'snap-dot pending');
    d.title = 'being judged';
    dots.append(d);
  }
  const play = button(`snap-rail-play${v.playing ? ' on' : ''}`, v.playing ? '■' : '▶', v.playing ? 'Stop the test phrase (Q)' : 'Play the test phrase (Q)', () => act.play());
  play.setAttribute('aria-pressed', String(v.playing));
  const only = v.list.length < 2;
  body.replaceChildren(tile, pos, play,
    button('snap-rail-step', '▲', 'The one before (Alt+K)', () => act.step(-1)),
    dots,
    button('snap-rail-step', '▼', 'The next (Alt+J)', () => act.step(1)),
    el('div', 'snap-rail-sep'),
    button('snap-rail-btn', 'PRE', v.engines ? 'Save preset: its instrument, with its FX drawer' : 'Save preset: this patch has no instrument', (b) => act.savePreset(b), !v.engines),
    button('snap-rail-btn', 'PAL', 'Add to palette: the one you hear', (b) => act.addToPalette(b)),
    button('snap-rail-btn', '✕', only ? ONLY_ONE : `Delete ${s.letter}, the one you hear (Alt+X)`, () => act.remove(s.letter), only),
    button('snap-rail-btn generate', `+${v.count}`, `Generate ${v.count} candidates (Alt+N)`, () => act.generate()));
}

/** the progress line under the list, only while a Generate round renders: "N of M found · Stop" */
export function renderProgress(line: HTMLElement, round: SideView['round']): void {
  line.hidden = !round;
  if (!round) return;
  const bar = line.querySelector<HTMLElement>('.snap-progress-bar span');
  if (bar) bar.style.width = `${Math.round((100 * round.found) / Math.max(1, round.of))}%`;
  const text = line.querySelector<HTMLElement>('.snap-progress-text');
  if (text) text.textContent = `${round.found} of ${round.of} found`;
}
