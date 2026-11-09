/* SPDX-License-Identifier: GPL-3.0-only */
/* The CPU clock and the supply rails, read only (#735, DIAG page 131 in main.c m1_diag). Nothing here writes a clock or
 * a rail: the clock stays the boot loader's, the rails are set once at boot (fm1_power.h). Register meanings after Melodee's notes (BUILDING.md "The boot clock" and
 * "The stock supply setup", github.com/keremimo/melodee): PLL2_CON1 [11:0] + 2 is the SYS VCO multiplier (24 MHz / 12 a
 * step; the boot loader's 268 = 540 MHz, CLK_CON2 picks 2/3 of it = 360 MHz). The rails (P33 analog registers): SYSVDD
 * = P3_ANA_CON9 [3:0] (0.93 V + 30 mV a step), VDC14 = P3_ANA_CON6 [2:0] (1.25 V + 50 mV), VDDIO = P3_ANA_CON5 [2:0]
 * (2.8 V + 100 mV).
 *   fm1_clock_probe(v)   v[0] PLL2_CON1, v[1] CLK_CON2, v[2] the three rail registers and the supply mode
 *                        (CON9 | CON6 << 8 | CON5 << 16 | CON0 << 24: bit 2 LDO13, bit 3 DCDC13), read with interrupts
 *                        off (P33 access is not reentrant), v[3] / v[4] TIMER4 ticks (24 MHz) for 1024 passes of 16 / 48
 *                        dependent adds, interrupts off (the difference, 32768 adds, leaves out the loop's own cost);
 *                        v[6] / v[7] are main.c's */
#pragma once
#include <stdint.h>
#include "fm1_time.h"
#include "fm1_sys.h"
#include "fm1_irq.h"

#define FM1_PLL2_CON1 (*(volatile uint32_t *)0x119ACu)
#define FM1_CLK_CON2_RD (*(volatile uint32_t *)0x10014u)

#define FM1_ADD1(x, i) do { __asm__ volatile("" : "+r"(x)); (x) += (i); } while (0)
#define FM1_ADD16(x, i) do { FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); \
    FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); \
    FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); FM1_ADD1(x, i); } while (0)

static uint32_t fm1_clock_adds(uint32_t wide, uint32_t *sink)
{
    uint32_t x = 1u, i, t;
    t = FM1_T4_CNT;
    if (wide)
        for (i = 0; i < 1024u; i++) { FM1_ADD16(x, i); FM1_ADD16(x, i); FM1_ADD16(x, i); }
    else
        for (i = 0; i < 1024u; i++) { FM1_ADD16(x, i); }
    t = FM1_T4_CNT - t;
    *sink += x;
    return t;
}

static void fm1_clock_probe(uint32_t v[8])
{
    uint32_t sink = 0, k;
    v[0] = FM1_PLL2_CON1;
    v[1] = FM1_CLK_CON2_RD;
    fm1_irq_off();
    v[2] = (uint32_t)fm1_p33_read(0x09) | (uint32_t)fm1_p33_read(0x06) << 8 | (uint32_t)fm1_p33_read(0x05) << 16 |
           (uint32_t)fm1_p33_read(0x00) << 24;
    for (k = 0; k < 2u; k++) {                  /* the second pass, with the loops in the cache */
        v[3] = fm1_clock_adds(0, &sink);
        v[4] = fm1_clock_adds(1, &sink);
    }
    fm1_irq_on();
    v[5] = sink;
    v[6] = v[7] = 0;
}
