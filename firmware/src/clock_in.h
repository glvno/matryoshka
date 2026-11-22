/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock in and transport in (GLO > MIDI > CLOCK IN, D-452, #870; MIDI 2/4 > TRANSPORT IN, #596): the realtime and
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
 * The host test (firmware/test/clock_in_test.c) runs this file with the engine.
 *
 * CLOCK IN DELAY (MIDI 2/4, #870, 0..200 ms, 0 as made): the FM-1 acts on every message this file takes that much later,
 * for a host whose MIDI clock runs ahead of its own audio (Reel: about 70 ms). Each message is due at the time it came
 * into the MIDI ring (midi_queue.h midi_in_at: TIMER4 in units of 1024 ticks, CIN_T) plus the delay set when it came; a change of the delay applies to
 * the messages that come after it. They wait in arrival order in a small queue (cin_dq) and go to clk_in_rt, the same
 * code as without the delay, after each drain of the ring (clk_in_idle), in order: never one before an earlier one, so a
 * delay lowered while messages wait holds the newer ones until the older ones are due. Clock, Start, Stop, Continue and
 * Song Position all wait, so tempo following, Start and Stop, Song Position and the stall handling act as without the
 * delay, only later; notes and controls do not wait. At 0 ms with nothing waiting a message goes to clk_in_rt at once,
 * as before the delay. A clock due within CIN_DQ_MERGE of the clock run newest in the queue joins that run (a burst of
 * missed clocks takes one entry a millisecond); a full queue (only a burst faster than that, 32 entries deep) lets its
 * oldest entry go early rather than lose one. MIDI clock out has nothing to pass on (clock_out.h: while MIDI clock
 * drives, the engine makes no ticks of its own), so it follows what the FM-1 plays.
 *
 * The log (#870: what a looper such as Reel sends, read on the Mac afterwards): the realtime and Song Position messages
 * as the FM-1 takes them from the MIDI ring, before CLOCK IN DELAY holds them, logged whether CLOCK IN and TRANSPORT IN
 * are on or not, in a ring of CIN_LOG_N entries. Each entry has its time in
 * microseconds (TIMER4, CIN_LOG_NOW) and the transport's state; Start, Stop and Continue the engine's tick count (low 16
 * bits) as the last block left it, Song Position its value. A clock that comes a period like the one before it (within a
 * quarter) and finds a clock entry newest is folded into it (up to 31 more; the entry keeps the time from its first clock
 * to its last), so steady clock takes little room and every irregular clock keeps its own time. CIN_LOG_AFTER messages
 * after a Stop it freezes, so the last loop before a Stop stays when a
 * host goes on sending clock while stopped; a Start or Continue lets it run again. RAM only: it lasts while the FM-1
 * stays on (unplugging USB keeps it). On the device the ring is the update session's staging buffers (modular.c
 * CIN_LOG_RING, ota.c ota_buf: the pool has no room of its own, D-100), so an update empties it. DIAG 145 (the header,
 * and the read starts at the oldest entry), 146 (the next 4 entries), 147 (empty it); tools/m1_link.py midilog. */
#ifndef CIN_LOG_NOW
#define CIN_LOG_NOW() fm1_ticks()               /* (TIMER4: the log's clock and CLOCK IN DELAY's) */
#endif
#define CIN_LOG_N 256u
#define CIN_LOG_AFTER 64u
typedef struct {
    uint32_t us;                                /* microseconds (the log's own clock: wraps after 71 minutes) */
    uint16_t v;                                 /* Start / Stop / Continue: the engine's ticks (low 16 bits); Song Position: its
                                                 * value; a clock: from its first to its last clock, in units of 100 us */
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
static uint8_t midi_spp_set;                    /* a Song Position came since the last Start or Continue: Continue plays */
static uint16_t midi_spp;                       /* from it (sixteenths from the top) */

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
            e->v = (uint16_t)((us - e->us) / 100u < 65535u ? (us - e->us) / 100u : 65535u);
            return;
        }
    }
    e = &cin_log[cin_log_w++ % CIN_LOG_N];
    e->us = us;
    e->st = (uint8_t)st;
    e->v = st == 0xF2u ? (uint16_t)(((pkt >> 16) & 0x7Fu) | ((pkt >> 24) & 0x7Fu) << 7) : st == 0xF8u ? 0u : (uint16_t)eng_ticks();
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

/* one realtime or system common packet (USB-MIDI layout: the status in bits 8..15, data above), when it is due */
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

/* CLOCK IN DELAY's queue (main thread only): each entry's due time (CIN_T) and its packet; a clock run keeps the clocks
 * after its first in the packet's bits 16..23, which a clock leaves 0. (CIN_DELAY_MAX, the setting's top: ui.c) */
#define CIN_T(ticks) ((uint16_t)((ticks) >> 10))   /* TIMER4 in units of 1024 ticks: 42.7 us, wrapping every 2.8 s */
#define CIN_T_MS(ms) (((uint32_t)(ms) * 1000u * FM1_TICKS_PER_US + 1023u) >> 10)   /* ms in those units, rounded up (the
                                                * stamp rounds down: a message goes within one unit of its time) */
