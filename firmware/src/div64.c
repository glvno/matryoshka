/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* 64-bit division for a core with a 32-bit divider only. The compiler turns every int64 / and % into a call
 * (__udivdi3, __divdi3, __umoddi3, __moddi3); compiler-rt's versions shift and subtract one bit at a time (some 300
 * cycles), and the engine divides in 64 bits in many per-block setups (a filter's cutoff, a reverb's decay, a modal
 * body's modes, a part's flaws). These definitions come before libcompiler-rt.a in the link (tools/build.py), so they
 * replace its members: with a divisor below 2^32, which is nearly always, the quotient takes one to three 32-bit
 * divisions (Hacker's Delight divlu, two 16-bit digits per 32-bit word); a larger divisor takes the normalised estimate
 * of Hacker's Delight divdu. Exact: firmware/test/exact_test.c checks them against the host's own division.
 * Only 32-bit targets get the libcall names (the host builds divide natively). No / or % on 64-bit values in here: that
 * would call back into these. */
#include <stdint.h>

static int div64_clz(uint32_t x)            /* x != 0 */
{
    int n = 0;
    if (!(x >> 16)) { n += 16; x <<= 16; }
    if (!(x >> 24)) { n += 8; x <<= 8; }
    if (!(x >> 28)) { n += 4; x <<= 4; }
    if (!(x >> 30)) { n += 2; x <<= 2; }
    if (!(x >> 31)) n += 1;
    return n;
}

/* (u1 2^32 + u0) / v for u1 < v (the quotient fits 32 bits); the remainder in *r */
static uint32_t div64_lu(uint32_t u1, uint32_t u0, uint32_t v, uint32_t *r)
{
    const uint32_t b = 65536u;
    uint32_t un1, un0, vn1, vn0, q1, q0, un32, un21, un10, rhat;
    int s = div64_clz(v);
    v <<= s;
    vn1 = v >> 16;
    vn0 = v & 0xFFFFu;
    un32 = s ? (u1 << s) | (u0 >> (32 - s)) : u1;
    un10 = u0 << s;
    un1 = un10 >> 16;
    un0 = un10 & 0xFFFFu;
    q1 = un32 / vn1;
    rhat = un32 - q1 * vn1;
    while (q1 >= b || q1 * vn0 > b * rhat + un1) {
        q1--;
        rhat += vn1;
        if (rhat >= b)
            break;
    }
    un21 = un32 * b + un1 - q1 * v;
    q0 = un21 / vn1;
    rhat = un21 - q0 * vn1;
    while (q0 >= b || q0 * vn0 > b * rhat + un0) {
        q0--;
        rhat += vn1;
        if (rhat >= b)
            break;
    }
    if (r)
        *r = (un21 * b + un0 - q0 * v) >> s;
    return q1 * b + q0;
}

/* a / b and a % b, b != 0 */
static uint64_t eng_udivmod64(uint64_t a, uint64_t b, uint64_t *rem)
{
    uint32_t ah = (uint32_t)(a >> 32), al = (uint32_t)a, bh = (uint32_t)(b >> 32), bl = (uint32_t)b, r, qh, ql;
    uint64_t q;
    int n;
    if (!bh) {
        if (!ah) {                          /* both fit 32 bits */
            ql = al / bl;
            if (rem)
                *rem = al - ql * bl;
            return ql;
        }
        qh = 0;
        if (ah >= bl) {                     /* the quotient needs more than 32 bits: its high word first */
            qh = ah / bl;
            ah -= qh * bl;
        }
        ql = div64_lu(ah, al, bl, &r);
        if (rem)
            *rem = r;
        return ((uint64_t)qh << 32) | ql;
    }
    /* b >= 2^32: the quotient fits 32 bits; estimate from the normalised top word, then at most one correction */
    n = div64_clz(bh);
    {
        uint32_t v1 = (uint32_t)((b << n) >> 32);
        uint64_t u1 = a >> 1;
        uint32_t q1 = div64_lu((uint32_t)(u1 >> 32), (uint32_t)u1, v1, 0);
        q = ((uint64_t)q1 << n) >> 31;
    }
    if (q)
        q--;
    if (a - q * b >= b)
        q++;
    if (rem)
        *rem = a - q * b;
    return q;
}

static int64_t eng_sdiv64(int64_t a, int64_t b)
{
    uint64_t q = eng_udivmod64(a < 0 ? 0u - (uint64_t)a : (uint64_t)a, b < 0 ? 0u - (uint64_t)b : (uint64_t)b, 0);
    return (a < 0) != (b < 0) ? (int64_t)(0u - q) : (int64_t)q;
}

static int64_t eng_smod64(int64_t a, int64_t b)
{
    uint64_t r;
    eng_udivmod64(a < 0 ? 0u - (uint64_t)a : (uint64_t)a, b < 0 ? 0u - (uint64_t)b : (uint64_t)b, &r);
    return a < 0 ? (int64_t)(0u - r) : (int64_t)r;
}

#if UINTPTR_MAX == 0xFFFFFFFFu && !defined(ENG_LIB_DIV64)
uint64_t __udivmoddi4(uint64_t a, uint64_t b, uint64_t *rem);
uint64_t __udivdi3(uint64_t a, uint64_t b);
uint64_t __umoddi3(uint64_t a, uint64_t b);
int64_t __divdi3(int64_t a, int64_t b);
int64_t __moddi3(int64_t a, int64_t b);
uint64_t __udivmoddi4(uint64_t a, uint64_t b, uint64_t *rem) { return eng_udivmod64(a, b, rem); }
uint64_t __udivdi3(uint64_t a, uint64_t b) { return eng_udivmod64(a, b, 0); }
uint64_t __umoddi3(uint64_t a, uint64_t b)
{
    uint64_t r;
    eng_udivmod64(a, b, &r);
    return r;
}
int64_t __divdi3(int64_t a, int64_t b) { return eng_sdiv64(a, b); }
int64_t __moddi3(int64_t a, int64_t b) { return eng_smod64(a, b); }
#endif
