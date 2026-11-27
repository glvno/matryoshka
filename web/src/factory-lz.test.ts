import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lzPack, lzUnpack, presetsHPatches } from '../scripts/factory-lz';
import { FIRMWARE_TIER_OVERRIDES } from './factory-tiers';

// The factory patches are stored packed in presets.h (scripts/factory-lz.ts packs, firmware/src/lz_unpack.h unpacks on the
// FM-1). Both decoders must give back exactly what was packed, and the C one must stay inside its buffers on any input.
const presetsH = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
const factory = presetsHPatches(presetsH);
const seeded = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, () => (seed = Math.imul(seed, 1103515245) + 12345 >>> 0) >>> 24);
const edges: [string, Uint8Array][] = [
  ['empty', new Uint8Array(0)],
  ['one byte', Uint8Array.of(7)],
  ['a run past the length extensions', new Uint8Array(3840).fill(0)],
  ['noise: literal runs past the extensions', seeded(3840, 1)],
  ['a match running to the end', Uint8Array.from([...seeded(40, 2), ...seeded(40, 2)])],
  ['short repeats under the shortest match', Uint8Array.from({ length: 600 }, (_, i) => i % 3 ? i & 255 : 0)],
];

describe('factory patches packed (presets.h)', () => {
  it('the TypeScript decoder gives back every factory patch and the edge cases', () => {
    expect(factory.length).toBeGreaterThan(0);
    for (const [, bytes] of [...factory.map((p): [string, Uint8Array] => [p.name, p.bytes]), ...edges])
      expect(lzUnpack(lzPack(bytes))).toEqual(bytes);
  });

  it('the stored bytes are smaller than the patches', () => {
    const raw = factory.reduce((n, p) => n + p.bytes.length, 0);
    const packed = factory.reduce((n, p) => n + lzPack(p.bytes).length, 0);
    expect(packed).toBeLessThan(raw * 0.75);
  });

  it('the C decoder unpacks every factory patch to the bytes the factory set id hashes, and stays in its buffers', () => {
    const cases = edges.map(([, bytes]) => ({ bytes, packed: lzPack(bytes) }));
    const source = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "presets.h"
${cases.map((c, i) => `static const uint8_t EDGE_${i}[${Math.max(1, c.packed.length)}] = {${c.packed.length ? Array.from(c.packed).join(',') : '0'}};`).join('\n')}
static const struct { const uint8_t *lz; uint32_t lz_len, len; } EDGES[] = {
${cases.map((c, i) => `  {EDGE_${i}, ${c.packed.length}, ${c.bytes.length}},`).join('\n')}
};
/* unpacked from a copy of exactly n bytes into exactly cap bytes (heap: the sanitizer catches a step outside either) */
static int32_t unpack(const uint8_t *lz, uint32_t n, uint32_t cap, uint8_t **out)
{
    uint8_t *src = malloc(n ? n : 1), *dst = malloc(cap ? cap : 1);
    int32_t len;
    memcpy(src, lz, n);
    len = lz_unpack(src, n, dst, cap);
    free(src);
    if (out) *out = dst; else free(dst);
    return len;
}
static void hex(const uint8_t *lz, uint32_t n, uint32_t len)
{
    uint8_t *dst;
    uint32_t i, k;
    if (unpack(lz, n, len, &dst) != (int32_t)len) { printf("FAIL\\n"); exit(1); }
    for (i = 0; i < len; i++) printf("%02x", dst[i]);
    printf("\\n");
    free(dst);
    if (len && unpack(lz, n, len - 1u, 0) != -1) { printf("FAIL short buffer\\n"); exit(1); }
    for (k = 0; k < n; k += k < 64u || k + 64u >= n ? 1u : 61u)      /* cut short: at both ends, and spread between */
        (void)unpack(lz, k, len, 0);
    for (k = 0; k < n && k < 64u; k++) {                              /* a flipped byte: any result, never outside */
        uint8_t *bad = malloc(n);
        memcpy(bad, lz, n);
        bad[k] ^= 0xFFu;
        (void)unpack(bad, n, len, 0);
        free(bad);
    }
}
int main(void)
{
    uint32_t i;
    for (i = 0; i < N_PRESETS; i++) hex(PRESET_LIST[i].lz, PRESET_LIST[i].lz_len, PRESET_LIST[i].len);
    for (i = 0; i < sizeof EDGES / sizeof EDGES[0]; i++) hex(EDGES[i].lz, EDGES[i].lz_len, EDGES[i].len);
    return 0;
}
`;
    const dir = mkdtempSync(join(tmpdir(), 'fm1-lz-'));
    let lines: string[];
    try {
      const binary = join(dir, 'lz-test');
      execFileSync(process.env.CC ?? 'cc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
        '-I', new URL('../../firmware/src', import.meta.url).pathname, '-x', 'c', '-', '-o', binary], { input: source, stdio: ['pipe', 'pipe', 'pipe'] });
      lines = execFileSync(binary, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
    const fromC = lines.slice(0, factory.length).map(unhex);
    expect(fromC).toEqual(factory.map((p) => p.bytes));
    expect(lines.slice(factory.length).map(unhex)).toEqual(edges.map(([, bytes]) => bytes));
    // the factory set id (export-defs.ts) is FNV-1a over the names and the unpacked bytes, then the firmware-tier overrides
    // when there are any: the released-set check is unchanged
    let h = 0x811c9dc5;
    factory.forEach((p, i) => {
      for (const x of [...new TextEncoder().encode(p.name), 0, ...fromC[i]]) h = Math.imul(h ^ x, 0x01000193) >>> 0;
    });
    if (FIRMWARE_TIER_OVERRIDES.length) for (const x of new TextEncoder().encode(JSON.stringify(FIRMWARE_TIER_OVERRIDES))) h = Math.imul(h ^ x, 0x01000193) >>> 0;
    expect(parseInt(presetsH.match(/#define FACTORY_SET_ID 0x([0-9a-f]+)u/)![1], 16)).toBe((h & 0xffffff) || 1);
  });
});
