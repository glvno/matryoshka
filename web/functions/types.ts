// SPDX-License-Identifier: GPL-3.0-only
// The little of Cloudflare Pages Functions' types the share store uses (no @cloudflare/workers-types dependency).
import type { Kv } from '../src/share-store';

export interface Env {
  /** the KV namespace of stored share links (wrangler.toml) */
  PATCHES: Kv;
}
export type Handler = (context: { request: Request; env: Env; params: Record<string, string | string[]> }) => Promise<Response> | Response;
