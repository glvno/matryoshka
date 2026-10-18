/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The engine's division-free helpers against the plain divisions they replace, on random and edge inputs (run by
 * tools/engine_exact.sh): blep_pos (poly-BLEP position), hz_turns (Hz -> turns per sample), block_mean. */
#include <stdio.h>
#include <stdlib.h>
#include "../src/engine.c"

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
    printf("%s: %ld wrong\n", bad ? "FAIL" : "ok", bad);
    return bad != 0;
}
