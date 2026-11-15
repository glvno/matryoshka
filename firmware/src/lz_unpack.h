/* SPDX-License-Identifier: GPL-3.0-only */
/* The factory patches are stored packed in presets.h (web/scripts/factory-lz.ts packs them; main.c factory_write unpacks
 * one right before it goes into the bank). The format follows LZ4's block format: a run of sequences, each
 *   a token byte: the high 4 bits count the literals, the low 4 bits are the match's length less 4; 15 in either means
 *     more bytes follow (after the token for the literals, after the distance for the match), each added, until one
 *     below 255;
 *   the literals, copied as they are;
 *   unless the input ends here: the match's distance back into the bytes already out, 2 bytes little endian, then the
 *     match copied from there one byte at a time (so it may overlap what it writes).
 * The input may end after a sequence's literals or after its match. */
#pragma once
#include <stdint.h>

/* src[0..n) unpacked into dst[0..cap): the unpacked length, or -1 when the input is cut short, points before the start
 * or would not fit (dst is never written past cap, src never read past n) */
static inline int32_t lz_unpack(const uint8_t *src, uint32_t n, uint8_t *dst, uint32_t cap)
{
    uint32_t i = 0, o = 0, t, len, d;
    while (i < n) {
        t = src[i++];
        len = t >> 4;
        if (len == 15u)
            do {
                if (i == n)
                    return -1;
                d = src[i++];
                len += d;
            } while (d == 255u);
        if (len > n - i || len > cap - o)
            return -1;
        while (len--)
            dst[o++] = src[i++];
        if (i == n)
            break;
        if (n - i < 2u)
            return -1;
        d = src[i] | (uint32_t)src[i + 1u] << 8;
        i += 2u;
        len = (t & 15u) + 4u;
        if (len == 19u)
            do {
                if (i == n)
                    return -1;
                t = src[i++];
                len += t;
            } while (t == 255u);
        if (!d || d > o || len > cap - o)
            return -1;
        for (; len; len--, o++)
            dst[o] = dst[o - d];
    }
    return (int32_t)o;
}
