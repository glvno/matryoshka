// SPDX-License-Identifier: GPL-3.0-only
// The palette's square of 8 chips (#1196): at the bottom of the Sound design sidebar, and in the Library (where patches
// are dragged from). Each chip is one position, numbered as the FM-1's black keys: the patch's name, its presets (the
// first, "+n" for more) and its pattern, or EMPTY / MISSING. The one the FM-1 plays is marked, and the one waiting for
// the bar line. With an FM-1 that keeps a palette: a click switches to it, a patch dropped on it goes there, a chip
// dragged onto another moves there (onto a full one the two swap), × empties it. With no FM-1: the last palette read,
// greyed and read-only; a click opens the entry from this browser's copy. palette.ts holds the model. The FM-1's square
// is headed ON THE FM-1 (after Send to FM-1: "· from Palette 3") with Save as a palette; a saved palette (#1236,
// library-palettes.ts) uses the same square in mode `saved`: a click hears the sound, drops, moves and × change the
// saved palette.
import type { Chip } from './palette';
import { patchDropTarget, DRAG_START_PX, type PatchDragItem } from './patch-drag';

/** how the chips work now: an FM-1 that keeps a palette, none (the last read, read-only), one whose firmware has none, or
 *  a saved palette (always editable) */
export type PaletteMode = 'live' | 'offline' | 'old' | 'saved';

export interface PaletteActions {
  click(pos: number): void;
  remove(pos: number): void;
  move(from: number, to: number): void;
  drop(pos: number, item: PatchDragItem): void;
  /** Save as a palette (the FM-1's square): the palette as a new saved palette */
  save?(): void;
}

/** the head of the FM-1's square */
export const ON_THE_FM1 = 'ON THE FM-1';

/** the text under the square for each mode (empty: none) */
export const PALETTE_NOTE: Record<PaletteMode, string> = {
  live: '',
  offline: 'No FM-1: the palette as last read. Click a chip to open it here.',
  old: 'Needs FM-1 firmware 1.26',
  saved: '',
};

/** a chip's second line: the first preset, "+n" for the others, and the pattern (P01 …) */
export function chipMeta(c: Chip): string {
  const presets = c.presets.length ? `${c.presets[0]}${c.presets.length > 1 ? ` +${c.presets.length - 1}` : ''}` : '';
  return [presets, `P${String(c.pattern + 1).padStart(2, '0')}`].filter(Boolean).join(' · ');
}

/** a chip's hover text */
function chipTitle(c: Chip, mode: PaletteMode): string {
  const n = c.pos + 1;
  if (mode === 'old') return `Palette ${n}: ${PALETTE_NOTE.old}`;
  if (mode === 'saved') {
    if (c.state === 'empty') return `${n}: empty. Drag a patch or a candidate here`;
    const presets = c.presets.length ? `, presets ${c.presets.join(', ')}` : '';
    return `${n}: ${c.name}${presets}, pattern ${c.pattern + 1}. Click to hear it in the editor; drag onto another chip to move it`;
  }
  if (c.state === 'empty') return mode === 'live' ? `Palette ${n}: empty. Drag a patch here, or hold HOME and black key ${n} for 1 s on the FM-1 to save the sound there` : `Palette ${n}: empty`;
  const presets = c.presets.length ? `, presets ${c.presets.join(', ')}` : '';
  const what = `Palette ${n}: ${c.name}${presets}, pattern ${c.pattern + 1}`;
  if (c.state === 'missing') return `${what}. MISSING: its slot no longer holds this patch, so the FM-1 skips it`;
  const here = c.copy ? '' : ' (no copy of it in this browser)';
  return mode === 'live'
    ? `${what}${here}. Click to switch the FM-1 to it (playing: at the next bar line); drag onto another chip to move it`
    : `${what}${here}. Click to open it`;
}

export class PaletteView {
  readonly el: HTMLElement;
  private grid: HTMLElement;
  private note: HTMLElement;
  private title: HTMLElement;
  private sub: HTMLElement;
  private keys: HTMLElement;
  private saveBtn: HTMLButtonElement;

  constructor(private act: PaletteActions, className = '') {
    this.el = document.createElement('div');
    this.el.className = `palette ${className}`.trim();
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', ON_THE_FM1);
    const head = document.createElement('div');
    head.className = 'palette-head';
    this.title = document.createElement('span');
    this.title.className = 'palette-title';
    this.title.textContent = ON_THE_FM1;
    this.sub = document.createElement('span');
    this.sub.className = 'palette-from';
    this.sub.hidden = true;
    this.keys = document.createElement('span');
    this.keys.className = 'palette-keys';
    this.keys.textContent = 'HOME + black key';
    this.keys.title = 'On the FM-1: hold HOME and tap black key 1..8 to switch, hold the key 1 s to save the sound there';
    this.saveBtn = document.createElement('button');
    this.saveBtn.type = 'button';
    this.saveBtn.className = 'palette-save';
    this.saveBtn.textContent = 'Save as a palette';
    this.saveBtn.hidden = true;
    this.saveBtn.onclick = () => this.act.save?.();
    head.append(this.title, this.sub, this.keys, this.saveBtn);
    this.grid = document.createElement('div');
    this.grid.className = 'palette-grid';
    this.note = document.createElement('p');
    this.note.className = 'palette-note';
    this.el.append(head, this.grid, this.note);
  }

