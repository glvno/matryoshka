// SPDX-License-Identifier: GPL-3.0-only
// The Sound design sidebar (#1040, #1048, D-984): the panel at the canvas's right edge. Its head says "Sound design" and
// holds the ⋯ menu and the fold; under it the Output scope (output-scope.ts), the candidates' list with the Mutate
// category's Aim chip, a progress line while a Generate round renders, and the footer's Generate and Nominate. The current
// patch is candidate A, the first row, always there. A drag on the panel's left edge sets its width; » folds it to a
// 52 px rail that keeps the audition loop playable: the letter heard, where it is among the stops, one dot per candidate,
// previous and next, Keep, remove and Generate. Before the first candidate it is folded until the user opens it. The canvas
// gives up the panel's width (style.css .snap-column). This browser remembers the width and the fold; nothing about it is
// saved in the patch. main.ts fills it (renderSnapshots) through renderList, renderRail and renderProgress.
import { CURRENT_LETTER, fitText, originText, type Snapshot } from './snapshots';

/** where this browser keeps it */
export const SNAP_SIDE_STORE = 'matryoshka.snapSidebar';
/** its width in CSS px: the default, the narrowest and the widest (the window can make the widest narrower) */
export const SIDE_W = { default: 300, min: 220, max: 640 };
/** what the widest leaves of the window beside it (the workspace sidebar, the canvas) */
const ROOM = 520;
/** the sentence of an empty list (the mockup's, #1048) */
export const EMPTY_TEXT = 'Make a few variations of this sound, listen to each, keep the good ones.';

interface Saved {
  w: number;
  /** folded or open by the user's own choice; none: folded until the first candidate */
  folded?: boolean;
}

