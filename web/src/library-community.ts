// SPDX-License-Identifier: GPL-3.0-only
// Library > Community: the bundled community patches (community.ts), opt-in. One card per family (an FM-1 version and its
// XL), with the author, the age, the notes' first line and the Source link, and a row per version: its name, its chip
// (FM-1 · NN % or SANDBOX, sandbox.ts) and Add / Added ✓. Add puts the entry into Your patches, linked to the bundled entry
// until the user saves it as their own; Added ✓ takes it out again. Filters: ALL, FM-1, SANDBOX, ADDED. Like the rest of
// the Library it opens nothing: an added patch opens from the Open picker or the palette.
import type { BufferAllocation } from './signal-buffers';
import type { LibrarySection } from './bank';
import ARCHIVED from '../community/factory.json';
import {
  addCommunity, addedTitles, ageOf, chipOfEntry, familiesOf, ISSUE_FORM, isAdded, LICENCES, loadCommunity, notesOf, onAddedChange,
  REDDIT_SEARCH, removeCommunity, SUBREDDIT, type CommunityPatch,
} from './community';
import { chipEl } from './sandbox';
import { isSaved, onSavedChange } from './saved';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

export type CommunityFilter = 'all' | 'fm1' | 'sandbox' | 'added';
const FILTERS: [CommunityFilter, string][] = [['all', 'ALL'], ['fm1', 'FM-1'], ['sandbox', 'SANDBOX'], ['added', 'ADDED']];
const archivedTitles = new Set(ARCHIVED.map(entry => entry.title));

/** whether a version row shows under a filter */
export function passes(c: CommunityPatch, f: CommunityFilter, added: string[] = addedTitles(), allocation: BufferAllocation = 0): boolean {
  if (f === 'added') return added.includes(c.entry.title);
  if (f === 'all') return true;
  return chipOfEntry(c, allocation).fits === (f === 'fm1');
}

export interface CommunityEvents {
  /** a message for the status line */
  status(msg: string): void;
}

/** Library > Community, built into `root` (it reads nothing from the FM-1) */
export function buildCommunitySection(root: HTMLElement, ev: CommunityEvents, allocation: () => BufferAllocation = () => 0): LibrarySection {
  let list: CommunityPatch[] | null = null;
  let filter: CommunityFilter = 'all';
  const grid = el('div', { class: 'comm-grid' });
  const filterBtns = FILTERS.map(([f, label]) => el('button', { type: 'button', textContent: label, onclick: () => { filter = f; refresh(); } }));

  const toggle = (c: CommunityPatch): void => {
    const t = c.entry.title;
    if (isAdded(t)) {
      ev.status(removeCommunity(t) ? `"${t}" is out of Your patches` : 'The browser refused the storage: nothing changed');
      return;
    }
    if (isSaved(t)) {
      ev.status(`Your patches already hold a patch named "${t}": rename it in Library > Patches to add this one too`);
      return;
    }
    ev.status(addCommunity(t) ? `"${t}" is in Your patches: open it from Open in the PATCH panel` : 'The browser refused the storage: it was not added');
  };

  const row = (c: CommunityPatch, base: CommunityPatch): HTMLElement => {
    const added = isAdded(c.entry.title) && !isSaved(c.entry.title);
    return el('div', { class: 'bank-row' },
      el('span', { class: 'grow', textContent: c.entry.title }),
      ...(archivedTitles.has(c.entry.title) ? [el('span', { class: 'muted', textContent: 'Archived factory', title: 'Original version, kept separately from current factory patches.' })] : []),
      ...(c.entry.author !== base.entry.author ? [el('span', { class: 'muted', textContent: c.entry.author })] : []),
      ...(c.entry.source !== base.entry.source ? [el('a', { href: c.entry.source, target: '_blank', rel: 'noopener', textContent: 'Source ↗' })] : []),
      ...(c.entry.licence !== base.entry.licence ? [el('a', { href: LICENCES[c.entry.licence].url, target: '_blank', rel: 'noopener', textContent: LICENCES[c.entry.licence].name })] : []),
      chipEl(chipOfEntry(c, allocation())),
      el('button', {
        type: 'button',
        class: added ? 'comm-add added' : 'comm-add',
        textContent: added ? 'Added ✓' : 'Add',
        title: added ? `In Your patches. Click to take it out again` : `Put "${c.entry.title}" into Your patches, with its author`,
        disabled: !c.patch,
        onclick: () => toggle(c),
      }),
    );
  };

  const card = (members: CommunityPatch[], name: string): HTMLElement => {
    const base = members[0];
    const authors = [...new Set(members.map((c) => c.entry.author))].join(', ');
    const newest = members.map((c) => c.entry.added).sort().at(-1)!;
    const notes = notesOf(base);
    return el('section', { class: 'card comm-card', ariaLabel: name },
      el('h2', {}, el('span', { class: 'grow', textContent: name }), el('span', { class: 'muted', textContent: `${authors} · ${ageOf(newest)}` })),
      ...(notes ? [el('p', { textContent: notes })] : []),
      el('div', { class: 'bank-list' }, ...members.map((c) => row(c, base))),
      el('p', { class: 'comm-source' },
        el('a', { href: base.entry.source, target: '_blank', rel: 'noopener', textContent: 'Source ↗' }),
        ' · ',
        el('a', { href: LICENCES[base.entry.licence].url, target: '_blank', rel: 'noopener', textContent: LICENCES[base.entry.licence].name }),
      ),
    );
  };

  function refresh(): void {
    for (const [i, b] of filterBtns.entries()) b.setAttribute('aria-pressed', String(FILTERS[i][0] === filter));
    if (!list) {
      grid.replaceChildren(el('p', { class: 'muted', textContent: 'Reading the community patches…' }));
      return;
    }
    const added = addedTitles();
    const cards = familiesOf(list)
      .map((f) => ({ name: f.name, members: f.members.filter((c) => passes(c, filter, added, allocation())) }))
      .filter((f) => f.members.length)
      .map((f) => card(f.members, f.name));
    grid.replaceChildren(...(cards.length ? cards : [el('p', { class: 'muted', textContent: filter === 'added' ? 'None added yet. Add puts a patch into Your patches.' : filter === 'all' ? 'No community patch here yet.' : 'None of the community patches is one of these.' })]));
  }

  root.append(
    el('div', { class: 'comm-top' },
      el('p', { class: 'muted' }, 'Patches by players and former factory instruments. Each card names its author and licence. Add one to put it in Your patches; nothing from here appears there until you add it.'),
      el('div', { class: 'comm-filters', role: 'group', ariaLabel: 'Show' }, ...filterBtns),
    ),
    grid,
    el('p', { class: 'comm-foot muted' },
      el('a', { href: ISSUE_FORM, target: '_blank', rel: 'noopener', textContent: 'Submit a patch' }),
      el('a', { href: REDDIT_SEARCH, target: '_blank', rel: 'noopener', textContent: `More on ${SUBREDDIT} ↗` }),
      el('span', { textContent: 'Added patches are kept by this browser.' }),
    ),
  );
  onAddedChange(refresh);
  onSavedChange(refresh);
  refresh();
  const enter = (): void => {
    if (list) refresh();
    else void loadCommunity().then((l) => { list = l; refresh(); });
  };
  return { refresh, enter, deviceChanged(shown) { if (shown) refresh(); } };
}