  /** the head: the FM-1's square says ON THE FM-1 and, after Send to FM-1, "· from Palette 3" (`sub`); a saved palette
   *  says its name */
  setHead(title: string, sub = ''): void {
    this.title.textContent = title;
    this.sub.textContent = sub ? `· ${sub}` : '';
    this.sub.hidden = !sub;
    this.el.setAttribute('aria-label', sub ? `${title} · ${sub}` : title);
  }

  /** Save as a palette: shown with `title` as its hover text, or hidden (null) */
  setSave(title: string | null): void {
    this.saveBtn.hidden = title === null || !this.act.save;
    this.saveBtn.title = title ?? '';
  }

  render(chips: Chip[], mode: PaletteMode): void {
    this.el.dataset.mode = mode;
    this.keys.hidden = mode === 'saved' || !this.saveBtn.hidden;
    this.note.textContent = PALETTE_NOTE[mode];
    this.note.hidden = !PALETTE_NOTE[mode];
    this.grid.replaceChildren(...chips.map((c) => this.chip(c, mode)));
  }

  private chip(c: Chip, mode: PaletteMode): HTMLElement {
    const r = document.createElement('div');
    r.className = `pal-chip ${c.state}`;
    r.dataset.pos = String(c.pos);
    r.classList.toggle('cur', c.cur);
    r.classList.toggle('next', c.next);
    r.classList.toggle('nocopy', c.state === 'ok' && !c.copy);
    r.title = chipTitle(c, mode);
    const num = document.createElement('span');
    num.className = 'pal-num';
    num.textContent = String(c.pos + 1);
    const name = document.createElement('span');
    name.className = 'pal-name';
    name.textContent = c.state === 'empty' ? 'EMPTY' : c.name;
    const meta = document.createElement('span');
    meta.className = 'pal-meta';
    meta.textContent = c.state === 'missing' ? 'MISSING' : c.state === 'ok' ? chipMeta(c) : '';
    r.append(num, name, meta);
    if (c.next) {
      const tag = document.createElement('span');
      tag.className = 'pal-tag';
      tag.textContent = 'NEXT';
      r.append(tag);
    }
    if (mode === 'old' || (mode === 'offline' && c.state === 'empty')) {
      r.setAttribute('aria-disabled', 'true');
      return r;
    }
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    r.setAttribute('aria-label', r.title);
    if (c.cur) r.setAttribute('aria-current', 'true');
    r.onclick = () => this.act.click(c.pos);
    r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.act.click(c.pos); } };
    if (mode !== 'live' && mode !== 'saved') return r;
    patchDropTarget(r, (item) => this.act.drop(c.pos, item));
    if (c.state === 'empty') return r;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'pal-x';
    x.textContent = '×';
    x.title = mode === 'saved' ? `Remove ${c.name} from ${c.pos + 1}` : `Remove ${c.name} from palette ${c.pos + 1} (the patch stays in its slot)`;
    x.setAttribute('aria-label', x.title);
    x.onclick = (e) => { e.stopPropagation(); this.act.remove(c.pos); };
    x.onpointerdown = (e) => e.stopPropagation();
    r.append(x);
    r.onpointerdown = (e) => this.drag(e, r, c.pos);
    return r;
  }

  /** a chip dragged onto another: it lifts and follows the pointer, the chip under it lights up, a release moves it there */
  private drag(e: PointerEvent, chip: HTMLElement, from: number): void {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let lift: HTMLElement | null = null;
    let to: HTMLElement | null = null;
    const move = (ev: PointerEvent): void => {
      if (!lift && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
      if (!lift) {
        const box = chip.getBoundingClientRect();
        lift = chip.cloneNode(true) as HTMLElement;
        lift.classList.add('pal-lifted');
        lift.style.width = `${box.width}px`;
        lift.style.left = `${box.left}px`;
        lift.style.top = `${box.top}px`;
        document.body.append(lift);
        chip.classList.add('pal-ghost');
      }
      lift.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px) rotate(-1.5deg)`;
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.pal-chip');
      const t = under && under !== chip && this.grid.contains(under) ? under : null;
      if (t !== to) { to?.classList.remove('pal-drop'); to = t; to?.classList.add('pal-drop'); }
    };
    const up = (): void => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      to?.classList.remove('pal-drop');
      chip.classList.remove('pal-ghost');
      if (!lift) return;
      lift.remove();
      const swallow = (c: MouseEvent): void => { c.stopPropagation(); c.preventDefault(); };
      addEventListener('click', swallow, true);
      setTimeout(() => removeEventListener('click', swallow, true));
      if (to) this.act.move(from, Number(to.dataset.pos));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }
}

/** the folded sidebar's rail: a dot per position, numbered, the one playing filled; a click as on its chip */
export function renderPaletteRail(root: HTMLElement, chips: Chip[], mode: PaletteMode, click: (pos: number) => void): void {
  root.replaceChildren(...chips.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pal-dot ${c.state}`;
    b.classList.toggle('cur', c.cur);
    b.classList.toggle('next', c.next);
    b.textContent = String(c.pos + 1);
    b.title = chipTitle(c, mode);
    b.setAttribute('aria-label', b.title);
    b.disabled = mode === 'old' || c.state === 'empty';
    b.onclick = () => click(c.pos);
    return b;
  }));
}
