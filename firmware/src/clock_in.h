/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI clock in and transport in (GLO > MIDI > CLOCK IN, D-452, #870; MIDI 2/3 > TRANSPORT IN, #596): the realtime and
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
 * The log (#870: what a looper such as Reel sends, read on the Mac afterwards): the realtime and Song Position messages
 * as the FM-1 takes them, logged whether CLOCK IN and TRANSPORT IN are on or not, in a ring of CIN_LOG_N entries. Each
 * entry has its time in
 * microseconds (TIMER4, CIN_LOG_NOW) and the transport's state; Start, Stop and Continue the engine's tick count (low 16
 * bits) as the last block left it, Song Position its value. A clock that comes a period like the one before it (within a
 * quarter) and finds a clock entry newest is folded into it (up to 31 more; the entry keeps the time from its first clock
 * to its last), so steady clock takes little room and every irregular clock keeps its own time. CIN_LOG_AFTER messages
 * after a Stop it freezes, so the last loop before a Stop stays when a
 * host goes on sending clock while stopped; a Start or Continue lets it run again. RAM only: it lasts while the FM-1
 * stays on (unplugging USB keeps it). On the device the ring is the update session's staging buffers (modular.c
 * CIN_LOG_RING, ota.c ota_buf: the pool has no room of its own, D-100), so an update empties it. DIAG 145 (the header,
 * and the read starts at the oldest entry), 146 (the next 4 entries), 147 (empty it); tools/m1_link.py midilog.
 *
 * Audio onset (#870: where a looper's audio downbeat lands against its Start and clock): the host's USB playback into
 * the FM-1 (usb_return.h) going from silence to sound. The audio ISR hands each half's peak (ur_mix: the OR of the
 * samples' magnitudes, made in the loop that already mixes them) to cin_onset_block; a half that reaches CIN_ONSET_THR
 * after at least CIN_ONSET_QUIET halves below it is an onset: its TIMER4 time and the engine's ticks are kept in the
 * ring's last entry (cin_onset, so the ring holds CIN_LOG_N = 255 entries and no RAM is added), and the main thread logs
 * it as an entry of its own (st CIN_ONSET_ST) at its next drain or message, on the log's clock. The time is the half's
 * mix into the output, block resolution (2.9 ms), after the playback queue's ~6 ms. Each silence of 200 ms or more
 * gives one, so each loop's first hit appears; frozen after a Stop as the messages are; not counted as a message. The
 * header carries the threshold and the silence (DIAG 145). */
#ifndef CIN_LOG_NOW
#define CIN_LOG_NOW() fm1_ticks()
#endif
#define CIN_LOG_N 255u                          /* (+1: the onset's state, cin_onset) */
#define CIN_LOG_AFTER 64u
#define CIN_ONSET_ST 0x01u                      /* an audio onset's entry (not a MIDI status) */
#define CIN_ONSET_THR 256u                      /* sound: a sample of either side at +256 / -257 of 32768 or beyond (-42
                                                 * dBFS); a power of two, which the OR peak compares exactly */
#define CIN_ONSET_QUIET 69u                     /* halves of silence before an onset (128 frames each: 200 ms) */
typedef struct {
    uint32_t us;                                /* microseconds (the log's own clock: wraps after 71 minutes) */
    uint16_t v;                                 /* Start / Stop / Continue / audio onset: the engine's ticks (low 16 bits);
                                                 * Song Position: its value; a clock: from its first to its last clock, in
                                                 * units of 100 us */
    uint8_t st;                                 /* the status byte: F2, F8, FA, FB, FC; CIN_ONSET_ST an audio onset */
    uint8_t fl;                                 /* bit 0 the transport runs (eng_run_ticks), 1 MIDI clock drives, 2 CLOCK IN on;
                                                 * a clock: bits 3..7 the clocks folded into it after it; an audio onset:
                                                 * bits 3..7 the bits of its half's peak (the peak is below 2^bits) */
} cin_ent_t;
#ifdef CIN_LOG_RING
#define cin_log CIN_LOG_RING
_Static_assert((CIN_LOG_N + 1u) * sizeof(cin_ent_t) <= CIN_LOG_RING_BYTES, "the log and the onset's state fit the ring");
#else
static cin_ent_t cin_log[CIN_LOG_N + 1u];
#endif
#define cin_onset (cin_log[CIN_LOG_N])         /* the onset's state: us its TIMER4 time | 1 while the main thread has not
                                                 * logged it (0: none), v the engine's ticks then, st its peak's bits, fl
                                                 * the silent halves before the newest half (up to 255) */
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
/* the audio ISR (modular.c UR_ONSET, with the engine running): one half of the host's playback, pk its peak (ur_mix) */
static void cin_onset_block(uint32_t pk)
{
    cin_ent_t *s = &cin_onset;
    if (pk < CIN_ONSET_THR) {
        if (s->fl < 255u)
            s->fl++;
        return;
    }
    if (s->fl >= CIN_ONSET_QUIET && !s->us) {
        uint32_t b = 9u;
        while (pk >> b)
            b++;
        s->v = (uint16_t)eng_ticks();
        s->st = (uint8_t)b;
        RING_PUBLISH();
        s->us = CIN_LOG_NOW() | 1u;
    }
    s->fl = 0;
}
/* the main thread: an onset the ISR found becomes an entry, at its own time on the log's clock (frozen: dropped) */
static void cin_onset_log(void)
{
    cin_ent_t *s = &cin_onset, *e;
    uint32_t t = *(volatile uint32_t *)&s->us;
    if (!t)
        return;
    if (cin_log_stop != 1u) {
        uint32_t us = cin_log_clock();
        e = &cin_log[cin_log_w++ % CIN_LOG_N];
        e->us = us - (CIN_LOG_NOW() - t) / FM1_TICKS_PER_US;
        e->v = s->v;
        e->st = CIN_ONSET_ST;
        e->fl = (uint8_t)(cin_log_state() | s->st << 3);
    }
    s->us = 0;
}
static void cin_log_add(uint32_t pkt)
{
    uint32_t st = (pkt >> 8) & 0xFFu, us;
    uint8_t fl;
    cin_ent_t *e;
    cin_onset_log();                            /* (an onset before this message comes first) */
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
/* DIAG 145..147 (main.c m1_diag): 145 the header (messages logged, the ring's size, the entries it holds, frozen | the
 * onset's silence in halves << 8 | its threshold << 16, the log's clock now, the engine's ticks now, the transport's
 * state now, entries made) and the read from the oldest entry; 146 the next 4 entries (8 bytes each: us u32, v u16, st,
 * fl; past the newest: zeros); 147 empties the log */
static uint32_t cin_log_diag(uint32_t page, uint8_t *out)
{
    uint32_t i, held = cin_log_w < CIN_LOG_N ? cin_log_w : CIN_LOG_N;
    if (page == 145u) {
        uint32_t v[8];
        v[0] = cin_log_n;
        v[1] = CIN_LOG_N;
        v[2] = held;
        v[3] = (cin_log_stop == 1u) | CIN_ONSET_QUIET << 8 | CIN_ONSET_THR << 16;
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
    cin_onset.us = 0;
    out[0] = 0;
    return 1u;
}

/* one realtime or system common packet from the MIDI ring (USB-MIDI layout: the status in bits 8..15, data above) */
static void clk_in_rt(uint32_t pkt)
{
    uint32_t rt = (pkt >> 8) & 0xFFu;
    cin_log_add(pkt);
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

/* after each drain: an onset the audio ISR found goes into the log; MIDI clock lets go of the clock half a second after
 * its last tick, unless the transport runs on it */
static void clk_in_idle(void)
{
    cin_onset_log();
    if (midi_clk_seen && (!cfg.clock_in || (fm1_ms - midi_clk_ms > 500u && eng_run_ticks() < 0))) {
        midi_clk_seen = 0;
        eng_clock_external(0);
    }
}
