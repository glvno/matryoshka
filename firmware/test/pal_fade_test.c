/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The palette's switch on the bar line (#1196, firmware/src/pal_fade.h, engine.c eng_next_bar / eng_samples_to /
 * eng_tick_fell) on the host: the engine renders half buffers as the audio interrupt does (audio.c fm1_alnk0_irq), the
 * fade runs after each render. Checked:
 *   - eng_next_bar in 3/4, 4/4, 6/8 and 7/8 from every run tick, with and without a lead;
 *   - eng_samples_to exact on the internal clock at 20, 120 and 300 bpm: the marked tick falls (eng_tick_fell, and the
 *     clock out's tick) on the predicted sample;
 *   - ARMED -> STOPPED on the bar's tick sample: the 10 ms fade ends there, the rest of the half is zero, the half still
 *     rendered (its tick out), the engine stopped; then the fade-in and IDLE; the DIAG hard cut;
 *   - a cancel before the fade, during it (back up through FADEIN from the gain reached) and once stopped;
 *   - the transport stopping while ARMED, and during the fade: NOW; NOW from a stopped transport; re-arming keeps the
 *     earlier stop; MIDI clock in: the stop within a half of the bar's tick;
 *   - every gain monotonic, 0 from the stop sample on, never above 1.
 *   tools/pal_fade_test.sh */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/engine.c"
#include "../src/presets.h"

static volatile uint8_t eng_run = 1, eng_overload;   /* (audio.c's) */
static void eng_resume(void) { eng_run = (uint8_t)!eng_overload; }
#include "../src/pal_fade.h"

#define HALF 128u
#define LEAD 882u                                   /* palette.c's 20 ms */
static int fails;
static void check(const char *what, int ok)
{
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok)
        fails++;
}

static int32_t l[HALF], r[HALF];
static uint64_t samples;                            /* samples rendered so far */
static int flat;                                    /* 1: the render's output replaced by full scale before the fade, so
                                                     * what comes out is the gain */
static int last_run;                                /* the last half's run flag, as audio.c keeps it */
#define GLOG 600000                                 /* (a bar at 20 bpm, 530k samples, and some) */
static int32_t glog[GLOG];                          /* the gains from glog0 on */
static uint64_t glog0;

/* one audio interrupt's half (audio.c fm1_alnk0_irq) */
static void half(void)
{
    uint32_t i;
    uint8_t run = eng_run;
    if (run) {
        eng_render(l, r, HALF);
        if (flat)
            for (i = 0; i < HALF; i++)
                l[i] = r[i] = 65536;
        if (pal_fade_st)
            pal_fade_half(l, r, HALF);
    } else {
        for (i = 0; i < HALF; i++)
            l[i] = r[i] = 0;
    }
    last_run = run;
    for (i = 0; i < HALF; i++)
        if (samples + i >= glog0 && samples + i - glog0 < GLOG)
            glog[samples + i - glog0] = l[i];
    samples += HALF;
}
static void halves(uint32_t n)
{
    while (n--)
        half();
}
static void log_from_now(void)
{
    glog0 = samples;
    memset(glog, 0xFF, sizeof glog);
}
/* factory patch with a Main module loaded: 0, else -1 */
static int load_factory(void)
{
    static uint8_t bin[4096];
    uint32_t k;
    for (k = 0; k < N_PRESETS; k++)
        if (lz_unpack(PRESET_LIST[k].lz, PRESET_LIST[k].lz_len, bin, sizeof bin) == (int32_t)PRESET_LIST[k].len &&
            !eng_load(bin, PRESET_LIST[k].len) && eng_find(T_FM1) >= 0)
            return 0;
    return -1;
}
/* the transport from its start at bpm, meter m */
static void restart(uint32_t bpm, uint32_t m)
{
    eng_transport(0);
    halves(2);
    eng_tempo_global(bpm);
    eng_meter(m);
    eng_transport(1);
    half();
}
/* the gains logged over [a, b): monotonic down (up: rising), within 0..1 */
static int monotonic(uint64_t a, uint64_t b, int up)
{
    uint64_t t;
    for (t = a; t < b; t++) {
        int32_t g = glog[t - glog0];
        if (g < 0 || g > 65536)
            return 0;
        if (t > a && (up ? g < glog[t - 1u - glog0] : g > glog[t - 1u - glog0]))
            return 0;
    }
    return 1;
}
/* run halves until the fade stops the engine (at most `max`): 0 if it did not */
static int until_stopped(uint32_t max)
{
    while (max-- && !pal_fade_stopped())
        half();
    return pal_fade_stopped();
}

