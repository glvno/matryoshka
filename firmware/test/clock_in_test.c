/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock in (D-452, #870, firmware/src/clock_in.h) on the host: a stand-in host sends MIDI clock, Start, Continue,
 * Stop and Song Position at a tempo other than the FM-1's, as a looper does (Reel at a loop's record-to-playback turn:
 * the clock stalls, sends the missed ticks in a burst or not, then Stop / Start or Song Position + Continue). The
 * messages reach clock_in.h at the half buffer they arrive in, the engine renders half buffers as the audio ISR does,
 * and the test checks that the 808 Kit's first Steps track steps on the host's ticks: step k on the host's tick 6k after
 * its Start, tick 0 being the first clock after it (the FM-1's own clock out counts the same, clock_out.h).
 *   tools/clock_in_test.sh */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/engine.c"
#include "../src/presets.h"

#define HALF 128u
static struct {
    uint8_t clock_in;
} cfg = {1};
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

    reset();                                        /* Continue from a Song Position the FM-1 does not follow (#596): it plays on */
    host_start(24, 96);
    host_send(0xFCu, 0, 0);
    host_send(0xF2u, 4, 0);
    host_send(0xFBu, 0, 0);
    host_ticks(48);
    sim_host();
    check("Stop, Song Position 4, Continue: the transport runs on MIDI clock", eng_transport_running() && eng_clock_is_external());

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

    reset();
    cfg.clock_in = 0;                               /* CLOCK IN off: none of it */
    host_start(24, 96);
    check("CLOCK IN off: clock and Start are not followed", !eng_transport_running() && !eng_clock_is_external());
    cfg.clock_in = 1;

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
