/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock in and transport in (D-452, #870, #596, firmware/src/clock_in.h) on the host: a stand-in host sends MIDI
 * clock, Start, Continue, Stop and Song Position at a tempo other than the FM-1's, as a looper does (Reel at a loop's
 * record-to-playback turn: the clock stalls, sends the missed ticks in a burst or not, then Stop / Start or Song Position
 * + Continue). The messages reach clock_in.h at the half buffer they arrive in, the engine renders half buffers as the
 * audio ISR does, and the test checks that the 808 Kit's first Steps track steps on the host's ticks: step k on the host's
 * tick 6k after its Start, tick 0 being the first clock after it (the FM-1's own clock out counts the same,
 * clock_out.h), and after a Song Position n step n on the first clock after its Continue. A Song Position + Continue
 * must land every Steps track (its step, its song entry, its passes) where playing from the top puts it, in a pattern,
 * in songs, in every direction and at every rate. CLOCK IN and TRANSPORT IN work alone and together.
 *   tools/clock_in_test.sh */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/engine.c"
#include "../src/presets.h"

#define HALF 128u
static struct {
    uint8_t clock_in, transport_in;
} cfg = {1, 1};
static volatile uint32_t fm1_ms;
static uint8_t ui_dirty;
static void leds_play(void) {}
#define FM1_TICKS_PER_US 24u
static uint32_t test_ticks(void);                   /* (TIMER4 from the samples rendered, below) */
#define CIN_LOG_NOW() test_ticks()
#include "../src/clock_in.h"

static int fails;
static void check(const char *what, int ok)
{
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok)
        fails++;
}

/* the host's messages, each at its sample; pos: where the host's playhead is once it is delivered (-9: as the messages say,
 * for a host whose playhead does not follow its own messages: a looper's relocation sent early, clocks that do not move it) */
#define EVN 20000
static struct {
    double at;
    uint32_t pkt;
    int pos;
} ev[EVN];
static int ev_w, ev_r;
static double host_t;                               /* the host's time (samples) */
static double host_per;                             /* samples a tick */
static void host_send_pos(uint32_t b, uint32_t d1, uint32_t d2, int pos)
{
    if (ev_w < EVN) {
        ev[ev_w].at = host_t;
        ev[ev_w].pkt = (b == 0xF2u ? 3u : 0xFu) | b << 8 | d1 << 16 | d2 << 24;
        ev[ev_w].pos = pos;
        ev_w++;
    }
}
static void host_send(uint32_t b, uint32_t d1, uint32_t d2) { host_send_pos(b, d1, d2, -9); }
static void host_tempo(double bpm) { host_per = 60.0 * ENG_SR / (bpm * 24.0); }
static void host_ticks(int n)                       /* n ticks, one a period, the first now */
{
    int k;
    for (k = 0; k < n; k++) {
        host_send(0xF8u, 0, 0);
        host_t += host_per;
    }
}
static void host_wait_ms(double ms) { host_t += ms * ENG_SR / 1000.0; }

/* the FM-1: the host's tick count since its Start (-1 before the first: the next tick is tick 0), as delivered */
static uint64_t samples;
static uint32_t test_ticks(void) { return (uint32_t)(samples * 24000000u / ENG_SR); }
static int host_m = -1, host_run;
static int trk_mod, trk_len = 16;
static int last_pos = -1;
#define LOGN 4096
static int log_m[LOGN], log_pos[LOGN], log_n;       /* each step the track took, and the host's tick then */
static void deliver(uint32_t pkt, int pos)
{
    uint32_t b = (pkt >> 8) & 0xFFu;
    if (b == 0xFAu) {
        host_run = 1;
        host_m = -1;
    } else if (b == 0xFBu) {
        host_run = 1;
    } else if (b == 0xFCu) {
        host_run = 0;
    } else if (b == 0xF2u) {
        host_m = (int)(((pkt >> 16) & 0x7Fu) | ((pkt >> 24) & 0x7Fu) << 7) * 6 - 1;
    } else if (b == 0xF8u && host_run) {
        host_m++;
    }
    if (pos != -9)
        host_m = pos;
    clk_in_rt(pkt);
}
static void sim_to(double t)
{
    static int32_t l[HALF], r[HALF];
    while ((double)samples < t) {
        fm1_ms = (uint32_t)(samples * 1000u / ENG_SR);
        while (ev_r < ev_w && ev[ev_r].at <= (double)samples)
            deliver(ev[ev_r].pkt, ev[ev_r].pos), ev_r++;
        clk_in_idle();
        eng_render(l, r, HALF);
        samples += HALF;
        {
            int p = eng_steps_pos((uint32_t)trk_mod);
            if (p != last_pos && p >= 0 && log_n < LOGN) {
                log_m[log_n] = host_m;
                log_pos[log_n] = p;
                log_n++;
            }
            last_pos = p;
        }
    }
}
static void sim_host(void) { sim_to(host_t); }

