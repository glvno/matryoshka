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
/* DEV DIAGNOSTIC (#870, the Reel record -> playback turn; a dev build on 1.25.0, never a release, never merged): the log
 * also holds, on the same clock:
 * - each audio onset of the host's USB playback (CIN_ONSET_ST, the onset build of #1150): the first half (128 frames)
 *   whose peak reaches CIN_ONSET_THR after at least CIN_ONSET_QUIET halves below it. The audio ISR hands each half's peak
 *   (usb_return.h ur_mix) to cin_onset_block; the onset's state sits in the ring's last entry (cin_onset); the main
 *   thread logs it at its time, the half's mix into the output;
 * - the USB audio events usb.c reports from the TIMER5 interrupt (cin_ev; modular.c UAC_EV, only while the engine runs,
 *   since an update session takes the ring's buffer with the engine stopped): CIN_EV_USB a request or a bus event (v: its
 *   code | its value << 8), CIN_EV_Q a playback queue event (v: its code | a count << 8), both with the playback queue's
 *   fill / 2 in fl; CIN_EV_WIN the queue's lowest and highest fill / 2 over 100 ms (v: lowest | highest << 8; fl: bit 0
 *   playing, bit 1 the recording interface at alt 1, bit 2 the host reads it, bits 3..7 the windows like it folded into
 *   it after it, each within 2 of its lowest and highest); CIN_EV_FB the explicit feedback sent (v: its value - 44.1
 *   frames a millisecond, in 1/16384 frames, signed; fl: the feedback packets the host took in the window). The codes:
 *   usb.c UE_* and UQ_*. At most CIN_EV_Q_MAX queue events a window; the rest are only counted (DIAG 145 word 6).
 * A message's time is when it came into the MIDI ring (midi_in_at), not when the main loop took it. Steady clocks fold
 * into the newest clock entry and like windows into the newest window entry, whatever came between. After a Stop,
 * CIN_LOG_AFTER more messages or events, then frozen; and once the log holds a Start, a bus reset after more than 2 s
 * with no host (the cable moved to the Mac to read the log) freezes it at once. A Start or Continue lets it run again. */
#ifndef CIN_LOG_NOW
#define CIN_LOG_NOW() fm1_ticks()               /* (TIMER4: the log's clock and CLOCK IN DELAY's) */
#endif
#ifndef CIN_LOCK
#define CIN_LOCK() ((void)0)                    /* the main thread's log writes against the TIMER5 interrupt's (modular.c) */
#define CIN_UNLOCK() ((void)0)
#endif
#define CIN_T(ticks) ((uint16_t)((ticks) >> 10))   /* TIMER4 in units of 1024 ticks: 42.7 us, wrapping every 2.8 s */
#define CIN_T_MS(ms) (((uint32_t)(ms) * 1000u * FM1_TICKS_PER_US + 1023u) >> 10)   /* ms in those units, rounded up (the
                                                * stamp rounds down: a message goes within one unit of its time) */
#define CIN_LOG_N 255u                          /* (+1: the onset's state, cin_onset) */
#define CIN_LOG_AFTER 64u
#define CIN_LOG_FMT 0xD1u                       /* DIAG 145 word 1's top byte: this build's entries (m1_link.py midilog) */
#define CIN_ONSET_ST 0x01u                      /* an audio onset's entry (not a MIDI status) */
#define CIN_ONSET_THR 256u                      /* sound: a sample of either side at +256 / -257 of 32768 or beyond (-42
                                                 * dBFS); a power of two, which the OR peak compares exactly */
#define CIN_ONSET_QUIET 69u                     /* halves of silence before an onset (128 frames each: 200 ms) */
#define CIN_EV_USB 0x10u                        /* the USB audio events' entries (usb.c's kinds UR_EV_*, the same) */
#define CIN_EV_Q 0x11u
#define CIN_EV_WIN 0x20u
#define CIN_EV_FB 0x21u
#define CIN_EV_RESET 4u                         /* CIN_EV_USB's code for a bus reset (usb.c UE_RESET); value 1: after > 2 s
                                                 * with no host */
#define CIN_EV_Q_MAX 8u                         /* queue events logged a window */
#ifdef UR_EV_USB
_Static_assert(UR_EV_USB == CIN_EV_USB && UR_EV_Q == CIN_EV_Q && UR_EV_WIN == CIN_EV_WIN && UR_EV_FB == CIN_EV_FB &&
               UE_RESET == CIN_EV_RESET, "usb.c's event kinds and reset code are the log's");
