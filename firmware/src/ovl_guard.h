/* SPDX-License-Identifier: GPL-3.0-only */
/* The overload guard's decision (audio.c, D-362, issue #458), kept apart from the ISR so the host can test it
 * (firmware/test/guard_test.c, tools/guard_test.sh). Fed once per half buffer with the ISR's time (the render plus the
 * key scan and USB nested in it, in ticks) and whether the half was late (the hardware began playing it before its render
 * ended); it says when a part should be dropped.
 *
 * Two rules, each for a different kind of overload:
 * - A load that stays high: the mean ISR time (an average that weights the last halves most, about the last 8, OVL_AVG
 *   shift 3) over OVL_AVG_PCT % of a half. Near 100 % the main loop (the panel, the LCD, the watchdog) gets nearly no
 *   time, and a little more makes every half late. A single heavy half (a note start) moves the mean by an eighth of
 *   its excess only.
 * - Halves that come out late, again and again: a second late half within OVL_LATE_SPAN halves (2 s) of the one before.
 *   A late half is heard (the hardware plays it before it is written, or the ISR misses a half and an old one plays
 *   again). A patch can sit under budget on average and still be late in one block of many: Oracle V's Poly-Mod Bell
 *   on five voices with four notes held ran about 80 % but every 32nd block (the idle fifth voice's check, D-360) up
 *   to 2,921 us, late about once a second (the test rig, issue #458). One late half alone (a note start) is a click,
 *   not a reason to drop a part. A render far over its half is late every time: a part goes every second half, as
 *   before. The first OVL_GRACE halves after a patch load do not count (its first render is the dearest).
 * After a drop the mean starts again below the limit and the late halves are forgotten, so the next part goes only if
 * the overload goes on. */
#pragma once
#include <stdint.h>

#define OVL_AVG_SHIFT 3u           /* the mean's weight: each half moves it by 1/8 of the difference */
#define OVL_AVG_PCT 90u            /* the mean's limit, % of a half */
#define OVL_LATE_SPAN 688u         /* two late halves this close (halves: 2 s) drop a part */
#define OVL_GRACE 2u               /* halves after a patch load whose lateness does not count */

typedef struct {
    uint32_t avg;                  /* the mean ISR time, ticks << OVL_AVG_SHIFT */
    uint16_t since;                /* halves since the last late one (OVL_LATE_SPAN: none that counts) */
    uint8_t grace;                 /* halves left whose lateness does not count */
} ovl_guard_t;

static inline void ovl_guard_reset(ovl_guard_t *g)
{
    g->avg = 0;
    g->since = OVL_LATE_SPAN;
    g->grace = OVL_GRACE;
}

/* the mean ISR time in ticks */
static inline uint32_t ovl_guard_mean(const ovl_guard_t *g) { return g->avg >> OVL_AVG_SHIFT; }

/* one half: `ticks` its ISR time, `half` a half's length in ticks, `late` 1 when it was late. 1: drop a part now. */
static inline int ovl_guard_step(ovl_guard_t *g, uint32_t ticks, uint32_t half, int late)
{
    uint32_t lim = half / 100u * OVL_AVG_PCT;
    int again = 0;
    g->avg = g->avg - (g->avg >> OVL_AVG_SHIFT) + ticks;
    if (g->grace) {
        g->grace--;
        late = 0;
    }
    if (late) {
        again = g->since < OVL_LATE_SPAN;
        g->since = 0;
    } else if (g->since < OVL_LATE_SPAN) {
        g->since++;
    }
    if (again || ovl_guard_mean(g) > lim) {
        g->avg = (lim - lim / 8u) << OVL_AVG_SHIFT;   /* a fresh start below the limit: a part more only if it goes on */
        g->since = OVL_LATE_SPAN;
        return 1;
    }
    return 0;
}