/* the steps taken since log entry `from`: how many were off the host's ticks, and the first one's error in ticks */
static int off_steps(int from, int *err)
{
    int i, bad = 0, span = 6 * trk_len;
    *err = 0;
    for (i = from; i < log_n; i++) {
        int e = ((log_m[i] - 6 * log_pos[i]) % span + span) % span;
        if (e >= span / 2)
            e -= span;
        if (e && !bad++)
            *err = e;
    }
    return bad;
}
static char what[200];
static void expect_in_step(const char *name, int from, int min_steps)
{
    int err, bad = off_steps(from, &err);
    snprintf(what, sizeof what, "%s: %d steps, %d off the host's ticks (the first by %d ticks)", name, log_n - from, bad, err);
    check(what, bad == 0 && log_n - from >= min_steps);
}
/* a case known to fail (Reel's loop point, #870: which sequence Reel sends is not known yet): "xfail" while it fails with
 * the error given, which does not count; "XPASS" when it passes, which does count, so the case is moved to expect_in_step */
static void expect_in_step_xfail(const char *name, int from, int min_steps, int known_err)
{
    int err, bad = off_steps(from, &err);
    int ok = bad == 0 && log_n - from >= min_steps;
    printf("%s %s: %d steps, %d off the host's ticks (the first by %d ticks; known: %d)\n", ok ? "XPASS" : "xfail", name,
           log_n - from, bad, err, known_err);
    if (ok)
        fails++;
    else if (err != known_err)
        check("  (an xfail case fails by another error than it is known for)", 0);
}

/* a fresh start: stopped, the clock let go, the 808 Kit at 120 bpm */
static void reset(void)
{
    host_send(0xFCu, 0, 0);
    host_wait_ms(1200);
    sim_host();
    check("  (stopped, MIDI clock let go)", !eng_transport_running() && !eng_clock_is_external());
}

static int factory_load(const char *name)
{
    static uint8_t bin[4096];
    uint32_t k;
    for (k = 0; k < N_PRESETS && strcmp(PRESET_LIST[k].name, name); k++)
        ;
    if (k == N_PRESETS || lz_unpack(PRESET_LIST[k].lz, PRESET_LIST[k].lz_len, bin, sizeof bin) != (int32_t)PRESET_LIST[k].len)
        return -1;
    return eng_load(bin, PRESET_LIST[k].len) ? -1 : 0;
}

/* the host plays: some clock first (Reel's Send clock), Start with the first tick, `ticks` ticks */
static int host_start(int preroll, int ticks)
{
    int from;
    host_ticks(preroll);
    sim_host();
    from = log_n;
    host_send(0xFAu, 0, 0);
    host_ticks(ticks);
    sim_host();
    return from;
}

/* (#596) every Steps track's state after a Song Position + Continue, against the same tick reached by playing from the
 * top: its step, visit, times round the pattern (from 0 at the start: the test sets it), passes, half ticks, song entry and
 * pattern. One MIDI clock a half buffer, so both runs measure the same samples a tick */
#define FF_TRK 16
typedef struct { int32_t pos, visit, count, half, spos, pat; uint32_t loop, pass; } ff_st;
static const int FF_AT[] = {1, 2, 3, 5, 7, 15, 16, 17, 31, 33, 63, 64, 65, 100, 127, 128, 129, 255, 256, 257, 1000, 4095,
                            4096, 9999, 16383};
