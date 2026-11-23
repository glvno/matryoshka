/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The palette's switch on the bar line (#1196): the audio interrupt fades the old sound out so that it ends on the bar
 * line's sample, stops the engine there for the main loop's load (palette.c), and fades the new sound in. Included by
 * audio.c after eng_run and eng_resume; host-tested by firmware/test/pal_fade_test.c.
 *
 * States (pal_fade_st; the interrupt tests only this byte, and calls pal_fade_half after each render while it is not 0):
 *   IDLE     nothing.
 *   ARMED    a stop at run tick pal_fade_bar (eng_next_bar). Gain per sample i of a half: (s - i) / PAL_FADE_N, held to
 *            0..1, s the samples from the half's first sample to the bar line's (eng_samples_to at the end of the half
 *            before; the arming lead, 20 ms, leaves the first half without gain). Once the tick fell in a render
 *            (eng_tick_fell), the samples from it on are zero, the engine stops (eng_run = 0) and the state is STOPPED.
 *            On MIDI clock s is an estimate: whichever comes first, the estimate's end or the tick, stops. The transport
 *            stopping turns it into NOW. A tick passed without falling (a jump) stops after that half.
 *   NOW      the same over PAL_FADE_NOW_N from the next half, no bar (the transport is stopped: switch at once).
 *   STOPPED  silent halves; the main loop loads, then pal_fade_resume (or pal_fade_cancel: the old engine plays on).
 *   FADEIN   gain 0 -> 1 over PAL_FADEIN_N from the first half rendered after the load, then IDLE. A cancel during the
 *            fade-out comes back up through it from the gain reached.
 * Gains are Q16, never above 1; the fade-out's never rises (a stop moved by NOW or a tempo change keeps the gain it
 * reached). The main loop hands a cancel to the interrupt (pal_fade_rq) while it runs a fade, so the two never write
 * the same state at once. */
#ifndef PAL_FADE_H
#define PAL_FADE_H

#define PAL_FADE_N 441u                          /* 10 ms fade-out ending on the bar line's sample */
#define PAL_FADEIN_N 128u                        /* the fade-in: one half, 2.9 ms */
#define PAL_FADE_NOW_N 220u                      /* 5 ms fade-out when the transport is stopped */
#define PAL_ONE 65536u                           /* a gain of 1, Q16 */
enum { PAL_FADE_IDLE, PAL_FADE_ARMED, PAL_FADE_NOW, PAL_FADE_STOPPED, PAL_FADE_IN };

static volatile uint8_t pal_fade_st;             /* the state (IDLE 0) */
static volatile uint8_t pal_fade_off;            /* DIAG (the device test mode only): 1 = no gain, a hard cut on the bar
                                                  * line's sample (as before the palette, but at the tick), to measure */
static volatile uint8_t pal_fade_rq;             /* 1: a cancel asked for, the interrupt takes it on its next half */
static volatile uint16_t pal_fade_len;           /* ARMED / NOW: the fade-out's samples */
static volatile uint16_t pal_fade_k = PAL_FADEIN_N;   /* the fade-in's sample (PAL_FADEIN_N: done) */
static volatile int32_t pal_fade_bar;            /* ARMED: the run tick */
static volatile int32_t pal_fade_s;              /* ARMED / NOW: samples from the next half's first sample to the stop;
                                                  * -1 not known yet (ARMED's first half: no gain) */
static volatile uint32_t pal_fade_dn = PAL_ONE;  /* the fade-out's gain at the last sample */
static volatile uint32_t pal_fade_g = PAL_ONE;   /* the gain at the last sample */

/* the interrupt, after each render while pal_fade_st is not IDLE: the half's gain, and the stop. In the flash (the
 * interrupt runs from RAM, build.py FAST_TEXT), called only on the few halves of a switch */
