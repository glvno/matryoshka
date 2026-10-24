// SPDX-License-Identifier: GPL-3.0-only
// The status line under the keyboard (design: status line): on the left what the pointer is over and what it does, as
// Ableton's info view; the FM-1 budget on the right (main.ts). The text comes from what is already there: an element's
// data-help (data-help-tag names it), else its title or an SVG <title> (a cable). "NAME: text" splits into tag and text.

const IDLE = 'Hover over anything to see what it does.';

let tagEl: HTMLElement | null = null;
let textEl: HTMLElement | null = null;
/** a message the app sets; `more`: a link after the text (it carries no title, so hovering it keeps the message up) */
interface Pinned { tag: string; text: string; more?: { label: string; run: () => void } }
/** messages set by the app (the armed track, a sandbox patch) by key; the first set shows while nothing is hovered */
const pinned = new Map<string, Pinned>();
/** the pinned message on show, so going back to it leaves its link in place */
let showing: Pinned | null = null;

function show(tag: string, text: string, idle = false, more?: Pinned['more']): void {
  if (!tagEl || !textEl) return;
  tagEl.textContent = tag;
  textEl.textContent = text;
  textEl.classList.toggle('idle', idle);
  if (more) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'sl-more';
    a.textContent = more.label;
    a.onclick = more.run;
    textEl.append(' ', a);
  }
  showing = null;
}

function rest(): void {
  const first = [...pinned.values()][0];
  if (first && first === showing) return;
  if (first) show(first.tag, first.text, false, first.more);
  else show('', IDLE, true);
  showing = first ?? null;
}

/** the help an element carries, or null: data-help, a title, an SVG element's <title> child */
export function helpOf(el: Element): { tag: string; text: string } | null {
  const h = el.closest<HTMLElement>('[data-help]');
  if (h) return { tag: h.dataset.helpTag ?? '', text: h.dataset.help! };
  const svgTitle = el instanceof SVGElement ? el.querySelector(':scope > title')?.textContent : null;
  const titled = svgTitle ? null : el.closest<HTMLElement | SVGElement>('[title]');
  const raw = svgTitle ?? titled?.getAttribute('title');
  if (!raw) return null;
  if (svgTitle && el.matches('.cable, .cable-hit')) return { tag: 'Cable', text: raw };
  const m = /^([A-Z0-9][^:.]{0,23}): (.+)$/s.exec(raw);
  return m ? { tag: m[1], text: m[2] } : { tag: '', text: raw };
}

/** fill the status line from now on: `el` holds the tag and the text (the budget sits after them) */
export function initStatusline(el: HTMLElement): void {
  tagEl = el.querySelector('.sl-tag');
  textEl = el.querySelector('.sl-text');
  rest();
  document.addEventListener('pointerover', (e) => {
    const h = e.target instanceof Element ? helpOf(e.target) : null;
    if (h) show(h.tag, h.text);
    else rest();
  });
  document.addEventListener('pointerleave', rest);
}

/** a message to show while nothing is hovered, under a key ('arm' before 'budget'); null takes it away */
export function pinStatus(msg: Pinned | null, key = 'budget'): void {
  if (msg) pinned.set(key, msg);
  else pinned.delete(key);
  const order = ['arm', 'budget'];
  const sorted = [...pinned].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  pinned.clear();
  for (const [k, v] of sorted) pinned.set(k, v);
  rest();
}