#endif
typedef struct {
    uint32_t us;                                /* microseconds (the log's own clock: wraps after 71 minutes) */
    uint16_t v;                                 /* Start / Stop / Continue / audio onset: the engine's ticks (low 16 bits);
                                                 * Song Position: its value; a clock: from its first to its last clock, in
                                                 * units of 100 us; a USB audio event: see above */
    uint8_t st;                                 /* the status byte: F2, F8, FA, FB, FC; CIN_ONSET_ST an audio onset; CIN_EV_*
                                                 * a USB audio event */
    uint8_t fl;                                 /* bit 0 the transport runs (eng_run_ticks), 1 MIDI clock drives, 2 CLOCK IN on;
                                                 * a clock: bits 3..7 the clocks folded into it after it; an audio onset:
                                                 * bits 3..7 the bits of its half's peak (the peak is below 2^bits); a USB
                                                 * audio event: see above */
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
static uint32_t cin_log_kclk, cin_log_kwin;     /* the newest clock entry's and window entry's number + 1 (0: none) */
static uint32_t cin_log_lost;                   /* queue events not logged (over CIN_EV_Q_MAX in their window) */
static uint8_t cin_log_qn;                      /* queue events logged in this window */
static uint8_t cin_log_started;                 /* a Start or Continue logged (since boot or the last DIAG 147) */
static uint8_t cin_log_frz;                     /* frozen by a bus reset after the cable moved */
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
/* the audio ISR (modular.c UR_ONSET, with the engine running): one half of the host's playback, pk its peak (ur_mix).
 * Out of line: inlined, it would grow the ISR's copy in NOINIT (build.py FAST_TEXT), which has little room */
static void __attribute__((noinline)) cin_onset_block(uint32_t pk)
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
    CIN_LOCK();
    if (cin_log_stop != 1u) {
        uint32_t us = cin_log_clock();
        e = &cin_log[cin_log_w++ % CIN_LOG_N];
        e->us = us - (CIN_LOG_NOW() - t) / FM1_TICKS_PER_US;
        e->v = s->v;
        e->st = CIN_ONSET_ST;
        e->fl = (uint8_t)(cin_log_state() | s->st << 3);
    }
    s->us = 0;
    CIN_UNLOCK();
}
/* the entry numbered k + 1 (cin_log_kclk, cin_log_kwin) if it is still in the ring, else 0 */
static cin_ent_t *cin_log_kept(uint32_t k1)
{
    return k1 && cin_log_w - k1 < CIN_LOG_N ? &cin_log[(k1 - 1u) % CIN_LOG_N] : 0;
}
/* the main thread: a realtime or Song Position message that came into the MIDI ring at `at` (CIN_T) */
static void cin_log_add(uint32_t pkt, uint16_t at)
{
    uint32_t st = (pkt >> 8) & 0xFFu, us, age;
    uint8_t fl;
    cin_ent_t *e;
    cin_onset_log();                            /* (an onset before this message comes first) */
    CIN_LOCK();
    if (st == 0xFAu || st == 0xFBu) {
        cin_log_stop = 0;
        cin_log_started = 1;
    } else if (cin_log_stop == 1u) {
        goto out;
    } else if (cin_log_stop) {
        cin_log_stop--;
    }
    cin_log_n++;
    us = cin_log_clock();
    age = (uint16_t)(CIN_T(CIN_LOG_NOW()) - at);
    if (age < CIN_T_MS(1000u))                  /* (its arrival; a stamp older than that is not one to trust) */
        us -= age * 1024u / FM1_TICKS_PER_US;
    fl = cin_log_state();
    if (st == 0xF8u) {
        uint32_t gap = us - cin_log_clk, was = cin_log_gap;
        cin_log_clk = us;
        cin_log_gap = gap;
        e = cin_log_kept(cin_log_kclk);
        if (e && (e->fl & 7u) == fl && (e->fl >> 3) < 31u && was && gap + was / 4u >= was && gap <= was + was / 4u) {
            e->fl = (uint8_t)(e->fl + 8u);      /* (a steady clock: one more in the newest clock entry) */
            e->v = (uint16_t)((us - e->us) / 100u < 65535u ? (us - e->us) / 100u : 65535u);
            goto out;
        }
    }
    e = &cin_log[cin_log_w++ % CIN_LOG_N];
    e->us = us;
    e->st = (uint8_t)st;
    e->v = st == 0xF2u ? (uint16_t)(((pkt >> 16) & 0x7Fu) | ((pkt >> 24) & 0x7Fu) << 7) : st == 0xF8u ? 0u : (uint16_t)eng_ticks();
    e->fl = fl;
    cin_log_kclk = st == 0xF8u ? cin_log_w : 0u;   /* (any other message ends the clock run: none folds across it) */
    if (st == 0xFCu)
        cin_log_stop = CIN_LOG_AFTER + 1u;
out:
    CIN_UNLOCK();
}
/* the TIMER5 interrupt (usb.c through modular.c UAC_EV, with the engine running): a USB audio event, logged now. Nothing
 * else writes the log meanwhile: the main thread writes with the interrupts off, the audio ISR only the onset's state */