#define FF_N ((int)(sizeof FF_AT / sizeof FF_AT[0]))
static void ff_get(ff_st *s)
{
    int k;
    for (k = 0; k < eng_steps_count() && k < FF_TRK; k++) {
        int mod = eng_steps_module((uint32_t)k);
        const inst_t *it = &inst_pool[E.node[mod].inst0];
        uint32_t t = E.node[mod].trk;
        s[k].pos = it->s.stp.pos;
        s[k].visit = it->s.stp.visit;
        s[k].count = it->s.stp.count;
        s[k].half = it->s.stp.half;
        s[k].spos = E.trk_spos[t];
        s[k].pat = E.trk_pat[t];
        s[k].loop = it->s.stp.loop;
        s[k].pass = it->s.stp.pass;
    }
}
static void ff_loops0(void)
{
    int k;
    for (k = 0; k < eng_steps_count(); k++)
        inst_pool[E.node[eng_steps_module((uint32_t)k)].inst0].s.stp.loop = 0;
}
static void ff_send(uint32_t b, uint32_t d1, uint32_t d2) { clk_in_rt((b == 0xF2u ? 3u : 0xFu) | b << 8 | d1 << 16 | d2 << 24); }
static void ff_clock(void)
{
    static int32_t l[HALF], r[HALF];
    ff_send(0xF8u, 0, 0);
    fm1_ms = (uint32_t)(samples * 1000u / ENG_SR);
    clk_in_idle();
    eng_render(l, r, HALF);
    samples += HALF;
}
static void ff_landing(int i)                       /* Stop, then Song Position FF_AT[i] + Continue and its clock */
{
    ff_send(0xFCu, 0, 0);
    ff_clock();
    ff_clock();
    ff_loops0();
    ff_send(0xF2u, (uint32_t)FF_AT[i] & 0x7Fu, (uint32_t)FF_AT[i] >> 7);
    ff_send(0xFBu, 0, 0);
    ff_clock();
}
static void ff_suite(const char *name, int npos)   /* (the first npos of FF_AT) */
{
    static ff_st want[FF_N][FF_TRK], got[FF_TRK];
    int i, k, t, n = eng_steps_count() < FF_TRK ? eng_steps_count() : FF_TRK, bad = 0, bad_at = -1, bad_k = -1;
    ff_send(0xFCu, 0, 0);
    for (k = 0; k < 4; k++)
        ff_clock();
    ff_loops0();
    ff_send(0xFAu, 0, 0);
    ff_clock();                                     /* (tick 0) */
    for (t = 1, i = 0; i < npos; t++) {
        ff_clock();
        if (t == 6 * FF_AT[i])
            ff_get(want[i++]);
    }
    for (i = 0; i < npos; i++) {
        ff_landing(i);
        ff_get(got);
        for (k = 0; k < n; k++)
            if (memcmp(&got[k], &want[i][k], sizeof got[k]) && !bad++) {
                bad_at = i;
                bad_k = k;
            }
    }
    snprintf(what, sizeof what, "%s: Song Position + Continue lands the track where playing from the top puts it, at %d "
             "positions up to %d (%d off)", name, npos, FF_AT[npos - 1], bad);
    check(what, bad == 0 && n > 0);
    if (bad) {
        const ff_st *w = &want[bad_at][bad_k], *g = &got[bad_k];
        ff_landing(bad_at);
        ff_get(got);
        printf("      (the first at Song Position %d, track %d: pos %d / %d, visit %d / %d, count %d / %d, half %d / %d, entry %d / %d, "
               "pattern %d / %d, loop %u / %u, pass %u / %u: Song Position / from the top)\n", FF_AT[bad_at], bad_k, g->pos, w->pos,
               g->visit, w->visit, g->count, w->count, g->half, w->half, g->spos, w->spos, g->pat, w->pat, g->loop, w->loop, g->pass, w->pass);
    }
    ff_send(0xFCu, 0, 0);
    ff_clock();
}

