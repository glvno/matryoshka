// SPDX-License-Identifier: GPL-3.0-only
// The controls strip (#554): a band under the emulated FM-1 in the Emu view, after Blender's status bar, that shows in big
// type the controls for what the FM-1 is doing now. It follows the Emu view's copy of the FM-1, or the connected FM-1
// when that one reports its panel (GUIDE_NOW, feature bit 18, #549). Everything in it is made from the controls table
// (controls.ts, #553): the rows, their order, their conditions, the state's name and the chips' parts. Nothing here is
// written by hand, so a new order in that table (#555) reaches the strip with no other change.
//
// While a button is held (or a step's white key), the strip shows what that modifier does instead, the way Blender's
// status bar changes while a modifier key is down: the rows whose gesture holds it.
import {
  BUTTON_ID, CONDITIONS, CONTROLS, doesText, gestureSpec, HELP_STATE_NAME, HELP_STATE_TITLE, HELP_STATES, sheetRows,
  type Button, type Condition, type ControlRow, type HelpState,
} from './controls';
import type { PanelState } from './protocol';

/** what the strip needs of the panel's state (GUIDE_NOW, or the Emu copy's same bytes) */
export type StripInput = Pick<PanelState, 'state' | 'held' | 'stepHeld' | 'conditions'>;

/** the modifier a row's gesture holds: a button, or a held step */
export type Modifier = Button | 'step';

export interface StripView {
  state: HelpState;
  /** the state's name on the sheet's tab (DEVICE, PIANO ROLL ...) */
  name: string;
  /** where the FM-1 is, in a sentence */
  title: string;
  /** the modifier held whose rows show, or null: the state's own rows */
  held: Modifier | null;
  /** the rows to show first, in the table's order */
  rows: ControlRow[];
  /** the state's EVERYWHERE rows (none while a modifier shows) */
  everywhere: ControlRow[];
  /** K1..K4: what each does among the rows shown, '' nothing */
  knobs: [string, string, string, string];
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

/** the strip for a panel state: the controls table's rows for that state, in its order, with what is held */
export function stripView(p: StripInput): StripView {
  const state = HELP_STATES[p.state] ?? 'device';
  const holds = (r: ControlRow): boolean => conditionHolds(r.when, p.conditions);
  const tab = (t: 'state' | 'everywhere'): ControlRow[] => sheetRows(state, t).filter((r): r is ControlRow => 'gesture' in r).filter(holds);
  const own = tab('state');
  const everywhere = tab('everywhere');
  // a held step first, then the buttons held: the first whose rows this state lists
  const candidates: Modifier[] = [...(p.stepHeld ? ['step' as const] : []), ...heldButtons(p.held)];
  for (const m of candidates) {
    const rows = [...own, ...everywhere].filter((r) => usesModifier(r, m));
    if (rows.length) return { state, name: HELP_STATE_NAME[state], title: HELP_STATE_TITLE[state], held: m, rows, everywhere: [], knobs: knobsOf(rows, state) };
  }
  return { state, name: HELP_STATE_NAME[state], title: HELP_STATE_TITLE[state], held: null, rows: own, everywhere, knobs: knobsOf(own.filter((r) => !r.gesture.hold), state) };
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

/** a row as chips: its gesture's parts, then what it does (in `state`'s words: the sheet's `doesIn`) */
export function rowChip(r: ControlRow, held: Modifier | null, lead = false, state?: HelpState): HTMLElement {
  const c = el('span', `cs-chip${lead ? ' lead' : ''}`);
  c.dataset.row = r.id;
  const spec = el('span', 'cs-spec');
  for (const s of gestureSpec(r.gesture).split('|').filter(Boolean)) spec.append(part(s, held));
  c.append(spec);
  const does = doesText(r, state);   // ({list}: the Page button, GUIDE_NOW does not name it)
  if (does) c.append(el('span', 'cs-does', does));
  return c;
}

/** where the strip's state comes from */
export type StripSource = 'emu' | 'fm1';

/** the strip's element and its drawing: draw(state) redraws only when what it shows changed */
export class ControlsStrip {
  readonly el: HTMLElement;
  private last = '';
  constructor() {
    this.el = el('section', 'controls-strip');
    this.el.setAttribute('aria-label', 'Controls strip: the FM-1 controls for what it is doing now');
    this.el.setAttribute('aria-live', 'polite');
    this.el.hidden = true;
  }

  /** draw the strip for a panel state (null: nothing known yet, hidden) */
  draw(p: StripInput | null, source: StripSource): void {
    if (!p) { this.el.hidden = true; this.last = ''; return; }
    const v = stripView(p);
    const key = JSON.stringify([source, v.state, v.held, v.rows.map((r) => r.id), v.everywhere.map((r) => r.id)]);
    this.el.hidden = false;
    if (key === this.last) return;
    this.last = key;
    this.el.classList.toggle('mod', !!v.held);
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
    v.rows.forEach((r, i) => rows.append(rowChip(r, v.held, i === 0, v.state)));
    body.append(rows);
    if (v.everywhere.length) {
      const ev = el('div', 'cs-rows cs-everywhere');
      ev.append(el('span', 'cs-label', 'EVERYWHERE'));
      for (const r of v.everywhere) ev.append(rowChip(r, null));
      body.append(ev);
    }
    const knobs = el('div', 'cs-kmap');
    v.knobs.forEach((t, i) => {
      const k = el('div', t ? '' : 'off');
      k.append(el('span', `cs-dot k${i + 1}`, String(i + 1)), el('span', '', t || '–'));
      knobs.append(k);
    });
    this.el.replaceChildren(head, body, knobs);
  }
}
