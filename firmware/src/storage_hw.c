/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Matryoshka (glvno). */
/* The firmware side of storage.c (FELUCCA_FLASH): flash reads in short IRQ-off windows so the audio keeps up, erases and
 * writes only inside the storage areas. The host tests (storage_test.c) provide their own st_* on a simulated NOR.
 *
 * Writes that keep the sound (#656). While the flash chip erases or programs, nothing can be read from it, and the code
 * and constant tables of everything the interrupts run (the audio render on both cores, the key scan, USB) are in the
 * flash. So a write used to keep the interrupts off for its whole length: an erase is 8 ms typical, 20 ms at most
 * (P25Q80H datasheet, the chip's JEDEC id 85 60 14), a page program 2 to 3 ms, and the audio stopped for the store's
 * write. The chip can suspend an erase or a program (75h) and resume it (7Ah); while suspended, every sector but the one
 * being written reads as normal (the store's sectors hold no code: the code ends below 0x93000, the store starts at
 * 0x97000). So st_op runs the erase or program in steps: fl_op_step (in RAM, interrupts off, the flash's read path
 * off) starts or resumes it and polls the chip; when the audio interrupt is pending (a half buffer is free) or
 * ST_RUN_MAX has passed, it suspends the chip, waits until the chip reports not busy (WIP 0), turns the read path back
 * on and returns. st_op then lets the interrupts run (the audio renders the half, from the flash, core 1 included: it
 * works only while the audio interrupt waits for it), turns them off and calls the step again, which resumes the chip.
 * The read path comes back on only after the chip said it is not busy, so a chip that ignores the suspend only loses
 * the steps: that write runs to its end with the interrupts off, as before (st_stat.sus_fail), and the audio buffer is
 * zeroed so the hardware does not loop it. Each run between a resume and the next suspend lasts at least ST_RUN_MIN:
 * the datasheet asks for 100 us so that an erase makes progress. The update path (ota_hw.c, the loader) keeps the
 * plain driver in hal/fm1_flash.h. */
static uint8_t flash_ok;                 /* JEDEC id matched at boot (persist_boot) */
static uint8_t st_serve;                 /* the interrupts are on (fm1_main): a write may hand them steps; before, it zeroes the
                                          * audio and keeps them off, as before #656 */
/* DIAG page 128 (#656): the store's flash writes since boot: erases, page programs, the longest stretch with the
 * interrupts off (us), the longest erase and program (us, steps included), the steps handed to the interrupts, writes
 * that ran without steps (before the interrupts were on, a suspend not taken, or longer than ST_SERVE_MAX), suspends the
 * chip did not take */
static struct { uint32_t erases, progs, off_max, erase_max, prog_max, steps, unserved, sus_fail; } st_stat;
static int st_read(uint32_t off, void *dst, uint32_t n)   /* 256-byte IRQ-off windows: audio keeps up */
{
    uint8_t *d = dst;
    while (n) {
        uint32_t k = n > 256u ? 256u : n, f = irq_save();
        int rc = FL_FAR(fl_read_ram)(off, d, k);
        irq_restore(f);
        if (rc)
            return rc;
        off += k;
        d += k;
        n -= k;
    }
    return 0;
}
static void audio_silence(void)                 /* IRQs off: the DMA would loop stale audio (buzz) */
{
    uint32_t i;
    for (i = 0; i < sizeof abuf / sizeof abuf[0]; i++)
        abuf[i] = 0;
}

#define ST_RUN_MIN (150u * 24u)          /* TIMER4 ticks: the least a resumed erase or program runs before the next suspend */
#define ST_RUN_MAX (450u * 24u)          /* ... and the most, so the 2 kHz USB poll (TIMER5) is not held back long */
#define ST_SERVE_MAX (250000u * 24u)     /* a write still running after 250 ms finishes without steps (the watchdog is 8 s) */
#define ST_TIMEOUT (750000u * 24u)       /* gives up (as fl_wait_ready's 500 ms did, with the steps on top) */
#define ST_SUS_MAX (100u * 24u)          /* the suspend's latency: 30 us at most by the datasheet */
#define ST_SR2_SUS 0x84u                 /* status register 2: SUS1 / SUS2 (S15, S10; the datasheet names them both ways) */
#define ST_ALNK_CON2 (*(volatile uint8_t *)0x12E08u)   /* fm1_audio.h FM1_ALNK_CON2: bit 7, a half buffer is free */

typedef struct {
    uint32_t op, off, n;                 /* 0x20 erase 4 KiB at off, or 0x02 program n bytes (one page) at off */
    uint8_t hdr[4];                      /* the command and its address, as sent */
    const uint8_t *src;                  /* the bytes to program, in RAM */
    volatile int32_t *quiet;             /* the audio buffer, zeroed when a suspend is not taken */
    uint32_t quiet_n;
    uint32_t serve;                      /* 1: suspend for the interrupts; 0: run to the end */
    uint32_t state;                      /* 0 not started, 1 suspended, 2 done */
    uint32_t t_start, off_max, sus_fail;
    int rc;
} st_op_t;

