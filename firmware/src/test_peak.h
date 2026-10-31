/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The device test mode's output meter (TEST_PEAK, #291): the loudest sample since the last read, 16 bit, before the
 * MASTER pot. The audio ISR adds each rendered half (tp_block); the main loop reads and restarts it (tp_take, proto.c's
 * TEST_PEAK). firmware/test/peak_test.c checks it with the ISR landing between any two of the reader's steps.
 *
 * Two accumulators, and `tp_cur` says which one the ISR fills. A read flips `tp_cur` first, then takes the other one
 * (#385). The ISR never runs in the middle of the reader's steps, only between them, and it reads `tp_cur` afresh each
 * time. So once the flip is done, nothing writes the accumulator the reader takes. A half that lands before the flip
 * counts in this read; one that lands after it counts in the next. Before this, the reader read the peak and then
 * zeroed it: a half that landed between those two steps was lost from both reads. No interrupt is masked.
 * TP_STEP() marks the steps for the host test (empty in the firmware). */
#ifndef TP_STEP
#define TP_STEP()
#endif

static volatile uint8_t tp_on;                     /* a script asked for the level: the ISR keeps it (no cost before) */
static volatile uint8_t tp_cur;                    /* the accumulator the ISR fills: 0 or 1 */
static volatile uint32_t tp_acc[2];                /* the loudest sample since the read that chose this accumulator */

/* audio ISR: one rendered half (Q16 +-1.0 per side), `mr` = the gain MASTER's default would give (Q12 * patch level) */
static void tp_block(const int32_t *l, const int32_t *r, uint32_t n, int32_t mr)
{
    uint32_t i, k = tp_cur, pk = tp_acc[k], a, b;
    for (i = 0; i < n; i++) {
        a = (uint32_t)(l[i] < 0 ? -l[i] : l[i]);
        b = (uint32_t)(r[i] < 0 ? -r[i] : r[i]);
        if (b > a)
            a = b;
        a = (uint32_t)(((uint64_t)a * (uint32_t)mr) >> 14);   /* the output's 16-bit scale: (x m >> 12 << 6) >> 8 */
        if (a > pk)
            pk = a;
    }
    tp_acc[k] = pk;
}

/* main loop: the peak since the last call, and a new window starts */
static uint32_t tp_take(void)
{
    uint32_t k, p;
    tp_on = 1;
    TP_STEP();
    k = tp_cur;
    TP_STEP();
    tp_cur = (uint8_t)(k ^ 1u);                    /* from here the ISR fills the other one */
    TP_STEP();
    p = tp_acc[k];
    TP_STEP();
    tp_acc[k] = 0;                                 /* ready for the read after next */
    return p;
}
