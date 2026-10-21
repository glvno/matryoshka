// SPDX-License-Identifier: GPL-3.0-only
// Community patches (glvno/matryoshka#157): a curated list bundled with the app, `community.json`, fed by the GitHub issue
// form `.github/ISSUE_TEMPLATE/community-patch.yml`. An accepted submission becomes one entry in a commit; the entries are
// third-party patches under CC BY-SA 4.0 (LICENSING.md), not the GPL code. No live fetching: the shelf reads only the
// bundled JSON, and "More on r/MVaveFM1" is a plain link. Each entry's `code` is a share link's `#p=` value, decoded lazily
// (share.ts) the first time the shelf or the Open picker needs it.
import RAW from './community.json';
import { instIsEngine } from './engines';
import { DEFS } from './modules';
import type { Patch } from './patch';
import { deviceBudget } from './patchbin';
import { decodeShare } from './share';
import { OLD_SITE_URL, SITE_URL } from './site';

export interface CommunityEntry {
  title: string;
  /** the name the author wants credited (a Reddit or GitHub handle is fine) */
  author: string;
  licence: 'CC-BY-SA-4.0';
  /** where it was posted: the Reddit post or the GitHub issue */
  source: string;
  /** the share link's `#p=` value */
  code: string;
  /** when it was added to the list, an ISO date (YYYY-MM-DD) */
  added: string;
  /** the submitter's notes, when the patch carries none of its own */
  notes?: string;
}

export const LICENCE = 'CC BY-SA 4.0';
export const LICENCE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
export const ISSUE_FORM = 'https://github.com/glvno/matryoshka/issues/new?template=community-patch.yml';
export const SUBREDDIT = 'r/MVaveFM1';
/** the address without its scheme and trailing slash, as a search term (matryoshka.pages.dev) */
const bare = (url: string): string => url.replace(/^https:\/\//, '').replace(/\/$/, '');
/** a search of the subreddit for posts that link the app, at its address or the old one (Reddit's search takes OR) */
export const REDDIT_SEARCH = `https://www.reddit.com/r/MVaveFM1/search?q=${encodeURIComponent(`${bare(SITE_URL)} OR ${bare(OLD_SITE_URL)}`)}&restrict_sr=1`;

const isUrl = (s: unknown): boolean => typeof s === 'string' && /^https:\/\/\S+$/.test(s);
const filled = (s: unknown): boolean => typeof s === 'string' && s.trim().length > 0;

/** what is wrong with an entry's fields, empty when nothing (the code is checked by decoding it) */
export function entryProblems(raw: unknown): string[] {
  const e = (raw ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (!filled(e.title)) out.push('no title');
  if (!filled(e.author)) out.push('no author');
  if (e.licence !== 'CC-BY-SA-4.0') out.push('the licence is not CC-BY-SA-4.0');
  if (!isUrl(e.source)) out.push('the source is not an https URL');
  if (typeof e.code !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(e.code)) out.push('the code is not a share link value');
  if (typeof e.added !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.added) || Number.isNaN(Date.parse(e.added))) out.push('added is not a YYYY-MM-DD date');
  if (e.notes !== undefined && typeof e.notes !== 'string') out.push('notes is not text');
  return out;
}

/** the list's well-formed entries, newest first */
export const communityEntries = (raw: unknown = RAW): CommunityEntry[] =>
  (Array.isArray(raw) ? raw : [])
    .filter((e) => !entryProblems(e).length)
    .map((e) => e as CommunityEntry)
    .sort((a, b) => b.added.localeCompare(a.added));

/** an entry with its patch decoded (`patch` undefined when its code holds no valid patch) */
export interface CommunityPatch {
  entry: CommunityEntry;
  patch?: Patch;
}

let decoded: CommunityPatch[] | null = null;
let pending: Promise<CommunityPatch[]> | null = null;

/** decodes every entry once; later calls return the same list */
export function loadCommunity(): Promise<CommunityPatch[]> {
  pending ??= Promise.all(
    communityEntries().map(async (entry) => {
      try {
        return { entry, patch: await decodeShare(entry.code, DEFS) };
      } catch {
        return { entry };
      }
    }),
  ).then((list) => (decoded = list));
  return pending;
}

/** the decoded entries so far (empty until loadCommunity has finished) */
export const communityPatches = (): CommunityPatch[] => decoded ?? [];

/** a fresh copy of an entry's patch, named after the entry when the patch has no name */
export const openCommunity = (c: CommunityPatch): Patch => {
  const p = structuredClone(c.patch!);
  if (!p.name.trim()) p.name = c.entry.title;
  return p;
};

/** the patch's own notes (#165) or the entry's, first line */
export function notesOf(c: CommunityPatch): string {
  const own = (c.patch as { notes?: unknown } | undefined)?.notes;
  const text = typeof own === 'string' && own.trim() ? own : c.entry.notes ?? '';
  return text.trim().split('\n')[0] ?? '';
}

/** the names of the engines in the patch (its top-level assemblies that take keys and make sound, engines.ts) */
export function enginesOf(p: Patch): string[] {
  const all = p.assemblies ?? [];
  const nested = new Set(all.flatMap((a) => a.children ?? []));
  return [...new Set(all.filter((a) => !nested.has(a.id) && instIsEngine(p, a)).map((a) => a.name))];
}

/** whether it fits the FM-1, computed when shown (never stored) */
export function fitOf(p: Patch): { fits: boolean; text: string } {
  const b = deviceBudget(p);
  return b.fits ? { fits: true, text: `plays on FM-1 · ${Math.round(b.use * 100)} %` } : { fits: false, text: 'browser only' };
}

/** how long ago it was added: today, 3 d, 2 w, 5 mo, 1 y */
export function ageOf(added: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(added)) / 86_400_000));
  if (days < 1) return 'today';
  if (days < 14) return `${days} d`;
  if (days < 60) return `${Math.floor(days / 7)} w`;
  if (days < 365) return `${Math.floor(days / 30)} mo`;
  return `${Math.floor(days / 365)} y`;
}