#define CIN_DQ_N 32u                            /* at 300 bpm 200 ms is 24 clocks; Start, Stop and Song Position besides */
#define CIN_DQ_MERGE (CIN_T_MS(1u) - 1u)        /* a clock due this soon after a run's first joins the run (under 1 ms) */
static uint16_t cin_dq_due[CIN_DQ_N];
static uint32_t cin_dq_pkt[CIN_DQ_N];
static uint8_t cin_dq_r, cin_dq_w;              /* (taken, put: CIN_DQ_N divides their 256) */
static uint8_t cin_dq_most;                     /* the deepest the queue has been, in entries (the host test) */
static uint32_t cin_dq_early;                   /* entries a full queue let go before their time (the host test) */

static void cin_dq_out(void)                    /* the oldest entry to clk_in_rt, a clock run clock by clock */
{
    uint32_t pkt = cin_dq_pkt[cin_dq_r % CIN_DQ_N], n = 1u;
    cin_dq_r++;
    if (((pkt >> 8) & 0xFFu) == 0xF8u) {
        n += (pkt >> 16) & 0xFFu;
        pkt &= 0xFFFFu;
    }
    while (n--)
        clk_in_rt(pkt);
}

/* the drain's realtime and Song Position packet, which came into the MIDI ring at `at` (CIN_T): logged, then to
 * clk_in_rt now (CLOCK IN DELAY at 0 and nothing waiting) or into the queue */
static void clk_in_take(uint32_t pkt, uint16_t at)
{
    uint32_t k, clock = ((pkt >> 8) & 0xFFu) == 0xF8u, full;
    uint16_t due;
    cin_log_add(pkt);
    if (!cfg.clock_delay && cin_dq_w == cin_dq_r) {
        clk_in_rt(pkt);
        return;
    }
    due = (uint16_t)(at + CIN_T_MS(cfg.clock_delay));
    full = (uint8_t)(cin_dq_w - cin_dq_r) == CIN_DQ_N;
    k = (uint8_t)(cin_dq_w - 1u) % CIN_DQ_N;
    if (clock && cin_dq_w != cin_dq_r && ((cin_dq_pkt[k] >> 8) & 0xFFu) == 0xF8u && ((cin_dq_pkt[k] >> 16) & 0xFFu) < 255u
        && ((int16_t)(due - cin_dq_due[k]) <= (int16_t)CIN_DQ_MERGE || full)) {
        cin_dq_pkt[k] += 1u << 16;              /* (a delay lowered meanwhile: due before the run, which it waits behind) */
        return;
    }
    if (full) {
        cin_dq_early++;
        cin_dq_out();
    }
    cin_dq_due[cin_dq_w % CIN_DQ_N] = due;
    cin_dq_pkt[cin_dq_w % CIN_DQ_N] = clock ? pkt & 0xFFFFu : pkt;
    cin_dq_w++;
    if ((uint8_t)(cin_dq_w - cin_dq_r) > cin_dq_most)
        cin_dq_most = (uint8_t)(cin_dq_w - cin_dq_r);
}

/* after each drain: CLOCK IN DELAY's messages that are due, in order; then MIDI clock lets go of the clock half a second
 * after its last tick, unless the transport runs on it. An entry more than the longest delay ahead is due too: it is
 * one that waited a whole wrap of CIN_T (2.8 s) behind a main loop that did not drain the ring (an update session) */
static void clk_in_idle(void)
{
    if (cin_dq_r != cin_dq_w) {
        uint16_t now = CIN_T(CIN_LOG_NOW());
        while (cin_dq_r != cin_dq_w) {
            int16_t late = (int16_t)(now - cin_dq_due[cin_dq_r % CIN_DQ_N]);
            if (late < 0 && late >= -(int16_t)CIN_T_MS(CIN_DELAY_MAX))
                break;
            cin_dq_out();
        }
    }
    if (midi_clk_seen && (!cfg.clock_in || (fm1_ms - midi_clk_ms > 500u && eng_run_ticks() < 0))) {
        midi_clk_seen = 0;
        eng_clock_external(0);
    }
}
