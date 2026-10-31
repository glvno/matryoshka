/* SPDX-License-Identifier: GPL-3.0-only */
/* The overload guard's decision (audio.c, D-362, issue #458), kept apart from the ISR so the host can test it
 * (firmware/test/guard_test.c, tools/guard_test.sh). Fed once per half buffer with the ISR's time (the render plus the
 * key scan and USB nested in it, in ticks) and whether the half was late (the hardware began playing it before its render
 * ended); it says when a part should be dropped.
 *
 * Two rules, each one for a different kind of overload:
 * - A load that stays high: the mean ISR time (an average that weights the last halves most, about the last 8, OVL_AVG
 *   shift 3) over OVL_AVG_PCT % of a half. A patch that sits a little over its budget makes every half late by a few
 *   microseconds, or makes the ISR skip a half, and is heard as a crackle; a patch near 100 % leaves the main loop (the
 *   panel, the LCD, the watchdog) nearly no time. A single heavy half (a note start) moves the mean by an eighth of its
 *   excess only.
 * - Halves that are really late: two late halves within the last eight. A render far over its half makes the ISR come
 *   back at once and the main loop starves; this sheds within two halves, as before. One late half alone (a note start)
 *   is a click, not a reason to drop a part.
 * After a drop the mean starts again from the threshold's share less a margin and the late halves are forgotten, so the
 * next part goes only if the overload goes on. */
#pragma once
#include <stdint.h>

#define OVL_AVG_SHIFT 3u           /* the mean's weight: each half moves it by 1/8 of the difference */
#define OVL_AVG_PCT 90u            /* the mean's limit, % of a half */
#define OVL_LATE_WINDOW 0xFFu      /* the late rule looks at the last 8 halves */

typedef struct {
    uint32_t avg;                  /* the mean ISR time, ticks << OVL_AVG_SHIFT */
    uint8_t late;                  /* bit k: the half k halves ago was late */
} ovl_guard_t;

static inline void ovl_guard_reset(ovl_guard_t *g)
{
    g->avg = 0;
    g->late = 0;
}

/* the mean ISR time in ticks */
static inline uint32_t ovl_guard_mean(const ovl_guard_t *g) { return g->avg >> OVL_AVG_SHIFT; }

static inline uint32_t ovl__ones(uint32_t v)
{
    uint32_t n = 0;
    for (; v; v &= v - 1u)
        n++;
    return n;
}

/* one half: `ticks` its ISR time, `half` a half's length in ticks, `late` 1 when it was late. 1: drop a part now. */
static inline int ovl_guard_step(ovl_guard_t *g, uint32_t ticks, uint32_t half, int late)
{
    uint32_t lim = half / 100u * OVL_AVG_PCT;
    g->avg = g->avg - (g->avg >> OVL_AVG_SHIFT) + ticks;
    g->late = (uint8_t)(g->late << 1 | (late ? 1u : 0u));
    if (ovl__ones(g->late & OVL_LATE_WINDOW) >= 2u || ovl_guard_mean(g) > lim) {
        g->avg = (lim - lim / 8u) << OVL_AVG_SHIFT;   /* a fresh start below the limit: a part more only if it goes on */
        g->late = 0;
        return 1;
    }
    return 0;
}
