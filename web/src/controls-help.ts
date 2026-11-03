// SPDX-License-Identifier: GPL-3.0-only
// The ? card's "On the FM-1" section, made from the controls table (controls.ts, #553): what the FM-1 does that is no
// single control, then the controls that work everywhere, then each state's, in the controls sheet's order.
import { everywhereRows, FM1_NOTES, gestureText, HELP_STATES, HELP_STATE_TITLE, onlyIn, rowHelp, stateRows, type HelpState } from './controls';

export interface HelpGroup { title: string | null; state?: HelpState; rows: { keys: string; text: string }[] }

/** the section's groups: the notes (no title), Everywhere, then one per state */
export function fm1HelpGroups(): HelpGroup[] {
  const cap = (t: string): string => t[0].toUpperCase() + t.slice(1);
  return [
    { title: null, rows: FM1_NOTES },
    { title: 'Everywhere', rows: everywhereRows().map((r) => ({ keys: gestureText(r.gesture), text: rowHelp(r) + onlyIn(r) })) },
    ...HELP_STATES.map((s) => ({ title: cap(HELP_STATE_TITLE[s]), state: s, rows: stateRows(s).map((r) => ({ keys: gestureText(r.gesture), text: rowHelp(r) })) })),
  ];
}

/** fills the section (its h3 kept) */
export function renderFm1Help(section: HTMLElement): void {
  const h3 = section.querySelector('h3');
  section.replaceChildren(...(h3 ? [h3] : []));
  for (const g of fm1HelpGroups()) {
    if (g.title) {
      const h = document.createElement('h4');
      h.textContent = g.title;
      section.append(h);
    }
    for (const r of g.rows) {
      const row = document.createElement('div');
      row.className = 'hrow';
      const keys = document.createElement('span');
      keys.className = 'hkeys';
      keys.textContent = r.keys;
      const text = document.createElement('span');
      text.textContent = r.text;
      row.append(keys, text);
      section.append(row);
    }
  }
}
