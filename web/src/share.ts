// SPDX-License-Identifier: GPL-3.0-only
// A patch as a link: the JSON (layout and assemblies included) deflated and base64url-encoded in the URL fragment,
// `#p=…`. Opening such a link loads the patch into the editor without touching the saved one until the user acts.
// Too long for a link (over LINK_MAX characters): the card positions and the assembly overlay are dropped first; a patch
// still too long without them is flagged `tooLong` and is never copied (the share sheet offers Save file instead).
import { validatePatch, type ModuleDef, type Patch } from './patch';
import { SITE_URL } from './site';

export const LINK_MAX = 8000;

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function deflate(text: string): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw')));
}

export async function inflate(code: string): Promise<string> {
  return new TextDecoder().decode(await pipe(unb64url(code), new DecompressionStream('deflate-raw')));
}

export interface Share {
  /** the fragment value (`p=`) and the whole link */
  code: string;
  link: string;
  /** the link's length in characters */
  length: number;
  /** the card positions and the assemblies are in it */
  layout: boolean;
  /** the full form (with the layout) would fit under LINK_MAX */
  layoutFits: boolean;
  /** even without the layout the link is over LINK_MAX: it must not be copied (Save file instead) */
  tooLong: boolean;
}

/** the patch without its card positions and assembly overlay: the cards open on a grid */
const slim = (p: Patch): Patch => {
  const s: Patch = { ...p, modules: p.modules.map((m) => ({ ...m, x: 0, y: 0 })) };
  delete s.assemblies;
  return s;
};

/** where the app lives (site.ts): the base of a link made outside a browser page (tests, scripts) */
export const PAGES_URL = SITE_URL;
const here = (): string => (typeof location === 'undefined' ? PAGES_URL : location.href);

/**
 * A patch as a link, with its layout and assemblies (`layout`, the default) while that fits under LINK_MAX characters, else
 * without them. `tooLong`: over LINK_MAX even without; such a link must not be handed out.
 */
export async function encodeShare(p: Patch, opts: { layout?: boolean; base?: string } = {}): Promise<Share> {
  const base = opts.base ?? here();
  const make = (code: string): { code: string; link: string; length: number } => {
    const link = shareLink(code, base);
    return { code, link, length: link.length };
  };
  const full = make(await deflate(JSON.stringify(p)));
  const layoutFits = full.length <= LINK_MAX;
  if (opts.layout !== false && layoutFits) return { ...full, layout: true, layoutFits, tooLong: false };
  const lean = make(await deflate(JSON.stringify(slim(p))));
  return { ...lean, layout: false, layoutFits, tooLong: lean.length > LINK_MAX };
}

export async function decodeShare(code: string, defs: Record<string, ModuleDef>): Promise<Patch> {
  return validatePatch(JSON.parse(await inflate(code)), defs);
}

/** the `p` value of a link's fragment (`#p=…`), or null */
export function shareCodeOf(url: string): string | null {
  const i = url.indexOf('#');
  if (i < 0) return null;
  const m = /(?:^|&)p=([A-Za-z0-9_-]+)/.exec(url.slice(i + 1));
  return m ? m[1] : null;
}

export const shareLink = (code: string, base = here()): string => `${base.split('#')[0]}#p=${code}`;
