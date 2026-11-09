// SPDX-License-Identifier: GPL-3.0-only
// The controls strip (#554): a band under the emulated FM-1 in the Emu view, after Blender's status bar, that shows in big
// type the controls for what the FM-1 is doing now. It follows the Emu view's copy of the FM-1, or the connected FM-1
// when that one reports its panel (GUIDE_NOW, feature bit 18, #549). Everything in it is made from the controls table
// (controls.ts, #553): the rows, their order, their conditions, the state's name and the chips' parts. Nothing here is
// written by hand, so a new order in that table (#555) reaches the strip with no other change.
//
// While a button is held (or a step's white key), the strip shows what that modifier does instead, the way Blender's
// status bar changes while a modifier key is down: the rows whose gesture holds it.
//
// From the loaded patch (StripPatch, when the FM-1 shown plays the editor's patch) it adds what the table cannot know: the
// patch buttons with a job (FX, LFO, EDIT, ARP, as the sheet lists them: help_ui.c help_patch_rows) and, on a device
// page, the names of the rows K1..K4 turn there. A long state shows the sheet's first screen (SHEET_ROWS rows) and a
// "+N more" toggle; the choice is remembered per viewer.
import { kindOf, mainOf, switches } from './buttons';
import {
  BUTTON_ID, CONDITIONS, doesText, gestureSpec, HELP_STATE_NAME, HELP_STATE_TITLE, HELP_STATES, sheetRows, stateRows, stripDoes,
  type Button, type Condition, type ControlRow, type HelpState,
} from './controls';
import { buttonLabel } from './modules';
import { panelLabel, type Patch } from './patch';
import { deviceSection } from './patchbin';
import { deviceView } from './poly';
import type { PanelState } from './protocol';
import './device-shown';   // (what the FM-1 shows, for the device compile pass)

/** what the strip needs of the panel's state (GUIDE_NOW, or the Emu copy's same bytes); the device page in focus too,
 * for its knob names */
export type StripInput = Pick<PanelState, 'state' | 'held' | 'stepHeld' | 'conditions'> & Partial<Pick<PanelState, 'device' | 'devicePage'>>;

/** the rows the FM-1's controls sheet shows on its first screen (help_ui.c HC_VIS): the strip's rows before "+N more" */
export const SHEET_ROWS = 8;

/** the modifier a row's gesture holds: a button, or a held step */
export type Modifier = Button | 'step';

/** a patch button with a job in the loaded patch, as the sheet lists it: its name, then "label pages / on/off / held" */
export interface PatchButtonRow { id: string; button: Button; does: string }
/** a row of the strip: one of the controls table's, or a patch button's */
export type StripRow = ControlRow | PatchButtonRow;
const isControl = (r: StripRow): r is ControlRow => 'gesture' in r;

/** what the strip takes from the loaded patch */
export interface StripPatch {
  /** the patch buttons with a job, in the sheet's order */
  buttons: PatchButtonRow[];
  /** the row names K1..K4 turn on the binary's device page [device][page] (the FM-1's indices, GUIDE_NOW's) */
  pages: string[][][];
}

/** the patch buttons the sheet lists (help_ui.c help_patch_rows; SEL, ENV and GLO are fixed) */
const PATCH_BUTTON_NAMES = ['fx', 'lfo', 'edit', 'arp'] as const;

/** what the strip needs of a patch: its patch buttons with a job, worded as the FM-1's sheet words them (help_ui.c
 * help_patch_rows: a Toggle or a Page button always has one, any other when a cable leaves its jack; the patch's label in
 * lower case, else the button's name, then "pages", "on/off" when it switches, else "held"), and its device pages' row
 * names as the binary lists them */
