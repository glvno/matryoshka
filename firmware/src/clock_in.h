/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock in and transport in (GLO > MIDI > CLOCK IN, D-452, #870; MIDI 2/2 > TRANSPORT IN, #596): the realtime and
 * Song Position messages midi_input.h takes from the MIDI ring, on the main thread. CLOCK IN takes the clock (0xF8),
 * TRANSPORT IN takes Start, Continue, Stop and Song Position; each works without the other. MIDI clock drives the clock
 * while it comes, and the Steps tracks step on its ticks: the host's first clock after its Start is their tick 0
 * (engine.c). Start plays from the top, also while the transport runs (a looper starting its loop again). Continue after
 * a Song Position plays from there, also while the transport runs: every Steps track as if it had played from the top
 * (engine.c steps_ff), the position's step on the next clock; Song Position 0 is the top. Continue with no Song Position
 * since the last Start or Continue plays on where the tracks are. Stop stops. On MIDI clock a start waits for the next
 * clock; with CLOCK IN off it starts at once, on the FM-1's own tempo. While the transport runs on MIDI clock, a stall of
 * the clock holds the tracks where they are until it comes back (a host busy writing a file): the FM-1's own tempo comes
 * back only half a second after the last clock while the transport is stopped, or at once with CLOCK IN off.
 * The host test (firmware/test/clock_in_test.c) runs this file with the engine. */
static uint32_t midi_clk_ms;                    /* fm1_ms of the last MIDI clock tick (MIDI clock drives the clock while they come) */
static uint8_t midi_clk_seen;
static uint8_t midi_spp_set;                    /* a Song Position came since the last Start or Continue: Continue plays */
static uint16_t midi_spp;                       /* from it (sixteenths from the top) */

/* one realtime or system common packet from the MIDI ring (USB-MIDI layout: the status in bits 8..15, data above) */
static void clk_in_rt(uint32_t pkt)
{
    uint32_t rt = (pkt >> 8) & 0xFFu;
    if (rt == 0xF8u) {
        if (!cfg.clock_in)
            return;
        if (!midi_clk_seen)
            eng_clock_external(1);
        midi_clk_seen = 1;
        midi_clk_ms = fm1_ms;
        eng_clock_tick();
        return;
    }
    if (!cfg.transport_in)
        return;
    if (rt == 0xF2u) {
        midi_spp = (uint16_t)(((pkt >> 16) & 0x7Fu) | ((pkt >> 24) & 0x7Fu) << 7);
        midi_spp_set = 1;
        return;
    }
    if (rt != 0xFAu && rt != 0xFBu && rt != 0xFCu)
        return;
    if (rt == 0xFCu) {
        eng_transport(0);
    } else {
        if (rt == 0xFAu)
            eng_transport_at(0u, cfg.clock_in);
        else if (midi_spp_set)
            eng_transport_at(midi_spp * 6u, cfg.clock_in);
        else
            eng_transport(1);
        midi_spp_set = 0;
    }
    leds_play();
    if (!ui_dirty)
        ui_dirty = 1;
}

/* after each drain: MIDI clock lets go of the clock half a second after its last tick, unless the transport runs on it */
static void clk_in_idle(void)
{
    if (midi_clk_seen && (!cfg.clock_in || (fm1_ms - midi_clk_ms > 500u && eng_run_ticks() < 0))) {
        midi_clk_seen = 0;
        eng_clock_external(0);
    }
}
