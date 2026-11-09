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
 * 0x97000). So st_op runs the erase or program in steps: fl_step_ram (hal/fm1_flash_step.h, in RAM, interrupts off, the flash's read path
 * off) starts or resumes it and polls the chip; when the audio interrupt is pending (a half buffer is free) or
 * ST_RUN_MAX has passed, it suspends the chip, waits until the chip reports not busy (WIP 0), turns the read path back
 * on and returns. st_op then lets the interrupts run (the audio renders the half, from the flash, core 1 included: it
 * works only while the audio interrupt waits for it), turns them off and calls the step again, which resumes the chip.
 * The read path comes back on only after the chip said it is not busy, so a chip that ignores the suspend only loses
 * the steps: that write runs to its end with the interrupts off, as before (st_stat.sus_fail), and the audio buffer is
 * zeroed so the hardware does not loop it. Each run between a resume and the next suspend lasts at least ST_RUN_MIN:
 * the datasheet asks for 100 us so that an erase makes progress. The update path (ota_hw.c, the loader) keeps the
 * plain driver in hal/fm1_flash.h. */
static uint8_t flash_ok;                 /* a known JEDEC id at boot (FL_JEDEC_OK) */
#define ST_RUN_MIN (150u * FM1_TICKS_PER_US)    /* the least a resumed erase or program runs before the next suspend */
#define ST_RUN_MAX (450u * FM1_TICKS_PER_US)    /* ... and the most, so the 2 kHz USB poll (TIMER5) is not held back long */
#define ST_SERVE_MAX (250000u * FM1_TICKS_PER_US)   /* a write still running after 250 ms finishes without steps (the
                                                 * watchdog is 8 s) */
#define ST_STEP_JEDEC FL_JEDEC_PUYA      /* the Puya P25Q80H, the one chip the steps were checked on (the test rig, 2026-11-07).
                                          * The UCUN UC25HQ80 (#739) has the same 75h / 7Ah and SUS bits, but its erase needs
                                          * runs of 200 us to make progress, over ST_RUN_MIN: it writes as before #656 until a
                                          * unit of it is checked */
static uint32_t st_jedec;                /* the flash chip's JEDEC id, read at boot (main.c fm1_main) */
static uint8_t st_serve;                 /* the interrupts are on (fm1_main): a write may hand them steps; before, it zeroes the
                                          * audio and keeps them off, as before #656 */
/* DIAG page 128 (#656): the store's flash writes since boot: erases, page programs, the longest stretch with the
 * interrupts off (us), the longest erase and program (us, steps included), the steps handed to the interrupts, writes
 * that ran without steps (before the interrupts were on, a suspend not taken, or longer than ST_SERVE_MAX), suspends the
 * chip did not take */
static struct { uint32_t erases, progs, off_max, erase_max, prog_max, steps, unserved, sus_fail; } st_stat;
/* DIAG page 130 (#729): the longest read window (st_read) and the longest write step (st_op: the whole call to
 * fl_step_ram, the command and its bytes included; DIAG 128's off_max counts from the command's end) with the interrupts
 * off, in TIMER4 ticks, since that page was last read, with the fm1_ms each ended at; and the fm1_ms the last write ended */
static struct { uint32_t rd_max, rd_at, step_max, step_at, wr_end; } st_off;
static int st_read(uint32_t off, void *dst, uint32_t n)   /* 256-byte IRQ-off windows: audio keeps up */
{
    uint8_t *d = dst;
    while (n) {
        uint32_t k = n > 256u ? 256u : n, f = irq_save(), t = fm1_ticks();
        int rc = FL_FAR(fl_read_ram)(off, d, k);
        t = fm1_ticks() - t;
        irq_restore(f);
        if (t > st_off.rd_max) {
            st_off.rd_max = t;
            st_off.rd_at = fm1_ms;
        }
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

/* an erase (op 0x20) or one page's program (op 0x02, src in RAM), in steps the interrupts run between */
static int st_op(uint32_t op, uint32_t off, const uint8_t *src, uint32_t n)
{
    fl_step_t b;
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
    b.run_min = ST_RUN_MIN;
    b.run_max = ST_RUN_MAX;
    b.serve_max = ST_SERVE_MAX;
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
        uint32_t ts;
        fm1__led_lines(0);                      /* (#236) the LED scan stops with the interrupts: one column would stay lit at
                                                 * full duty, a flash of the panel. Dark rows: the tick lights them again */
        ts = fm1_ticks();
        FL_FAR(fl_step_ram)(&b);
        ts = fm1_ticks() - ts;
        if (ts > st_off.step_max) {
            st_off.step_max = ts;
            st_off.step_at = fm1_ms;
        }
        if (b.state == 2u)
            break;
        irq_restore(f);                         /* the chip is suspended: the interrupts run (the audio renders its half) */
        {
            uint32_t tw = fm1_ticks();
            while ((fm1_audio_pending() & FM1_AUDIO_HALF) && fm1_ticks() - tw < 3000u * FM1_TICKS_PER_US)
                ;                               /* (the audio interrupt takes the free half and clears this) */
            while (fm1_ticks() - tw < 5u * FM1_TICKS_PER_US)
                ;                               /* (and the others pending get their turn) */
        }
        f = irq_save();
        st_stat.steps++;
    }
    irq_restore(f);
    st_busy = 0;
    st_off.wr_end = fm1_ms;
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