export function stripPatch(source: Patch): StripPatch {
  const dev = deviceView(source, true).patch;
  const main = mainOf(dev);
  const panel = mainOf(source)?.panel;
  const buttons: PatchButtonRow[] = main ? PATCH_BUTTON_NAMES.flatMap((b) => {
    const kind = kindOf(panel, b);
    const job = kind === 'bypass' || kind === 'page' || dev.cables.some((c) => c.from.module === main.id && c.from.port === b);
    if (!job) return [];
    const label = (panelLabel(panel?.labels?.[b]) || buttonLabel(b)).toLowerCase();
    const how = kind === 'page' ? 'pages' : kind === 'bypass' || switches(panel, b) ? 'on/off' : 'held';
    return [{ id: `patch-${b}`, button: buttonLabel(b) as Button, does: `${label} ${how}` }];
  }) : [];
  const pages = deviceSection(source, dev).map((d) => d.pages.map((pg) => pg.rows.map((r) => r.label)));
  return { buttons, pages };
}

export interface StripView {
  state: HelpState;
  /** the state's name on the sheet's tab (DEVICE, PIANO ROLL ...) */
  name: string;
  /** where the FM-1 is, in a sentence */
  title: string;
  /** the modifier held whose rows show, or null: the state's own rows */
  held: Modifier | null;
  /** the rows to show first, in the table's order (the patch buttons in their place): the sheet's first screen */
  rows: StripRow[];
  /** the rows after the first SHEET_ROWS, behind "+N more" */
  more: StripRow[];
  /** the state's EVERYWHERE rows (none while a modifier shows) */
  everywhere: ControlRow[];
  /** K1..K4: what each does ('' nothing): on a device page the names of its rows, else from the rows shown; null hides
   * them (a state whose knobs act only on a held step, with none held) */
  knobs: [string, string, string, string] | null;
}

/** the buttons by matrix id, without the OCT alias (both OCT buttons have their own name) */
const BUTTON_AT: Button[] = (Object.keys(BUTTON_ID) as Button[]).filter((b) => b !== 'OCT').sort((a, b) => BUTTON_ID[a] - BUTTON_ID[b]);

/** a row's condition holds in the panel's state (GUIDE_NOW's bit c is CONDITIONS[c - 1]) */
export function conditionHolds(when: ControlRow['when'], conditions: number): boolean {
  if (!when) return true;
  const neg = when.startsWith('!');
  const c = CONDITIONS.indexOf((neg ? when.slice(1) : when) as Condition);
  const on = ((conditions >> (c + 1)) & 1) !== 0;
  return neg ? !on : on;
}

/** the buttons held, by name, in matrix order */
export const heldButtons = (held: number): Button[] => BUTTON_AT.filter((b) => (held >> BUTTON_ID[b]) & 1);

/** a row works while `m` is held: it holds m, or m itself is held while the keys play (FX held: accent) */
const usesModifier = (r: ControlRow, m: Modifier): boolean =>
  r.gesture.hold === m || (r.gesture.how === 'held' && r.gesture.do.some((p) => 'button' in p && p.button === m));

/** a state whose K1..K4 act only on a held step (the drum grid): every row of it that turns one holds a
 * step */
export function knobsOnlyHeld(s: HelpState): boolean {
  const k = stateRows(s).filter((r) => r.gesture.do.some((d) => 'knobs' in d));
  return k.length > 0 && k.every((r) => r.gesture.hold === 'step');
}

/** the strip for a panel state: the controls table's rows for that state, in its order, with what is held; with the
 * loaded patch, its patch buttons where the sheet puts them and the device page's knob names */
