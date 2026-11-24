// SPDX-License-Identifier: GPL-3.0-only
// Library > Palettes (#1236): the palettes this browser keeps (saved-palettes.ts), 8 sounds each, to send to the FM-1. The
// list: a row per palette, newest change first, with Open (a click on the row too), Send to FM-1, Export and ✕, and under
// it Recently deleted (this session) with "put back". A palette open: its name (an input), its 8 chips (palette-view.ts,
// mode 'saved': a click opens the sound in the editor, a patch dropped on a chip takes that position after asking its
// name, a chip dragged onto another moves there or the two swap, × empties it), Send to FM-1, Export, Delete, and beside
// the chips the open patch's candidates to drag in. main.ts does the rest (the send's confirm, files, toasts, the dock).
import type { LibrarySection } from './bank';
import { PaletteView } from './palette-view';
import { patchDragSource, type PatchDragItem } from './patch-drag';
import { PALETTE_SLOTS, soundChip, soundOf, type PaletteSound, type SavedPalette, type SavedPaletteStore } from './saved-palettes';

export interface PalettesEvents {
  store: SavedPaletteStore;
  /** an FM-1 that keeps a palette is linked (Send to FM-1 / Save from FM-1 work) */
  linked(): boolean;
  /** a chip clicked: open the sound in the editor */
  hear(s: PaletteSound, p: SavedPalette, pos: number): void;
  /** Send to FM-1 (main asks first) */
  send(p: SavedPalette): void;
  saveFromFm1(): void;
  exportFile(p: SavedPalette): void;
  importFile(): void;
  /** after store.remove: main offers Undo */
  deleted(p: SavedPalette): void;
  /** the name a sound goes in under, asked at `anchor` (`initial` offered); null: cancelled */
  askName(initial: string, anchor: HTMLElement): Promise<string | null>;
  /** the open patch's candidates, as drag sources */
  candidates(): { patchName: string; rows: { letter: string; name?: string; item: PatchDragItem }[] };
  /** the open palette changed (main's Library dock follows) */
  opened(id: string | null): void;
  say(text: string): void;
}

export interface PalettesSection extends LibrarySection {
  /** show a palette open (null, deleted or unknown: the list) */
  open(id: string | null): void;
  openId(): string | null;
}

/** why Send / Save from FM-1 cannot work now */
const NOT_LINKED = 'Connect an FM-1 with firmware 1.26';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

/** a button that does `run` */
const button = (text: string, title: string, run: () => void, cls = ''): HTMLButtonElement =>
  el('button', { type: 'button', class: cls, textContent: text, title, onclick: (e: MouseEvent) => { e.stopPropagation(); run(); } });

const soundCount = (p: SavedPalette): number => p.sounds.filter(Boolean).length;
/** "5 sounds", as the list and Recently deleted say it */
const soundsLabel = (p: SavedPalette): string => { const n = soundCount(p); return `${n} sound${n === 1 ? '' : 's'}`; };

