/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* Host test of the device test mode's output meter (firmware/src/test_peak.h, TEST_PEAK, #385):
 *   - the audio ISR landing between any two of the reader's steps: a half counts in exactly one read, the read it landed
 *     before the flip of, or the next one; never twice, never in a later read than that, and two reads with no half
 *     between them read silence;
 *   - the same with the reader as it was before #385 (read, then zero): the harness finds its lost half, so it can tell;
 *   - a long run with halves of random levels at random steps: no read misses a half that landed between it and the
 *     previous read, and none reports a level older than the previous read;
 *   - the level's scale against the output's own words: (x m >> 12 << 6) >> 8 at MASTER's default.
 *   tools/peak_test.sh */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int step_at = -1;        /* the reader's step after which a half lands (-1: none) */
static int step_now;
static void isr_hook(void);
#define TP_STEP() isr_hook()
#include "../src/test_peak.h"

static int fails;
#define CHECK(c, ...) do { if (!(c)) { fails++; printf("FAIL " __VA_ARGS__); printf("\n"); } } while (0)

#define N 128u
static int32_t hl[N], hr[N];
static const int32_t MR = (int32_t)(((int64_t)2048 * 65536) >> 16);   /* MASTER's default, the patch at full level */
static uint32_t pending_level;  /* the level (16 bit) of the half that lands at step_at */

/* one half whose loudest sample reads `level` on the meter */
static void half(uint32_t level)
{
    uint32_t i;
    int32_t x = (int32_t)((level << 14) / (uint32_t)MR);   /* the inverse of the meter's scale (exact for these levels) */
    for (i = 0; i < N; i++)
        hl[i] = hr[i] = 0;
    hl[N / 3] = -x;
    if (level)
        hr[N / 2] = x - 1;
    tp_block(hl, hr, N, MR);
}
static void (*land)(uint32_t) = half;   /* what the ISR does when it lands */
static void isr_hook(void)
{
    if (step_now++ == step_at)
        land(pending_level);
}
/* a read by `take`, with a half of `level` landing after its step `at` */
static uint32_t read_at(uint32_t (*take)(void), int at, uint32_t level)
{
    uint32_t p;
    step_now = 0;
    step_at = at;
    pending_level = level;
    p = take();
    step_at = -1;
    return p;
}
static uint32_t take_at(int at, uint32_t level) { return read_at(tp_take, at, level); }

/* the reader before #385, with the same steps marked */
static volatile uint32_t old_peak;
static uint32_t old_take(void)
{
    uint32_t p;
    TP_STEP();
    p = old_peak;
    TP_STEP();
    old_peak = 0;
    return p;
}
static void old_half(uint32_t level)
{
    if (level > old_peak)
        old_peak = level;
}

int main(void)
{
    int at, steps = 4;
    /* 1. a half landing at each step of a read */
    for (at = 0; at < steps; at++) {
        uint32_t a, b, c, d;
        tp_take();
        tp_take();
        half(1000);                         /* before the read: always in it */
        a = take_at(at, 2000);              /* a half lands inside the read */
        b = tp_take();
        c = tp_take();
        d = tp_take();
        CHECK(a >= 1000 && a <= 2000, "step %d: the read has the half before it (%u)", at, a);
        CHECK((a == 2000) != (b == 2000), "step %d: the half inside the read counts once (%u then %u)", at, a, b);
        CHECK(b == 0 || b == 2000, "step %d: the read after has nothing older (%u)", at, b);
        CHECK(c == 0 && d == 0, "step %d: nothing played: silence (%u, %u)", at, c, d);
    }
    printf("ok   a half landing between any two of the reader's steps counts in exactly one read\n");

    /* 2. the reader before #385: the half that lands between its two steps is in neither read */
    {
        int lost = 0;
        land = old_half;
        for (at = 0; at < 2; at++) {
            uint32_t a, b;
            old_peak = 0;
            a = read_at(old_take, at, 2000);
            b = old_take();
            if (a != 2000 && b != 2000)
                lost++;
        }
        land = half;
        CHECK(lost == 1, "the old reader: the harness should find one lost half (%d)", lost);
        printf("ok   the reader before #385 loses a half that lands between its read and its zeroing (the harness sees it)\n");
    }

    /* 3. a long run: halves of random levels at random steps */
    {
        uint32_t k, since_prev = 0, during = 0, prev_during = 0;
        srand(385);
        tp_take();
        for (k = 0; k < 200000u; k++) {
            uint32_t p, lv;
            int nh = rand() % 3, j;
            since_prev = 0;
            for (j = 0; j < nh; j++) {
                lv = (uint32_t)(rand() % 8000);
                half(lv);
                if (lv > since_prev)
                    since_prev = lv;
            }
            lv = (uint32_t)(rand() % 8000);
            at = rand() % (steps + 2) - 1;  /* -1 or past the last step: no half inside this read */
            during = at >= 0 && at < steps ? lv : 0;
            p = take_at(at, lv);
            /* every half between the previous read and this one is in it; nothing louder than what landed since the
             * previous read began (its own inner half included) */
            CHECK(p >= since_prev, "run %u: read %u misses a half of %u", k, p, since_prev);
            {
                uint32_t most = since_prev > during ? since_prev : during;
                if (prev_during > most)
                    most = prev_during;
                CHECK(p <= most, "run %u: read %u is louder than anything since the previous read (%u)", k, p, most);
            }
            prev_during = during;
            if (fails > 10)
                break;
        }
        printf("ok   200000 reads with halves at random steps: none missed, none stale\n");
    }

    /* 4. the scale: the meter reads what the output words carry at MASTER's default, >> 8 */
    {
        int i;
        uint32_t worst = 0;
        tp_take();
        tp_take();
        for (i = 0; i < 20000; i++) {
            int32_t x = (int32_t)(rand() % 131071) - 65535, word;
            uint32_t m, want;
            int j;
            for (j = 0; j < (int)N; j++)
                hl[j] = hr[j] = 0;
            hl[7] = x;
            hr[9] = x / 3;
            tp_block(hl, hr, N, MR);
            m = tp_take();
            word = ((x * MR) >> 12) << 6;
            want = (uint32_t)((word < 0 ? -word : word) >> 8);
            if ((m > want ? m - want : want - m) > worst)
                worst = m > want ? m - want : want - m;
        }
        CHECK(worst <= 1, "the meter's scale is off the output's by %u", worst);
        printf("ok   the level matches the output's 16-bit words at MASTER's default (within %u)\n", worst);
    }
    if (fails)
        printf("%d failed\n", fails);
    return fails != 0;
}
