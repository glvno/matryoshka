// SPDX-License-Identifier: GPL-3.0-only
// GET /api/patch/<id>: a stored share code (share-store.ts), as text; an id's patch never changes, so it is cached for good.
import { fetchCode } from '../../../src/share-store';
import type { Handler } from '../../types';

export const onRequestGet: Handler = async ({ env, params }) => {
  const code = await fetchCode(env.PATCHES, String(params.id));
  if (code === null) return new Response('no such patch', { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(code, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' } });
};
