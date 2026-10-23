// SPDX-License-Identifier: GPL-3.0-only
// The button editor (#116, design board F): what a patch button does in this patch. DOES (Nothing / Gate / Toggle), a
// Toggle's TARGET (a module or an assembly), PRESS (while held / switches) and the LABEL the FM-1 shows. The Editor owns
// the popover (a top-layer element that survives redraws) and refills it with this after every change.

import { assembliesOf } from './assembly';
import { KIND_LABEL, kindOf, mainOf, pageList, setKind, setPages, setSwitches, setTarget, switches, type ButtonKind } from './buttons';
import { pageLabel, type Device } from './pages';
import { moduleName } from './labels';
import { buttonLabel, DEFS, FIXED_DOES } from './modules';
import { EDITOR_ONLY, PAGE_LIST_MAX, PANEL_LABEL_MAX, type Patch } from './patch';

export interface ButtonEditorEvents {
  patch(): Patch;
  /** one undo step: the edit, then the redraw and the engine reload (Editor.change) */
  change(fn: () => void): void;
  /** the label on the FM-1 (patch.ts panelLabel), '' for none */
  label(text: string): void;
  /** the patch's devices and their pages (pages.ts devicesOf) */
  devices(): Device[];
}

/** "Oracle V · filter 1/2": a page of a Page button's list */
export const listEntryName = (devices: Device[], x: { device: string; page: number }): string => {
  const d = devices.find((y) => y.key === x.device);
  const pg = d?.pages[x.page];
  return d && pg ? `${d.name} · ${pageLabel(d, x.page)}` : '(gone)';
};

/** the targets a Toggle can name, assemblies first, each with a name to tell it apart */
export function toggleChoices(p: Patch): { value: string; text: string; group: 'asm' | 'module' }[] {
  const out: { value: string; text: string; group: 'asm' | 'module' }[] = [];
  for (const a of assembliesOf(p)) out.push({ value: `a${a.id}`, text: a.label, group: 'asm' });
  const seen = new Map<string, number>();
  for (const m of p.modules) {
    if (m.type === 'fm1' || m.type === 'output' || EDITOR_ONLY.has(m.type)) continue;
    const base = moduleName(m.type, DEFS[m.type].label) + (m.name ? ` ${m.name}` : '');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ value: `m${m.id}`, text: n > 1 ? `${base} ${n}` : base, group: 'module' });
  }
  return out;
}

/** a row of choices, one pressed (a segmented control) */
function segmented<T extends string>(label: string, options: [T, string][], now: T, pick: (v: T) => void): HTMLElement {
  const field = document.createElement('div');
  field.className = 'be-field';
  const head = document.createElement('span');
  head.className = 'be-label';
  head.textContent = label;
  const row = document.createElement('div');
  row.className = 'be-seg';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-pressed', String(v === now));
    b.onclick = () => { if (v !== now) pick(v); };
    row.append(b);
  }
  field.append(head, row);
  return field;
}

/** the editor's content for button b (`fixed`: GLO, whose job is fixed: no DOES, no target) */
export function buttonEditor(b: string, ev: ButtonEditorEvents, fixed = false): HTMLElement[] {
  const p = ev.patch();
  const panel = mainOf(p)?.panel;
  const kind = kindOf(panel, b);
  const name = buttonLabel(b);
  const head = document.createElement('div');
  head.className = 'be-head';
  const title = document.createElement('strong');
  title.textContent = `${name} button`;
  const scope = document.createElement('span');
  scope.textContent = 'this patch';
  head.append(title, scope);
  const out: HTMLElement[] = [head];
  if (!fixed)
    out.push(segmented<ButtonKind>('Does', (['nothing', 'gate', 'page', 'bypass'] as ButtonKind[]).map((k) => [k, KIND_LABEL[k]]), kind,
      (k) => ev.change(() => setKind(ev.patch(), b, k))));
  if (kind === 'bypass' && !fixed) {
    const field = document.createElement('label');
    field.className = 'be-field';
    const l = document.createElement('span');
    l.className = 'be-label';
    l.textContent = 'Bypasses';
    const sel = document.createElement('select');
    const t = panel?.targets?.[b];
    const now = !t ? '' : 'module' in t ? `m${t.module}` : `a${t.asm}`;
    const none = new Option('— pick a module or assembly —', '');
    sel.append(none);
    const choices = toggleChoices(p);
    for (const [group, text] of [['asm', 'Assemblies'], ['module', 'Modules']] as const) {
      const list = choices.filter((c) => c.group === group);
      if (!list.length) continue;
      const og = document.createElement('optgroup');
      og.label = text;
      for (const c of list) og.append(new Option(c.text, c.value));
      sel.append(og);
    }
    sel.value = now;
    sel.onchange = () => {
      const v = sel.value;
      ev.change(() => setTarget(ev.patch(), b, !v ? null : v[0] === 'm' ? { module: Number(v.slice(1)) } : { asm: Number(v.slice(1)) }));
    };
    field.append(l, sel);
    out.push(field);
  }
  if (kind === 'page') out.push(pagesField(b, ev));
  if (kind === 'gate' || kind === 'bypass')
    out.push(segmented<'hold' | 'switch'>('Press', [['hold', 'While held'], ['switch', 'Switches']], switches(panel, b) ? 'switch' : 'hold',
      (v) => ev.change(() => setSwitches(ev.patch(), b, v === 'switch'))));
  {
    const field = document.createElement('label');
    field.className = 'be-field';
    const l = document.createElement('span');
    l.className = 'be-label';
    l.textContent = 'Label on the FM-1';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = PANEL_LABEL_MAX;
    input.placeholder = name;
    input.value = panel?.labels?.[b] ?? '';
    input.spellcheck = false;
    input.onchange = () => ev.label(input.value);
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); };
    field.append(l, input);
    out.push(field);
  }
  const hint = document.createElement('p');
  hint.className = 'be-hint';
  hint.textContent = fixed ? `${buttonLabel(b)}: ${FIXED_DOES[b] ?? 'the FM-1’s own'}. Fixed on the FM-1; its jack is high while held.`
    : kind === 'nothing' ? 'Unassigned: no role. Its jack still goes high while it is held.'
    : kind === 'gate' ? 'Its jack is high while held (or switched on): patch it.'
    : kind === 'page' ? 'A press puts the next page of the list on K1..K4; held, its first page shows while it is down; HOME goes back.'
    : 'Bypasses its target, like the card’s ⏻. Its jack is high while engaged.';
  out.push(hint);
  return out;
}

