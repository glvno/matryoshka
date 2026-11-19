/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock out and transport out (#473, #596, docs/ARCHITECTURE.md "MIDI out map"): the FM-1 sends MIDI clock (0xF8, 24
 * a quarter note) over USB at the tempo that plays (the global tempo, or Main's: D-907), all the time, and Start / Stop
 * when PLAY starts and stops the transport. PLAY from a SONG page entry sends Song Position (the entry's start in
 * sixteenths) and Continue in place of Start. GLO > MIDI > CLOCK OUT turns the clock off, MIDI 2/2 > TRANSPORT OUT the
 * Start, Continue, Stop and Song Position; each goes without the other, and neither needs MIDI OUT (the panel's own
 * controls). While MIDI clock in drives the clock (D-452) the engine makes no ticks of its own, so nothing is passed on:
 * no loops.
 *
 * The ticks are the engine's own (eng_clock_out), timed by the audio clock, not the main loop. The audio ISR
 * (clk_out_block, after the render) puts each one in a small ring with the time it is due: the ISR's start, plus a half
 * buffer (when the rendered half begins to sound), plus the tick's sample in the render. The 2 kHz timer
 * (clk_out_poll, before usb_poll) hands each message to the USB ring when its time comes, so a tick leaves within half a
 * millisecond of its sample sounding, whatever the render's length. Start (PLAY) goes out in the render where the
 * engine starts the transport, just before that render's tick 0; Stop in the render where it stops. Play once (#632)
 * starts and stops the transport itself: its Start and Stop go out the same way, unasked.
 *
 * The time base is TIMER4's 24 MHz count (fm1_ticks), which wraps every 179 s: times are compared as differences. */

#define CO_N 8u                         /* the due ring: a Song Position, a Start or Stop and a tick a render, two renders deep */
#define CO_LAT_SAMPLES 128u             /* a half buffer (audio.c HALF_FRAMES): the rendered half begins to sound after it */
#define CO_KEEP 8u                      /* at most this many ticks wait in the USB ring: the host stopped reading */
#define CO_TICK (0x0Fu | 0xF8u << 8)    /* a clock as a USB MIDI packet (code index 0xF: one byte) */
static struct {
    uint32_t due[CO_N];
    uint32_t pkt[CO_N];                 /* the USB MIDI packet */
} co_q;
static volatile uint32_t co_w, co_r;
static volatile uint8_t co_play;        /* PLAY asked for Start (0xFA), Continue (0xFB) or Stop (0xFC): it goes out with the
                                         * engine's edge */
static volatile uint16_t co_spp;        /* with Continue: the Song Position before it (sixteenths) */
static uint8_t co_play_age;             /* renders the request waited: after CO_PLAY_WAIT it goes out anyway */
#define CO_PLAY_WAIT 3u
static uint32_t co_mark[CO_KEEP];       /* where each of the last CO_KEEP ticks sits in the USB ring (mo_w after it) */
static uint32_t co_k;
static uint32_t co_dropped;             /* ticks not sent because the host stopped reading (DIAG) */
static uint32_t co_sent;                /* ticks sent (DIAG, the host test) */

/* the settings record's byte 6 (main.c settings_pack): CLOCK IN in bit 0, CLOCK OUT off in bit 1, TRANSPORT OUT off in bit
 * 3, TRANSPORT IN off in bit 4 (bit 2 is 3.5MM OUT's). A record from before has bits 1, 3 and 4 clear, so it reads them as
 * ON; older firmware reads bit 0 alone, so it keeps CLOCK IN */
static uint8_t co_set_byte(uint32_t clock_in, uint32_t clock_out, uint32_t transport_in, uint32_t transport_out)
{
    return (uint8_t)((clock_in & 1u) | (clock_out ? 0u : 2u) | (transport_out ? 0u : 8u) | (transport_in ? 0u : 16u));
}
static uint8_t co_set_clock_out(uint8_t b) { return (uint8_t)!(b & 2u); }
static uint8_t co_set_transport_out(uint8_t b) { return (uint8_t)!(b & 8u); }
static uint8_t co_set_transport_in(uint8_t b) { return (uint8_t)!(b & 16u); }

/* the main loop (panel.c play_toggle through main.c midi_send_rt): PLAY's Start, Continue (after Song Position `spp`) or
 * Stop, sent with the engine's edge */
static void clk_out_play(uint32_t b, uint32_t spp)
{
    co_play_age = 0;
    co_spp = (uint16_t)spp;
    co_play = (uint8_t)b;
}

static void co_push(uint32_t due, uint32_t pkt)
{
    if (co_w - co_r >= CO_N)
        return;
    co_q.due[co_w % CO_N] = due;
    co_q.pkt[co_w % CO_N] = pkt;
    RING_PUBLISH();
    co_w++;
}
static uint32_t co_rt(uint32_t b) { return 0x0Fu | b << 8; }

/* the audio ISR, after eng_render (`rendered`: the engine ran this half; t0: fm1_ticks at the ISR's start). CLOCK OUT and
 * TRANSPORT OUT are read here, as the messages are made. */
static void clk_out_block(uint32_t t0, int rendered)
{
    uint32_t off[CKO_MAX], n = 0, k;
    int32_t edge = 0;
    int transport = cfg.transport_out != 0, clock = cfg.clock_out != 0;
    if (rendered)
        n = eng_clock_out(off, CKO_MAX, &edge);
    if (co_play) {                      /* PLAY's Start / Continue / Stop: at the edge it asked for, before the edge's tick 0 */
        uint32_t b = co_play;
        if ((edge > 0 && b != 0xFCu) || (edge < 0 && b == 0xFCu) || ++co_play_age > CO_PLAY_WAIT) {
            uint32_t due = t0 + (CO_LAT_SAMPLES + (n ? off[0] : 0u)) * 1000000u / ENG_SR * FM1_TICKS_PER_US;
            co_play = 0;
            if (transport && b == 0xFBu)    /* (Song Position: code index 3, three bytes) */
                co_push(due, 0x03u | 0xF2u << 8 | (co_spp & 0x7Fu) << 16 | (co_spp >> 7 & 0x7Fu) << 24);
            if (transport)
                co_push(due, co_rt(b));
        }
    }
    if ((edge == 2 || edge == -2) && transport)   /* play once started or stopped the transport itself (#632): its Start / Stop */
        co_push(t0 + (CO_LAT_SAMPLES + (edge > 0 && n ? off[0] : 0u)) * 1000000u / ENG_SR * FM1_TICKS_PER_US, co_rt(edge > 0 ? 0xFAu : 0xFCu));
    if (clock)
        for (k = 0; k < n; k++)
            co_push(t0 + (CO_LAT_SAMPLES + off[k]) * 1000000u / ENG_SR * FM1_TICKS_PER_US, CO_TICK);
}

/* the 2 kHz timer, before usb_poll: the messages whose time has come go to the USB ring (midi_out_event). A tick is
 * dropped while CO_KEEP ticks before it still wait there (the host stopped reading: no burst of old ticks when it reads
 * again) */
static void clk_out_poll(uint32_t now)
{
    while (co_r != co_w) {
        uint32_t at = co_r % CO_N, p;
        RING_PUBLISH();
        if ((int32_t)(now - co_q.due[at]) < 0)
            break;
        p = co_q.pkt[at];
        if (p != CO_TICK) {
            midi_out_event(p);
        } else if ((int32_t)(co_mark[co_k % CO_KEEP] - mo_r) > 0) {
            co_dropped++;
        } else {
            midi_out_event(p);
            co_mark[co_k++ % CO_KEEP] = mo_w;
            co_sent++;
        }
        RING_PUBLISH();
        co_r++;
    }
}
