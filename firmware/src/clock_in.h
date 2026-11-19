/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock in (MENU > MIDI > CLOCK IN, D-452, #870): the realtime and Song Position messages midi_input.h takes from the
 * MIDI ring, on the main thread. MIDI clock drives the clock while it comes, and the Steps tracks step on its ticks: the
 * host's first clock after its Start is their tick 0 (engine.c). Start plays from the top, also while the transport runs
 * (a looper starting its loop again); Song Position 0 then Continue does the same. Continue from another position plays
 * on where the tracks are (following a Song Position is #596). Stop stops. While the transport runs on MIDI clock, a
 * stall of the clock holds the tracks where they are until it comes back (a host busy writing a file): the FM-1's own
 * tempo comes back only half a second after the last clock while the transport is stopped, or at once with CLOCK IN off.
 * The host test (firmware/test/clock_in_test.c) runs this file with the engine. */
static uint32_t midi_clk_ms;                    /* fm1_ms of the last MIDI clock tick (MIDI clock drives the clock while they come) */
static uint8_t midi_clk_seen;
static uint8_t midi_spp_top;                    /* the last Song Position was 0: Continue plays from the top */

/* one realtime or system common packet from the MIDI ring (USB-MIDI layout: the status in bits 8..15, data above) */
static void clk_in_rt(uint32_t pkt)
{
    uint32_t rt = (pkt >> 8) & 0xFFu;
    if (!cfg.clock_in)
        return;
    if (rt == 0xF8u) {
        if (!midi_clk_seen)
            eng_clock_external(1);
        midi_clk_seen = 1;
        midi_clk_ms = fm1_ms;
        eng_clock_tick();
        return;
    }
    if (rt == 0xF2u) {
        midi_spp_top = ((pkt >> 16) & 0x7Fu) == 0u && ((pkt >> 24) & 0x7Fu) == 0u;
        return;
    }
    if (rt != 0xFAu && rt != 0xFBu && rt != 0xFCu)
        return;
    if (rt == 0xFCu)
        eng_transport(0);
    else if (rt == 0xFAu || midi_spp_top)
        eng_transport_top();
    else
        eng_transport(1);
    midi_spp_top = 0;
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