/** a Page button's list: drag to reorder, × to remove, a picker to add (or Alt-click a card row while this is open) */
function pagesField(b: string, ev: ButtonEditorEvents): HTMLElement {
  const p = ev.patch();
  const devices = ev.devices();
  const list = pageList(p, b, devices);
  const field = document.createElement('div');
  field.className = 'be-field';
  const head = document.createElement('span');
  head.className = 'be-label';
  head.textContent = `Pages (${list.length})`;
  const ol = document.createElement('ol');
  ol.className = 'be-pages';
  let dragged = -1;
  list.forEach((x, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    const grip = document.createElement('span');
    grip.className = 'be-grip';
    grip.textContent = '≡';
    grip.setAttribute('aria-hidden', 'true');
    const n = document.createElement('span');
    n.className = 'be-n';
    n.textContent = String(i + 1);
    const name = document.createElement('span');
    name.className = 'be-name';
    name.textContent = listEntryName(devices, x);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'be-del';
    del.textContent = '×';
    del.setAttribute('aria-label', `Remove ${name.textContent}`);
    del.onclick = () => ev.change(() => setPages(ev.patch(), b, list.filter((_, k) => k !== i)));
    // keyboard: Alt+Up / Alt+Down move the page
    li.tabIndex = 0;
    li.onkeydown = (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const to = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= list.length) return;
      const next = [...list];
      next.splice(to, 0, next.splice(i, 1)[0]);
      ev.change(() => setPages(ev.patch(), b, next));
    };
    li.ondragstart = (e) => { dragged = i; e.dataTransfer?.setData('text/plain', String(i)); li.classList.add('dragging'); };
    li.ondragend = () => li.classList.remove('dragging');
    li.ondragover = (e) => { if (dragged >= 0) e.preventDefault(); };
    li.ondrop = (e) => {
      e.preventDefault();
      if (dragged < 0 || dragged === i) return;
      const next = [...list];
      next.splice(i, 0, next.splice(dragged, 1)[0]);
      dragged = -1;
      ev.change(() => setPages(ev.patch(), b, next));
    };
    li.append(grip, n, name, del);
    ol.append(li);
  });
  const add = document.createElement('select');
  add.className = 'be-add';
  add.setAttribute('aria-label', 'Add a page');
  add.append(new Option(list.length >= PAGE_LIST_MAX ? `the list is full (${PAGE_LIST_MAX})` : '+ Add page (or Alt-click a card row)', ''));
  add.disabled = list.length >= PAGE_LIST_MAX;
  for (const d of devices) {
    const og = document.createElement('optgroup');
    og.label = d.name;
    d.pages.forEach((_, i) => og.append(new Option(`${d.name} · ${pageLabel(d, i)}`, `${d.key}#${i}`)));
    add.append(og);
  }
  add.onchange = () => {
    const [device, page] = add.value.split('#');
    if (device) ev.change(() => setPages(ev.patch(), b, [...list, { device, page: Number(page) }]));
  };
  field.append(head, ol, add);
  return field;
}
