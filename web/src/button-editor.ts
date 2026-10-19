// SPDX-License-Identifier: GPL-3.0-only
// The button editor (#116, design board F): what a patch button does in this patch. DOES (Nothing / Gate / Toggle), a
// Toggle's TARGET (a module or an assembly), PRESS (while held / switches) and the LABEL the FM-1 shows. The Editor owns
// the popover (a top-layer element that survives redraws) and refills it with this after every change.

import { assembliesOf } from './assembly';
import { KIND_LABEL, kindOf, mainOf, setKind, setSwitches, setTarget, switches, type ButtonKind } from './buttons';
import { moduleName } from './labels';
import { DEFS } from './modules';
import { EDITOR_ONLY, PANEL_LABEL_MAX, type Patch } from './patch';

export interface ButtonEditorEvents {
  patch(): Patch;
  /** one undo step: the edit, then the redraw and the engine reload (Editor.change) */
  change(fn: () => void): void;
  /** the label on the FM-1 (patch.ts panelLabel), '' for none */
  label(text: string): void;
}

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
  const name = b.toUpperCase();
  const head = document.createElement('div');
  head.className = 'be-head';
  const title = document.createElement('strong');
  title.textContent = `${name} button`;
  const scope = document.createElement('span');
  scope.textContent = 'this patch';
  head.append(title, scope);
  const out: HTMLElement[] = [head];
  if (!fixed)
    out.push(segmented<ButtonKind>('Does', (['nothing', 'gate', 'bypass'] as ButtonKind[]).map((k) => [k, KIND_LABEL[k]]), kind,
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
  if (kind !== 'nothing')
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
  hint.textContent = fixed ? 'GLO will open Main’s global page (#118).'
    : kind === 'nothing' ? 'Unassigned: no role. Its jack still goes high while it is held.'
    : kind === 'gate' ? 'Its jack is high while held (or switched on): patch it.'
    : 'Bypasses its target, like the card’s ⏻. Its jack is high while engaged.';
  out.push(hint);
  return out;
}
