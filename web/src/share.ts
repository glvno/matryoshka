// SPDX-License-Identifier: GPL-3.0-only
// A patch as a link: the JSON (layout and assemblies included) deflated and base64url-encoded in the URL fragment,
// `#p=…`. Opening such a link loads the patch into the editor without touching the saved one until the user acts.
// Over LINK_MAX characters (a Reddit comment, GitHub's issue form) the whole patch is stored on the site instead
// (share-store.ts, web/functions/) and the link is `#s=<id>`; when the site cannot be reached, a `#p=` link without the
// card positions (the assemblies stay; the editor tidies the pile it opens as) is the fallback while that fits.
import { validatePatch, type ModuleDef, type Patch } from './patch';
import { SITE_URL } from './site';
import { b64url, inflateCapped, isStoreId, STORE_MAX } from './share-store';

export const LINK_MAX = 8000;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function deflate(text: string): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw')));
}

export async function inflate(code: string): Promise<string> {
  return inflateCapped(code);
}

export interface Share {
  /** the `#p=` link: its fragment value and the whole link (with the layout when that was asked for and fits) */
  code: string;
  link: string;
  /** the link's length in characters */
  length: number;
  /** the card positions are in `link` */
  layout: boolean;
  /** the full form (with the layout) fits under LINK_MAX */
  layoutFits: boolean;
  /** `link` is under LINK_MAX: it can be handed out (or is the fallback when storing fails) */
  fits: boolean;
  /** the link handed out is a stored one (`handOut`): what was asked for does not fit a `#p=` link */
  stores: boolean;
  /** the full form's code, what a stored link holds */
  full: string;
  /** neither a `#p=` link nor the site can hold it: Save file instead */
  tooLong: boolean;
}

/** the patch without its card positions (and frame sizes, and the view): the cards open as a pile the editor tidies.
 *  The assemblies stay: which modules they hold is the patch's structure (device pages, poly racks), not layout. */
const slim = (p: Patch): Patch => {
  const s: Patch = { ...p, modules: p.modules.map((m) => ({ ...m, x: 0, y: 0 })) };
  if (p.assemblies) s.assemblies = p.assemblies.map(({ size: _s, frameSize: _f, ...a }) => ({ ...a, x: 0, y: 0 }));
  delete s.view;
  return s;
};

/** where the app lives (site.ts): the base of a link made outside a browser page (tests, scripts) */
export const PAGES_URL = SITE_URL;
const here = (): string => (typeof location === 'undefined' ? PAGES_URL : location.href);

/**
 * A patch as a link, with its layout (`layout`, the default) while that fits under LINK_MAX characters, else without it
 * (the assemblies are always kept). `stores`: the layout was asked for and does not fit, or even the lean link does not:
 * `handOut` stores the full form on the site.
 */
export async function encodeShare(p: Patch, opts: { layout?: boolean; base?: string } = {}): Promise<Share> {
  const base = opts.base ?? here();
  const make = (code: string): { code: string; link: string; length: number } => {
    const link = shareLink(code, base);
    return { code, link, length: link.length };
  };
  const full = make(await deflate(JSON.stringify(p)));
  const layoutFits = full.length <= LINK_MAX;
  const wanted = opts.layout !== false;
  const tooLong = full.code.length > STORE_MAX;
  if (wanted && layoutFits) return { ...full, layout: true, layoutFits, fits: true, stores: false, full: full.code, tooLong };
  const lean = make(await deflate(JSON.stringify(slim(p))));
  const fits = lean.length <= LINK_MAX;
  return { ...lean, layout: false, layoutFits, fits, stores: wanted || !fits, full: full.code, tooLong: tooLong && !fits };
}

/** the API that stores and serves patches (web/functions/api/patch*.ts): on the page's own site */
const api = (path: string): string => new URL(`/api/patch${path}`, typeof location === 'undefined' ? PAGES_URL : location.origin).href;

/** store a share code on the site: its id */
export async function storeShare(code: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const r = await fetchImpl(api(''), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: code });
  const body = (await r.json().catch(() => ({}))) as { id?: unknown; error?: unknown };
  if (!r.ok || typeof body.id !== 'string' || !isStoreId(body.id)) throw new Error(typeof body.error === 'string' ? body.error : `the site answered ${r.status}`);
  return body.id;
}

/** a stored patch's code */
export async function fetchStored(id: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const r = await fetchImpl(api(`/${id}`));
  if (r.status === 404) throw new Error('no patch is stored under this link');
  if (!r.ok) throw new Error(`the site answered ${r.status}`);
  return (await r.text()).trim();
}

export interface HandedOut {
  link: string;
  length: number;
  /** the card positions are in it (a stored link always has them) */
  layout: boolean;
  stored: boolean;
  /** storing failed and this is the `#p=` fallback: why */
  fallback?: string;
}

/** the link to hand out: the `#p=` one, or (`stores`) the full patch stored on the site, or that failing the `#p=` one
 *  while it fits. Throws when nothing can be handed out. */
export async function handOut(s: Share, opts: { base?: string; store?: (code: string) => Promise<string> } = {}): Promise<HandedOut> {
  const own = { link: s.link, length: s.length, layout: s.layout, stored: false };
  if (!s.stores) return own;
  if (s.tooLong) throw new Error('the patch is too big for a link: save the file instead');
  try {
    const link = storedLink(await (opts.store ?? storeShare)(s.full), opts.base);
    return { link, length: link.length, layout: true, stored: true };
  } catch (e) {
    if (!s.fits) throw new Error(`the patch is too big for a plain link and the site could not store it (${(e as Error).message})`);
    return { ...own, fallback: (e as Error).message };
  }
}

export async function decodeShare(code: string, defs: Record<string, ModuleDef>): Promise<Patch> {
  return validatePatch(JSON.parse(await inflate(code)), defs);
}

/** the `p` value of a link's fragment (`#p=…`), or null */
export const shareCodeOf = (url: string): string | null => fragmentValue(url, 'p');
/** the `s` value of a stored link's fragment (`#s=…`), or null */
export const storedIdOf = (url: string): string | null => {
  const id = fragmentValue(url, 's');
  return id && isStoreId(id) ? id : null;
};
function fragmentValue(url: string, name: string): string | null {
  const i = url.indexOf('#');
  if (i < 0) return null;
  const m = new RegExp(`(?:^|&)${name}=([A-Za-z0-9_-]+)`).exec(url.slice(i + 1));
  return m ? m[1] : null;
}

/** the patch a link holds, `#p=` or `#s=` (fetched from the site), or null when it is neither */
export async function openShareLink(url: string, defs: Record<string, ModuleDef>, fetchImpl: typeof fetch = fetch): Promise<Patch | null> {
  const code = shareCodeOf(url);
  if (code) return decodeShare(code, defs);
  const id = storedIdOf(url);
  return id ? decodeShare(await fetchStored(id, fetchImpl), defs) : null;
}

/** a link holds a patch (`#p=` or `#s=`) */
export const isShareLink = (url: string): boolean => !!(shareCodeOf(url) ?? storedIdOf(url));

export const shareLink = (code: string, base = here()): string => `${base.split('#')[0]}#p=${code}`;
export const storedLink = (id: string, base = here()): string => `${base.split('#')[0]}#s=${id}`;
