// SPDX-License-Identifier: GPL-3.0-only
// Bringing the browser data over from an earlier address. The browser keeps localStorage per origin, so the patches, bank,
// library and settings stay behind when the app moves. Before 1.0 the app lived on GitHub Pages (site.ts OLD_SITE_URL),
// which now serves a forwarder (deploy/github-pages-forward); with data present it offers "Bring my patches". From 1.0 to
// 1.4 it lived at matry0shka.pages.dev (PAGES_DEV_URL), which still serves the app; with data present the app there offers
// "Move them there" (move-offer.ts, sendMigration). Either opens this app with `?migrate=1`. The hand-off is window.open +
// postMessage (an iframe bridge reads partitioned storage in Chrome, so it would see nothing):
//   1. the app, seeing `migrate=1` and an opener, posts {type: READY} to the opener, once for each origin of MIGRATE_FROM
//      (the browser delivers only the one that matches the opener);
//   2. the sender checks the origin and source, and replies {type: DATA, keys: {key: value}}, targetOrigin the app's;
//   3. the app takes the reply only from an origin of MIGRATE_FROM and the opener, imports it (planImport), answers
//      {type: DONE} to that origin, and strips `migrate=1` from the address. No reply within MIGRATE_TIMEOUT: it stops
//      listening, quietly.
// "Download a backup" (the forwarder) and "Save browser backup" (the app) save the same keys as a file (BACKUP_FORMAT),
// which "Load .json" takes as well. The data never goes into a URL.
import { SLOTS } from './protocol';
import { OLD_SITE_URL, PAGES_DEV_URL } from './site';

/** the earlier addresses' origins. Only a test build sets VITE_MIGRATE_FROM (a forwarder served locally); the default is
 *  production */
export const MIGRATE_FROM: readonly string[] = (import.meta.env?.VITE_MIGRATE_FROM as string | undefined)
  ? [import.meta.env.VITE_MIGRATE_FROM as string]
  : [new URL(OLD_SITE_URL).origin, new URL(PAGES_DEV_URL).origin];
export const MIGRATE_READY = 'matryoshka-migrate-ready';
export const MIGRATE_DATA = 'matryoshka-migrate-data';
export const MIGRATE_DONE = 'matryoshka-migrate-done';
export const MIGRATE_TIMEOUT = 5000;
/** the `format` of the forwarder's backup file */
export const BACKUP_FORMAT = 'matryoshka-browser-backup';

/** the app's storage keys: matryoshka.*, and the upstream names (modular-1.*) that storage-key.ts renamed */
const ACCEPTED = /^(matryoshka|modular-1)\.[\w.-]+$/;
/** what the pages.dev address remembers of its move offer (move-offer.ts): about that address only, never handed over */
export const MOVE_OFFER = 'matryoshka.move-offer';

/** the accepted keys of `raw` with string values; a legacy modular-1.x becomes matryoshka.x unless that is there too
 *  (the old site's renamedKey copied them, so the matryoshka.* value is the newer one) */
export function acceptKeys(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const entries = Object.entries(raw as Record<string, unknown>).filter(([k, v]) => ACCEPTED.test(k) && k !== MOVE_OFFER && typeof v === 'string') as [string, string][];
  for (const [k, v] of entries) if (k.startsWith('matryoshka.')) out[k] = v;
  for (const [k, v] of entries) {
    if (!k.startsWith('modular-1.')) continue;
    const key = 'matryoshka.' + k.slice('modular-1.'.length);
    if (!(key in out)) out[key] = v;
  }
  return out;
}

/** the app's keys and values in `storage` (acceptKeys): what a hand-off sends and a backup file holds; none when storage
 *  is blocked */
export function collectKeys(storage: Pick<Storage, 'length' | 'key' | 'getItem'> = localStorage): Record<string, string> {
  const raw: Record<string, string> = {};
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      const v = k === null ? null : storage.getItem(k);
      if (k !== null && v !== null) raw[k] = v;
    }
  } catch {
    /* storage blocked: nothing */
  }
  return acceptKeys(raw);
}

/** a backup file of `keys`, as the forwarder's "Download a backup" writes it */
export function backupFile(keys: Record<string, string>, from: string, saved = new Date()): { format: string; version: 1; from: string; saved: string; keys: Record<string, string> } {
  return { format: BACKUP_FORMAT, version: 1, from, saved: saved.toISOString(), keys };
}

/** a backup file's keys (acceptKeys), or null when `raw` is not a backup file */
export function backupKeys(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== BACKUP_FORMAT) return null;
  return acceptKeys((raw as { keys?: unknown }).keys);
}

const OPEN_PATCH = 'matryoshka.patch';
const PATCHES = 'matryoshka.patches';
/** the suffix of a patch or assembly brought over under a name that holds something else here */
export const OLD_SUFFIX = 'old site';

