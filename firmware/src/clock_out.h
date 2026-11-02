/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock out (#473, docs/ARCHITECTURE.md "MIDI out map"): the FM-1 sends MIDI clock (0xF8, 24 a quarter note) over USB
 * at the tempo that plays (the global tempo, or Main's: D-907), all the time, and Start / Stop when PLAY starts and
 * stops the transport. MENU > MIDI > CLOCK OUT turns the clock off; with MIDI OUT off nothing goes out. While MIDI clock
 * in drives the clock (D-452) the engine makes no ticks of its own, so nothing is passed on: no loops.
 *
 * The ticks are the engine's own (eng_clock_out), timed by the audio clock, not the main loop. The audio ISR
 * (clk_out_block, after the render) puts each one in a small ring with the time it is due: the ISR's start, plus a half
 * buffer (when the rendered half begins to sound), plus the tick's sample in the render. The 2 kHz timer
 * (clk_out_poll, before usb_poll) hands each byte to the USB ring when its time comes, so a tick leaves within half a
 * millisecond of its sample sounding, whatever the render's length. Start (PLAY) goes out in the render where the
 * engine starts the transport, just before that render's tick 0; Stop in the render where it stops.
 *
 * The time base is TIMER4's 24 MHz count (fm1_ticks), which wraps every 179 s: times are compared as differences. */

#define CO_N 8u                         /* the due ring: a Start or Stop and a tick a render, two renders deep, and room */
#define CO_LAT_SAMPLES 128u             /* a half buffer (audio.c HALF_FRAMES): the rendered half begins to sound after it */
#define CO_KEEP 8u                      /* at most this many ticks wait in the USB ring: the host stopped reading */
static struct {
    uint32_t due[CO_N];
    uint8_t byte[CO_N];
} co_q;
static volatile uint32_t co_w, co_r;
static volatile uint8_t co_play;        /* PLAY asked for Start (0xFA) or Stop (0xFC): it goes out with the engine's edge */
static uint8_t co_play_age;             /* renders the request waited: after CO_PLAY_WAIT it goes out anyway */
#define CO_PLAY_WAIT 3u
static uint32_t co_mark[CO_KEEP];       /* where each of the last CO_KEEP ticks sits in the USB ring (mo_w after it) */
static uint32_t co_k;
static uint32_t co_dropped;             /* ticks not sent because the host stopped reading (DIAG) */
static uint32_t co_sent;                /* ticks sent (DIAG, the host test) */

/* the settings record's byte 6 (main.c settings_pack): CLOCK IN in bit 0, CLOCK OUT off in bit 1. A record from before
 * has bit 1 clear, so it reads as ON; older firmware reads bit 0 alone, so it keeps CLOCK IN */
static uint8_t co_set_byte(uint32_t clock_in, uint32_t clock_out) { return (uint8_t)((clock_in & 1u) | (clock_out ? 0u : 2u)); }
static uint8_t co_set_clock_out(uint8_t b) { return (uint8_t)!(b & 2u); }

/* the main loop (panel.c play_toggle through main.c midi_send_rt): PLAY's Start or Stop, sent with the engine's edge */
static void clk_out_play(uint32_t b)
{
    co_play_age = 0;
    co_play = (uint8_t)b;
}

static void co_push(uint32_t due, uint32_t b)
{
    if (co_w - co_r >= CO_N)
        return;
    co_q.due[co_w % CO_N] = due;
    co_q.byte[co_w % CO_N] = (uint8_t)b;
    RING_PUBLISH();
    co_w++;
}

/* the audio ISR, after eng_render (`rendered`: the engine ran this half; t0: fm1_ticks at the ISR's start). MIDI OUT
 * and CLOCK OUT are read here, as the bytes are made. */
static void clk_out_block(uint32_t t0, int rendered)
{
    uint32_t off[CKO_MAX], n = 0, k;
    int32_t edge = 0;
    int out = cfg.midi_out != 0, clock = out && cfg.clock_out;
    if (rendered)
        n = eng_clock_out(off, CKO_MAX, &edge);
    if (co_play) {                      /* PLAY's Start / Stop: at the edge it asked for, before the edge's tick 0 */
        uint32_t b = co_play;
        if ((edge > 0 && b == 0xFAu) || (edge < 0 && b == 0xFCu) || ++co_play_age > CO_PLAY_WAIT) {
            co_play = 0;
            if (out)
                co_push(t0 + (CO_LAT_SAMPLES + (n ? off[0] : 0u)) * 1000000u / ENG_SR * FM1_TICKS_PER_US, b);
        }
    }
    if (clock)
        for (k = 0; k < n; k++)
            co_push(t0 + (CO_LAT_SAMPLES + off[k]) * 1000000u / ENG_SR * FM1_TICKS_PER_US, 0xF8u);
}

/* the 2 kHz timer, before usb_poll: the bytes whose time has come go to the USB ring (midi_out_event). A tick is dropped
 * while CO_KEEP ticks before it still wait there (the host stopped reading: no burst of old ticks when it reads again) */
static void clk_out_poll(uint32_t now)
{
    while (co_r != co_w) {
        uint32_t at = co_r % CO_N, b;
        RING_PUBLISH();
        if ((int32_t)(now - co_q.due[at]) < 0)
            break;
        b = co_q.byte[at];
        if (b != 0xF8u) {
            midi_out_event(0x0Fu | b << 8);
        } else if ((int32_t)(co_mark[co_k % CO_KEEP] - mo_r) > 0) {
            co_dropped++;
        } else {
            midi_out_event(0x0Fu | b << 8);
            co_mark[co_k++ % CO_KEEP] = mo_w;
            co_sent++;
        }
        RING_PUBLISH();
        co_r++;
    }
}
