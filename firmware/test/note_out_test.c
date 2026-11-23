/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* Note Out (D-1353, engine.c m_nout, firmware/src/clock_out.h) on the host: the engine renders half buffers as the audio
 * ISR does, clk_out_block queues the notes, the 2 kHz timer hands them on, and the test reads what left. A rising gate is
 * a Note On and a falling one its Note Off, each handed on at the first timer tick after its sample sounds (the ISR's
 * start, plus a half buffer, plus the sample: the due time), velocity from vel (unpatched 100), MIDI OUT and CLOCK OUT off
 * change nothing, and a bypass, the transport stopping and a patch change turn off what was left on. Many Note Outs at
 * once with the clock and the transport: no note is ever on twice, and every Note On gets its Note Off.
 * The patches: web/scripts/note-out-kits.ts (tools/note_out_test.sh makes them).
 *   tools/note_out_test.sh */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/engine.c"

#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#define FM1_TICKS_PER_US 24u
#define HALF 128u
static struct {
    uint8_t midi_out, clock_out, transport_out;
} cfg = {1, 1, 1};

/* usb.c's MIDI out ring, read at once; the log keeps each packet and when it was handed on */
static uint32_t mo_w, mo_r;
static uint32_t now_t;                              /* the simulated TIMER4 (24 MHz) */
#define LOGN 100000
static uint32_t log_t[LOGN], log_p[LOGN];
static int log_n;
static void midi_out_event(uint32_t pkt)
{
    mo_w++;
    if (log_n < LOGN) {
        log_t[log_n] = now_t;
        log_p[log_n++] = pkt;
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
#define RENDERS 200000
static uint32_t t0_of[RENDERS];                     /* each render's ISR start */
#define EDGES 4096
static uint64_t edge_at[EDGES];                     /* the left channel's crossings of the gate level (0.5), and which way */
static uint8_t edge_up[EDGES];
static int nedge, track, track_hi;

static uint32_t at_sample(uint64_t s) { return (uint32_t)(s * 1000000u / ENG_SR * FM1_TICKS_PER_US); }
/* `ms` of audio: a half buffer at a time as the ISR does (up to 20 us late), the timer at 2 kHz between */
static void play_ms(uint32_t ms)
{
    uint64_t end = samples + (uint64_t)ms * ENG_SR / 1000u;
    static uint32_t next_poll;
    while (samples < end) {
        uint32_t i, t_next;
        now_t = at_sample(samples) + (uint32_t)(rand() % 20) * FM1_TICKS_PER_US;
        t0_of[(samples / HALF) % RENDERS] = now_t;
        eng_render(l, r, HALF);
        if (track)
            for (i = 0; i < HALF; i++)
                if ((l[i] >= 32768) != track_hi) {
                    track_hi ^= 1;
                    if (nedge < EDGES) {
                        edge_at[nedge] = samples + i;
                        edge_up[nedge++] = (uint8_t)track_hi;
                    }
                }
        clk_out_block(now_t, 1);
        samples += HALF;
        t_next = at_sample(samples);
        while ((int32_t)(next_poll - t_next) < 0) {
            now_t = next_poll;
            clk_out_poll(now_t);
            mo_r = mo_w;
            next_poll += 500u * FM1_TICKS_PER_US;
        }
    }
}
/* the due time of sample s: its render's ISR start, a half buffer, its place in the render */
static uint32_t due_of(uint64_t s) { return t0_of[(s / HALF) % RENDERS] + (CO_LAT_SAMPLES + (uint32_t)(s % HALF)) * 1000000u / ENG_SR * FM1_TICKS_PER_US; }

static uint8_t bins[8][4096];
static uint32_t bin_len[8];
static int load(int k, const char *dir, const char *name)
{
    char path[512];
    FILE *f;
    snprintf(path, sizeof path, "%s/%s.m1p", dir, name);
    f = fopen(path, "rb");
    if (!f)
        return -1;
    bin_len[k] = (uint32_t)fread(bins[k], 1, sizeof bins[k], f);
    fclose(f);
    return 0;
}
static int run(int k) { return eng_load(bins[k], bin_len[k]); }
static void play(int on)
{
    clk_out_play(on ? 0xFAu : 0xFCu, 0u);
    eng_transport(on);
}

static int is_on(uint32_t p) { return (p & 0x0Fu) == 0x09u; }
static int is_off(uint32_t p) { return (p & 0x0Fu) == 0x08u; }
static uint32_t note_of(uint32_t p) { return p >> 16 & 0x7Fu; }
static uint32_t chan_of(uint32_t p) { return p >> 8 & 0x0Fu; }
static uint32_t vel_of(uint32_t p) { return p >> 24 & 0x7Fu; }
/* the Note Ons (on) or Note Offs of note `note` (-1 any) since log entry `from` */
static int count(int from, int on, int note)
{
    int i, n = 0;
    for (i = from; i < log_n; i++)
        if ((on ? is_on(log_p[i]) : is_off(log_p[i])) && (note < 0 || note_of(log_p[i]) == (uint32_t)note))
            n++;
    return n;
}
/* the first note message at or after log entry `from` (the clock's go between) */
static int note_at(int from)
{
    while (from < log_n && !is_on(log_p[from]) && !is_off(log_p[from]))
        from++;
    return from;
}
static int ticks(int from)
{
    int i, n = 0;
    for (i = from; i < log_n; i++)
        n += (log_p[i] >> 8 & 0xFFu) == 0xF8u;
    return n;
}

enum { K_EDGES, K_VEL, K_HELD, K_MANY };

int main(int argc, char **argv)
{
    const char *dir = argc > 1 ? argv[1] : "build/note-out";
    char what[200];
    int at, i, k;
    check("the kits load (web/scripts/note-out-kits.ts)", !load(K_EDGES, dir, "edges") && !load(K_VEL, dir, "vel")
          && !load(K_HELD, dir, "held") && !load(K_MANY, dir, "many"));
    check("  a format 66 binary", bins[K_EDGES][1] == 66u && ENG_PATCH_VERSION == 66);
    check("  the edges kit plays, with a Note Out in it", run(K_EDGES) == 0 && eng_find(T_NOUT) >= 0);
    eng_tempo_global(0);

    /* rising -> Note On, falling -> Note Off, each at its sample's due time */
    at = log_n;
    nedge = 0;
    track = 1;
    track_hi = 0;
    play_ms(2000);
    track = 0;
    play_ms(20);                                    /* (the last edges' notes leave) */
    {
        int ne = 0, bad = 0, worst = 0, best = 1 << 30, kind = 0, vel = 0, e = 0;
        for (i = at; i < log_n; i++) {
            uint32_t p = log_p[i];
            int d;
            if (!is_on(p) && !is_off(p))
                continue;
            if (e >= nedge)
                break;
            if ((is_on(p) != edge_up[e]) || note_of(p) != 36u || chan_of(p) != 4u) {
                bad++;
                e++;
                continue;
            }
            kind += (is_on(p) && (p >> 8 & 0xF0u) == 0x90u) || (is_off(p) && (p >> 8 & 0xF0u) == 0x80u && vel_of(p) == 0u);
            vel += is_off(p) || vel_of(p) == 100u;
            d = (int)(log_t[i] - due_of(edge_at[e]));
            if (d < best)
                best = d;
            if (d > worst)
                worst = d;
            e++;
            ne++;
        }
        snprintf(what, sizeof what, "37 Hz square, 2 s: %d edges in the audio, %d notes out in their order (%d wrong)", nedge, ne, bad);
        check(what, nedge > 140 && ne == nedge && !bad);
        snprintf(what, sizeof what, "  each handed on %.1f..%.1f us after its sample's due time (the timer's next tick: 0..500)",
                 best / 24.0, worst / 24.0);
        check(what, best >= 0 && worst < 500 * 24);
        check("  Note On 0x94 (channel 5) note 36 velocity 100 with nothing in vel; Note Off 0x84 velocity 0", kind == ne && vel == ne);
        {
            int mid = 0;
            for (i = 0; i < nedge; i++)
                mid += edge_at[i] % HALF != 0u;
            check("  the edges fall inside renders, not only on their first samples", mid > nedge / 2);
        }
    }

    /* MIDI OUT and CLOCK OUT off: the notes still go (the patch asks for them), the clock does not */
    cfg.midi_out = 0;
    cfg.clock_out = 0;
    play_ms(20);                                    /* (the ticks already queued leave) */
    at = log_n;
    play_ms(500);
    snprintf(what, sizeof what, "MIDI OUT and CLOCK OUT off: %d Note Ons, %d Note Offs, %d clocks", count(at, 1, 36), count(at, 0, 36), ticks(at));
    check(what, count(at, 1, 36) >= 17 && count(at, 0, 36) >= 17 && ticks(at) == 0);
    cfg.midi_out = 1;
    cfg.clock_out = 1;

    /* velocity: vel x 127 at the edge's sample, held to 1..127 */
    check("the vel kit plays", run(K_VEL) == 0);
    play_ms(20);
    at = log_n;
    play_ms(500);
    {
        int ok = 1, n = 0;
        for (i = at; i < log_n; i++)
            if (is_on(log_p[i])) {
                uint32_t p = log_p[i], want = note_of(p) == 40u ? 64u : note_of(p) == 41u ? 1u : 127u;
                ok &= chan_of(p) == 0u && vel_of(p) == want;
                n++;
            }
        snprintf(what, sizeof what, "vel 0.5 -> 64, -0.2 -> 1, 2 -> 127 on channel 1: %d Note Ons", n);
        check(what, ok && n >= 27);
    }

    /* what a Note Out left on goes off: a bypass, the transport stopping, a patch change */
    check("the held kit plays", run(K_HELD) == 0);
    at = log_n;
    play_ms(100);
    check("a gate held high: one Note On (note 50), no Note Off", count(at, 1, 50) == 1 && count(at, 0, 50) == 0);
    k = eng_find(T_NOUT);
    at = log_n;
    eng_set_bypass((uint32_t)k, 1);
    {
        uint64_t s = samples;
        play_ms(100);
        int a = note_at(at);
        check("  bypassed: its Note Off, at the next render's first sample", count(at, 0, 50) == 1 && count(at, 1, -1) == 0
              && (int32_t)(log_t[a] - due_of(s)) >= 0 && (int32_t)(log_t[a] - due_of(s)) < 500 * 24);
    }
    at = log_n;
    eng_set_bypass((uint32_t)k, 0);
    play_ms(100);
    check("  back: nothing (the gate did not rise)", count(at, 1, -1) == 0 && count(at, 0, -1) == 0);

    check("the held kit again", run(K_HELD) == 0);
    at = log_n;
    play_ms(100);
    check("  its Note On", count(at, 1, 50) == 1);
    play(1);
    play_ms(200);
    at = log_n;
    play(0);
    play_ms(100);
    check("  the transport stops: its Note Off", count(at, 0, 50) == 1 && count(at, 1, -1) == 0);
    at = log_n;
    play(1);
    play_ms(200);
    play(0);
    play_ms(100);
    check("  PLAY again: nothing (the gate did not rise)", count(at, 1, -1) == 0 && count(at, 0, -1) == 0);

    check("the held kit again", run(K_HELD) == 0);
    play_ms(100);
    at = log_n;
    check("  the same patch loaded again", run(K_HELD) == 0);
    play_ms(100);
    k = note_at(at);
    check("  its Note Off, then its new Note On on the same sample", count(at, 0, 50) == 1 && count(at, 1, 50) == 1
          && is_off(log_p[k]) && note_at(k + 1) == k + 1 && is_on(log_p[k + 1]) && log_t[k] == log_t[k + 1]);
    at = log_n;
    check("  another patch loaded (the vel kit)", run(K_VEL) == 0);
    play_ms(100);
    k = note_at(at);
    check("  note 50 goes off, first", count(at, 0, 50) == 1 && is_off(log_p[k]) && note_of(log_p[k]) == 50u && count(at, 1, 50) == 0);

    /* many at once, with the clock and the transport: never a note on twice, every Note On its Note Off */
    check("the many kit plays", run(K_MANY) == 0);
    at = log_n;
    for (i = 0; i < 12; i++) {
        play(i & 1 ? 0 : 1);
        play_ms(250);
    }
    play(0);
    play_ms(50);
    run(K_HELD);
    play_ms(50);
    {
        int on[128] = {0}, twice = 0, offs = 0, retrig = 0, firsts = 0, unpaired = 0, j;
        for (i = at; i < log_n; i++) {
            uint32_t p = log_p[i], nt = note_of(p);
            if (is_on(p) && nt != 50u) {
                twice += on[nt];
                on[nt] = 1;
            } else if (is_off(p) && nt != 50u) {
                on[nt] = 0;
                offs++;
                if (nt == 70u && i + 1 < log_n && is_on(log_p[i + 1]) && note_of(log_p[i + 1]) == 70u && log_t[i] == log_t[i + 1])
                    retrig++;
            }
        }
        for (j = 0; j < 128; j++)
            unpaired += on[j];
        for (j = 60; j < 66; j++)
            firsts += count(at, 1, j) > 0;
        snprintf(what, sizeof what, "eight Note Outs, the clock and PLAY / STOP: %d Note Offs, a note on twice %d times, %d left on",
                 offs, twice, unpaired);
        check(what, offs > 200 && !twice && !unpaired);
        snprintf(what, sizeof what, "  note 70 sent while it was on: its Note Off first, on the same sample (%d times)", retrig);
        check(what, retrig > 0);
        snprintf(what, sizeof what, "  six on one edge: at least ENG_NOUT_ON (%u) of them sent (%d notes of 60..65 heard)", ENG_NOUT_ON, firsts);
        check(what, firsts >= (int)ENG_NOUT_ON);
        check("  the clock went on meanwhile", ticks(at) > 100);
    }

    printf(fails ? "%d FAILED\n" : "all passed\n", fails);
    return fails != 0;
}
