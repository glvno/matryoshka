/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments */
/* The firmware side of storage.c (FELUCCA_FLASH): flash reads in short IRQ-off windows so the
 * audio keeps up, erases and writes only inside the storage areas, the audio buffer silenced
 * first. The host tests (storage_test.c) provide their own st_* on a simulated NOR. */
static uint8_t flash_ok;                 /* JEDEC id matched at boot (persist_boot) */
/* DIAG page 128 (#656): the store's flash writes since boot: erases and page programs, the longest stretch with the
 * interrupts off (us), the longest erase / program (us) */
static struct { uint32_t erases, progs, off_max, erase_max, prog_max; } st_stat;
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
static int st_erase(uint32_t off)
{
    uint32_t took, f;
    int rc;
    if (!FL_STORE_OK(off, 0x1000u))
        return -8;
    uint32_t t0 = fm1_ticks(), dt;
    f = irq_save();
    audio_silence();
    fm1__led_lines(0);                          /* (#236) the erase stops the LED scan for ~17 ms (the IRQs are off and its code */
    rc = FL_FAR(fl_erase4k_ram)(off, &took);    /* is in the flash): one column would stay lit at full duty and the rest dark, a */
    irq_restore(f);                             /* flash of the whole panel. Dark rows: the panel just drops out; the tick lights */
    dt = (fm1_ticks() - t0) / FM1_TICKS_PER_US; /* the rows again at its next pass */
    st_stat.erases++;
    if (dt > st_stat.off_max)
        st_stat.off_max = dt;
    if (dt > st_stat.erase_max)
        st_stat.erase_max = dt;
    return rc;
}
/* fl_write reads its source with XIP off: a source in the flash (.rodata: a factory patch, presetstore's zero word) hangs
 * the CPU on a cache miss (a preset delete froze the FM-1), so every write goes through a RAM copy, a page at a time */
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
        {
            uint32_t t0 = fm1_ticks(), dt;
            rc = fl_write(off, bounce, k);
            dt = (fm1_ticks() - t0) / FM1_TICKS_PER_US;
            st_stat.progs++;
            if (dt > st_stat.off_max)
                st_stat.off_max = dt;
            if (dt > st_stat.prog_max)
                st_stat.prog_max = dt;
        }
        if (rc)
            return rc;
        off += k;
        s += k;
        n -= k;
    }
    return 0;
}
