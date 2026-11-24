// SPDX-License-Identifier: GPL-3.0-only
// The button editor (#116, design board F): what a patch button does in this patch. DOES (Nothing / Gate / Toggle), a
// Toggle's TARGET (a device or an effect, D-1424), PRESS (while held / switches) and the LABEL the FM-1 shows. The Editor
// owns the popover (popover.ts openFloat, kept across redraws) and refills it with this after every change.

import { arpJackless } from './arp-button';
import { assembliesOf, assemblyById, assemblyOf, drawers, effectsOf, ownerOf, parentOf, type AssemblyInst } from './assembly';
import { KIND_LABEL, kindOf, mainOf, pageList, setKind, setPages, setSwitches, setTarget, switches, type ButtonKind } from './buttons';
import { NOT_DEVICES, pageLabel, type Device } from './pages';
import { moduleName } from './labels';
import { buttonLabel, DEFS, FIXED_DOES } from './modules';
import { PAGE_LIST_MAX, PANEL_LABEL_MAX, type ModuleInst, type Patch } from './patch';
import { closeButton } from './popover';

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

/** a target a Toggle offers: its select value (`a` + assembly id, `m` + module id), its name, the heading it is under */
export interface ToggleChoice { value: string; text: string; group: string }

/** a module's name in the lists: its type's, then its own name */
const memberName = (m: ModuleInst): string => moduleName(m.type, DEFS[m.type].label) + (m.name ? ` ${m.name}` : '');

/**
 * The targets a Toggle offers (D-1424): what the user sees as devices. The top-level assemblies, then the top-level
 * modules (never Main or the Output), then each FX drawer of the Output or of a top-level instrument, the drawer itself
 * and each of its effects ("Monolith D › FX › Delay"). Never a member inside an assembly.
 */
export function toggleChoices(p: Patch): ToggleChoice[] {
  const out: ToggleChoice[] = [];
  for (const a of assembliesOf(p)) if (!a.drawer && !parentOf(p, a.id)) out.push({ value: `a${a.id}`, text: a.label, group: 'Assemblies' });
  const inside = new Set(assembliesOf(p).flatMap((a) => a.modules));
  const seen = new Map<string, number>();
  for (const m of p.modules) {
    if (inside.has(m.id) || m.type === 'fm1' || m.type === 'output' || NOT_DEVICES.has(m.type)) continue;
    const base = memberName(m);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ value: `m${m.id}`, text: n > 1 ? `${base} ${n}` : base, group: 'Modules' });
  }
  for (const d of drawers(p)) {
    const own = ownerOf(p, d);
    if (own !== 'output' && parentOf(p, own.id)) continue;   // (an instrument inside another assembly is no device)
    const group = `${own === 'output' ? 'Output' : own.label} › FX`;
    out.push({ value: `a${d.id}`, text: group, group });
    for (const e of effectsOf(p, d)) out.push({ value: `a${e.id}`, text: `${group} › ${e.label}`, group });
  }
  return out;
}

/**
 * A Toggle's target that the list does not offer (a member inside an assembly, set before D-1424): it keeps working, and
 * the editor shows it as the device it is in, "Monolith D › Filter 2". Null when the list has it or it is gone.
 */
export function keptTarget(p: Patch, t: { module: number } | { asm: number } | undefined): ToggleChoice | null {
  if (!t) return null;
  const value = 'module' in t ? `m${t.module}` : `a${t.asm}`;
  if (toggleChoices(p).some((c) => c.value === value)) return null;
  const path: string[] = [];
  let a: AssemblyInst | undefined;
  if ('module' in t) {
    const m = p.modules.find((x) => x.id === t.module);
    if (!m) return null;
    path.push(memberName(m));
    a = assemblyOf(p, m.id);
  } else a = assemblyById(p, t.asm);
  for (; a; a = parentOf(p, a.id)) path.unshift(a.label);
  return path.length > 1 || 'asm' in t ? { value, text: path.join(' › '), group: 'Set before: inside a device' } : null;
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
  head.append(title, scope, closeButton(`the ${name} button editor`));
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
    const none = new Option('— pick a device or effect —', '');
    sel.append(none);
    const kept = keptTarget(p, t);
    const groups = new Map<string, ToggleChoice[]>();
    for (const c of [...toggleChoices(p), ...(kept ? [kept] : [])]) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    for (const [label, list] of groups) {
      const og = document.createElement('optgroup');
      og.label = label;
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
    if (kept) {
      const note = document.createElement('p');
      note.className = 'be-hint be-kept';
      note.textContent = `It bypasses ${kept.text}, a part inside a device, set before the list offered only devices. It still works; pick another target to change it.`;
      out.push(note);
    }
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
    : b === 'arp' && arpJackless(p) ? 'Switches its Arpeggiator, like the card’s ⏻. It has no jack while it does.'
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
