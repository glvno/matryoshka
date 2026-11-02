/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock out (#473, firmware/src/clock_out.h) on the host: the engine renders half buffers as the audio ISR does, the
 * 2 kHz timer hands the bytes on, and the test counts and times the ticks against the tempo: several tempos, a tempo
 * change mid-run, the global tempo against the patch's, Start / Stop with PLAY, MIDI clock in (no clock out while it
 * drives, the FM-1's own again after its timeout), CLOCK OUT off, MIDI OUT off, a host that stops reading.
 *   tools/clock_out_test.sh */
#include <stdio.h>
#include <stdlib.h>
#include "../src/engine.c"
#include "../src/presets.h"

#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#define FM1_TICKS_PER_US 24u
#define HALF 128u
static struct {
    uint8_t midi_out, clock_out;
} cfg = {1, 1};

/* usb.c's MIDI out ring: a host that reads (`reading`) takes every packet at once; the log keeps each byte and its time */
#define MQ 64u
static uint32_t mo_w, mo_r;
static int reading = 1;
static uint32_t now_t;                              /* the simulated TIMER4 (24 MHz) */
#define LOGN 200000
static uint8_t log_b[LOGN];
static uint32_t log_t[LOGN];
static int log_n;
static void midi_out_event(uint32_t pkt)
{
    if (mo_w - mo_r < MQ)
        mo_w++;
    if (log_n < LOGN) {
        log_b[log_n] = (uint8_t)(pkt >> 8);
        log_t[log_n] = now_t;
        log_n++;
    }
}
#include "../src/clock_out.h"

static int fails;
static void check(const char *what, int ok)
{
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok)
        fails++;
}

static int32_t l[HALF], r[HALF];
static uint64_t samples;                            /* samples rendered so far */
static int run_engine = 1;

/* `ms` of audio: a half buffer at a time as the ISR does (its start at the sample clock's time, plus a little jitter of
 * its own as on the device), the timer at 2 kHz between */
static void play_ms(uint32_t ms)
{
    uint64_t end = samples + (uint64_t)ms * ENG_SR / 1000u;
    static uint32_t next_poll;
    while (samples < end) {
        uint32_t t0 = (uint32_t)(samples * 1000000u / ENG_SR * FM1_TICKS_PER_US), t_next;
        now_t = t0 + (uint32_t)(rand() % 20) * FM1_TICKS_PER_US;   /* the ISR starts up to 20 us late */
        if (run_engine)
            eng_render(l, r, HALF);
        clk_out_block(now_t, run_engine);
        samples += HALF;
        t_next = (uint32_t)(samples * 1000000u / ENG_SR * FM1_TICKS_PER_US);
        while ((int32_t)(next_poll - t_next) < 0) {
            now_t = next_poll;
            clk_out_poll(now_t);
            if (reading)
                mo_r = mo_w;
            next_poll += 500u * FM1_TICKS_PER_US;
        }
    }
}

static int count(int from, uint8_t b)
{
    int i, n = 0;
    for (i = from; i < log_n; i++)
        n += log_b[i] == b;
    return n;
}
static int first(int from, uint8_t b)
{
    int i;
    for (i = from; i < log_n; i++)
        if (log_b[i] == b)
            return i;
    return -1;
}
/* the ticks since `from`: their mean period and the largest deviation of a period from it, in us */
static void periods(int from, double *mean, double *dev)
{
    int i, prev = -1, n = 0;
    double sum = 0, worst = 0;
    for (i = from; i < log_n; i++)
        if (log_b[i] == 0xF8u) {
            if (prev >= 0) {
                sum += (double)(uint32_t)(log_t[i] - log_t[prev]) / FM1_TICKS_PER_US;
                n++;
            }
            prev = i;
        }
    *mean = n ? sum / n : 0;
    prev = -1;
    for (i = from; i < log_n; i++)
        if (log_b[i] == 0xF8u) {
            if (prev >= 0) {
                double d = (double)(uint32_t)(log_t[i] - log_t[prev]) / FM1_TICKS_PER_US - *mean;
                if (d < 0)
                    d = -d;
                if (d > worst)
                    worst = d;
            }
            prev = i;
        }
    *dev = worst;
}
static int load_factory(void)
{
    uint32_t k;
    for (k = 0; k < N_PRESETS; k++)
        if (eng_load(PRESET_LIST[k].data, PRESET_LIST[k].len) == 0 && eng_find(T_FM1) >= 0)
            return (int)k;
    return -1;
}
static void set_tempo(uint32_t bpm) { eng_set_param((uint32_t)eng_find(T_FM1), FM1_P_TEMPO, (int32_t)(bpm << 16)); }
/* PLAY as panel.c play_toggle does it: the request, then the transport */
static void play(int run)
{
    clk_out_play(run ? 0xFAu : 0xFCu);
    eng_transport(run);
}

