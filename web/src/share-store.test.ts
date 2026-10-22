// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { deflate } from './share';
import { codeProblem, fetchCode, ID_LENGTH, storeCode, storeId, STORE_MAX, type Kv } from './share-store';
import { PRESETS } from './presets';

const memoryKv = (): Kv & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, put: async (k, v) => void map.set(k, v) };
};

describe('stored share links (the site side)', () => {
  it('stores a patch under the hash of its code, once, and serves it back', async () => {
    const kv = memoryKv();
    const code = await deflate(JSON.stringify(PRESETS['Oracle V']()));
    const r = await storeCode(kv, code);
    expect(r).toEqual({ id: await storeId(code) });
    const id = (r as { id: string }).id;
    expect(id).toHaveLength(ID_LENGTH);
    expect(await storeCode(kv, code)).toEqual({ id });
    expect(kv.map.size).toBe(1);
    expect(await fetchCode(kv, id)).toBe(code);
    expect(await fetchCode(kv, 'nope')).toBeNull();
    expect(await fetchCode(kv, 'AAAAAAAAAAAA')).toBeNull();
  });

  it('keeps only what looks like a patch', async () => {
    expect(await codeProblem('')).toMatch(/share code/);
    expect(await codeProblem('not base64!')).toMatch(/share code/);
    expect(await codeProblem(await deflate('{"hello":1}'))).toMatch(/Matryoshka/);
    expect(await codeProblem(await deflate('plain text'))).toMatch(/not a patch/);
    expect(await codeProblem('A'.repeat(STORE_MAX + 1))).toMatch(/over/);
    // a small code that inflates past the cap (a zip bomb)
    expect(await codeProblem(await deflate(' '.repeat(5_000_000)))).toMatch(/too large/);
    const kv = memoryKv();
    expect(await storeCode(kv, await deflate('{"hello":1}'))).toMatchObject({ status: 400 });
    expect(kv.map.size).toBe(0);
  });

  it('refuses a different code under an id that is taken (a hash collision)', async () => {
    const kv = memoryKv();
    const code = await deflate(JSON.stringify(PRESETS.Init()));
    kv.map.set(`p:${await storeId(code)}`, 'something else');
    expect(await storeCode(kv, code)).toMatchObject({ status: 409 });
  });
});
