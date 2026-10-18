/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The engine's division-free helpers against the plain divisions they replace, on random and edge inputs (run by
 * tools/engine_exact.sh): blep_pos (poly-BLEP position), hz_turns (Hz -> turns per sample), block_mean. */
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

int main(int argc, char **argv)
{
    long cases = argc > 1 ? atol(argv[1]) : 20000000, k, bad = 0;
    uint32_t rc[2] = {0, 0};
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