export function stripView(p: StripInput, patch: StripPatch | null = null): StripView {
  const state = HELP_STATES[p.state] ?? 'device';
  const holds = (r: ControlRow): boolean => conditionHolds(r.when, p.conditions);
  const tab = (t: 'state' | 'everywhere'): StripRow[] =>
    sheetRows(state, t).flatMap((r): StripRow[] => (!('gesture' in r) ? patch?.buttons ?? [] : holds(r) ? [r] : []));
  const ownAll = tab('state');
  const own = ownAll.filter(isControl);
  const everywhere = tab('everywhere').filter(isControl);
  const base = { state, name: HELP_STATE_NAME[state], title: HELP_STATE_TITLE[state] };
  const split = (rows: StripRow[]): { rows: StripRow[]; more: StripRow[] } => ({ rows: rows.slice(0, SHEET_ROWS), more: rows.slice(SHEET_ROWS) });
  // on a device page: the names of the rows K1..K4 turn on the page in focus (unknown without the patch)
  const names = state === 'device' && p.device !== undefined && p.devicePage !== undefined ? patch?.pages[p.device]?.[p.devicePage] : undefined;
  const pageKnobs = names ? ([0, 1, 2, 3].map((k) => names[k] ?? '') as [string, string, string, string]) : null;
  // a held step first, then the buttons held: the first whose rows this state lists
  const candidates: Modifier[] = [...(p.stepHeld ? ['step' as const] : []), ...heldButtons(p.held)];
  for (const m of candidates) {
    const rows = [...own, ...everywhere].filter((r) => usesModifier(r, m));
    if (rows.length) return { ...base, held: m, ...split(rows), everywhere: [], knobs: pageKnobs ?? knobsOf(rows, state) };
  }
  const knobs = pageKnobs ?? (state === 'roll' || knobsOnlyHeld(state) ? null : knobsOf(own.filter((r) => !r.gesture.hold), state));
  return { ...base, held: null, ...split(ownAll), everywhere, knobs };
}

/** K1..K4's jobs among rows: the first row each knob turns */
function knobsOf(rows: ControlRow[], state: HelpState): [string, string, string, string] {
  const out: [string, string, string, string] = ['', '', '', ''];
  for (let k = 0; k < 4; k++) {
    const r = rows.find((x) => x.gesture.do.some((d) => 'knobs' in d && d.knobs.includes(String(k + 1))));
    if (r) out[k] = doesText(r, state);
  }
  return out;
}

// ---- drawing: the sheet's row spec (gestureSpec) as chips, as the FM-1's sheet draws them

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** one part of a row spec ('k:SEL', 'n:ALGO', 'c:1234', 'w:', 'b:10', 't:+', 'm:KEYS') as a chip */
function part(spec: string, held: Modifier | null): HTMLElement {
  const k = spec[0];
  const v = spec.slice(2);
  switch (k) {
    case 'k': return el('span', `cs-cap${held === v ? ' held' : ''}`, v);
    case 'n': {
      const n = el('span', 'cs-enc');
      n.append(el('span', 'cs-dot'), v);
      return n;
    }
    case 'c': {
      const n = el('span', 'cs-knobs');
      for (const d of v) n.append(el('span', `cs-dot k${d}`, d));
      return n;
    }
    case 'w': case 'b': {
      const n = el('span', `cs-key ${k === 'w' ? 'white' : 'black'}`);
      n.append(el('i', ''), k === 'w' ? 'WHITE' : `BLACK${v ? ` ${v}` : ''}`);
      return n;
    }
    case 'm': return el('span', 'cs-word', v);
    default: return el('span', `cs-t${held === 'step' && v === 'hold step +' ? ' held' : ''}`, v);
  }
}

/** a row as chips: its gesture's parts, then what it does in the strip's plain words (controls.ts stripDoes, in `state`'s words); a patch button its
 * cap, then its job in the patch */
export function rowChip(r: StripRow, held: Modifier | null, lead = false, state?: HelpState): HTMLElement {
  const c = el('span', `cs-chip${lead ? ' lead' : ''}${isControl(r) ? '' : ' patch'}`);
  c.dataset.row = r.id;
  const spec = el('span', 'cs-spec');
  for (const s of (isControl(r) ? gestureSpec(r.gesture) : `k:${r.button}`).split('|').filter(Boolean)) spec.append(part(s, held));
  c.append(spec);
  const does = isControl(r) ? stripDoes(r, state) : r.does;   // (the strip's own words; {list}: the Page button, GUIDE_NOW does not name it)
  if (does) c.append(el('span', 'cs-does', does));
  return c;
}

/** where the strip's state comes from */
export type StripSource = 'emu' | 'fm1';

