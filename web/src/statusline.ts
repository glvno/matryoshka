// SPDX-License-Identifier: GPL-3.0-only
// The status line under the keyboard (design: status line): on the left what the pointer is over and what it does, as
// Ableton's info view; the FM-1 budget on the right (main.ts). The text comes from what is already there: an element's
// data-help (data-help-tag names it), else its title or an SVG <title> (a cable). "NAME: text" splits into tag and text.

const IDLE = 'Hover over anything to see what it does.';

let tagEl: HTMLElement | null = null;
let textEl: HTMLElement | null = null;
/** messages set by the app (the armed track, an over-budget warning) by key; the first set shows while nothing is hovered */
const pinned = new Map<string, { tag: string; text: string }>();

function show(tag: string, text: string, idle = false): void {
  if (!tagEl || !textEl) return;
  tagEl.textContent = tag;
  textEl.textContent = text;
  textEl.classList.toggle('idle', idle);
}

function rest(): void {
  const first = [...pinned.values()][0];
  if (first) show(first.tag, first.text);
  else show('', IDLE, true);
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
export function pinStatus(msg: { tag: string; text: string } | null, key = 'budget'): void {
  if (msg) pinned.set(key, msg);
  else pinned.delete(key);
  const order = ['arm', 'budget'];
  const sorted = [...pinned].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  pinned.clear();
  for (const [k, v] of sorted) pinned.set(k, v);
  rest();
}
