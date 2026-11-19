/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock in (MENU > MIDI > CLOCK IN, D-452, #870): the realtime and Song Position messages midi_input.h takes from the
 * MIDI ring, on the main thread. MIDI clock drives the clock while it comes, and the Steps tracks step on its ticks: the
 * host's first clock after its Start is their tick 0 (engine.c). Start plays from the top, also while the transport runs
 * (a looper starting its loop again); Song Position 0 then Continue does the same. Continue from another position plays
 * on where the tracks are (following a Song Position is #596). Stop stops. While the transport runs on MIDI clock, a
 * stall of the clock holds the tracks where they are until it comes back (a host busy writing a file): the FM-1's own
 * tempo comes back only half a second after the last clock while the transport is stopped, or at once with CLOCK IN off.
 * The host test (firmware/test/clock_in_test.c) runs this file with the engine.
 *
 * The log (#870: what a looper such as Reel sends, read on the Mac afterwards): the realtime and Song Position messages
 * as the FM-1 takes them, logged whether CLOCK IN is on or not, in a ring of CIN_LOG_N entries. Each entry has its time in
 * microseconds (TIMER4, CIN_LOG_NOW), the engine's tick count (low 16 bits; the position for Song Position) as the last
 * block left it, and the transport's state. A clock that comes a period like the one before it (within a quarter) and
 * finds a clock entry newest is folded into it (up to 31 more), so steady clock takes little room and every irregular
 * clock keeps its own time. CIN_LOG_AFTER messages after a Stop it freezes, so the last loop before a Stop stays when a
 * host goes on sending clock while stopped; a Start or Continue lets it run again. RAM only: it lasts while the FM-1
 * stays on (unplugging USB keeps it). On the device the ring is the update session's staging buffers (modular.c
 * CIN_LOG_RING, ota.c ota_buf: the pool has no room of its own, D-100), so an update empties it. DIAG 145 (the header,
 * and the read starts at the oldest entry), 146 (the next 4 entries), 147 (empty it); tools/m1_link.py midilog. */
#ifndef CIN_LOG_NOW
#define CIN_LOG_NOW() fm1_ticks()
#endif
#define CIN_LOG_N 256u
#define CIN_LOG_AFTER 64u
typedef struct {
    uint32_t us;                                /* microseconds (the log's own clock: wraps after 71 minutes) */
    uint16_t v;                                 /* the engine's ticks (low 16 bits); Song Position: its value */
    uint8_t st;                                 /* the status byte: F2, F8, FA, FB, FC */
    uint8_t fl;                                 /* bit 0 the transport runs (eng_run_ticks), 1 MIDI clock drives, 2 CLOCK IN on;
                                                 * a clock: bits 3..7 the clocks folded into it after it */
} cin_ent_t;
#ifdef CIN_LOG_RING
#define cin_log CIN_LOG_RING
#else
static cin_ent_t cin_log[CIN_LOG_N];
#endif
static uint32_t cin_log_w, cin_log_rd, cin_log_n;   /* entries made, DIAG 146's next entry, messages logged (since boot or
                                                     * the last DIAG 147) */
static uint32_t cin_log_us, cin_log_tk, cin_log_ms, cin_log_clk, cin_log_gap;   /* the log's clock; the last clock's time,
                                                                                 * and its period before it */
static uint8_t cin_log_stop;                    /* 0 logging; n: after a Stop, n - 1 more messages, then frozen (1) */
static uint32_t midi_clk_ms;                    /* fm1_ms of the last MIDI clock tick (MIDI clock drives the clock while they come) */
static uint8_t midi_clk_seen;
static uint8_t midi_spp_top;                    /* the last Song Position was 0: Continue plays from the top */

/* the log's clock now, in microseconds: TIMER4 (24 MHz) wraps every 179 s, so a longer gap is counted in fm1_ms */
static uint32_t cin_log_clock(void)
{
    uint32_t now = CIN_LOG_NOW(), d = now - cin_log_tk;
    if (fm1_ms - cin_log_ms > 170000u) {
        cin_log_us += (fm1_ms - cin_log_ms) * 1000u;
        cin_log_tk = now;
    } else {
        cin_log_us += d / FM1_TICKS_PER_US;
        cin_log_tk = now - d % FM1_TICKS_PER_US;
    }
    cin_log_ms = fm1_ms;
    return cin_log_us;
}
static uint8_t cin_log_state(void)
{
    return (uint8_t)((eng_run_ticks() >= 0 ? 1u : 0u) | (eng_clock_is_external() ? 2u : 0u) | (cfg.clock_in ? 4u : 0u));
}
static void cin_log_add(uint32_t pkt)
{
    uint32_t st = (pkt >> 8) & 0xFFu, us;
    uint8_t fl;
    cin_ent_t *e;
    if (st == 0xFAu || st == 0xFBu)
        cin_log_stop = 0;
    else if (cin_log_stop == 1u)
        return;
    else if (cin_log_stop)
        cin_log_stop--;
    cin_log_n++;
    us = cin_log_clock();
    fl = cin_log_state();
    if (st == 0xF8u) {
        uint32_t gap = us - cin_log_clk, was = cin_log_gap;
        cin_log_clk = us;
        cin_log_gap = gap;
        e = cin_log_w ? &cin_log[(cin_log_w - 1u) % CIN_LOG_N] : 0;
        if (e && e->st == 0xF8u && (e->fl & 7u) == fl && (e->fl >> 3) < 31u && was && gap + was / 4u >= was &&
            gap <= was + was / 4u) {
            e->fl = (uint8_t)(e->fl + 8u);      /* (a steady clock: one more in the newest clock entry) */
            return;
        }
    }
    e = &cin_log[cin_log_w++ % CIN_LOG_N];
    e->us = us;
    e->st = (uint8_t)st;
    e->v = st == 0xF2u ? (uint16_t)(((pkt >> 16) & 0x7Fu) | ((pkt >> 24) & 0x7Fu) << 7) : (uint16_t)eng_ticks();
    e->fl = fl;
    if (st == 0xFCu)
        cin_log_stop = CIN_LOG_AFTER + 1u;
}
/* DIAG 145..147 (main.c m1_diag): 145 the header (messages logged, the ring's size, the entries it holds, frozen, the
 * log's clock now, the engine's ticks now, the transport's state now, entries made) and the read from the oldest entry;
 * 146 the next 4 entries (8 bytes each: us u32, v u16, st, fl; past the newest: zeros); 147 empties the log */
static uint32_t cin_log_diag(uint32_t page, uint8_t *out)
{
    uint32_t i, held = cin_log_w < CIN_LOG_N ? cin_log_w : CIN_LOG_N;
    if (page == 145u) {
        uint32_t v[8];
        v[0] = cin_log_n;
        v[1] = CIN_LOG_N;
        v[2] = held;
        v[3] = cin_log_stop == 1u;
        v[4] = cin_log_clock();
        v[5] = eng_ticks();
        v[6] = cin_log_state();
        v[7] = cin_log_w;
        cin_log_rd = cin_log_w - held;
        for (i = 0; i < 32u; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return 32u;
    }
    if (page == 146u) {
        for (i = 0; i < 4u; i++, out += 8) {
            uint32_t k;
            if ((int32_t)(cin_log_w - cin_log_rd) <= 0 || cin_log_w - cin_log_rd > held) {
                for (k = 0; k < 8u; k++)
                    out[k] = 0;
                continue;
            }
            {
                const cin_ent_t *e = &cin_log[cin_log_rd++ % CIN_LOG_N];
                for (k = 0; k < 4u; k++)
                    out[k] = (uint8_t)(e->us >> (8u * k));
                out[4] = (uint8_t)e->v;
                out[5] = (uint8_t)(e->v >> 8);
                out[6] = e->st;
                out[7] = e->fl;
            }
        }
        return 32u;
    }
    cin_log_w = cin_log_rd = cin_log_n = cin_log_gap = 0;   /* 147 */
    cin_log_stop = 0;
    out[0] = 0;
    return 1u;
}

/* one realtime or system common packet from the MIDI ring (USB-MIDI layout: the status in bits 8..15, data above) */
static void clk_in_rt(uint32_t pkt)
{
    uint32_t rt = (pkt >> 8) & 0xFFu;
    cin_log_add(pkt);
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
