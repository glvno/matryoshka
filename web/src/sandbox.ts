// SPDX-License-Identifier: GPL-3.0-only
// Sandbox patches: a patch over the FM-1's budget (patchbin.ts deviceBudget) plays in the browser with no limits. It is
// first-class, never an error: its colour is gold (--sandbox in style.css), red stays for real failures, and the word is SANDBOX. Here:
// the chip every patch list shows (FM-1 · NN % or SANDBOX, worked out from the patch when shown, never stored), the
// status line's words for an open sandbox patch, and the "No limits here" card, shown once per browser the first time a
// patch is a sandbox patch and afterwards from the status line's SANDBOX pill.
import type { Patch } from './patch';
import { deviceBudget, type Budget } from './patchbin';

export interface Chip {
  fits: boolean;
  /** "FM-1 · 84 %" or "SANDBOX" */
  text: string;
}

/** the chip of a budget: FM-1 and how full it is, or SANDBOX */
export const chipOfBudget = (b: Pick<Budget, 'fits' | 'use'>): Chip =>
  b.fits ? { fits: true, text: `FM-1 · ${Math.round(b.use * 100)} %` } : { fits: false, text: 'SANDBOX' };

/** chips worked out this visit, by the patch's content (the Open picker lists every patch again after each save) */
const known = new Map<string, Chip>();

/** a patch's chip (a patch that cannot be counted is a sandbox patch) */
export function chipOf(p: Patch): Chip {
  const key = JSON.stringify(p);
  const had = known.get(key);
  if (had) return { ...had };
  let c: Chip;
  try {
    c = chipOfBudget(deviceBudget(p));
  } catch {
    c = { fits: false, text: 'SANDBOX' };
  }
  if (known.size >= 256) known.clear();
  known.set(key, c);
  return { ...c };
}

/** the chip as an element: teal outline for FM-1, gold fill for SANDBOX */
export function chipEl(c: Chip): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `fit-chip ${c.fits ? 'fm1' : 'sandbox'}`;
  s.textContent = c.text;
  s.title = c.fits ? 'Fits the FM-1: this much of its budget' : 'Sandbox patch: too big for the FM-1, it plays here in the browser with no limits';
  return s;
}

/** how many times the FM-1's budget, rounded up to a tenth so a patch just over never reads 1.0× */
const times = (x: number): string => `${(Math.ceil(x * 10 - 1e-9) / 10).toFixed(1)}×`;

/** the status line's words for a sandbox patch: "Plays here, with no FM-1 limits: 2.7× its CPU, 2.1× its memory." (and any
 *  browser-only ability it uses: "Delay over 520 ms") */
export function sandboxWords(b: Pick<Budget, 'memory' | 'cpu'> & { over?: Budget['over'] }): string {
  const parts = [
    ...(b.cpu.use > 1 ? [`${times(b.cpu.use)} its CPU`] : []),
    ...(b.memory > 1 ? [`${times(b.memory)} its memory`] : []),
    ...(b.over ?? []).filter((i) => i.key === 'browser').map((i) => i.label.replace(/: browser only$/, '')),
  ];
  return parts.length ? `Plays here, with no FM-1 limits: ${parts.join(', ')}.` : 'Plays here, with no FM-1 limits.';
}

const SEEN = 'matryoshka.sandbox-seen';

/** whether the first-time card is still due in this browser (storage blocked: never, as it could not be dismissed) */
export function sandboxCardDue(): boolean {
  try {
    return localStorage.getItem(SEEN) === null;
  } catch {
    return false;
  }
}

const LINES: [string, string, string][] = [
  ['♪', 'Plays here.', 'Every module, cable and voice you add.'],
  ['⌁', 'Your FM-1 is the controller.', 'Connected, its keys, knobs and pages drive this patch; the computer makes the sound.'],
  ['↧', 'Not stored on the FM-1.', 'Bring it under the bars to send it, or keep it as a sandbox patch.'],
];

let open: HTMLElement | null = null;

/** the "No limits here" card; marks it seen. `costs` opens the budget's breakdown (What costs most) */
export function showSandboxCard(o: { costs: () => void }): void {
  try {
    localStorage.setItem(SEEN, '1');
  } catch {
    /* storage blocked: it shows from the pill only */
  }
  open?.remove();
  const card = document.createElement('section');
  card.className = 'tutorial-offer spanel sandbox-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-labelledby', 'sandbox-card-title');
  const head = document.createElement('div');
  head.className = 'shead';
  const tag = document.createElement('span');
  tag.className = 'fit-chip sandbox';
  tag.textContent = 'SANDBOX';
  const title = document.createElement('span');
  title.className = 'stitle';
  title.id = 'sandbox-card-title';
  title.textContent = 'No limits here';
  head.append(tag, title);
  const body = document.createElement('div');
  body.className = 'tutorial-body';
  const lead = document.createElement('p');
  lead.textContent = 'This patch is bigger than the FM-1 can hold, and that is fine: it plays here in the browser. Keep building.';
  const list = document.createElement('div');
  list.className = 'sandbox-lines';
  for (const [icon, strong, rest] of LINES) {
    const i = document.createElement('span');
    i.className = 'sandbox-icon';
    i.setAttribute('aria-hidden', 'true');
    i.textContent = icon;
    const t = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = strong;
    t.append(b, ` ${rest}`);
    list.append(i, t);
  }
  const actions = document.createElement('div');
  actions.className = 'tour-actions';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'primary';
  ok.textContent = 'Got it';
  const costs = document.createElement('button');
  costs.type = 'button';
  costs.textContent = 'What costs most';
  actions.append(ok, costs);
  body.append(lead, list, actions);
  card.append(head, body);
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
  const close = (): void => {
    card.remove();
    if (open === card) open = null;
    document.removeEventListener('keydown', onKey);
  };
  ok.onclick = close;
  costs.onclick = () => { close(); o.costs(); };
  document.body.append(card);
  document.addEventListener('keydown', onKey);
  open = card;
  ok.focus();
}
