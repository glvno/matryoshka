// SPDX-License-Identifier: GPL-3.0-only
/* Host test of the overload guard's decision (firmware/src/ovl_guard.h, issue #458): which loads drop a part and how soon.
 * A half is 2,902 us; ISR times are given in us and fed in ticks (24 per us), as audio.c does.
 *   tools/guard_test.sh */
#include <stdio.h>
#include <stdlib.h>
#include "../src/ovl_guard.h"

#define TPU 24u
#define HALF_US 2901u              /* audio.c: HALF_FRAMES * 1000000 / FS */
static int fails;
#define CHECK(c, ...) do { if (!(c)) { fails++; printf("FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

/* run `n` halves of `us` microseconds each (late when over a half); the halves at which a part was dropped */
static int run(ovl_guard_t *g, uint32_t n, uint32_t (*us)(uint32_t k), uint32_t *first)
{
    int sheds = 0;
    uint32_t k;
    for (k = 0; k < n; k++) {
        uint32_t t = us(k);
        if (ovl_guard_step(g, t * TPU, HALF_US * TPU, t > HALF_US)) {
            if (!sheds && first)
                *first = k;
            sheds++;
        }
    }
    return sheds;
}

static uint32_t steady_101(uint32_t k) { (void)k; return 2923; }            /* Poly-Mod Bell at four voices (#458) */
static uint32_t steady_96(uint32_t k) { (void)k; return 2790; }
static uint32_t steady_86(uint32_t k) { (void)k; return 2490; }             /* Io 4 Ensemble Pad at four parts (#461) */
static uint32_t steady_80(uint32_t k) { (void)k; return 2320; }
static uint32_t far_over(uint32_t k) { (void)k; return 4000; }              /* a render far over its half */
/* note starts: 80 % with one half at 110 % (late) every 100 halves; the first half after a load at 110 % too */
static uint32_t peaks(uint32_t k) { return k % 100u == 0u ? 3200u : 2320u; }
/* two note starts close together: 80 % with late halves 20 halves apart */
static uint32_t two_peaks(uint32_t k) { return k == 10u || k == 30u ? 3200u : 2320u; }
/* a chord: four heavy halves in a row at 98 % (voices starting), then 84 % */
static uint32_t chord(uint32_t k) { return k >= 50u && k < 54u ? 2850u : 2440u; }
/* alternating heavy and light halves, the heavy one late: the mean is 85 %, but every other half crackles */
static uint32_t alt(uint32_t k) { return k & 1u ? 2930u : 2000u; }

int main(void)
{
    ovl_guard_t g;
    uint32_t first = 0;
    int n;

    ovl_guard_reset(&g);
    n = run(&g, 344, steady_101, &first);           /* one second */
    CHECK(n >= 1, "a steady 101 %% load must drop a part (dropped %d)", n);
    CHECK(first <= 4, "a late half every time drops within a few halves (first at half %u)", first);

    ovl_guard_reset(&g);
    n = run(&g, 344, steady_96, &first);
    CHECK(n >= 1 && first < 40, "a steady 96 %% load drops a part within 40 halves (dropped %d, first at %u)", n, first);

    ovl_guard_reset(&g);
    n = run(&g, 3440, steady_86, NULL);             /* ten seconds */
    CHECK(n == 0, "a steady 86 %% load plays on (dropped %d)", n);

    ovl_guard_reset(&g);
    n = run(&g, 3440, steady_80, NULL);
    CHECK(n == 0, "80 %% plays on (dropped %d)", n);

    ovl_guard_reset(&g);
    n = run(&g, 2, far_over, &first);
    CHECK(n == 1 && first == 1, "a render far over its half drops a part at the second half (dropped %d, first at %u)", n, first);
    ovl_guard_reset(&g);
    n = run(&g, 8, far_over, NULL);
    CHECK(n == 4, "and one more every two halves while it lasts (dropped %d in 8)", n);

    ovl_guard_reset(&g);
    n = run(&g, 3440, peaks, NULL);
    CHECK(n == 0, "single late halves (note starts) drop nothing (dropped %d)", n);

    ovl_guard_reset(&g);
    n = run(&g, 344, two_peaks, NULL);
    CHECK(n == 0, "late halves 20 halves apart drop nothing (dropped %d)", n);

    ovl_guard_reset(&g);
    n = run(&g, 344, chord, NULL);
    CHECK(n == 0, "a chord's four heavy halves at 98 %% drop nothing (dropped %d)", n);

    ovl_guard_reset(&g);
    n = run(&g, 344, alt, &first);
    CHECK(n >= 1 && first <= 4, "a late half every other half drops a part (dropped %d, first at %u)", n, first);

    /* after a drop the load falls: no second drop */
    {
        int k, sheds = 0;
        ovl_guard_reset(&g);
        for (k = 0; k < 3440; k++) {
            uint32_t t = sheds ? 2200u : 2923u;     /* a part less: 76 % */
            sheds += ovl_guard_step(&g, t * TPU, HALF_US * TPU, t > HALF_US);
        }
        CHECK(sheds == 1, "one drop, then the lighter load plays on (dropped %d)", sheds);
    }
    /* after a drop the load stays at 96 %: a second part goes, not at once */
    {
        int k, sheds = 0, at[4] = {0};
        ovl_guard_reset(&g);
        for (k = 0; k < 344 && sheds < 2; k++) {
            uint32_t t = sheds ? 2790u : 2923u;
            if (ovl_guard_step(&g, t * TPU, HALF_US * TPU, t > HALF_US))
                at[sheds++] = k;
        }
        CHECK(sheds == 2 && at[1] - at[0] >= 4, "a second drop comes later if the overload goes on (%d drops, at %d and %d)", sheds, at[0], at[1]);
    }

    printf(fails ? "guard_test: %d failed\n" : "guard_test: ok\n", fails);
    return fails ? 1 : 0;
}