int main(void)
{
    static const uint32_t METERS[] = {1, 2, 4, 5};  /* 3/4, 4/4, 6/8, 7/8 */
    static const uint32_t LEADS[] = {0, LEAD, 6000};
    static const uint32_t BPMS[] = {20, 120, 300};
    char what[200];
    uint32_t k, j;
    setvbuf(stdout, NULL, _IOLBF, 0);
    check("a factory patch with Main loads", load_factory() == 0);
    eng_clock_external(0);

    /* ---- eng_next_bar from every run tick */
    for (k = 0; k < 4u; k++)
        for (j = 0; j < 3u; j++) {
            int32_t bar = METER_BAR[METERS[k]], seen_max = -1, bad = 0, gaps = 0, rt;
            restart(300, METERS[k]);
            while ((rt = eng_run_ticks()) < 2 * bar + 3) {
                int32_t b = eng_next_bar(LEADS[j]), first = (rt / bar + 1) * bar;
                gaps += rt > seen_max + 1;
                seen_max = rt > seen_max ? rt : seen_max;
                bad += b % bar != 0 || b <= rt || eng_samples_to(b) < LEADS[j] || (b != first && b != first + bar) ||
                       (b - bar > rt && eng_samples_to(b - bar) >= LEADS[j]);
                half();
            }
            snprintf(what, sizeof what, "eng_next_bar, %s, lead %u samples: the first bar line far enough ahead from every "
                     "run tick 0..%d (%d wrong, %d ticks skipped)", METER_NAME[METERS[k]], LEADS[j], seen_max, bad, gaps);
            check(what, !bad && !gaps);
        }
    eng_transport(0);
    halves(2);
    check("eng_next_bar: -1 while the transport is stopped", eng_next_bar(0) == -1 && eng_samples_to(96) == 0);

    /* ---- eng_samples_to exact on the internal clock: the tick falls where predicted */
    for (k = 0; k < 3u; k++) {
        int32_t targets[3], n_ok = 0, n_bad = 0, t;
        restart(BPMS[k], 2);
        halves(37);
        targets[0] = eng_run_ticks() + 1;
        targets[1] = eng_run_ticks() + 7;
        targets[2] = eng_next_bar(LEAD);
        for (t = 0; t < 3; t++) {
            uint64_t pred = samples + eng_samples_to(targets[t]), pred0 = pred;
            int32_t fell = -1, bad = 0, guard = 5000;
            eng_tick_mark(targets[t]);
            while (fell < 0 && guard--) {
                uint64_t s0 = samples;
                uint32_t off[8], n, q, in_out = 0;
                int32_t edge;
                bad += samples + eng_samples_to(targets[t]) != pred0;
                half();
                fell = eng_tick_fell(targets[t]);
                if (fell >= 0) {
                    n = eng_clock_out(off, 8, &edge);
                    for (q = 0; q < n; q++)
                        in_out |= off[q] == (uint32_t)fell;
                    bad += s0 + (uint64_t)fell != pred || !in_out || eng_run_ticks() != targets[t] ||
                           eng_samples_to(targets[t]) != 0;
                }
            }
            n_bad += bad || fell < 0;
            n_ok += !bad && fell >= 0;
        }
        eng_tick_mark(-1);
        snprintf(what, sizeof what, "eng_samples_to at %u bpm: ticks +1, +7 and the next bar fall on the predicted sample, "
                 "every half's prediction the same, the clock out's tick there (%d of 3)", BPMS[k], n_ok);
        check(what, n_ok == 3 && !n_bad);
    }

    /* ---- ARMED -> STOPPED on the bar's sample, then the fade-in */
    flat = 1;
    for (k = 0; k < 3u; k++) {
        int32_t b, rt, bad = 0, due_bad = 0;
        uint64_t stop, t, h0;
        uint32_t off[8], n, q, in_out = 0;
        int32_t edge;
        restart(BPMS[k], 2);
        halves(200);
        log_from_now();
        b = eng_next_bar(LEAD);
        stop = samples + eng_samples_to(b);
        pal_fade_arm(b);
        check("armed: ARMED, due = the samples to the bar line", pal_fade_st == PAL_FADE_ARMED && pal_fade_due() == (int32_t)(stop - samples));
        while (!pal_fade_stopped() && samples < stop + 4u * HALF) {
            h0 = samples;
            half();
            if (!pal_fade_stopped())
                due_bad += pal_fade_due() != (int32_t)(stop - samples);
        }
        n = eng_clock_out(off, 8, &edge);
        for (q = 0; q < n; q++)
            in_out |= h0 + off[q] == stop;
        rt = eng_run_ticks();
        for (t = glog0; t < h0 + HALF; t++) {
            int32_t want = t >= stop ? 0 : stop - t >= PAL_FADE_N ? 65536 : (int32_t)((stop - t) * 65536u / PAL_FADE_N);
            bad += glog[t - glog0] != want;
        }
        snprintf(what, sizeof what, "%u bpm: ARMED -> STOPPED in the half of the bar's sample, the 10 ms fade ending on it, "
                 "zero from it on (%d samples off), due right (%d off)", BPMS[k], bad, due_bad);
        check(what, pal_fade_stopped() && !eng_run && stop >= h0 && stop < h0 + HALF && !bad && !due_bad);
        check("the stopping half rendered (its run flag kept), the bar's tick in its clock out, the run tick the bar's",
              last_run == 1 && in_out && rt == b);
        check("gain monotonic, 0 at the bar sample, never above 1", monotonic(glog0, h0 + HALF, 0) && glog[stop - glog0] == 0 &&
              glog[stop - 1u - glog0] > 0 && glog[glog0 + 0u - glog0] == 65536);
        check("the first half after arming has no gain (the lead)", glog[HALF - 1u] == 65536);
        half();
        check("stopped: a silent half, due 0", last_run == 0 && glog[samples - 1u - glog0] == 0 && pal_fade_due() == 0);
        pal_fade_resume();
        check("resumed: the engine runs, FADEIN", eng_run == 1 && pal_fade_st == PAL_FADE_IN && pal_fade_due() == -1);
        h0 = samples;
        half();
        for (t = h0, bad = 0; t < h0 + HALF; t++)
            bad += glog[t - glog0] != (int32_t)((t - h0) * 65536u / PAL_FADEIN_N);
        half();
        for (t = h0 + HALF; t < samples; t++)
            bad += glog[t - glog0] != 65536;
        snprintf(what, sizeof what, "fade-in: 0 -> 1 over the first half, then IDLE at full gain (%d samples off)", bad);
        check(what, !bad && pal_fade_st == PAL_FADE_IDLE && eng_run_ticks() >= b);
    }

    /* ---- the DIAG hard cut (pal_fade_off) */
    {
        int32_t b, bad = 0;
        uint64_t stop, t;
        restart(120, 2);
        halves(50);
        log_from_now();
        pal_fade_off = 1;
        b = eng_next_bar(LEAD);
        stop = samples + eng_samples_to(b);
        pal_fade_arm(b);
        check("pal_fade_off: stops", until_stopped(2000));
        for (t = glog0; t < samples; t++)
            bad += glog[t - glog0] != (t >= stop ? 0 : 65536);
        check("pal_fade_off: no gain, a hard cut on the bar's sample", !bad && eng_run_ticks() == b);
        pal_fade_resume();
        half();
        check("pal_fade_off: no fade-in", glog[samples - HALF - glog0] == 65536 && pal_fade_st == PAL_FADE_IDLE);
        pal_fade_off = 0;
    }

    /* ---- cancel */
    {
        int32_t b, g;
        uint64_t c, t;
        restart(120, 2);
        halves(50);
        log_from_now();
        b = eng_next_bar(LEAD);
        pal_fade_arm(b);
        half();
        pal_fade_cancel();
        half();
        check("cancel before the fade: IDLE at once, no gain, the mark gone", pal_fade_st == PAL_FADE_IDLE && glog[samples - 1u - glog0] == 65536 &&
              monotonic(glog0, samples, 1) && glog[glog0 - glog0] == 65536 && tick_mark == -1);

        log_from_now();
        b = eng_next_bar(LEAD);
        pal_fade_arm(b);
        while (pal_fade_due() >= 300)
            half();
        c = samples;
        g = glog[c - 1u - glog0];
        pal_fade_cancel();
        halves(2);
        check("cancel during the fade: FADEIN, then IDLE", pal_fade_st == PAL_FADE_IDLE && eng_run);
        for (t = c; t < c + HALF && glog[t - glog0] < 65536; t++)
            ;
        snprintf(what, sizeof what, "cancel during the fade (gain %d): back up from the gain reached to 1 within %u samples, "
                 "never under it", g, PAL_FADEIN_N);
        check(what, g > 0 && g < 65536 && monotonic(glog0, c, 0) && monotonic(c, samples, 1) && glog[c - glog0] >= g &&
              t - c <= PAL_FADEIN_N);
        while (eng_run_ticks() <= b)
            half();
        check("cancelled: the bar passes, the engine runs on", eng_run && pal_fade_st == PAL_FADE_IDLE &&
              glog[samples - 1u - glog0] == 65536);

        b = eng_next_bar(LEAD);
        pal_fade_arm(b);
        check("stopped for a cancel", until_stopped(2000));
        pal_fade_cancel();
        check("cancel once stopped: FADEIN, the old engine runs again", eng_run && pal_fade_st == PAL_FADE_IN);
        log_from_now();
        halves(2);
        check("... from 0 up, then IDLE", glog[0] == 0 && monotonic(glog0, samples, 1) && glog[samples - 1u - glog0] == 65536 &&
              pal_fade_st == PAL_FADE_IDLE);
    }

    /* ---- the transport stopping while ARMED: NOW; NOW from a stopped transport; re-arming */
    {
        int32_t b, i0;
        uint64_t h0, t;
        restart(120, 2);
        halves(50);
        b = eng_next_bar(20000);
        pal_fade_arm(b);
        halves(3);
        pal_fade_arm(b + 96);
        check("re-arming a later bar keeps the earlier", pal_fade_bar == b && pal_fade_st == PAL_FADE_ARMED);
        pal_fade_arm(-1);
        check("re-arming NOW while ARMED keeps ARMED", pal_fade_bar == b && pal_fade_st == PAL_FADE_ARMED);
        eng_transport(0);
        log_from_now();
        h0 = samples;
        half();
        check("the transport stopped while ARMED: NOW", pal_fade_st == PAL_FADE_NOW);
        check("... stops", until_stopped(4));
        for (t = glog0, i0 = -1; t < samples; t++)
            if (i0 < 0 && glog[t - glog0] == 0)
                i0 = (int32_t)(t - h0);
        snprintf(what, sizeof what, "... fading over %u samples from the gain reached, 0 from sample %d on", PAL_FADE_NOW_N, i0);
        check(what, i0 == (int32_t)PAL_FADE_NOW_N && monotonic(glog0, samples, 0) && glog[0] == 65536);
        pal_fade_resume();
        halves(2);

        restart(120, 2);
        halves(50);
        log_from_now();
        b = eng_next_bar(LEAD);
        pal_fade_arm(b);
        while (pal_fade_due() >= 300)
            half();
        h0 = samples;
        eng_transport(0);
        check("the transport stopped during the fade: stops", until_stopped(4));
        check("... the gain never rises, 0 at the end, never above 1", monotonic(glog0, samples, 0) && glog[samples - 1u - glog0] == 0 &&
              samples - h0 <= 2u * HALF);
        pal_fade_resume();
        halves(2);

        log_from_now();
        h0 = samples;
        pal_fade_arm(eng_next_bar(LEAD));             /* (stopped: -1, NOW) */
        check("stopped transport: arming is NOW, due 220", pal_fade_st == PAL_FADE_NOW && pal_fade_due() == (int32_t)PAL_FADE_NOW_N);
        check("NOW stops after two halves", until_stopped(2) && samples == h0 + 2u * HALF);
        for (t = h0, i0 = -1; t < samples; t++)
            if (i0 < 0 && glog[t - glog0] == 0)
                i0 = (int32_t)(t - h0);
        check("NOW: from 1 to 0 at sample 220, monotonic", i0 == (int32_t)PAL_FADE_NOW_N && monotonic(glog0, samples, 0) &&
              glog[0] == 65536 && glog[PAL_FADE_NOW_N - 1u] > 0);
        pal_fade_resume();
        halves(2);
    }

    /* ---- MIDI clock in: the stop within a half of the bar's tick */
    {
        int32_t b, ok_stop;
        uint64_t next_tick, tick_at = 0, h0 = 0;
        const uint32_t per = 919;                      /* 120 bpm */
        eng_clock_external(1);
        eng_tempo_global(0);
        eng_transport(0);
        next_tick = samples;
        eng_transport(1);
        while (eng_run_ticks() < 60) {
            while (next_tick < samples + HALF) {
                eng_clock_tick();
                next_tick += per;
            }
            half();
        }
        log_from_now();
        b = eng_next_bar(LEAD);
        tick_at = next_tick + (uint64_t)(b - (eng_run_ticks() + 1 + (int32_t)(clk_ticks - E.clk_seen))) * per;
        pal_fade_arm(b);
        while (!pal_fade_stopped() && samples < glog0 + 120000u) {
            while (next_tick < samples + HALF) {         /* (the ticks that come during the half: this half takes them) */
                eng_clock_tick();
                next_tick += per;
            }
            h0 = samples;
            half();
        }
        /* (whichever first: the estimate, from the last tick's length as the blocks measured it, or the tick) */
        ok_stop = pal_fade_stopped() && h0 + 2u * HALF >= tick_at && h0 <= tick_at + HALF && eng_run_ticks() <= b &&
                  eng_run_ticks() >= b - 1;
        snprintf(what, sizeof what, "MIDI clock in: stopped within a half of the bar's tick (the tick at %lld, the stop's half "
                 "at %lld, run tick %d of %d), the gain monotonic and 0 at the end", (long long)(tick_at - glog0),
                 (long long)(h0 - glog0), eng_run_ticks(), b);
        check(what, ok_stop && monotonic(glog0, samples, 0) && glog[samples - 1u - glog0] == 0);
        pal_fade_resume();
        eng_clock_external(0);
    }

    printf(fails ? "pal fade test: %d FAILED\n" : "pal fade test passed\n", fails);
    return fails ? 1 : 0;
}