export class SnapSidebar {
  private saved: Saved;
  private candidates = 0;
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
    // a click anywhere in it gives it the focus, so ↑ ↓ go through the candidates there (main.ts); not a Tab stop itself
    root.tabIndex = -1;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Sound design');
    this.setWidth(this.saved.w);
    this.show();
    globalThis.addEventListener?.('resize', () => this.setWidth(this.saved.w));
  }

  get width(): number {
    return this.saved.w;
  }

  /** folded to the rail: the user's choice, else folded until the first candidate */
  get folded(): boolean {
    return this.saved.folded ?? this.candidates === 0;
  }

  /** the width, held between the narrowest and the widest the window allows */
  setWidth(w: number): void {
    const max = Math.max(SIDE_W.min, Math.min(SIDE_W.max, (globalThis.innerWidth || Infinity) - ROOM));
    this.saved.w = Math.round(Math.max(SIDE_W.min, Math.min(max, w)));
    this.root.style.setProperty('--snap-side-w', `${this.saved.w}px`);
  }

  /** fold or open, as the user chose (remembered) */
  setFolded(on: boolean): void {
    this.saved.folded = on;
    this.save();
    this.show();
  }

  /** how many candidates there are (the fold before the first, while the user has not chosen) */
  setCandidates(n: number): void {
    this.candidates = n;
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

/** what the sidebar shows: the candidates and the stop heard */
export interface SideView {
  readonly list: readonly Snapshot[];
  /** the letter heard; null: the current patch, A */
  shown: string | null;
  /** the candidate heard has been changed since it was taken */
  edited: boolean;
  /** the current patch's name */
  currentName: string;
  /** how many settings a candidate differs from the current patch by */
  changes(s: Snapshot): number;
  /** a Generate round that renders by ear (a category, #1033): found so far of the round's count, and how many were
   *  rendered of the most it renders; null when none runs */
  round: { found: number; of: number; rendered: number; most: number } | null;
  /** candidates per round */
  count: number;
}

/** what the sidebar's controls do */
export interface SideActions {
  /** hear a candidate, or the current patch (null) */
  hear(letter: string | null): void;
  keep(letter: string, on: boolean): void;
  /** make the candidate the current patch (it becomes A) */
  use(letter: string): void;
  remove(letter: string): void;
  /** the candidate's menu (right-click, double-click) */
  more(s: Snapshot, anchor: HTMLElement): void;
  /** the current patch's menu (right-click on A) */
  currentMore(anchor: HTMLElement, e: Event): void;
  /** a pointer down on a candidate's row: maybe a drag to reorder */
  drag(e: PointerEvent, row: HTMLElement, letter: string): void;
  step(dir: 1 | -1): void;
  generate(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** a candidate's (or A's) title: its letter and its name */
export const candidateTitle = (letter: string, name?: string): string => (name ? `${letter} “${name}”` : letter);

/** the list: A (the current patch) first, then the candidates in the order the user set, then the candidate being judged
 *  while an aimed round renders. The row heard has a teal letter and edge bar and is the only one with Keep · Use · ✕;
 *  the others show their change count and their keep tick */
export function renderList(strip: HTMLElement, v: SideView, act: SideActions): void {
  const button = (cls: string, text: string, title: string, run: () => void): HTMLButtonElement => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      run();
    };
    b.onpointerdown = (e) => e.stopPropagation();   // (no drag from a button)
    return b;
  };
  const row = (letter: string, name: string, dim: boolean, meta: (string | [string, string])[], title: string): HTMLElement => {
    const r = el('div', 'snap');
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    r.title = title;
    const body = el('div', 'snap-body');
    const n = el('div', `snap-name${dim ? ' dim' : ''}`, name);
    const m = el('div', 'snap-meta');
    meta.forEach((x, i) => m.append(...(i ? [' · '] : []), typeof x === 'string' ? x : el('span', x[0], x[1])));
    body.append(n, m);
    r.append(el('span', 'snap-let', letter), body);
    return r;
  };
  const shownA = v.shown === null;
  const a = row(CURRENT_LETTER, v.currentName || 'Current patch', false, ['the current patch, your latest edits'],
    `A, the current patch: your latest edits.${shownA ? ' You are hearing it.' : ' Click to hear it.'} Alt+J goes on to the candidates and round again, Alt+K goes back`);
  a.classList.add('current');
  if (shownA) a.classList.add('shown');
  a.setAttribute('aria-current', String(shownA));
  a.onclick = () => act.hear(null);
  a.onkeydown = (e) => { if (e.key === 'Enter') act.hear(null); };
  a.oncontextmenu = (e) => act.currentMore(a, e);
  const rows = v.list.map((s) => {
    const shown = v.shown === s.letter;
    const kept = s.mark === 'keep';
    const edited = shown && v.edited;
    const fit = fitText(s);
    const meta: (string | [string, string])[] = [s.from && s.from !== 'mutate' && s.from !== 'use' ? ['src', originText(s)] : originText(s)];
    if (fit) meta.push([s.aim!.fits ? 'fit' : 'miss', fit]);
    if (edited) meta.push('changed since');
    const n = v.changes(s);
    const r = row(s.letter, s.name ?? 'unnamed', !s.name, meta, `${candidateTitle(s.letter, s.name)}: ${n ? `${plural(n, 'change')} from the current patch` : 'the same as the current patch'}, ${originText(s)}${fit ? `, ${fit}` : ''}${kept ? '. Kept: Generate breeds from the kept ones' : ''}${edited ? '. Changed since it was taken: switching away keeps the changes as a new candidate' : ''}. ${shown ? 'You are hearing it' : 'Click to hear it'}; drag it up or down to change the order; right-click or double-click for more`);
    r.dataset.letter = s.letter;
    r.classList.toggle('shown', shown);
    r.classList.toggle('kept', kept);
    r.classList.toggle('edited', edited);
    r.setAttribute('aria-current', String(shown));
    r.onclick = () => act.hear(s.letter);
    r.onkeydown = (e) => { if (e.key === 'Enter') act.hear(s.letter); };
    r.onpointerdown = (e) => act.drag(e, r, s.letter);
    const more = (e: Event): void => { e.preventDefault(); act.more(s, r); };
    r.oncontextmenu = more;
    r.ondblclick = more;
    if (shown) {
      const acts = el('div', 'snap-acts');
      const k = button(`snap-keep-b${kept ? ' on' : ''}`, kept ? 'Kept' : 'Keep', kept ? 'Kept: Generate breeds from it. Click to unkeep' : 'Keep it: Generate breeds from the kept ones', () => act.keep(s.letter, !kept));
      k.setAttribute('aria-pressed', String(kept));
      acts.append(k, button('snap-use', 'Use', 'Make it the current patch, A (Alt+C); the current patch takes its place with a new letter', () => act.use(s.letter)),
        button('snap-remove', '✕', 'Remove it (Alt+X)', () => act.remove(s.letter)));
      r.append(acts);
    } else {
      const right = el('div', 'snap-right');
      const tick = button('snap-tick', '✓', kept ? `${s.letter} is kept: click to unkeep` : `Keep ${s.letter}`, () => act.keep(s.letter, !kept));
      tick.setAttribute('aria-pressed', String(kept));
      right.append(el('span', 'snap-ch', String(n)), tick);
      r.append(right);
    }
    return r;
  });
  const items: HTMLElement[] = [a, ...rows];
  if (v.round) {
    const p = row('·', 'listening…', true, [`candidate ${Math.min(v.round.rendered + 1, v.round.most)} of up to ${v.round.most}`], 'Being judged: rendered silently with the test phrase; it joins the list if it fits, or the nearest fill the round at its end');
    p.classList.add('pending');
    p.removeAttribute('role');
    p.tabIndex = -1;
    items.push(p);
  }
  if (!v.list.length && !v.round) items.push(el('p', 'snap-empty', EMPTY_TEXT));
  const focused = strip.contains(document.activeElement);
  strip.replaceChildren(...items);
  // the list had the focus (a row clicked, or ↑ ↓ pressed in it): the row heard takes it, so the keys stay in the sidebar
  if (focused) strip.querySelector<HTMLElement>('.snap.shown')?.focus({ preventScroll: true });
  // the row heard stays in view of the list when it scrolls, under A (which stays at the top); only the list scrolls
  // (scrollIntoView could scroll the page)
  const on = strip.querySelector<HTMLElement>('.snap.shown:not(.current)');
  if (on && on.offsetTop < strip.scrollTop + a.offsetHeight) strip.scrollTop = on.offsetTop - a.offsetHeight;
  else if (on && on.offsetTop + on.offsetHeight > strip.scrollTop + strip.clientHeight) strip.scrollTop = on.offsetTop + on.offsetHeight - strip.clientHeight;
}

