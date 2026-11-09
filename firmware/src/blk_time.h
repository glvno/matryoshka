/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* What an audio block's time is made of (#802, #803), measured: DIAG pages 132..139 (main.c m1_diag), read with
 * tools/m1_link.py blocktime. Read only: TIMER4 (24 MHz) timestamps at the seams of the audio interrupt (audio.c), around
 * the voices' render (engine.c ENG_TMARK, three marks), at the hand-off to the second core and core 0's wait for it
 * (modular.c eng_lane_run, eng_lane_wait), on the second core around its job (bt_c1_job), and at the end of TIMER5's
 * interrupt (main.c). At the end of each rendered half the ISR turns the marks into spans and adds them to running sums
 * and maxima (bt_block); reading page 132 takes that window and starts the next. Nothing here changes what is rendered,
 * in which order or on which core.
 *
 * Its own cost, on core 0 in the audio ISR: 8 TIMER4 reads, 3 more in the engine, 4 per job handed to the second core,
 * and bt_block's sums (its time is a span of its own, BT_SELF, from the block before); on the second core 2 reads per job;
 * in TIMER5's interrupt 1 read (it already read the timer at its start). Page 139 measures a read's cost. */
#pragma once
#include <stdint.h>
#ifndef BT_POOL
#define BT_POOL                 /* modular.c: the pool (.pool, zeroed at boot), as the RAM region has no room to spare */
#endif

enum {                  /* the spans of one block, in ticks of TIMER4 */
    BT_ENTRY,           /* the ISR's start to the half chosen: the pending flags, their ack, the free half */
    BT_PRE,             /* USB audio's render start (uac_render_start: the ring's fill) and the guard's shed */
    BT_ENG_PRE,         /* eng_render up to the voices: the clock, the arpeggiators, the parts' flaws, the idle checks */
    BT_VOICES,          /* the voices: render_split, every module of the patch (both cores) */
    BT_ENG_POST,        /* after them: idle detection, the triggers, the group cables */
    BT_ENG_OUT,         /* the Output modules' sum into the block and the clamp */
    BT_MIX,             /* MASTER and the patch level to the I2S words, the loudness check, the test meter */
    BT_CLK,             /* MIDI clock out's ticks (clk_out_block) */
    BT_UAC,             /* USB audio's tap (uac_tap: the half into the ring, 16 bit; nothing while no host reads) */
    BT_TAIL,            /* the count-in's click, OUTPUT's mono fold, 3.5MM OUT, the half's ack */
    BT_GUARD,           /* the overload guard and its counters, up to bt_block */
    BT_ISR,             /* the whole ISR in C, its first line to bt_block */
    BT_T5_IN,           /* TIMER5's interrupts nested in this ISR (their C bodies; they are inside the spans above too) */
    BT_T5_OUT,          /* TIMER5's interrupts outside the audio ISR since the block before (C bodies) */
    BT_SELF,            /* bt_block itself, the block before's */
    BT_HAND,            /* core 0 handing segments to the second core (eng_lane_run) */
    BT_WAIT,            /* core 0 waiting for the second core (eng_lane_wait) */
    BT_C0_BUSY,         /* core 0 in the voices, less its waits */
    BT_C1_BUSY,         /* the second core in its jobs */
    BT_C1_IDLE,         /* the second core waiting for work while the voices render (BT_VOICES less BT_C1_BUSY) */
    BT_N
};
enum { BT_M_IN, BT_M_T0, BT_M_REND0, BT_M_REND1, BT_M_MIX1, BT_M_CLK1, BT_M_TAP1, BT_M_ACK1, BT_M_N };   /* audio.c's marks */
#define BT_BLOCKS_MAX 61000u    /* a window's sums stay in 32 bits up to here (61,000 full halves, 177 s): then it stops */

typedef struct {
    uint32_t sum[BT_N], max[BT_N];
    uint32_t blocks;            /* halves rendered and counted */
    uint32_t stopped;           /* halves with the engine stopped (eng_run 0): not counted */
    uint32_t jobs, refused;     /* segments the second core took; hand-offs it did not take (off, held, split off) */
    uint32_t gave_up;           /* waits that gave the second core up (core 0 rendered its lane) */
    uint32_t parts[2];          /* the awake parts of the segments handed over: core 0's lane (even), core 1's (odd) */
    uint32_t jobs_max;          /* the most segments handed over in one block */
    uint32_t lat_sum, lat_max;  /* a job's hand-off: core 0 starting it to the second core starting it */
    uint32_t job_max;           /* the longest job on the second core */
    uint32_t t5_in, t5_out;     /* TIMER5 interrupts nested in the audio ISR, and outside it (main.c fills them) */
    uint32_t t5_max;            /* the longest TIMER5 interrupt (its C body) */
    uint32_t ms0;               /* fm1_ms when the window began (main.c) */
} bt_acc_t;
static bt_acc_t bt BT_POOL;                             /* the running window (the audio ISR; main.c takes it with the interrupts off) */
static uint32_t bt_m[BT_M_N] BT_POOL;                   /* this half's marks (audio.c) */
static uint32_t bt_eng[3] BT_POOL;                      /* the engine's (modular.c ENG_TMARK): before the voices, after them,
                                                 * before the Output sum */
static volatile uint8_t bt_in_audio BT_POOL;            /* the audio ISR runs (TIMER5's interrupt nests in it) */
static uint32_t bt_hand BT_POOL, bt_wait BT_POOL, bt_c0_jobs BT_POOL, bt_self BT_POOL, bt_t5_in_seen BT_POOL,
    bt_t5_out_seen BT_POOL;