/**
 * The issue form, filled in as far as the app can: the patch's name and its share link (from the share sheet, #165).
 * GitHub fills an issue form's fields from query parameters named after their ids.
 */
export function submitUrl(patch?: { name: string }, link?: string): string {
  const q = new URLSearchParams({ template: 'community-patch.yml' });
  const name = patch?.name.trim();
  if (name) {
    q.set('title', `Community patch: ${name}`);
    q.set('patch-title', name);
  }
  if (link) q.set('link', link);
  return `https://github.com/glvno/matryoshka/issues/new?${q}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

const SVG = 'http://www.w3.org/2000/svg';
const CARD = { w: 300, h: 170 };

/** a thumbnail of the patch's canvas: a box per module where it sits, its cables as lines */
function thumb(p: Patch): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'community-thumb');
  svg.setAttribute('aria-hidden', 'true');
  const ms = p.modules.slice(0, 60);
  const x0 = Math.min(0, ...ms.map((m) => m.x)), y0 = Math.min(0, ...ms.map((m) => m.y));
  const x1 = Math.max(CARD.w, ...ms.map((m) => m.x + CARD.w)), y1 = Math.max(CARD.h, ...ms.map((m) => m.y + CARD.h));
  svg.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const at = new Map(ms.map((m) => [m.id, m]));
  for (const m of ms) {
    const r = document.createElementNS(SVG, 'rect');
    for (const [k, v] of Object.entries({ x: m.x + 10, y: m.y + 10, width: CARD.w - 20, height: CARD.h - 20, rx: 14 })) r.setAttribute(k, String(v));
    svg.append(r);
  }
  for (const c of p.cables.slice(0, 80)) {
    const a = at.get(c.from.module), b = at.get(c.to.module);
    if (!a || !b) continue;
    const l = document.createElementNS(SVG, 'line');
    for (const [k, v] of Object.entries({ x1: a.x + CARD.w - 10, y1: a.y + CARD.h / 2, x2: b.x + 10, y2: b.y + CARD.h / 2 })) l.setAttribute(k, String(v));
    svg.append(l);
  }
  return svg;
}

export interface ShelfEvents {
  /** load a patch into the editor, as a share link does (not saved until the user saves it) */
  open(p: Patch, title: string): void;
  /** "Post yours": the share sheet (#165) */
  post(): void;
  /** the decoded list is ready (the Open picker refills) */
  loaded(): void;
}

/** the "Community patches" card at the top of the Library tab */
export function buildCommunityShelf(root: HTMLElement, ev: ShelfEvents): void {
  const list = el('div', { class: 'community-list' });
  const licence = (): HTMLAnchorElement => el('a', { href: LICENCE_URL, target: '_blank', rel: 'noopener', textContent: LICENCE, title: 'Creative Commons Attribution-ShareAlike 4.0' });
  const render = (items: CommunityPatch[]): void => {
    const ok = items.filter((c) => c.patch);
    if (!ok.length) {
      list.replaceChildren(
        el('div', { class: 'community-empty' },
          el('b', { textContent: 'None yet: post yours.' }),
          el('span', { textContent: `Be the first: share a patch through the form and it lands here for everyone, credited to you under ${LICENCE}.` }),
        ),
      );
      return;
    }
    list.replaceChildren(
      ...ok.map((c) => {
        const p = c.patch!;
        const fit = fitOf(p);
        const engines = enginesOf(p);
        const notes = notesOf(c);
        return el('div', { class: 'community-row' },
          thumb(p),
          el('div', { class: 'community-main' },
            el('b', { class: 'community-title', textContent: c.entry.title, title: c.entry.title }),
            el('span', { class: 'community-by' }, `by ${c.entry.author} · `, licence(), ` · ${ageOf(c.entry.added)}`),
            ...(notes ? [el('span', { class: 'community-notes', textContent: notes, title: notes })] : []),
            el('span', { class: 'community-meta' },
              ...(engines.length ? [`Engines: ${engines.join(', ')} · `] : []),
              el('span', { class: fit.fits ? 'community-fit' : 'community-fit over', textContent: fit.text }),
            ),
          ),
          el('div', { class: 'community-tools' },
            el('button', { class: 'community-open', textContent: 'Open', title: 'open it in the editor (nothing is saved until you save it)', onclick: () => ev.open(openCommunity(c), c.entry.title) }),
            el('a', { class: 'community-src', href: c.entry.source, target: '_blank', rel: 'noopener', textContent: '↗', title: 'open the post', ariaLabel: `open the post of "${c.entry.title}"` }),
          ),
        );
      }),
    );
  };
  list.replaceChildren(el('p', { class: 'muted', textContent: 'Loading…' }));
  void loadCommunity().then((items) => {
    render(items);
    ev.loaded();
  });
  root.append(
    el('section', { class: 'card community', ariaLabel: 'Community patches' },
      el('h2', {}, el('span', { class: 'mtag eng', textContent: 'SHARED' }), 'Community patches', el('span', { class: 'muted', textContent: `by players, ${LICENCE}` })),
      list,
      el('div', { class: 'community-foot' },
        el('span', { class: 'muted' }, 'Open loads a patch like a patch link: nothing is saved until you save it. ', el('a', { href: ISSUE_FORM, target: '_blank', rel: 'noopener', textContent: 'Submit one through the form' }), '.'),
        el('a', { class: 'community-more', href: REDDIT_SEARCH, target: '_blank', rel: 'noopener', textContent: `More on ${SUBREDDIT} ↗` }),
        el('button', { class: 'community-post', textContent: 'Post yours', title: 'share the open patch and submit it to the list', onclick: () => ev.post() }),
      ),
    ),
  );
}