int main(void)
{
    static const uint32_t TEMPOS[] = {20, 60, 120, 133, 174, 300};
    uint32_t k;
    int at;
    double mean, dev;
    char what[160];
    check("a factory patch with Main loads", load_factory() >= 0);
    eng_tempo_global(0);                            /* TEMPO: PATCH */

    for (k = 0; k < sizeof TEMPOS / sizeof TEMPOS[0]; k++) {   /* stopped: the clock goes out all the time, at the tempo */
        uint32_t bpm = TEMPOS[k], secs = bpm < 60u ? 12u : 6u, want = bpm * 24u * secs / 60u;
        int n;
        set_tempo(bpm);
        play_ms(500);
        at = log_n;
        play_ms(secs * 1000u);
        n = count(at, 0xF8u);
        periods(at, &mean, &dev);
        snprintf(what, sizeof what, "%u bpm, stopped: %d ticks in %u s (want %u +-1), period %.1f us (want %.1f), "
                 "largest deviation %.0f us", bpm, n, secs, want, mean, 60e6 / (bpm * 24.0), dev);
        check(what, abs(n - (int)want) <= 1 && mean > 60e6 / (bpm * 24.0) - 30.0 && mean < 60e6 / (bpm * 24.0) + 30.0
              && dev <= 520.0);
    }

    set_tempo(120);                                 /* a tempo change mid-run */
    play_ms(500);
    at = log_n;
    play_ms(2000);
    set_tempo(180);
    play_ms(2000);
    snprintf(what, sizeof what, "120 then 180 bpm, 2 s each: %d ticks (want %d +-2)", count(at, 0xF8u), 96 + 144);
    check(what, abs(count(at, 0xF8u) - 240) <= 2);
    periods(log_n - 30, &mean, &dev);
    check("after the change the period is 180 bpm's", mean > 13888.9 - 30 && mean < 13888.9 + 30);

    eng_tempo_global(140);                          /* TEMPO: GLOBAL at 140; the patch keeps its own (180) */
    play_ms(300);
    at = log_n;
    play_ms(3000);
    snprintf(what, sizeof what, "the global tempo (140) over the patch's (180): %d ticks in 3 s (want 168 +-1)", count(at, 0xF8u));
    check(what, abs(count(at, 0xF8u) - 168) <= 1);
    eng_tempo_global(0);
    play_ms(300);
    at = log_n;
    play_ms(3000);
    snprintf(what, sizeof what, "TEMPO: PATCH again: the patch's 180, %d ticks in 3 s (want 216 +-1)", count(at, 0xF8u));
    check(what, abs(count(at, 0xF8u) - 216) <= 1);

    set_tempo(120);                                 /* Start: just before the start's tick 0, which is the start's sample */
    play_ms(507);
    at = log_n;
    {
        uint64_t s0 = samples;
        uint32_t want_t;
        int fa, f8;
        play(1);
        play_ms(1000);
        fa = first(at, 0xFAu);
        f8 = fa >= 0 ? first(fa, 0xF8u) : -1;
        want_t = (uint32_t)((s0 + CO_LAT_SAMPLES) * 1000000u / ENG_SR * FM1_TICKS_PER_US);
        check("PLAY: one Start, then a tick", count(at, 0xFAu) == 1 && fa >= 0 && f8 == fa + 1);
        snprintf(what, sizeof what, "the Start and its tick 0 leave together, %.0f us after the start's sample sounds",
                 f8 >= 0 ? (double)(int32_t)(log_t[f8] - want_t) / FM1_TICKS_PER_US : -1.0);
        check(what, f8 >= 0 && log_t[f8] == log_t[fa] && (int32_t)(log_t[f8] - want_t) >= 0
              && (int32_t)(log_t[f8] - want_t) <= 600 * (int32_t)FM1_TICKS_PER_US);
        snprintf(what, sizeof what, "running: 48 ticks a second from the Start's tick 0 (%d in 1 s)", count(fa, 0xF8u));
        check(what, count(fa, 0xF8u) == 48 || count(fa, 0xF8u) == 49);
        check("the ticks out count as the tracks do (tick 0, then the engine's run ticks; the last may still wait)",
              count(fa, 0xF8u) == eng_run_ticks() + 1 || count(fa, 0xF8u) == eng_run_ticks());
    }
    at = log_n;
    play(0);
    play_ms(1000);
    check("PLAY again: one Stop, and the clock goes on", count(at, 0xFCu) == 1 && count(at, 0xFAu) == 0
          && abs(count(at, 0xF8u) - 48) <= 1);

    at = log_n;                                     /* the ISR before the transport: the Start still goes out with the edge */
    clk_out_play(0xFAu);
    play_ms(3);
    eng_transport(1);
    play_ms(500);
    check("a Start asked a render early waits for the engine's start", count(at, 0xFAu) == 1 && log_b[first(at, 0xFAu) + 1] == 0xF8u
          && log_t[first(at, 0xFAu)] == log_t[first(at, 0xFAu) + 1]);
    play(0);
    play_ms(200);

    at = log_n;                                     /* no engine (a patch being loaded): Start / Stop still go, a little later */
    run_engine = 0;
    play(1);
    play_ms(100);
    check("no render: no ticks, and the Start goes out after a few halves", count(at, 0xF8u) == 0 && count(at, 0xFAu) == 1);
    play(0);
    play_ms(100);
    run_engine = 1;
    play_ms(100);

    cfg.clock_out = 0;                              /* CLOCK OUT off: no ticks, Start / Stop still go */
    at = log_n;
    play_ms(1000);
    play(1);
    play_ms(500);
    play(0);
    play_ms(100);
    check("CLOCK OUT off: no ticks; Start and Stop still go out", count(at, 0xF8u) == 0 && count(at, 0xFAu) == 1 && count(at, 0xFCu) == 1);
    cfg.clock_out = 1;
    cfg.midi_out = 0;                               /* MIDI OUT off: nothing */
    at = log_n;
    play_ms(1000);
    play(1);
    play_ms(500);
    play(0);
    play_ms(100);
    check("MIDI OUT off: nothing goes out, the clock included", log_n == at);
    cfg.midi_out = 1;

    at = log_n;                                     /* MIDI clock in drives the clock: nothing passed on, no own clock */
    eng_clock_external(1);
    for (k = 0; k < 48u; k++) {
        eng_clock_tick();
        play_ms(21);
    }
    check("while MIDI clock in drives the clock, no clock goes out", count(at, 0xF8u) == 0);
    eng_clock_external(0);                          /* (midi_input.h: 0.5 s without a tick) */
    play_ms(100);
    at = log_n;
    play_ms(1000);
    check("after clock in stops, the FM-1's own clock goes out again at its tempo", abs(count(at, 0xF8u) - 48) <= 1);

    at = log_n;                                     /* a host that stops reading: at most CO_KEEP ticks wait, none pile up */
    reading = 0;
    play_ms(3000);
    {
        int sent = count(at, 0xF8u);
        snprintf(what, sizeof what, "a host that stops reading: %d ticks queued (at most %u), %u dropped", sent, CO_KEEP, co_dropped);
        check(what, sent == (int)CO_KEEP && co_dropped > 100u);
    }
    reading = 1;
    mo_r = mo_w;
    at = log_n;
    play_ms(1000);
    check("it reads again: the clock goes on at once", abs(count(at, 0xF8u) - 48) <= 1);

    check("the settings record: a record from before reads CLOCK OUT as ON", co_set_clock_out(0u) && co_set_clock_out(1u));
    check("  OFF is bit 1 of byte 6, and CLOCK IN stays bit 0 for older firmware (d[6] & 1)",
          co_set_byte(1u, 0u) == 3u && !co_set_clock_out(co_set_byte(1u, 0u)) && (co_set_byte(0u, 0u) & 1u) == 0u
          && (co_set_byte(1u, 1u) & 1u) == 1u && co_set_clock_out(co_set_byte(0u, 1u)));

    printf(fails ? "%d FAILED\n" : "all passed\n", fails);
    return fails != 0;
}