/* TIMER5's interrupt (main.c), the only writer: since boot, its C bodies' ticks and count, nested and outside */
static volatile uint32_t bt_t5_in_ticks BT_POOL, bt_t5_in_n BT_POOL, bt_t5_out_ticks BT_POOL, bt_t5_out_n BT_POOL;

/* the second core's side: its job runs fn (render_split's lane1_job) between two reads of the timer */
static void (*volatile bt_c1_fn)(uint32_t) BT_POOL;
static volatile uint32_t bt_c1_start BT_POOL, bt_c1_busy BT_POOL;   /* its last job's start; its jobs' ticks this block */
static uint32_t bt_hand_t BT_POOL, bt_busy0 BT_POOL;            /* core 0: when it began handing over the last job; bt_c1_busy then */
static void bt_c1_job(uint32_t arg)             /* (on the second core) */
{
    uint32_t t0 = fm1_ticks();
    bt_c1_start = t0;
    bt_c1_fn(arg);
    bt_c1_busy += fm1_ticks() - t0;
}

static inline void bt_span(uint32_t k, uint32_t d)
{
    bt.sum[k] += d;
    if (d > bt.max[k])
        bt.max[k] = d;
}

/* core 0, eng_lane_run: a hand-off begins (the second core is idle: every job before was waited for) */
static inline uint32_t bt_hand_begin(void)
{
    bt_busy0 = bt_c1_busy;
    return bt_hand_t = fm1_ticks();
}

/* core 0, eng_lane_run: the hand-off that began at t0, taken or not */
static inline void bt_handed(uint32_t t0, int took)
{
    bt_hand += fm1_ticks() - t0;
    if (took)
        bt_c0_jobs++;
    else
        bt.refused++;
}

/* core 0, eng_lane_wait: a wait that began at t0; rc its answer (0: the job is done) */
static inline void bt_waited(uint32_t t0, int rc)
{
    uint32_t lat = bt_c1_start - bt_hand_t, job = bt_c1_busy - bt_busy0;
    bt_wait += fm1_ticks() - t0;
    if (rc != 0) {
        bt.gave_up++;
        return;
    }
    if ((int32_t)lat < 0)
        lat = 0;
    bt.lat_sum += lat;
    if (lat > bt.lat_max)
        bt.lat_max = lat;
    if (job > bt.job_max)
        bt.job_max = job;
}

/* TIMER5's interrupt, at its end (t0: its start) */
static inline void bt_t5(uint32_t t0)
{
    uint32_t d = fm1_ticks() - t0;
    if (bt_in_audio) {
        bt_t5_in_ticks += d;
        bt_t5_in_n++;
    } else {
        bt_t5_out_ticks += d;
        bt_t5_out_n++;
    }
    if (d > bt.t5_max)
        bt.t5_max = d;
}

/* the audio ISR's last step: this half's spans into the window (rendered: the engine ran; the engine's marks are this
 * half's) */
static void bt_block(int rendered)
{
    uint32_t t = fm1_ticks(), *m = bt_m, voices, c1, in, out, jobs = bt_c0_jobs;
    in = bt_t5_in_ticks;
    out = bt_t5_out_ticks;
    if (rendered && bt.blocks < BT_BLOCKS_MAX) {
        bt.blocks++;
        bt_span(BT_ENTRY, m[BT_M_T0] - m[BT_M_IN]);
        bt_span(BT_PRE, m[BT_M_REND0] - m[BT_M_T0]);
        bt_span(BT_ENG_PRE, bt_eng[0] - m[BT_M_REND0]);
        voices = bt_eng[1] - bt_eng[0];
        bt_span(BT_VOICES, voices);
        bt_span(BT_ENG_POST, bt_eng[2] - bt_eng[1]);
        bt_span(BT_ENG_OUT, m[BT_M_REND1] - bt_eng[2]);
        bt_span(BT_MIX, m[BT_M_MIX1] - m[BT_M_REND1]);
        bt_span(BT_CLK, m[BT_M_CLK1] - m[BT_M_MIX1]);
        bt_span(BT_UAC, m[BT_M_TAP1] - m[BT_M_CLK1]);
        bt_span(BT_TAIL, m[BT_M_ACK1] - m[BT_M_TAP1]);
        bt_span(BT_GUARD, t - m[BT_M_ACK1]);
        bt_span(BT_ISR, t - m[BT_M_IN]);
        bt_span(BT_T5_IN, in - bt_t5_in_seen);
        bt_span(BT_T5_OUT, out - bt_t5_out_seen);
        bt_span(BT_SELF, bt_self);
        bt_span(BT_HAND, bt_hand);
        bt_span(BT_WAIT, bt_wait);
        bt_span(BT_C0_BUSY, voices > bt_wait ? voices - bt_wait : 0u);
        c1 = bt_c1_busy;
        bt_span(BT_C1_BUSY, c1);
        bt_span(BT_C1_IDLE, voices > c1 ? voices - c1 : 0u);
        bt.jobs += jobs;
        if (jobs > bt.jobs_max)
            bt.jobs_max = jobs;
    } else if (!rendered)
        bt.stopped++;
    bt_t5_in_seen = in;
    bt_t5_out_seen = out;
    bt_hand = bt_wait = bt_c0_jobs = 0;
    bt_c1_busy = 0;
    bt_in_audio = 0;
    bt_self = fm1_ticks() - t;
}
