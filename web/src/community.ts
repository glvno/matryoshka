// SPDX-License-Identifier: GPL-3.0-only
// Community patches (glvno/matryoshka#157): a curated list bundled with the app, `community.json`, fed by the GitHub issue
// form `.github/ISSUE_TEMPLATE/community-patch.yml`. An accepted submission becomes one entry in a commit; the entries are
// third-party patches under CC BY-SA 4.0 (LICENSING.md), not the GPL code. No live fetching: the app reads only the
// bundled JSON, and "More on r/MVaveFM1" is a plain link. Each entry's `code` is a share link's `#p=` value, decoded lazily
// (share.ts) the first time Library > Community shows or an added entry is listed.
// Community is opt-in: nothing from it shows anywhere until the user adds an entry in Library > Community. An added entry
// is listed in Your patches with its author ("Sol 29N XL · michael glaviano"); it stays linked to the bundled entry (it
// loads by decoding it, so a fix to the entry reaches the user) until the user saves it under its name, which makes it
// their own copy and drops the link. Removing it from Your patches un-adds it. The added titles are kept in this browser.
// An FM-1 version and its XL ("<name> XL", the full browser version) are one family: one card in the Library.
import RAW from './community.json';
import { instIsEngine } from './engines';
import { DEFS } from './modules';
import type { Patch } from './patch';
import { chipOf, type Chip } from './sandbox';
import { decodeShare } from './share';
import { OLD_SITE_URL, PAGES_DEV_URL, SITE_URL } from './site';

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
/** the address without its scheme and trailing slash, as a search term (matryoshka.lol) */
const bare = (url: string): string => url.replace(/^https:\/\//, '').replace(/\/$/, '');
/** a search of the subreddit for posts that link the app, at its address or an earlier one (Reddit's search takes OR) */
export const REDDIT_SEARCH = `https://www.reddit.com/r/MVaveFM1/search?q=${encodeURIComponent([SITE_URL, PAGES_DEV_URL, OLD_SITE_URL].map(bare).join(' OR '))}&restrict_sr=1`;

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

/** its chip, FM-1 · NN % or SANDBOX (sandbox.ts): worked out once per entry when first shown, as the bundled entries do not
 *  change while the page is open (never stored) */
const chips = new Map<string, Chip>();
export function chipOfEntry(c: CommunityPatch): Chip {
  let chip = chips.get(c.entry.title);
  if (!chip) chips.set(c.entry.title, (chip = c.patch ? chipOf(c.patch) : { fits: false, text: 'SANDBOX' }));
  return chip;
}

/** the FM-1 version's name of an XL ("Sol 29N XL" → "Sol 29N"), else null */
export const xlBase = (name: string): string | null => /^(.*\S) XL$/.exec(name.trim())?.[1] ?? null;

/** names in their order with each XL moved right under its FM-1 version (an XL without one stays where it is) */
export function pairXl(names: string[]): { name: string; xl: boolean }[] {
  const all = new Set(names);
  const under = (n: string): boolean => { const b = xlBase(n); return b !== null && all.has(b); };
  return names.filter((n) => !under(n)).flatMap((n) => [
    { name: n, xl: false },
    ...names.filter((x) => xlBase(x) === n).map((x) => ({ name: x, xl: true })),
  ]);
}

/** one Library card: an FM-1 version and its XL, the FM-1 version first; in the order of the family's newest entry */
export interface Family<T> {
  name: string;
  members: T[];
}
export function familiesOf<T extends { entry: CommunityEntry }>(list: T[]): Family<T>[] {
  const out: Family<T>[] = [];
  for (const { name, xl } of pairXl(list.map((c) => c.entry.title))) {
    const c = list.find((x) => x.entry.title === name)!;
    if (xl) out.find((f) => f.name === xlBase(name))!.members.push(c);
    else out.push({ name, members: [c] });
  }
  const first = (f: Family<T>): number => Math.min(...f.members.map((m) => list.indexOf(m)));
  return out.sort((a, b) => first(a) - first(b));
}

// ---- the entries added to Your patches (by title), kept in this browser
const ADDED = 'matryoshka.community-added';
const addedListeners = new Set<() => void>();
export const onAddedChange = (fn: () => void): void => void addedListeners.add(fn);

/** the added titles, the latest added first ([] when storage is blocked or holds nothing) */
export function addedTitles(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ADDED) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
function writeAdded(list: string[]): boolean {
  try {
    if (list.length) localStorage.setItem(ADDED, JSON.stringify(list));
    else localStorage.removeItem(ADDED);
  } catch {
    return false;
  }
  for (const fn of addedListeners) fn();
  return true;
}
export const isAdded = (title: string): boolean => addedTitles().includes(title);
/** add an entry to Your patches (false: the browser refused the storage) */
export const addCommunity = (title: string): boolean => isAdded(title) || writeAdded([title, ...addedTitles()]);
/** take it out of Your patches again (un-add) */
export const removeCommunity = (title: string): boolean => !isAdded(title) || writeAdded(addedTitles().filter((t) => t !== title));
/** drop the link of every added entry the user has saved a patch of that name for: that copy is theirs now */
export function unlinkSaved(savedNames: Iterable<string>): void {
  const saved = new Set(savedNames);
  const list = addedTitles();
  if (list.some((t) => saved.has(t))) writeAdded(list.filter((t) => !saved.has(t)));
}

/** the added entries, decoded, latest added first (empty until loadCommunity has finished; an entry gone from the list
 *  or that does not decode is left out) */
export const addedCommunity = (): (CommunityPatch & { patch: Patch })[] =>
  addedTitles()
    .map((t) => communityPatches().find((c) => c.entry.title === t))
    .filter((c): c is CommunityPatch & { patch: Patch } => !!c?.patch);

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
