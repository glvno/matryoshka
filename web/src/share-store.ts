// SPDX-License-Identifier: GPL-3.0-only
// Stored share links: a patch too big for a `#p=` link is kept on the site (Cloudflare Pages Functions, the KV namespace
// bound as PATCHES; web/functions/api/patch*.ts) and shared as `#s=<id>`. The id is the start of the SHA-256 of the
// share code, so the same patch always gets the same id and an entry is never overwritten. The server keeps only what
// looks like a patch (inflates within a cap, a JSON object with version, modules and cables); the app runs validatePatch
// when it opens one, as for any link. No imports: the functions bundle this file and nothing else of the app.

/** the longest share code the site stores (deflated, base64url characters) */
export const STORE_MAX = 400_000;
/** the most a stored code may inflate to (bytes of JSON) */
export const INFLATED_MAX = 4_000_000;
/** a stored link's id: 12 base64url characters (72 bits of the hash) */
export const ID_LENGTH = 12;
export const isStoreId = (s: string): boolean => new RegExp(`^[A-Za-z0-9_-]{${ID_LENGTH}}$`).test(s);
const CODE_RE = /^[A-Za-z0-9_-]+$/;

export const b64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64url = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** the id a code is stored under */
export async function storeId(code: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))).slice(0, ID_LENGTH);
}

/** inflate a share code, giving up past `max` bytes (a small code can inflate to a great deal) */
export async function inflateCapped(code: string, max = INFLATED_MAX): Promise<string> {
  const stream = new Blob([unb64url(code) as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error('the patch is too large');
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) all.set(p, (at += p.length) - p.length);
  return new TextDecoder().decode(all);
}

/** why the site will not store this code, or null: it must look like a patch */
export async function codeProblem(code: string): Promise<string | null> {
  if (!code || !CODE_RE.test(code)) return 'not a share code';
  if (code.length > STORE_MAX) return `over ${STORE_MAX} characters`;
  let p: unknown;
  try {
    p = JSON.parse(await inflateCapped(code));
  } catch (e) {
    return `not a patch: ${(e as Error).message}`;
  }
  const o = p as { version?: unknown; modules?: unknown; cables?: unknown } | null;
  if (!o || typeof o !== 'object' || (o.version !== 1 && o.version !== 2) || !Array.isArray(o.modules) || !Array.isArray(o.cables)) return 'not a Matryoshka patch';
  return null;
}

/** the part of a KV namespace the store uses */
export interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
const key = (id: string): string => `p:${id}`;

/** store a code (POST /api/patch): its id, or an HTTP status and why not */
export async function storeCode(kv: Kv, code: string): Promise<{ id: string } | { status: number; error: string }> {
  const problem = await codeProblem(code);
  if (problem) return { status: code.length > STORE_MAX ? 413 : 400, error: problem };
  const id = await storeId(code);
  const there = await kv.get(key(id));
  if (there === null) await kv.put(key(id), code);
  else if (there !== code) return { status: 409, error: 'another patch has this id' }; // (a 72-bit hash collision)
  return { id };
}

/** a stored code (GET /api/patch/<id>), or null */
export async function fetchCode(kv: Kv, id: string): Promise<string | null> {
  return isStoreId(id) ? kv.get(key(id)) : null;
}