/* fl_op_step's phases, one bit each (tested with &, never ==: a chain of == the compiler may turn into a table, and a
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
static RAMFN void fl_op_step(st_op_t *b)
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
            else if (t - b->t_start > ST_TIMEOUT) {
                b->rc = -4;
                ph = FP_DONE;
            } else {
                if (b->serve && t - b->t_start > ST_SERVE_MAX)
                    b->serve = 0u;
                if (b->serve && t - t0 >= ST_RUN_MIN && (t - t0 >= ST_RUN_MAX || (ST_ALNK_CON2 & 0x80u)))
                    ph = FP_SUSPEND;
            }
        } else if (ph & FP_SR2) {             /* nothing suspended: done; suspended though no step is open: resume */
            ph = v & ST_SR2_SUS ? FP_RESUME : FP_DONE;
            if (ph & FP_DONE)
                b->rc = 0;
        } else if (ph & FP_SUSPEND) {
            ts = T4_CNT;
            ph = FP_SUSWAIT;
        } else if (ph & FP_SUSWAIT) {
            if (!(v & 1u))
                ph = FP_SUSCHK;
            else if (T4_CNT - ts > ST_SUS_MAX) {    /* not taken: no more steps; this write runs to its end, the audio
                                                     * buffer zeroed (the hardware would loop it) */
                volatile int32_t *q = b->quiet;
                b->serve = 0u;
                b->sus_fail++;
                for (i = 0; i < b->quiet_n; i++)
                    q[i] = 0;
                ph = FP_POLL;
            }
        } else {                                /* FP_SUSCHK: suspended: the read path back on for the interrupts */
            if (!(v & ST_SR2_SUS)) {
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

/* an erase (op 0x20) or one page's program (op 0x02, src in RAM), in steps the interrupts run between */
static int st_op(uint32_t op, uint32_t off, const uint8_t *src, uint32_t n)
{
    st_op_t b;
    uint32_t f, t0 = fm1_ticks(), dt;
    b.op = op;
    b.off = off;
    b.hdr[0] = (uint8_t)op;
    b.hdr[1] = (uint8_t)(off >> 16);
    b.hdr[2] = (uint8_t)(off >> 8);
    b.hdr[3] = (uint8_t)off;
    b.src = src;
    b.n = n;
    b.quiet = abuf;
    b.quiet_n = sizeof abuf / sizeof abuf[0];
    b.serve = st_serve;
    b.state = 0;
    b.t_start = 0;
    b.off_max = 0;
    b.sus_fail = 0;
    b.rc = 0;
    st_busy = 1;
    f = irq_save();
    if (!b.serve)
        audio_silence();
    for (;;) {
        fm1__led_lines(0);                      /* (#236) the LED scan stops with the interrupts: one column would stay lit at
                                                 * full duty, a flash of the panel. Dark rows: the tick lights them again */
        FL_FAR(fl_op_step)(&b);
        if (b.state == 2u)
            break;
        irq_restore(f);                         /* the chip is suspended: the interrupts run (the audio renders its half) */
        {
            uint32_t tw = fm1_ticks();
            while ((ST_ALNK_CON2 & 0x80u) && fm1_ticks() - tw < 3000u * FM1_TICKS_PER_US)
                ;                               /* (the audio interrupt takes the free half and clears this) */
            while (fm1_ticks() - tw < 5u * FM1_TICKS_PER_US)
                ;                               /* (and the others pending get their turn) */
        }
        f = irq_save();
        st_stat.steps++;
    }
    irq_restore(f);
    st_busy = 0;
    dt = (fm1_ticks() - t0) / FM1_TICKS_PER_US;
    if (b.off_max / FM1_TICKS_PER_US > st_stat.off_max)
        st_stat.off_max = b.off_max / FM1_TICKS_PER_US;
    if (op == 0x20u) {
        st_stat.erases++;
        if (dt > st_stat.erase_max)
            st_stat.erase_max = dt;
    } else {
        st_stat.progs++;
        if (dt > st_stat.prog_max)
            st_stat.prog_max = dt;
    }
    st_stat.unserved += !b.serve;
    st_stat.sus_fail += b.sus_fail;
    return b.rc;
}

static int st_erase(uint32_t off)
{
    if (!FL_STORE_OK(off, 0x1000u))
        return -8;
    return st_op(0x20u, off, 0, 0x1000u);
}
/* the program reads its source with the read path off: a source in the flash (.rodata: a factory patch, presetstore's zero
 * word) hangs the CPU on a cache miss (a preset delete froze the FM-1), so every write goes through a RAM copy, a page at
 * a time */
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    static uint8_t bounce[256];
    const uint8_t *s = src;
    if (!FL_STORE_OK(off, n))                   /* only inside the storage areas */
        return -8;
    while (n) {
        uint32_t k = 256u - (off & 0xFFu), i;
        int rc;
        if (k > n)
            k = n;
        for (i = 0; i < k; i++)
            bounce[i] = s[i];
        if ((rc = st_op(0x02u, off, bounce, k)))
            return rc;
        off += k;
        s += k;
        n -= k;
    }
    return 0;
}
