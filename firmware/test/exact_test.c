/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The engine's division-free helpers against the plain divisions they replace, on random and edge inputs (run by
 * tools/engine_exact.sh): blep_pos (poly-BLEP position), hz_turns (Hz -> turns per sample), block_mean, exp2_scale (its
 * 32-bit form against the 64-bit one it replaced). */
#include <stdio.h>
#include <stdlib.h>
#include "../src/engine.c"
#include "../src/div64.c"

static uint64_t rs = 88172645463325252ull;
static uint32_t rnd(void)
{
    rs ^= rs << 13;
    rs ^= rs >> 7;
    rs ^= rs << 17;
    return (uint32_t)rs;
}

/* exp2_scale as it was written with 64-bit arithmetic throughout (before #453) */
static uint32_t exp2_scale_ref(uint32_t base, int32_t x)
{
    int32_t n = x >> 16;
    uint32_t fr = (uint32_t)x & 0xFFFFu, i = fr >> 8, r = fr & 255u;
    uint32_t m = EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1u] - EXP2_T[i]) * r) >> 8);
    uint64_t v = ((uint64_t)base * m) >> 28;
    if (n >= 0) {
        if (n >= 32 || v >= (1ull << (32 - n)))
            return 0xFFFFFFFFu;
        return (uint32_t)(v << n);
    }
    return -n >= 64 ? 0u : (uint32_t)(v >> -n);
}

/* every x from -70 to +40 octaves for the engine's bases and bases around the 32-bit border of v, random pairs besides */
static long exp2_check(long cases)
{
    static const uint32_t bases[] = {0u, 1u, 255u, 65536u, 25469723u /* INC_C4 */, 65536u * 440u, 1u << 30, 0x7FFFFFFFu,
                                     0x80000000u, 0x80000001u, 0xC0000000u, 0xFFFFFFFFu};
    long bad = 0, k;
    uint32_t b;
    int32_t x;
    for (b = 0; b < sizeof bases / sizeof bases[0]; b++)
        for (x = -(70 << 16); x <= (40 << 16); x++)
            if (exp2_scale(bases[b], x) != exp2_scale_ref(bases[b], x) && bad++ < 5)
                printf("exp2_scale base %u x %d\n", bases[b], x);
    for (k = 0; k < cases; k++) {
        uint32_t base = rnd() >> (rnd() % 32);
        x = (int32_t)rnd();
        if (k & 1)
            x >>= rnd() % 32;
        if (exp2_scale(base, x) != exp2_scale_ref(base, x) && bad++ < 10)
            printf("exp2_scale base %u x %d\n", base, x);
    }
    return bad;
}

/* One patched output must equal that output with every port patched, including partial blocks. */
static int single_outputs(void)
{
    int32_t a[128], b[128], reference[MATH_NOUT][128], actual[128], par[MATH_NPAR];
    inst_t full = {0}, one = {0};
    node_t node = {0};
    uint32_t kind, trial, j, i, n, count;
    full.in[0] = one.in[0] = a;
    full.in[1] = one.in[1] = b;
    full.eff = one.eff = par;
    for (kind = 0; kind < 2; kind++) {
        void (*run)(const node_t *, inst_t *, uint32_t) = kind ? m_logic : m_math;
        count = kind ? LOGIC_NOUT : MATH_NOUT;
        for (trial = 0; trial < 64; trial++) {
            n = 1 + rnd() % 128;
            for (i = 0; i < n; i++) {
                a[i] = (int32_t)(rnd() % 262145) - 131072;
                b[i] = (int32_t)(rnd() % 262145) - 131072;
            }
            for (j = 0; j < MATH_NPAR; j++) par[j] = (int32_t)(rnd() % 262145) - 131072;
            for (j = 0; j < count; j++) full.out[j] = reference[j];
            run(&node, &full, n);
            for (j = 0; j < count; j++) {
                uint32_t k;
                for (k = 0; k < count; k++) one.out[k] = dummy_out;
                one.out[j] = actual;
                run(&node, &one, n);
                for (i = 0; i < n; i++) if (actual[i] != reference[j][i]) {
                    printf("single output mismatch type %u port %u sample %u\n", kind, j, i);
                    return 1;
                }
            }
        }
    }
    return 0;
}

int main(int argc, char **argv)
{
    long cases = argc > 1 ? atol(argv[1]) : 20000000, k, bad = 0;
    uint32_t rc[2] = {0, 0};
    bad += single_outputs();
    bad += exp2_check(cases);
    for (k = 0; k < cases; k++) {
        uint32_t dt = rnd() >> (rnd() % 32), t;
        if (!dt)
            dt = 1;
        switch (k & 3) {
        case 0: t = rnd() % dt; break;
        case 1: t = dt - 1u - (dt > 4u ? rnd() % 4u : 0u); break;
        case 2: t = dt > 8u ? rnd() % 8u : 0u; break;
        default: t = (uint32_t)(((uint64_t)dt * (rnd() & 0xFFFFu)) >> 16); break;
        }
        if (k % 1000 == 0)
            dt = 65536u + (uint32_t)(k / 1000 % 5) - 2u, t = dt - 1u;   /* around the 32-bit / reciprocal border */
        if (blep_pos(t, dt, rc) != (uint32_t)(((uint64_t)t << 16) / dt) && bad++ < 5)
            printf("blep_pos t %u dt %u\n", t, dt);
    }
    for (k = 0; k < cases; k++) {
        uint32_t x = k < 70000 ? (uint32_t)k : rnd() >> (rnd() % 32);
        if (hz_turns(x) != (uint32_t)(((uint64_t)x << 16) / ENG_SR) && bad++ < 10)
            printf("hz_turns %u\n", x);
    }
    for (k = 0; k < cases / 10; k++) {
        int64_t sum = (int64_t)(int32_t)rnd() * (int64_t)(rnd() % 129u);
        if (k & 1)
            sum = -sum;
        if (block_mean(sum, ENG_BLOCK) != (int32_t)(sum / (int64_t)ENG_BLOCK) && bad++ < 15)
            printf("block_mean %lld\n", (long long)sum);
    }
    for (k = 0; k < cases; k++) {                       /* div64.c against the host's 64-bit division */
        uint64_t a = ((uint64_t)rnd() << 32 | rnd()) >> (rnd() % 64), b = ((uint64_t)rnd() << 32 | rnd()) >> (rnd() % 64), r;
        int64_t sa, sb;
        if (k % 7 == 0)
            b = (b & 0xFFFFu) | 1u;                             /* small divisors */
        if (k % 11 == 0)
            b = (uint64_t)1 << (rnd() % 64);
        if (k % 13 == 0)
            a = ~(uint64_t)0 - (rnd() % 3);
        if (!b)
            b = 1;
        if (eng_udivmod64(a, b, &r) != a / b || r != a % b) {
            if (bad++ < 20)
                printf("udiv %llu / %llu\n", (unsigned long long)a, (unsigned long long)b);
        }
        sa = (int64_t)a * ((k & 1) ? -1 : 1);
        sb = (int64_t)b * ((k & 2) ? -1 : 1);
        if (sb == 0 || (sa == INT64_MIN && sb == -1))
            continue;
        if (eng_sdiv64(sa, sb) != sa / sb || eng_smod64(sa, sb) != sa % sb) {
            if (bad++ < 20)
                printf("sdiv %lld / %lld\n", (long long)sa, (long long)sb);
        }
    }
    printf("%s: %ld wrong\n", bad ? "FAIL" : "ok", bad);
    return bad != 0;
}
