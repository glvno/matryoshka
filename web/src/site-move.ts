// SPDX-License-Identifier: GPL-3.0-only
// matry0shka.pages.dev, the address from 1.0 to 1.4, serves the same app as matryoshka.lol (site.ts). A visitor there whose
// browser holds none of the app's data is sent on to matryoshka.lol at once, path, query and fragment kept, so old links
// land on the new address. A visitor with data stays, and the app offers to move it (move-offer.ts). main.ts imports this
// first: when it sends the visitor on it throws, so no other module runs and nothing is stored at the old address (the
// starter patch would otherwise count as data on the next visit).
import { PAGES_DEV_URL, SITE_URL } from './site';

/** a storage key of the app: matryoshka.*, or an upstream name (modular-1.*) that storage-key.ts renames */
export const APP_KEY = /^(matryoshka|modular-1)\./;

/** where a visit to `href` goes instead: SITE_URL with the same path, query and fragment, when `href` is on the pages.dev
 *  address and its storage `keys` hold none of the app's; else null */
export function forwardTo(href: string, keys: readonly string[]): string | null {
  const u = new URL(href);
  if (u.origin !== new URL(PAGES_DEV_URL).origin || keys.some((k) => APP_KEY.test(k))) return null;
  return new URL(u.pathname.replace(/^\/+/, '') + u.search + u.hash, SITE_URL).href;
}

if (typeof location !== 'undefined') {
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    keys = []; // storage blocked: there is nothing to keep here
  }
  const to = forwardTo(location.href, keys);
  if (to) {
    location.replace(to);
    throw new Error(`Matryoshka lives at ${SITE_URL} now: on to ${to}`);
  }
}