/** Library > Palettes, built into `root` (after its title) */
export function buildPalettesSection(root: HTMLElement, ev: PalettesEvents): PalettesSection {
  const { store } = ev;
  let openId: string | null = null;

  // the list
  const rowsEl = el('div', { class: 'bank-list lpal-rows' });
  rowsEl.setAttribute('role', 'list');
  rowsEl.setAttribute('aria-label', 'Palettes');
  const emptyEl = el('p', { class: 'muted lpal-empty', textContent: 'No palettes yet. New palette makes an empty one, Save from FM-1 keeps a copy of the FM-1’s palette, and Add to palette on a patch or candidate fills one.' });
  const binRows = el('div', { class: 'bank-list' });
  binRows.setAttribute('role', 'list');
  binRows.setAttribute('aria-label', 'Recently deleted');
  const binEl = el('section', { class: 'lpal-deleted' }, el('h3', { class: 'lpal-sub', textContent: 'Recently deleted' }), binRows);
  const saveBtn = button('Save from FM-1', '', () => ev.saveFromFm1());
  const listView = el('section', { class: 'card lib-single lpal-list' },
    el('p', { class: 'muted lpal-intro', textContent: 'Palettes you keep in this browser, 8 sounds each, to send to the FM-1. The sidebar’s chips are the palette ON THE FM-1.' }),
    el('div', { class: 'toolbar' },
      button('New palette', 'Make an empty palette and open it, its name ready to change', () => {
        open(store.create().id);
        nameEl.focus();
        nameEl.select();
      }, 'primary'),
      button('Import…', 'Open a palette file (.palette.json) as a new palette', () => ev.importFile()),
      saveBtn,
    ),
    emptyEl, rowsEl, binEl,
  );

  // a palette open
  const nameEl = el('input', { type: 'text', class: 'lpal-name', spellcheck: false });
  nameEl.setAttribute('aria-label', 'Palette name');
  const sendBtn = button('Send to FM-1', '', () => { const p = current(); if (p) ev.send(p); }, 'primary');
  const exportBtn = button('Export', '', () => { const p = current(); if (p) ev.exportFile(p); });
  const deleteBtn = button('Delete', '', () => {
    const p = current();
    if (!p || !store.remove(p.id)) return;
    ev.deleted(p);
    open(null);
  }, 'delete');
  const view = new PaletteView({
    click(pos) {
      const p = current(), s = p?.sounds[pos];
      if (p && s) ev.hear(s, p, pos);
    },
    remove(pos) { if (openId) store.setSound(openId, pos, null); },
    move(from, to) { if (openId) store.move(openId, from, to); },
    drop(pos, item) { void dropOn(pos, item); },
  }, 'lpal-chips');
  const candHead = el('h3', { class: 'lpal-sub' });
  const candRows = el('div', { class: 'lpal-cand-list' });
  candRows.setAttribute('role', 'list');
  const candNone = el('p', { class: 'muted', textContent: 'No candidates: open a patch to drag its candidates in.' });
  const openView = el('section', { class: 'card lpal-open', hidden: true },
    el('div', { class: 'lpal-bar' },
      button('← All palettes', 'Back to the list of palettes', () => open(null), 'lpal-back'),
      nameEl,
      el('div', { class: 'toolbar lpal-actions' }, sendBtn, exportBtn, deleteBtn),
    ),
    el('div', { class: 'lpal-body' },
      view.el,
      el('aside', { class: 'lpal-cands' },
        candHead,
        el('p', { class: 'muted lpal-hint', textContent: 'Drag one onto a chip. While this palette is open, rows in Library › Patches and Community drag onto its square at the bottom right.' }),
        candRows, candNone,
      ),
    ),
  );
  root.append(listView, openView);

  /** the open palette, if it still exists */
  function current(): SavedPalette | undefined {
    return openId ? store.get(openId) : undefined;
  }

  /** a patch dropped on chip `pos`: it goes there under the name the user gives */
  async function dropOn(pos: number, item: PatchDragItem): Promise<void> {
    const id = openId;
    if (!id) return;
    const patch = item.patch();
    if (!patch) {
      ev.say(`No copy of "${item.name}" in this browser: it cannot go into a saved palette`);
      return;
    }
    const chip = view.el.querySelector<HTMLElement>(`.pal-chip[data-pos="${pos}"]`) ?? view.el;
    const name = await ev.askName(item.name, chip);
    if (name === null) return;
    store.setSound(id, pos, soundOf(name.trim() || item.name, patch));
  }

  const commitName = (): void => {
    const p = current();
    if (!p) return;
    if (nameEl.value.trim() && nameEl.value.trim() !== p.name) store.rename(p.id, nameEl.value);
    nameEl.value = store.get(p.id)?.name ?? p.name;
  };
  nameEl.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitName(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nameEl.value = current()?.name ?? ''; }
  };
  nameEl.onchange = commitName;
  nameEl.onblur = commitName;

  /** Send to FM-1 on `b`, for `p` */
  const sendState = (b: HTMLButtonElement, p: SavedPalette): void => {
    b.disabled = !ev.linked();
    b.title = b.disabled ? NOT_LINKED : `Send ${p.name} to the FM-1: it replaces the FM-1’s whole palette (asks first)`;
  };

  const renderList = (): void => {
    const all = store.all();
    emptyEl.hidden = all.length > 0;
    rowsEl.hidden = !all.length;
    saveBtn.disabled = !ev.linked();
    saveBtn.title = saveBtn.disabled ? NOT_LINKED : 'Save the FM-1’s palette as a new palette';
    rowsEl.replaceChildren(...all.map((p) => {
      const names = p.sounds.flatMap((s) => (s ? [s.name] : [])).join(' · ');
      const send = button('Send to FM-1', '', () => ev.send(p));
      sendState(send, p);
      const row = el('div', { class: 'bank-row lpal-row', title: `Open ${p.name}`, onclick: () => open(p.id) },
        el('span', { class: 'lpal-pname', textContent: p.name }),
        el('span', { class: 'muted lpal-count', textContent: soundsLabel(p) }),
        el('span', { class: 'grow muted lpal-sounds', textContent: names, title: names }),
        button('Open', `Open ${p.name} to change its sounds`, () => open(p.id)),
        send,
        button('Export', `Save ${p.name} as a file (.palette.json)`, () => ev.exportFile(p)),
        button('✕', `Delete ${p.name}`, () => { if (store.remove(p.id)) ev.deleted(p); }, 'delete'),
      );
      row.setAttribute('role', 'listitem');
      return row;
    }));
    const bin = store.deleted();
    binEl.hidden = !bin.length;
    binRows.replaceChildren(...bin.map(({ palette: p }) => {
      const row = el('div', { class: 'bank-row lpal-row-deleted' },
        el('span', { class: 'lpal-pname', textContent: p.name }),
        el('span', { class: 'grow muted', textContent: soundsLabel(p) }),
        button('put back', `Put ${p.name} back in the list`, () => store.putBack(p.id)),
      );
      row.setAttribute('role', 'listitem');
      return row;
    }));
  };

  const renderOpen = (p: SavedPalette): void => {
    // (not while the user types in it, unless it shows another palette)
    if (document.activeElement !== nameEl || nameEl.dataset.id !== p.id) nameEl.value = p.name;
    nameEl.dataset.id = p.id;
    view.setHead(p.name, `${soundCount(p)} of ${PALETTE_SLOTS}`);
    view.render(p.sounds.map((s, i) => soundChip(s, i)), 'saved');
    sendState(sendBtn, p);
    exportBtn.title = `Save ${p.name} as a file (.palette.json)`;
    deleteBtn.title = `Delete ${p.name} (you can undo it)`;
    const c = ev.candidates();
    candHead.textContent = `Drag in: candidates of ${c.patchName || 'Untitled'}`;
    candNone.hidden = c.rows.length > 0;
    candRows.replaceChildren(...c.rows.map((r) => {
      const row = el('div', { class: 'lpal-cand', title: `Drag onto a chip to put ${r.item.name} there` },
        el('span', { class: 'lpal-letter', textContent: r.letter }),
        el('span', { class: 'lpal-cand-name', textContent: r.name || r.item.name }),
      );
      row.setAttribute('role', 'listitem');
      patchDragSource(row, () => r.item);
      return row;
    }));
  };

  /** show the palette `id` open, or the list */
  function open(id: string | null): void {
    const to = id && store.get(id) ? id : null;
    const changed = to !== openId;
    if (changed && document.activeElement === nameEl) commitName();   // (a name typed for the palette open goes to it)
    openId = to;
    refresh();
    if (changed) ev.opened(to);
  }

  function refresh(): void {
    const p = current();
    if (openId && !p) {
      openId = null;
      ev.opened(null);
    }
    listView.hidden = !!p;
    openView.hidden = !p;
    if (p) renderOpen(p);
    else renderList();
  }

  refresh();
  return {
    refresh,
    enter: refresh,
    deviceChanged: refresh,
    open,
    openId: () => openId,
  };
}
