// SPDX-License-Identifier: GPL-3.0-only
// The factory patches' packing in presets.h: export-defs.ts (and golden.ts's panel fixtures) store each factory patch
// packed, firmware/src/lz_unpack.h unpacks one right before the FM-1 writes it into its bank. The format, after LZ4's block
// format, is described in lz_unpack.h; lzUnpack here is the same decoder, for the scripts and tests that read presets.h.

const MIN_MATCH = 4;
const MAX_DIST = 0xffff;

/** bytes packed for lz_unpack.h: greedy longest matches (every earlier place with the same 4 bytes tried), one byte of
 *  lookahead when the next place matches longer */
export function lzPack(src: Uint8Array): Uint8Array {
  const n = src.length, out: number[] = [];
  const prev = new Int32Array(n).fill(-1), head = new Map<number, number>();
  for (let i = 0; i + MIN_MATCH <= n; i++) {
    const k = src[i] | src[i + 1] << 8 | src[i + 2] << 16 | src[i + 3] << 24;   // (the place's first 4 bytes)
    prev[i] = head.get(k) ?? -1;
    head.set(k, i);
  }
  const longest = (i: number): [number, number] => {
    let len = 0, dist = 0;
    if (i + MIN_MATCH > n) return [0, 0];
    for (let j = prev[i]; j >= 0 && i - j <= MAX_DIST; j = prev[j]) {
      let k = MIN_MATCH;
      while (i + k < n && src[j + k] === src[i + k]) k++;
      if (k > len) { len = k; dist = i - j; }
    }
    return [len, dist];
  };
  const more = (v: number): void => {
    for (; v >= 255; v -= 255) out.push(255);
    out.push(v);
  };
  const sequence = (from: number, to: number, len: number, dist: number): void => {
    const lit = to - from, m = len - MIN_MATCH;
    out.push(Math.min(lit, 15) << 4 | (len ? Math.min(m, 15) : 0));
    if (lit >= 15) more(lit - 15);
    for (let k = from; k < to; k++) out.push(src[k]);
    if (!len) return;
    out.push(dist & 255, dist >> 8);
    if (m >= 15) more(m - 15);
  };
  let anchor = 0, i = 0;
  while (i < n) {
    const [len, dist] = longest(i);
    if (!len || longest(i + 1)[0] > len) { i++; continue; }
    sequence(anchor, i, len, dist);
    i += len;
    anchor = i;
  }
  if (anchor < n) sequence(anchor, n, 0, 0);
  return Uint8Array.from(out);
}

/** what lzPack packed, back; throws on input lz_unpack.h refuses (cut short, a distance before the start, over `cap`) */
export function lzUnpack(src: Uint8Array, cap = 1 << 16): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const byte = (): number => {
    if (i >= src.length) throw new Error('packed patch cut short');
    return src[i++];
  };
  const more = (len: number): number => {
    for (let d = 255; d === 255; len += d) d = byte();
    return len;
  };
  while (i < src.length) {
    const t = byte();
    let len = t >> 4;
    if (len === 15) len = more(len);
    if (len > src.length - i || out.length + len > cap) throw new Error('packed patch literals overrun');
    for (; len; len--) out.push(src[i++]);
    if (i === src.length) break;
    const dist = byte() | byte() << 8;
    len = (t & 15) + MIN_MATCH;
    if (len === 15 + MIN_MATCH) len = more(len);
    if (!dist || dist > out.length || out.length + len > cap) throw new Error('packed patch match out of range');
    for (; len; len--) out.push(out[out.length - dist]);
  }
  return Uint8Array.from(out);
}

/** the C lines of a packed patch list, as presets.h's PRESET_LIST: an array `<prefix>_n` of each patch packed, then
 *  `<list>[N_PRESETS]`, each entry its name, packed bytes, packed length and unpacked length (main.c factory_write) */
export function packedListC(prefix: string, list: string, patches: { name: string; binary: Uint8Array }[]): string[] {
  const packed = patches.map(({ name, binary }) => {
    const z = lzPack(binary);
    if (binary.length > 0xffff || z.length > 0xffff) throw new Error(`${name}: too long for a packed list's 16-bit lengths`);
    return z;
  });
  return [
    ...packed.map((z, i) => `static const uint8_t ${prefix}_${i}[${z.length}] = {${Array.from(z).join(',')}};   /* ${patches[i].name} */`),
    `static const struct { const char *name; const uint8_t *lz; uint16_t lz_len, len; } ${list}[N_PRESETS] = {`,
    ...patches.map(({ name, binary }, i) => `    {${JSON.stringify(name.toUpperCase())}, ${prefix}_${i}, sizeof ${prefix}_${i}, ${binary.length}},`),
    '};'];
}

/** the factory patches of a presets.h (today's, or an earlier commit's), in PRESET_LIST order: unpacked when stored packed
 *  (the list's entries carry the unpacked length after the array's size) */
export function presetsHPatches(src: string): { name: string; bytes: Uint8Array }[] {
  const data = new Map<string, Uint8Array>();
  for (const m of src.matchAll(/static const uint8_t (PRESET_\d+)\[\d+\] = \{([^}]*)\}/g)) data.set(m[1], Uint8Array.from(m[2].split(',').map(Number)));
  return [...src.matchAll(/\{"([^"]*)", (PRESET_\d+), [^,}]+(?:, (\d+))?\}/g)].map((m) => {
    const stored = data.get(m[2]);
    if (!stored) throw new Error(`presets.h: no array ${m[2]}`);
    if (m[3] === undefined) return { name: m[1], bytes: stored };
    const bytes = lzUnpack(stored);
    if (bytes.length !== Number(m[3])) throw new Error(`presets.h: ${m[1]} unpacks to ${bytes.length} bytes, not ${m[3]}`);
    return { name: m[1], bytes };
  });
}