static __attribute__((noinline)) void pal_fade_half(int32_t *l, int32_t *r, uint32_t n)
{
    uint32_t st = pal_fade_st, k = pal_fade_k, dn = pal_fade_dn, g = pal_fade_g, len = pal_fade_len, off = pal_fade_off, i, z = n;
    int32_t s = pal_fade_s, b = pal_fade_bar, stop = 0;
    if (st == PAL_FADE_STOPPED) {                /* (the engine was run again meanwhile: silent until the load) */
        for (i = 0; i < n; i++)
            l[i] = r[i] = 0;
        eng_run = 0;
        return;
    }
    if (pal_fade_rq) {                           /* a cancel: back up from the gain reached */
        pal_fade_rq = 0;
        if (st != PAL_FADE_IN) {
            eng_tick_mark(-1);
            k = (g * PAL_FADEIN_N + PAL_ONE - 1u) / PAL_ONE;   /* (rounded up: never under the gain reached) */
            st = k >= PAL_FADEIN_N ? PAL_FADE_IDLE : PAL_FADE_IN;
        }
    }
    if (st == PAL_FADE_ARMED && eng_run_ticks() < 0) {   /* the transport stopped: switch at once, from the gain reached */
        int32_t t = (int32_t)(dn * PAL_FADE_NOW_N / PAL_ONE);
        eng_tick_mark(-1);
        st = PAL_FADE_NOW;
        len = PAL_FADE_NOW_N;
        s = s >= 0 && s < t ? s : t;
    }
    if (off)
        k = PAL_FADEIN_N;
    if (st == PAL_FADE_IDLE) {
        pal_fade_k = PAL_FADEIN_N;
        pal_fade_g = PAL_ONE;
        pal_fade_st = PAL_FADE_IDLE;
        return;
    }
    if (k < PAL_FADEIN_N || (st != PAL_FADE_IN && (dn < PAL_ONE || (s >= 0 && s < (int32_t)(n - 1u + len))))) {
        for (i = 0; i < n; i++) {
            uint32_t up = PAL_ONE, d = st == PAL_FADE_IN ? PAL_ONE : dn;
            if (k + i < PAL_FADEIN_N)
                up = (k + i) * PAL_ONE / PAL_FADEIN_N;
            if (st != PAL_FADE_IN && s >= 0) {
                if ((int32_t)i >= s)
                    d = 0;
                else if (!off && (uint32_t)s - i < len && ((uint32_t)s - i) * PAL_ONE / len < d)
                    d = ((uint32_t)s - i) * PAL_ONE / len;
            }
            if (st != PAL_FADE_IN)
                dn = d;
            g = up < d ? up : d;
            l[i] = (int32_t)(((int64_t)l[i] * g) >> 16);
            r[i] = (int32_t)(((int64_t)r[i] * g) >> 16);
        }
    } else {
        g = PAL_ONE;
    }
    k = k + n < PAL_FADEIN_N ? k + n : PAL_FADEIN_N;
    if (st == PAL_FADE_IN) {
        if (k >= PAL_FADEIN_N)
            st = PAL_FADE_IDLE;
    } else {
        int32_t at = st == PAL_FADE_ARMED ? eng_tick_fell(b) : -1;
        if (at >= 0) {                           /* the bar's tick fell: nothing of the old pattern's beat 1 */
            z = (uint32_t)at;
            stop = 1;
        } else if (s >= 0 && (uint32_t)s <= n && (st == PAL_FADE_NOW || eng_clock_is_external())) {
            z = (uint32_t)s;                     /* the fade's end (on MIDI clock the estimate's, if first) */
            stop = 1;
        } else if (st == PAL_FADE_ARMED && eng_run_ticks() >= b) {
            stop = 1;                            /* (passed without falling: a jump) */
        }
        if (stop) {
            for (i = z; i < n; i++)
                l[i] = r[i] = 0;
            eng_tick_mark(-1);
            eng_run = 0;                         /* (audio.c keeps this half's run flag: its clock out still goes) */
            st = PAL_FADE_STOPPED;
            g = dn = 0;
        } else {
            s = st == PAL_FADE_ARMED ? (int32_t)eng_samples_to(b) : s - (int32_t)n;
        }
    }
    pal_fade_s = s;
    pal_fade_len = (uint16_t)len;
    pal_fade_k = (uint16_t)k;
    pal_fade_dn = dn;
    pal_fade_g = g;
    pal_fade_st = (uint8_t)st;
}

/* The main loop's side. pal_fade_arm: bar_tick >= 0 (eng_next_bar), stop at that run tick; < 0, NOW: fade out over
 * PAL_FADE_NOW_N from the next half. Armed already (ARMED, NOW, STOPPED): the earlier stop stays. Marks the tick for
 * eng_tick_fell; from FADEIN the fade-in goes on under the fade-out */
static void pal_fade_arm(int32_t bar_tick)
{
    uint8_t st;
    pal_fade_rq = 0;                             /* (a cancel not yet taken: the switch stays armed) */
    st = pal_fade_st;
    if (st == PAL_FADE_ARMED || st == PAL_FADE_NOW || st == PAL_FADE_STOPPED)
        return;
    if (st == PAL_FADE_IDLE)
        pal_fade_k = PAL_FADEIN_N;
    pal_fade_bar = bar_tick < 0 ? -1 : bar_tick;
    pal_fade_len = (uint16_t)(bar_tick < 0 ? PAL_FADE_NOW_N : PAL_FADE_N);
    pal_fade_s = bar_tick < 0 ? (int32_t)PAL_FADE_NOW_N : -1;
    pal_fade_dn = PAL_ONE;
    eng_tick_mark(bar_tick < 0 ? -1 : bar_tick);
    pal_fade_st = (uint8_t)(bar_tick < 0 ? PAL_FADE_NOW : PAL_FADE_ARMED);
}
/* after the load in STOPPED: the new engine runs (the overload rule: eng_resume) and fades in over PAL_FADEIN_N */
static void pal_fade_resume(void)
{
    if (pal_fade_st != PAL_FADE_STOPPED)
        return;
    pal_fade_k = 0;
    pal_fade_g = 0;
    pal_fade_dn = PAL_ONE;
    pal_fade_s = -1;
    pal_fade_st = PAL_FADE_IN;
    eng_resume();
}
/* the switch called off: ARMED / NOW back up through FADEIN from the gain reached (IDLE if none was applied yet), the
 * interrupt's next half; STOPPED (nothing was loaded): FADEIN, the old engine runs again */
static void pal_fade_cancel(void)
{
    pal_fade_rq = 1;
    switch (pal_fade_st) {
    case PAL_FADE_IDLE:
        pal_fade_rq = 0;
        break;
    case PAL_FADE_STOPPED:
        pal_fade_rq = 0;
        pal_fade_resume();
        break;
    default:                                     /* (ARMED, NOW, FADEIN: the interrupt takes it) */
        break;
    }
}
/* 1: the interrupt stopped the engine on the bar line (or at NOW's end): the main loop loads now */
static int pal_fade_stopped(void) { return pal_fade_st == PAL_FADE_STOPPED; }
/* samples until the stop (ARMED, NOW), 0 when STOPPED, -1 IDLE / FADEIN: the main loop holds its redraw while
 * 0 <= due < 2646 (60 ms) */
static int32_t pal_fade_due(void)
{
    uint8_t st = pal_fade_st;
    int32_t s = pal_fade_s;
    if (st == PAL_FADE_STOPPED)
        return 0;
    if (st == PAL_FADE_ARMED)
        return s >= 0 ? s : (int32_t)eng_samples_to(pal_fade_bar);
    if (st == PAL_FADE_NOW)
        return s;
    return -1;
}

#endif