/** where the viewer's "+N more" choice is kept (this browser only) */
export const MORE_KEY = 'matryoshka.controlsStrip.more';
const readMore = (): boolean => { try { return localStorage.getItem(MORE_KEY) === '1'; } catch { return false; } };

/** the strip's element and its drawing: draw(state) redraws only when what it shows changed */
export class ControlsStrip {
  readonly el: HTMLElement;
  private last = '';
  /** every row of a long state, not only the sheet's first screen (the viewer's choice) */
  private expanded = readMore();
  private redraw: (() => void) | null = null;
  constructor() {
    this.el = el('section', 'controls-strip');
    this.el.setAttribute('aria-label', 'Controls strip: the FM-1 controls for what it is doing now');
    this.el.setAttribute('aria-live', 'polite');
    this.el.hidden = true;
  }

  /** every row of a long state, or its first SHEET_ROWS; kept for this viewer */
  setExpanded(on: boolean): void {
    this.expanded = on;
    try { localStorage.setItem(MORE_KEY, on ? '1' : '0'); } catch { /* storage blocked: this visit only */ }
    this.last = '';
    this.redraw?.();
  }

  /** draw the strip for a panel state (null: nothing known yet, hidden); `patch`: the loaded patch's buttons and pages,
   * when the FM-1 shown plays the editor's patch */
  draw(p: StripInput | null, source: StripSource, patch: StripPatch | null = null): void {
    if (!p) { this.el.hidden = true; this.last = ''; this.redraw = null; return; }
    this.redraw = () => this.draw(p, source, patch);
    const v = stripView(p, patch);
    const key = JSON.stringify([source, v.state, v.held, v.rows.map((r) => r.id), v.more.map((r) => r.id), v.everywhere.map((r) => r.id),
      v.knobs, patch?.buttons.map((b) => b.does), this.expanded]);
    this.el.hidden = false;
    if (key === this.last) return;
    this.last = key;
    this.el.classList.toggle('mod', !!v.held);
    this.el.classList.toggle('no-kmap', !v.knobs);
    this.el.dataset.state = v.state;
    const head = el('div', 'cs-head');
    const heldName = v.held === 'step' ? 'STEP' : v.held;
    head.append(
      el('div', 'cs-name', heldName ? `${heldName} +` : v.name),
      el('div', 'cs-sub', heldName ? `${v.held === 'step' ? 'a step' : heldName} held, ${v.title}` : v.title),
      el('div', 'cs-from', source === 'fm1' ? 'following your FM-1' : 'following the Emu FM-1'),
    );
    const body = el('div', 'cs-body');
    const rows = el('div', 'cs-rows');
    const shown = this.expanded ? [...v.rows, ...v.more] : v.rows;
    shown.forEach((r, i) => rows.append(rowChip(r, v.held, i === 0, v.state)));
    if (v.more.length) {
      const t = el('button', 'cs-more', this.expanded ? 'fewer' : `+${v.more.length} more`);
      t.type = 'button';
      t.setAttribute('aria-expanded', String(this.expanded));
      t.title = this.expanded ? `back to the first ${SHEET_ROWS}, as the FM-1's controls sheet shows them` : 'every control here, past the sheet’s first screen';
      t.addEventListener('click', () => this.setExpanded(!this.expanded));
      rows.append(t);
    }
    body.append(rows);
    if (v.everywhere.length) {
      const ev = el('div', 'cs-rows cs-everywhere');
      ev.append(el('span', 'cs-label', 'EVERYWHERE'));
      for (const r of v.everywhere) ev.append(rowChip(r, null, false, v.state));
      body.append(ev);
    }
    if (!v.knobs) { this.el.replaceChildren(head, body); return; }
    const knobs = el('div', 'cs-kmap');
    v.knobs.forEach((t, i) => {
      const k = el('div', t ? '' : 'off');
      k.append(el('span', `cs-dot k${i + 1}`, String(i + 1)), el('span', '', t || '–'));
      knobs.append(k);
    });
    this.el.replaceChildren(head, body, knobs);
  }
}