/** the folded rail: the letter heard (A outlined for the current patch), its place among the stops, ▲, one dot per stop
 *  (A a square, gold for kept, dashed while being judged; a click plays it), ▼, then Keep, remove and Generate (+N) */
export function renderRail(body: HTMLElement, v: SideView, act: SideActions): void {
  const button = (cls: string, text: string, title: string, run: () => void, disabled = false): HTMLButtonElement => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = disabled;
    b.onclick = run;
    return b;
  };
  const s = v.list.find((x) => x.letter === v.shown);
  const letter = s?.letter ?? CURRENT_LETTER;
  const tile = el('div', `snap-rail-tile${s ? '' : ' current'}`, letter);
  tile.title = s ? `Hearing ${candidateTitle(s.letter, s.name)}` : 'Hearing A, the current patch';
  const at = s ? v.list.indexOf(s) + 2 : 1;
  const pos = el('span', 'snap-rail-pos', `${at} / ${v.list.length + 1}`);
  pos.title = `Stop ${at} of ${v.list.length + 1}: A, the current patch, then the candidates`;
  const dots = el('div', 'snap-rail-dots');
  const dot = (cls: string, title: string, run?: () => void): HTMLElement => {
    const d = run ? button(`snap-dot ${cls}`, '', title, run) : el('span', `snap-dot ${cls}`);
    d.title = title;
    return d;
  };
  dots.append(dot(`current${s ? '' : ' shown'}`, 'A, the current patch', () => act.hear(null)),
    ...v.list.map((x) => dot(`${x.mark === 'keep' ? 'kept' : ''}${x === s ? ' shown' : ''}`, `${candidateTitle(x.letter, x.name)}${x.mark === 'keep' ? ', kept' : ''}${x === s ? ', hearing' : ''}`, () => act.hear(x.letter))),
    ...(v.round ? [dot('pending', 'being judged')] : []));
  const kept = s?.mark === 'keep';
  const keep = button(`snap-rail-btn${kept ? ' on' : ''}`, '✓', s ? (kept ? `${s.letter} is kept: click to unkeep` : `Keep ${s.letter}`) : 'Keep: hear a candidate first (A is the current patch)', () => s && act.keep(s.letter, !kept), !s);
  keep.setAttribute('aria-pressed', String(kept));
  body.replaceChildren(tile, pos,
    button('snap-rail-step', '▲', 'Previous (Alt+K)', () => act.step(-1)),
    dots,
    button('snap-rail-step', '▼', 'Next (Alt+J)', () => act.step(1)),
    el('div', 'snap-rail-sep'),
    keep,
    button('snap-rail-btn', '✕', s ? `Remove ${s.letter} (Alt+X)` : 'Remove: hear a candidate first (A is the current patch)', () => s && act.remove(s.letter), !s),
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