type Entry = Record<string, unknown> & { name?: unknown };
interface ListRule {
  /** what identifies an entry */
  id: (e: Entry) => string;
  /** an entry of the same id holds something else: renamed (kept as a copy) or, without, the one here is kept */
  rename?: (e: Entry, name: string) => Entry;
  /** what is compared (the save date of a patch is not) */
  body?: (e: Entry) => unknown;
  cap?: number;
  /** a count for the summary: "3 of Your patches" */
  what: (n: number) => string;
}
const byName = (e: Entry): string => String(e.name ?? '');
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;
/** the lists merged entry by entry; any other key is a value of its own */
const LISTS: Record<string, ListRule> = {
  [PATCHES]: {
    id: byName, body: (e) => e.patch, what: (n) => `${n} of Your patches`,
    rename: (e, name) => ({ ...e, name, patch: { ...(e.patch as object), name } }),
  },
  'matryoshka.assemblies': { id: byName, what: (n) => plural(n, 'library assembly', 'library assemblies'), rename: (e, name) => ({ ...e, name }) },
  // the FM-1 bank is the slot list the FM-1 gets: a name already in it keeps its patch, and it holds SLOTS at most
  'matryoshka.bank': { id: byName, cap: SLOTS, what: (n) => plural(n, 'FM-1 bank entry', 'FM-1 bank entries') },
  'matryoshka.bank-over': { id: byName, what: (n) => plural(n, 'browser-only bank patch', 'browser-only bank patches') },
  'matryoshka.tutorial.variations': { id: (e) => String(e.id ?? ''), what: (n) => plural(n, 'tutorial variation') },
};
/** the values with a name of their own in the summary; the rest are settings */
const NAMED: Record<string, string> = { [OPEN_PATCH]: 'the open patch', 'matryoshka.tutorial': 'the tutorial progress' };

const parseList = (v: string | null): Entry[] | null => {
  if (v === null) return null;
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) && a.every((e) => e && typeof e === 'object' && !Array.isArray(e)) ? (a as Entry[]) : null;
  } catch {
    return null;
  }
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** `name (old site)`, else `name (old site 2)`, ... : the first not in `taken` */
const freeName = (name: string, taken: Set<string>): string => {
  for (let n = 1; ; n++) {
    const c = `${name} (${OLD_SUFFIX}${n === 1 ? '' : ` ${n}`})`;
    if (!taken.has(c)) return c;
  }
};

export interface ImportPlan {
  /** the values to store */
  writes: Record<string, string>;
  /** what came over, one phrase each */
  brought: string[];
  /** what stayed as it was here, one phrase each */
  kept: string[];
}

/**
 * What to store of `incoming` (acceptKeys) in a storage that holds `current(key)`, without overwriting anything silently:
 * - the lists (Your patches, the library, the bank, ...) are merged entry by entry: a new entry is added, an identical one
 *   skipped; one that differs under the same name is added as "name (old site)" where a copy can be told apart (Your
 *   patches, the library), else the one here is kept (the bank: its names are the FM-1's slots);
 * - any other value (the open patch, the tutorial progress, settings) is taken when this page found none at its start
 *   (`hadAtStart`: what the app wrote since, the starter patch, is not the user's), else the one here is kept; a kept open
 *   patch that differs goes into Your patches instead, so it is not lost.
 */
export function planImport(incoming: Record<string, string>, current: (key: string) => string | null, hadAtStart: (key: string) => boolean): ImportPlan {
  const writes: Record<string, string> = {};
  const brought: string[] = [];
  const kept: string[] = [];
  let settings = 0;
  let keptSettings = 0;
  const lists = new Map<string, Entry[]>();
  const listOf = (key: string): Entry[] => lists.get(key) ?? parseList(current(key)) ?? [];
  const added = new Map<string, number>();
  const skipped = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

  const mergeInto = (key: string, rule: ListRule, entries: Entry[]): void => {
    const list = listOf(key);
    const body = rule.body ?? ((e: Entry) => e);
    for (const e of entries) {
      const id = rule.id(e);
      const here = list.find((x) => rule.id(x) === id);
      if (here && same(body(here), body(e))) continue;
      if (here && !rule.rename) {
        bump(skipped, key);
        continue;
      }
      if (rule.cap !== undefined && list.length >= rule.cap) {
        bump(skipped, key);
        continue;
      }
      list.push(here ? rule.rename!(e, freeName(id, new Set(list.map(rule.id)))) : e);
      bump(added, key);
    }
    lists.set(key, list);
  };

  for (const [key, value] of Object.entries(incoming)) {
    const rule = LISTS[key];
    const entries = rule ? parseList(value) : null;
    // (nothing here yet merges into an empty list: the list as it was)
    if (rule && entries && (current(key) === null || parseList(current(key)) !== null)) {
      mergeInto(key, rule, entries);
      continue;
    }
    const here = current(key);
    if (here === value) continue;
    if (here === null || !hadAtStart(key)) {
      writes[key] = value;
      if (NAMED[key]) brought.push(NAMED[key]);
      else settings++;
      continue;
    }
    if (key === OPEN_PATCH) {
      // the open patch here stays open; the old one goes into Your patches
      try {
        const p = JSON.parse(value) as Entry;
        const name = (typeof p.name === 'string' && p.name.trim()) || 'Untitled';
        mergeInto(PATCHES, LISTS[PATCHES], [{ name, patch: { ...p, name }, saved: Date.now() }]);
        kept.push('the open patch (the old one is in Your patches)');
      } catch {
        kept.push('the open patch');
      }
      continue;
    }
    if (NAMED[key]) kept.push(NAMED[key]);
    else keptSettings++;
  }

  for (const [key, list] of lists) {
    if (!added.get(key)) continue;
    writes[key] = JSON.stringify(list);
    brought.push(LISTS[key].what(added.get(key)!));
  }
  for (const [key, n] of skipped) kept.push(`${LISTS[key].what(n)} (${LISTS[key].cap !== undefined ? 'the one here or no room' : 'the one here'})`);
  if (settings) brought.push(plural(settings, 'setting'));
  if (keptSettings) kept.push(plural(keptSettings, 'setting'));
  return { writes, brought, kept };
}