static void cin_ev(uint32_t st, uint32_t v, uint32_t fl)
{
    cin_ent_t *e;
    uint32_t frz = 0;
    if (cin_log_stop == 1u)
        return;
    if (st == CIN_EV_WIN) {
        cin_log_qn = 0;                         /* (a window: the next one's queue events start counting) */
        e = cin_log_kept(cin_log_kwin);
        if (e && !((e->fl ^ fl) & 7u) && (e->fl >> 3) < 31u && (v & 0xFFu) + 2u - (e->v & 0xFFu) <= 4u &&
            (v >> 8) + 2u - (e->v >> 8) <= 4u) {
            e->fl = (uint8_t)(e->fl + 8u);      /* (a window like the newest one's: folded into it) */
            return;
        }
    } else if (st == CIN_EV_Q && ++cin_log_qn > CIN_EV_Q_MAX) {
        cin_log_lost++;
        return;
    } else if (st == CIN_EV_USB && (v & 0xFFu) == CIN_EV_RESET && (v >> 8) && cin_log_started) {
        frz = 1;
    }
    if (cin_log_stop)
        cin_log_stop--;                         /* (after a Stop, an event counts as a message does) */
    e = &cin_log[cin_log_w++ % CIN_LOG_N];
    e->us = cin_log_clock();
    e->v = (uint16_t)v;
    e->st = (uint8_t)st;
    e->fl = (uint8_t)fl;
    if (st == CIN_EV_WIN)
        cin_log_kwin = cin_log_w;
    else if (st != CIN_EV_FB)
        cin_log_kwin = 0;                       /* (a request, bus or queue event ends the window run) */
    if (frz) {
        cin_log_stop = 1u;
        cin_log_frz = 1u;
    }
}
/* DIAG 145..147 (main.c m1_diag): 145 the header (messages logged; the ring's size | CLOCK IN DELAY (ms) << 16 |
 * CIN_LOG_FMT << 24; the entries it holds; frozen | frozen by a bus reset << 1 | the onset's silence in halves << 8 |
 * its threshold << 16; the log's clock now; the engine's ticks now; the transport's state now | queue events not logged
 * << 8; entries made) and the read from the oldest entry; 146 the next 4 entries (8 bytes each: us u32, v u16, st, fl;
 * past the newest: zeros); 147 empties the log */
static uint32_t cin_log_diag(uint32_t page, uint8_t *out)
{
    uint32_t i, held, n = 32u;
    CIN_LOCK();
    held = cin_log_w < CIN_LOG_N ? cin_log_w : CIN_LOG_N;
    if (page == 145u) {
        uint32_t v[8];
        v[0] = cin_log_n;
        v[1] = CIN_LOG_N | (uint32_t)cfg.clock_delay << 16 | CIN_LOG_FMT << 24;
        v[2] = held;
        v[3] = (cin_log_stop == 1u) | (uint32_t)cin_log_frz << 1 | CIN_ONSET_QUIET << 8 | CIN_ONSET_THR << 16;
        v[4] = cin_log_clock();
        v[5] = eng_ticks();
        v[6] = cin_log_state() | cin_log_lost << 8;
        v[7] = cin_log_w;
        cin_log_rd = cin_log_w - held;
        for (i = 0; i < 32u; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
    } else if (page == 146u) {
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
    } else {                                    /* 147 */
        cin_log_w = cin_log_rd = cin_log_n = cin_log_gap = cin_log_kclk = cin_log_kwin = cin_log_lost = 0;
        cin_log_stop = cin_log_started = cin_log_frz = cin_log_qn = 0;
        cin_onset.us = 0;
        out[0] = 0;
        n = 1u;
    }
    CIN_UNLOCK();
    return n;
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
    cin_log_add(pkt, at);
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

/* after each drain: an onset the audio ISR found goes into the log; CLOCK IN DELAY's messages that are due, in order;
 * then MIDI clock lets go of the clock half a second after its last tick, unless the transport runs on it. An entry more
 * than the longest delay ahead is due too: it is one that waited a whole wrap of CIN_T (2.8 s) behind a main loop that
 * did not drain the ring (an update session) */
static void clk_in_idle(void)
{
    cin_onset_log();
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
