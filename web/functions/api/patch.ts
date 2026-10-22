// SPDX-License-Identifier: GPL-3.0-only
// POST /api/patch: store a share code too long for a `#p=` link (share-store.ts); answers { id } or { error }.
import { STORE_MAX, storeCode } from '../../src/share-store';
import type { Handler } from '../types';

export const onRequestPost: Handler = async ({ request, env }) => {
  if (Number(request.headers.get('content-length')) > STORE_MAX + 64) return Response.json({ error: 'the patch is too large' }, { status: 413 });
  const r = await storeCode(env.PATCHES, (await request.text()).trim());
  return 'id' in r ? Response.json(r) : Response.json({ error: r.error }, { status: r.status });
};