/** the toast after an import */
export function importSummary(plan: ImportPlan, from: string): string {
  if (!plan.brought.length && !plan.kept.length) return `Nothing new to bring over from ${from}: it is all here already.`;
  const parts: string[] = [];
  parts.push(plan.brought.length ? `Brought over from ${from}: ${plan.brought.join(', ')}.` : `Nothing brought over from ${from}.`);
  if (plan.kept.length) parts.push(`Kept as it was here: ${plan.kept.join(', ')}.`);
  return parts.join(' ');
}

// ---- the browser side

/** the keys this page found in storage when it started: what the app writes later (the starter patch) is not the user's */
const atStart: Set<string> = (() => {
  try {
    return new Set(typeof localStorage === 'undefined' ? [] : Object.keys(localStorage));
  } catch {
    return new Set<string>();
  }
})();

/** plan and store an import into localStorage; returns the plan */
export function applyImport(incoming: Record<string, string>, storage: Storage = localStorage): ImportPlan {
  const plan = planImport(incoming, (k) => storage.getItem(k), (k) => atStart.has(k));
  for (const [k, v] of Object.entries(plan.writes)) storage.setItem(k, v);
  return plan;
}

/** the address without `migrate=1` */
export function withoutMigrate(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('migrate');
  return u.pathname + u.search + u.hash;
}

/**
 * The receiving end of the hand-off, when the address has `migrate=1`: asks the opener (the forwarder, or the app at the
 * pages.dev address) for its data and calls `onData` with the accepted keys and the sender's origin, once. Anything from
 * another origin or window is ignored. Returns whether it listens. `from` is MIGRATE_FROM outside tests.
 */
export function receiveMigration(onData: (keys: Record<string, string>, origin: string) => void, from: readonly string[] = MIGRATE_FROM, timeout = MIGRATE_TIMEOUT): boolean {
  if (typeof window === 'undefined' || new URLSearchParams(location.search).get('migrate') !== '1') return false;
  const strip = (): void => history.replaceState(history.state, '', withoutMigrate(location.href));
  const opener = window.opener as Window | null;
  if (!opener) {
    strip();
    return false;
  }
  let timer = 0;
  const stop = (): void => {
    clearTimeout(timer);
    window.removeEventListener('message', listen);
    strip();
  };
  const listen = (e: MessageEvent): void => {
    if (!from.includes(e.origin) || e.source !== opener) return;
    const data = e.data as { type?: unknown; keys?: unknown } | null;
    if (data?.type !== MIGRATE_DATA) return;
    stop();
    onData(acceptKeys(data.keys), e.origin);
    try {
      opener.postMessage({ type: MIGRATE_DONE }, e.origin);
    } catch {
      /* the forwarder's tab is gone */
    }
  };
  window.addEventListener('message', listen);
  timer = window.setTimeout(stop, timeout);
  try {
    for (const origin of from) opener.postMessage({ type: MIGRATE_READY }, origin);
  } catch {
    stop();
    return false;
  }
  return true;
}

/**
 * The sending end, from the app at an earlier address: opens `target` with `migrate=1` in a new tab and answers its READY
 * with `keys()`. `onState` hears 'sending' when the data went out and 'done' when the new tab stored it. Returns false
 * when the browser blocked the tab. Call it from a click, so the tab is not a blocked popup; it is not `noopener`, as the
 * new tab answers through window.opener.
 */
export function sendMigration(target: string, keys: () => Record<string, string>, onState: (state: 'sending' | 'done') => void): boolean {
  const url = new URL(target);
  url.searchParams.set('migrate', '1');
  const opened = window.open(url.href, '_blank');
  if (!opened) return false;
  const listen = (e: MessageEvent): void => {
    if (e.origin !== url.origin || e.source !== opened) return;
    const type = (e.data as { type?: unknown } | null)?.type;
    if (type === MIGRATE_READY) {
      opened.postMessage({ type: MIGRATE_DATA, keys: keys() }, url.origin);
      onState('sending');
    } else if (type === MIGRATE_DONE) {
      window.removeEventListener('message', listen);
      onState('done');
    }
  };
  window.addEventListener('message', listen);
  return true;
}