int main(void)
{
    int from, mid, k;
    check("the 808 Kit loads", factory_load("808 KIT") == 0);
    eng_set_param((uint32_t)eng_find(T_FM1), FM1_P_TEMPO, 120 << 16);
    trk_mod = eng_steps_module(0);
    check("  it has a Steps track", trk_mod >= 0);
    host_tempo(90);

    reset();
    from = host_start(24, 96 * 4);
    expect_in_step("90 bpm, Start with a tick: the steps on the host's ticks over four bars", from, 60);
    for (k = from; k < log_n; k++)
        if (log_pos[k] + 1 > trk_len)
            trk_len = log_pos[k] + 1;

    reset();
    host_tempo(150);
    from = host_start(0, 96 * 2);
    expect_in_step("150 bpm, clock only from Start on", from, 30);
    host_tempo(90);

    reset();
    host_ticks(24);
    sim_host();
    from = log_n;
    host_send(0xFAu, 0, 0);
    host_t += host_per / 2;                         /* the first tick half a tick after Start */
    host_ticks(96 * 2);
    sim_host();
    expect_in_step("Start, then the first tick half a tick later", from, 30);

    {   /* no clock before Start, its first clock a whole tick after it (the 1.21.0 qualification's host): the tracks start
         * on that clock, at a host tempo below and above the FM-1's own 120 */
        static const int bpm[] = {90, 150};
        for (k = 0; k < 2; k++) {
            reset();
            host_tempo(bpm[k]);
            from = log_n;
            host_send(0xFAu, 0, 0);
            host_t += host_per;
            host_ticks(96 * 2);
            sim_host();
            snprintf(what, sizeof what, "%d bpm, no clock before Start, the first a tick after it", bpm[k]);
            expect_in_step(what, from, 30);
        }
        host_tempo(90);
    }

    {   /* (a) the clock stalls and goes on where it was (the host's tape paused too), (b) the missed ticks in a burst */
        static const int ms[] = {120, 300, 480, 800, 2000};
        for (k = 0; k < 5; k++) {
            int burst;
            for (burst = 0; burst < 2; burst++) {
                reset();
                host_start(24, 96 + 40);
                host_wait_ms(ms[k]);
                if (burst) {
                    int n = (int)(ms[k] * ENG_SR / 1000.0 / host_per);
                    double keep = host_per;
                    host_per = 0;
                    host_ticks(n);
                    host_per = keep;
                    sim_to(host_t + HALF);          /* (the burst's own half: several steps at once, judged after it) */
                }
                mid = log_n;
                host_ticks(96 * 2);
                sim_host();
                snprintf(what, sizeof what, "a %d ms stall, then %s", ms[k], burst ? "the missed ticks at once" : "the clock goes on");
                expect_in_step(what, mid, 28);
            }
        }
    }

    {   /* (c) at a loop's end (two bars) the host starts again from its top: Stop + Start, Start alone, Stop + Song Position 0
         * + Continue, Song Position 0 + Continue while running; and the same after a 700 ms stall */
        static const char *how[] = {"Stop and Start", "Start alone", "Stop, Song Position 0, Continue", "Song Position 0, Continue"};
        int stall;
        for (stall = 0; stall < 2; stall++)
            for (k = 0; k < 4; k++) {
                reset();
                host_start(24, 96 * 2 - 10);        /* (the pattern ends 10 ticks short of a bar line: the top is not the next step) */
                if (stall)
                    host_wait_ms(700);
                if (k == 0 || k == 2)
                    host_send(0xFCu, 0, 0);
                if (k == 2 || k == 3)
                    host_send(0xF2u, 0, 0);
                host_send(k < 2 ? 0xFAu : 0xFBu, 0, 0);
                sim_to(host_t + 1);
                mid = log_n;
                host_ticks(96 * 2);
                sim_host();
                snprintf(what, sizeof what, "%sthe host from its top again with %s", stall ? "a 700 ms stall, then " : "", how[k]);
                expect_in_step(what, mid, 30);
            }
    }

    {   /* Reel's loop point (#870, the owner's 1.21.0 check: the FM-1 a sixteenth ahead of Reel after each loop, whatever the
         * tempo or the loop's length). The sequences that give the FM-1 a sixteenth ahead, until a capture (DIAG 145..147,
         * tools/m1_link.py midilog) says which one Reel sends: (a) the relocation one sixteenth (6 clocks) before the loop
         * point, the playhead going on to the loop's end; (b) 6 clocks at the loop point that do not move the playhead. And
         * one that is fixed: (c) a clock in the same block just before a Start is the old run's, not the new one's tick 0 */
        static const char *how[] = {"Start a sixteenth before the loop point", "Song Position 0 + Continue a sixteenth before the loop point",
                                    "Start and the loop's first clock, then 6 clocks at once that do not move the playhead",
                                    "a loop a sixteenth longer in clocks, nothing else sent",
                                    "the old loop's last clock and Start in one block, then the first clock"};
        static const int known[] = {-6, -6, -6, -6};
        for (k = 0; k < 5; k++) {
            int j;
            reset();
            host_start(24, 96 * 2 - (k < 2 ? 6 : k == 4 ? 1 : 0));
            if (k == 0)
                host_send(0xFAu, 0, 0);
            if (k == 1)
                host_send(0xF2u, 0, 0), host_send(0xFBu, 0, 0);
            for (j = 0; j < (k < 2 ? 6 : k == 3 ? 6 : 0); j++) {   /* the old loop's last clocks, the playhead on to its end */
                host_send_pos(0xF8u, 0, 0, 96 * 2 - (k < 2 ? 6 : 0) + j);
                host_t += host_per;
            }
            if (k == 4) {
                host_send_pos(0xF8u, 0, 0, 96 * 2 - 1);
                host_send(0xFAu, 0, 0);
                host_t += host_per;
            }
            if (k == 2)
                host_send(0xFAu, 0, 0);
            host_send_pos(0xF8u, 0, 0, 0);       /* the loop's first clock: the playhead at its start */
            host_t += host_per;
            if (k == 2)
                for (j = 0; j < 6; j++)
                    host_send_pos(0xF8u, 0, 0, 0);
            sim_to(host_t + (k == 2 ? HALF + 1 : 0));   /* (the burst's own half: several steps at once, judged after it) */
            mid = log_n;
            host_ticks(96 * 2);
            sim_host();
            if (k == 4)
                expect_in_step(how[k], mid, 30);
            else
                expect_in_step_xfail(how[k], mid, 30, known[k]);
        }
    }

    {   /* (d) Song Position + Continue (#596): the tracks play from the position, its step on the next clock; after a Stop,
         * and while running (a looper relocating at its loop point, as Reel may), with a 700 ms stall before it or not */
        static const int spp[] = {4, 5, 37, 300, 16383};
        int stall, run;
        for (run = 0; run < 2; run++)
            for (stall = 0; stall < 2; stall++)
                for (k = 0; k < 5; k++) {
                    reset();
                    host_start(24, 96 + 17);        /* (mid-step, mid-bar) */
                    if (stall)
                        host_wait_ms(700);
                    if (!run)
                        host_send(0xFCu, 0, 0);
                    host_send(0xF2u, (uint32_t)spp[k] & 0x7Fu, (uint32_t)spp[k] >> 7);
                    host_send(0xFBu, 0, 0);
                    sim_to(host_t + 1);
                    host_ticks(1);
                    sim_host();
                    snprintf(what, sizeof what, "%s%s, Song Position %d, Continue: step %d on the first clock", stall ? "a 700 ms stall, " : "",
                             run ? "running" : "Stop", spp[k], spp[k] % trk_len);
                    check(what, eng_steps_pos((uint32_t)trk_mod) == spp[k] % trk_len && eng_run_ticks() == 6 * spp[k]);
                    mid = log_n;
                    host_ticks(96 * 2);
                    sim_host();
                    expect_in_step("  and on from there", mid, 30);
                }
    }
    check("(the 808 Kit's first track is 16 steps at 1/16)", trk_len == 16);

    {   /* the track lands where playing from the top puts it (#596): the 808 Kit's pattern, its song, then a song of
         * patterns with their own lengths and rates, in every direction, with the track at other lengths and rates */
        uint32_t mod = (uint32_t)trk_mod, p, c;
        static const uint8_t SHAPE[4][2] = {{16, 4}, {7, 1}, {12, 3}, {5, 0}};   /* (steps, the track's rate: 1/16 at most) */
        static const char *const SHAPE_NAME[4] = {"16 steps at 1/16", "7 steps at 1/4T", "12 steps at 1/8T", "5 steps at 1/4"};
        static const char *const DIR_NAME[4] = {"forward", "backward", "ping-pong", "random"};
        static const uint8_t P[] = {0, 1, 1, 2, 0, 3, 2};
        ff_suite("the 808 Kit's pattern", FF_N);
        check("  (the 808 Kit has a song)", eng_song_len(0) > 1);
        eng_song_set(1);
        ff_suite("the 808 Kit's song", FF_N);
        eng_song_set(0);
        for (p = 1; p <= 3u; p++) {                 /* patterns 2..4: made by a step set on each (stopped: it plays at once) */
            eng_pattern_set(p);
            ff_clock();
            eng_steps_toggle(mod, p, 60, 100);
        }
        eng_pattern_set(0);
        ff_clock();
        check("  (patterns 2..4 made: pattern 2 has 12 steps at 1/64 of its own, pattern 3 5 steps, pattern 4 the rate 1/2)",
              eng_pattern_has(mod, 1) && eng_pattern_has(mod, 2) && eng_pattern_has(mod, 3) && eng_pattern_shape(mod, 1, 12, 8) == 0
              && eng_pattern_shape(mod, 2, 5, 0xFFu) == 0 && eng_pattern_shape(mod, 3, 0, 7) == 0);
        while (eng_song_len(2) > 0)
            (void)eng_song_delete(2, 0);
        for (p = 0; p < sizeof P; p++)
            (void)eng_song_put(2, p, P[p], (int32_t)p - 3);
        eng_song_set(3);
        for (c = 0; c < 17u; c++) {                 /* song 3 (patterns 1, 2, 2, 3, 1, 4, 3): every direction, four shapes; */
            char name[160];                         /* then the pattern alone, random, 12 steps at 1/8T */
            uint32_t d = c < 16u ? c / 4u : 3u, s = c < 16u ? c % 4u : 2u;
            eng_set_param(mod, STEPS_P_DIR, (int32_t)(d << 16));
            eng_set_param(mod, STEPS_P_LEN, (int32_t)((uint32_t)SHAPE[s][0] << 16));
            eng_set_param(mod, STEPS_P_RATE, (int32_t)((uint32_t)SHAPE[s][1] << 16));
            if (c == 16u)
                eng_song_set(0);
            snprintf(name, sizeof name, "%s, %s, the track %s", c < 16u ? "song 3 of patterns with their own lengths and rates"
                     : "the pattern alone", DIR_NAME[d], SHAPE_NAME[s]);
            ff_suite(name, c == 7u || c == 13u || c == 16u ? FF_N : 21);   /* (three of them up to 16383, the rest up to 1000) */
        }
        check("the 808 Kit loads again", factory_load("808 KIT") == 0);
        eng_set_param((uint32_t)eng_find(T_FM1), FM1_P_TEMPO, 120 << 16);
        trk_mod = eng_steps_module(0);
        last_pos = -1;
        host_t = (double)samples;                   /* (the suites rendered without the host: its time goes on from here) */
    }

    reset();                                        /* the host goes away while the transport runs: the FM-1 waits for it */
    host_start(24, 96);
    host_wait_ms(3000);
    sim_host();
    check("no clock for 3 s while the transport runs: still on MIDI clock, waiting", eng_transport_running() && eng_clock_is_external());
    {
        int p = eng_steps_pos((uint32_t)trk_mod);
        host_wait_ms(1000);
        sim_host();
        check("  and the steps wait with it", eng_steps_pos((uint32_t)trk_mod) == p);
    }
    eng_transport(0);                               /* PLAY stops it (panel.c) */
    host_wait_ms(100);
    sim_host();
    check("PLAY stops it: the FM-1's own tempo again at once", !eng_clock_is_external());

    reset();                                        /* clock without Start: the tempo follows, half a second after the last
                                                     * tick the FM-1's own again (D-452) */
    host_ticks(48);
    sim_host();
    check("clock while stopped: MIDI clock drives the tempo", eng_clock_is_external() && !eng_transport_running());
    host_wait_ms(400);
    sim_host();
    check("  0.4 s after the last tick: still", eng_clock_is_external());
    host_wait_ms(200);
    sim_host();
    check("  0.6 s after: the FM-1's own tempo again", !eng_clock_is_external());

    reset();                                        /* Start with no clock (a host sending its transport only): after 150 ms
                                                     * waiting for a first clock, the FM-1's own tempo (120 bpm: a sixteenth
                                                     * 125 ms) */
    from = log_n;
    host_send(0xFAu, 0, 0);
    host_wait_ms(140);
    sim_host();
    check("Start with no clock: 140 ms on, still waiting for a first clock", eng_run_ticks() < 0 && log_n == from);
    host_wait_ms(860);
    sim_host();
    snprintf(what, sizeof what, "  then the FM-1's own tempo (%d steps in the second's last 850 ms)", log_n - from);
    check(what, eng_run_ticks() >= 0 && !eng_clock_is_external() && log_n - from >= 7 && log_n - from <= 8);

    reset();                                        /* CLOCK IN and TRANSPORT IN (#596): each alone, both off */
    cfg.transport_in = 0;
    host_start(24, 96);
    check("TRANSPORT IN off: the clock is followed, Start is not", !eng_transport_running() && eng_clock_is_external());
    eng_transport(1);                               /* (PLAY: the FM-1's own transport, on the host's clock) */
    host_ticks(1);
    sim_host();
    mid = log_n;
    host_ticks(96);
    sim_host();
    check("  PLAY starts it on the host's next clock, and it runs on the host's tempo", eng_transport_running() && eng_clock_is_external()
          && eng_run_ticks() == 96 && log_n - mid >= 15);
    host_send(0xFCu, 0, 0);
    host_ticks(24);
    sim_host();
    check("  the host's Stop is not followed either", eng_transport_running());
    eng_transport(0);
    cfg.transport_in = 1;

    reset();
    cfg.clock_in = 0;
    host_start(24, 0);
    host_wait_ms(10);
    sim_host();
    check("CLOCK IN off: Start is followed at once, on the FM-1's own tempo", eng_transport_running() && eng_run_ticks() >= 0
          && !eng_clock_is_external());
    host_ticks(96);
    sim_host();
    check("  the host's clock is not", !eng_clock_is_external());
    host_send(0xFCu, 0, 0);
    host_send(0xF2u, 37, 0);
    host_send(0xFBu, 0, 0);
    host_wait_ms(10);                               /* (a block stopped, then the start: less than a tick at 120 bpm) */
    sim_host();
    snprintf(what, sizeof what, "  Song Position 37 + Continue: from there at once, step 5 of 16 (run ticks %d, step %d)",
             eng_run_ticks(), eng_steps_pos((uint32_t)trk_mod));
    check(what, eng_transport_running() && eng_run_ticks() == 222 && eng_steps_pos((uint32_t)trk_mod) == 37 % 16);
    host_send(0xFCu, 0, 0);
    host_wait_ms(10);
    sim_host();
    check("  Stop is followed", !eng_transport_running());

    reset();
    cfg.transport_in = 0;                           /* (CLOCK IN still off) */
    host_start(24, 96);
    check("CLOCK IN and TRANSPORT IN off: neither clock nor Start is followed", !eng_transport_running() && !eng_clock_is_external());
    cfg.clock_in = 1;
    cfg.transport_in = 1;

    {   /* the log (DIAG 145..147, tools/m1_link.py midilog): what came in, in order, with its time and the engine's state;
         * steady clocks folded into one entry, an irregular one its own; frozen CIN_LOG_AFTER messages after a Stop,
         * running again with a Start; the newest CIN_LOG_N entries kept */
        uint8_t o[32];
        uint32_t h[8], n, i, k2, ok, clocks, stall_seen = 0;
        cin_ent_t got[CIN_LOG_N];
        reset();
        cin_log_diag(147u, o);
        host_send(0xF2u, 3, 0);
        host_send(0xFAu, 0, 0);
        host_ticks(20);
        host_wait_ms(100);                          /* (a stall: the next clock comes late, in an entry of its own) */
        host_ticks(10);
        host_send(0xFCu, 0, 0);
        host_ticks(100);                            /* (clock while stopped: 64 of it logged, then the log waits) */
        sim_host();
#define READ_LOG()                                                                                                     \
        do {                                                                                                           \
            cin_log_diag(145u, o);                                                                                     \
            for (i = 0; i < 8u; i++)                                                                                   \
                h[i] = (uint32_t)o[4 * i] | (uint32_t)o[4 * i + 1] << 8 | (uint32_t)o[4 * i + 2] << 16 | (uint32_t)o[4 * i + 3] << 24; \
            for (n = 0; n < h[2]; n += 4u) {                                                                           \
                cin_log_diag(146u, o);                                                                                 \
                for (i = 0; i < 4u && n + i < CIN_LOG_N; i++) {                                                        \
                    const uint8_t *p = o + 8u * i;                                                                     \
                    got[n + i].us = (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; \
                    got[n + i].v = (uint16_t)(p[4] | p[5] << 8);                                                       \
                    got[n + i].st = p[6];                                                                              \
                    got[n + i].fl = p[7];                                                                              \
                }                                                                                                      \
            }                                                                                                          \
        } while (0)
        READ_LOG();
        snprintf(what, sizeof what, "the MIDI log: %u messages (want 97: Song Position, Start, 30 clocks, Stop, 64 clocks) in %u entries, frozen %u",
                 h[0], h[2], h[3]);
        check(what, h[0] == 97u && h[3] == 1u && h[1] == CIN_LOG_N && h[2] < 16u);
        ok = got[0].st == 0xF2u && got[0].v == 3u && got[1].st == 0xFAu;
        for (i = 2, clocks = 0; i < h[2] && got[i].st == 0xF8u; i++) {
            clocks += 1u + (got[i].fl >> 3);
            if (i > 2u && got[i].us - got[i - 1u].us > 120000u)   /* (100 ms + a tick after the run's last clock) */
                stall_seen = 1;
        }
        ok &= clocks == 30u && i < h[2] && got[i].st == 0xFCu;
        for (k2 = i + 1u, clocks = 0; k2 < h[2]; k2++)
            clocks += got[k2].st == 0xF8u ? 1u + (got[k2].fl >> 3) : 0u;
        check("  in order: Song Position 3, Start, 30 clocks, Stop, 64 clocks; steady ones folded", ok && clocks == 64u);
        check("  the clock after the stall in an entry of its own; the transport seen running on MIDI clock",
              stall_seen && (got[3].fl & 7u) == 7u);
        host_send(0xFAu, 0, 0);                     /* a Start: logging again */
        host_ticks(5);
        sim_host();
        READ_LOG();
        check("  a Start after it: the log runs again (103 messages)", h[0] == 103u && h[3] == 0u);
        for (k2 = 0; k2 < 300u; k2++) {             /* irregular clocks: none folds, the ring goes round */
            host_ticks(1);
            if (k2 & 1u)
                host_wait_ms(15);
        }
        sim_host();
        READ_LOG();
        for (i = 1, ok = 1; i < h[2]; i++)
            ok &= got[i].us > got[i - 1u].us;
        snprintf(what, sizeof what, "  300 irregular clocks: the newest %u entries kept, oldest to newest (%u messages)", h[2], h[0]);
        check(what, h[0] == 403u && h[2] == CIN_LOG_N && ok && got[CIN_LOG_N - 1].st == 0xF8u);
        cin_log_diag(147u, o);
        READ_LOG();
        check("  DIAG 147 empties it", h[0] == 0u && h[2] == 0u);
    }

    printf(fails ? "%d FAILED\n" : "all passed\n", fails);
    return fails != 0;
}
