/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* FM-1 SPI NOR: an erase or a page program in steps, suspended (75h) for the interrupts and resumed (7Ah), for the
 * app's store (storage_hw.c st_op, #656). Built on fm1_flash.h's helpers; that file, its plain entry points and the
 * update loader that uses them stay as they are.
 *
 * fl_step_ram(b): interrupts off, b in RAM. It starts the write (state 0) or resumes it (state 1) and polls the chip.
 * When b->serve is set and the run since the start or resume has lasted run_min, it suspends the chip once the audio
 * interrupt is pending (ALNK0: a half buffer is free) or run_max has passed, waits until the chip reports not busy
 * (WIP 0, then SUS1 or SUS2 set), turns the read path (XIP) back on and returns with state 1: the caller lets the
 * interrupts run and calls it again. The read path comes back on only after the chip said it is not busy: a chip that
 * does not take the suspend within FL_STEP_SUS_MAX ends the steps for that write (serve 0, sus_fail counted, the
 * audio buffer `quiet` zeroed so the hardware does not loop it), which then runs to its end with the interrupts off.
 * Done: state 2, rc 0, or -1 (outside the store's areas), -2 (continuous-read XIP), -3 (WEL did not set), -4 (timeout).
 *
 * The P25Q80H (JEDEC 85 60 14; datasheet V1.7, 10.36 to 10.38 and table 5-4): erase 8 ms typical, 20 ms at most; a
 * page program 2 to 3 ms; suspend latency 30 us at most; while suspended, everything but the sector or page being
 * written reads; resume sets WIP at once; a run of 100 us or more between a resume and the next suspend lets an erase
 * make progress. Status register 2 holds SUS1 and SUS2 at bits 7 and 2 (S15, S10). */
#pragma once
#include <stdint.h>
#include "fm1_flash.h"
#include "fm1_audio.h"

#define FL_STEP_TIMEOUT (750000u * 24u)  /* TIMER4 ticks from the start: gives up (fl_wait_ready's 500 ms, steps on top) */
#define FL_STEP_SUS_MAX (100u * 24u)     /* the suspend's latency: 30 us at most by the datasheet */
#define FL_SR2_SUS 0x84u                 /* status register 2: SUS1 / SUS2 (S15, S10; the datasheet names them both ways) */

typedef struct {
    uint32_t op, off, n;                 /* 0x20 erase 4 KiB at off, or 0x02 program n bytes (one page) at off */
    uint8_t hdr[4];                      /* the command and its address, as sent */
    const uint8_t *src;                  /* the bytes to program, in RAM */
    volatile int32_t *quiet;             /* the audio buffer, zeroed when a suspend is not taken */
    uint32_t quiet_n;
    uint32_t serve;                      /* 1: suspend for the interrupts; 0: run to the end */
    uint32_t run_min, run_max, serve_max;   /* TIMER4 ticks: the least and most a run lasts before a suspend; from
                                         * serve_max after the start, no more suspends */
    uint32_t state;                      /* 0 not started, 1 suspended, 2 done */
    uint32_t t_start, off_max, sus_fail;
    int rc;
} fl_step_t;

/* fl_step_ram's phases, one bit each (tested with &, never ==: a chain of == the compiler may turn into a table, and a
 * table would be read from the flash): each is one transaction on the flash chip, sent from one place (.ram_text is
 * small) */
#define FP_WREN 0x001u
#define FP_WEL 0x002u
#define FP_CMD 0x004u
#define FP_RESUME 0x008u
#define FP_POLL 0x010u
#define FP_SR2 0x020u
#define FP_SUSPEND 0x040u
#define FP_SUSWAIT 0x080u
#define FP_SUSCHK 0x100u
#define FP_DONE 0x200u
#define FP_READS (FP_WEL | FP_POLL | FP_SR2 | FP_SUSWAIT | FP_SUSCHK)   /* the phases that read a status byte back */

/* one step: start (state 0) or resume (state 1) the write, then poll until it is done (state 2, rc set) or suspended for
 * the interrupts (state 1). IRQs off, args in RAM; no calls (tools/build.py checks), no constants from the flash, no
 * switch or table (it would be read from the flash). Returns with the flash's read path on either way. */
static RAMFN void fl_step_ram(fl_step_t *b)
{
    fl_saved_t s;
    uint32_t t0, ts = 0, i, nh, nd, ph, v;
    if (fl_enter(&s)) {
        b->rc = -2;
        b->state = 2u;
        return;
    }
    t0 = T4_CNT;
    ph = FP_RESUME;
    if (b->state == 0u) {
        ph = FP_WREN;
        if (b->op == 0x20u ? !FL_STORE_OK(b->off, 0x1000u) || (b->off & 0xFFFu)
                           : !FL_STORE_OK(b->off, b->n) || !b->n || ((b->off & 0xFFu) + b->n) > 256u) {
            b->rc = -1;
            ph = FP_DONE;
        }
    }
    while (!(ph & FP_DONE)) {
        uint8_t one = ph & FP_WREN ? 0x06u : ph & FP_RESUME ? 0x7Au : ph & FP_SUSPEND ? 0x75u
                    : ph & (FP_SR2 | FP_SUSCHK) ? 0x35u : 0x05u;
        const uint8_t *h = ph & FP_CMD ? b->hdr : &one;
        nh = ph & FP_CMD ? 4u : 1u;
        nd = ph & FP_CMD && b->op == 0x02u ? b->n : 0u;
        fl_cs(0);
        for (i = 0; i < nh + nd; i++)
            fl_tx(i < nh ? h[i] : b->src[i - nh]);
        v = ph & FP_READS ? fl_rx() : 0u;
        fl_cs(1);
        if (ph & FP_WREN) {
            ph = FP_WEL;
        } else if (ph & FP_WEL) {
            ph = FP_CMD;
            if (!(v & 2u)) {                    /* WEL did not set */
                b->rc = -3;
                ph = FP_DONE;
            }
        } else if (ph & (FP_CMD | FP_RESUME)) {
            t0 = T4_CNT;
            if (ph & FP_CMD)
                b->t_start = t0;
            ph = FP_POLL;
        } else if (ph & FP_POLL) {
            uint32_t t = T4_CNT;
            if (!(v & 1u))
                ph = FP_SR2;                    /* not busy: done, or suspended */
            else if (t - b->t_start > FL_STEP_TIMEOUT) {
                b->rc = -4;
                ph = FP_DONE;
            } else {
                if (b->serve && t - b->t_start > b->serve_max)
                    b->serve = 0u;
                if (b->serve && t - t0 >= b->run_min && (t - t0 >= b->run_max || (FM1_ALNK_CON2 & FM1_AUDIO_HALF)))
                    ph = FP_SUSPEND;
            }
        } else if (ph & FP_SR2) {             /* nothing suspended: done; suspended though no step is open: resume */
            ph = v & FL_SR2_SUS ? FP_RESUME : FP_DONE;
            if (ph & FP_DONE)
                b->rc = 0;
        } else if (ph & FP_SUSPEND) {
            ts = T4_CNT;
            ph = FP_SUSWAIT;
        } else if (ph & FP_SUSWAIT) {
            if (!(v & 1u))
                ph = FP_SUSCHK;
            else if (T4_CNT - ts > FL_STEP_SUS_MAX) {    /* not taken: no more steps; this write runs to its end, the audio
                                                     * buffer zeroed (the hardware would loop it) */
                volatile int32_t *q = b->quiet;
                b->serve = 0u;
                b->sus_fail++;
                for (i = 0; i < b->quiet_n; i++)
                    q[i] = 0;
                ph = FP_POLL;
            }
        } else {                                /* FP_SUSCHK: suspended: the read path back on for the interrupts */
            if (!(v & FL_SR2_SUS)) {
                b->rc = 0;                      /* (it ended before the suspend) */
                ph = FP_DONE;
            } else {
                v = T4_CNT - t0;
                if (v > b->off_max)
                    b->off_max = v;
                b->state = 1u;
                fl_exit(&s);
                return;
            }
        }
    }
    if (!b->rc)
        fl_inval(b->off, b->op == 0x20u ? 0x1000u : b->n);
    b->state = 2u;
    v = T4_CNT - t0;
    if (v > b->off_max)
        b->off_max = v;
    fl_exit(&s);
}
