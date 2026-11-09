/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Kerem Kilic (Ellic Studio) */
/* From Melodee (github.com/keremimo/melodee, commit 165d177), firmware/hal/fm1_power.h. Changed for Matryoshka (#735):
 * the MELODEE_CORE1_TEST diagnostics (fm1_power_get, fm1_clock_regs, fm1_cpu_ticks) are left out (DIAG page 131 reads
 * the clock and the rails: fm1_clock.h); fm1_power_step counts the steps, so a failure says where it stopped;
 * fm1_power_boot reads the four registers as the boot loader left them (fm1_power_before), then runs fm1_power_init
 * and keeps its result (fm1_power_state). The sequence's own transfers are Melodee's, unchanged. */
/* FM-1 supply startup, matching the stock V15 analog setup.
 * Register order / values: stock app 0x02004F90..0x0200509A, identified against
 * the AC79 SDK __hw_power_init. See Melodee's BUILDING.md, "The stock supply setup".
 * Call with IRQs off and CPU1 held, after application RAM is initialized.
 *
 *   fm1_power_boot()     main.c fm1_cstart: the registers before, the stock setup, its result
 *   fm1_power_report()   DIAG page 131: fm1_power_state | fm1_power_step << 8 | P33 timeouts during it << 16
 *
 * Levels (SDK p33.h): SYSVDD, the core and SRAM rail (isd_config "DVDD"),
 * 0.93 V + 30 mV a step (15: 1.38 V); VDC14 ("DCDC14") 1.25 V + 50 mV a step
 * (7: 1.60 V); VDDIO 2.8 V + 100 mV a step (4: 3.2 V).
 * The boot loader leaves SYSVDD 11 (1.26 V) and VDC14 3 (1.40 V): read on the test rig, 2026-11-09 (#735).
 */
#pragma once
#include <stdint.h>
#ifndef FM1_POWER_HOST_TEST
#include "fm1_sys.h"
#include "fm1_time.h"

/* Stock delay(1000), not 1000 us: keep its nop / increment / branch loop.
 * The memory clobber also keeps each delay between its P33 operations. */
static inline __attribute__((always_inline)) void fm1_power_settle(void)
{
    int32_t n = -1000;
    __asm__ volatile("goto 2f\n1:\n\tnop\n\t%0 += 1\n2:\n\tif (%0 != 0) goto 1b"
                     : "+r"(n) :: "memory");
}
#endif

enum { FM1_POWER_NOT_RUN, FM1_POWER_OK, FM1_POWER_FAILED };
#define FM1_POWER_CHECK_STEP 21u                /* fm1_power_step: 1..20 the sequence's steps, 21 the check after it */

static uint8_t fm1_power_ready;
static uint8_t fm1_power_state;                 /* FM1_POWER_NOT_RUN (update mode), _OK or _FAILED */
static uint8_t fm1_power_step;                  /* the last step begun: where a failed setup stopped */
static uint8_t fm1_power_lost;                  /* P33 timeouts during the setup (at most 255) */
static uint32_t fm1_power_before;               /* as the boot loader left them: CON9 | CON6 << 8 | CON5 << 16 | CON0 << 24 */

/* Same field replacement as P33_CON_SET. Never turn a timed-out read's dummy
 * byte into an analog-register write. A failed transfer stops the sequence. */
static int fm1_power_field(uint32_t reg, uint32_t start, uint32_t width, uint32_t value)
{
    uint32_t timeouts = fm1_p33_timeouts;
    uint32_t mask = ((1u << width) - 1u) << start;
    uint8_t old = fm1_p33_read(reg);
    if (fm1_p33_timeouts != timeouts)
        return 0;
    fm1_p33_write(reg, (uint8_t)((old & ~mask) | ((value << start) & mask)));
    return fm1_p33_timeouts == timeouts;
}

/* Both builds use the stock supply setup. This is a fixed boot sequence, not
 * a runtime voltage ladder. CPU1 remains held if any transfer or check fails.
 * The stock's unused reads (6, 5, 5) are retained in their original position. */
static int fm1_power_init(void)
{
    uint32_t timeouts = fm1_p33_timeouts;
    uint8_t mode, io, vdc14, sysvdd;
    fm1_power_step = 0;
#define FM1_POWER_STEP(op) do { fm1_power_step++; op; if (fm1_p33_timeouts != timeouts) return 0; } while (0)
#define FM1_POWER_FIELD(reg, start, width, value) \
    do { fm1_power_step++; if (!fm1_power_field(reg, start, width, value)) return 0; } while (0)
    FM1_POWER_FIELD(0x00u, 2, 1, 1);             /* LDO13 on during handover */
    fm1_power_settle();
    FM1_POWER_FIELD(0x00u, 3, 1, 1);             /* DCDC13 on */
    fm1_power_settle();
    FM1_POWER_FIELD(0x00u, 2, 1, 0);             /* LDO13 off */
    fm1_power_settle();
    FM1_POWER_STEP(fm1_p33_write(0x01u, 0x20));
    FM1_POWER_STEP(fm1_p33_write(0x05u, 0x40));
    FM1_POWER_STEP(fm1_p33_write(0x06u, 0x0C));
    FM1_POWER_STEP(fm1_p33_write(0x07u, 0xA5));
    FM1_POWER_STEP(fm1_p33_write(0x08u, 0x96));
    FM1_POWER_FIELD(0x09u, 4, 1, 1);             /* SYSVDD drive */
    FM1_POWER_FIELD(0x05u, 0, 3, 4);             /* VDDIOM 3.2 V */
    FM1_POWER_FIELD(0x06u, 0, 3, 7);             /* VDC14 1.60 V */
    FM1_POWER_FIELD(0x05u, 4, 2, 3);             /* VDDIOW 3.2 V */
    FM1_POWER_STEP((void)fm1_p33_read(0x06u));
    FM1_POWER_STEP((void)fm1_p33_read(0x05u));
    FM1_POWER_STEP((void)fm1_p33_read(0x05u));
    FM1_POWER_STEP(fm1_p33_or(0x00u, 0x80));      /* RC_250k_EN */
    FM1_POWER_FIELD(0x16u, 0, 6, 0);             /* analog keep */
    FM1_POWER_STEP(fm1_p33_or(0x02u, 0x40));      /* VDDOK_DIS */
    FM1_POWER_STEP(fm1_p33_and(0x17u, 0xDF));
    FM1_POWER_FIELD(0x09u, 0, 4, 15);            /* SYSVDD 1.38 V, last */
#undef FM1_POWER_FIELD
#undef FM1_POWER_STEP
    /* Additional read-only verification; no retry or speculative rollback. */
    fm1_power_step = FM1_POWER_CHECK_STEP;
    mode = fm1_p33_read(0x00u);
    io = fm1_p33_read(0x05u);
    vdc14 = fm1_p33_read(0x06u);
    sysvdd = fm1_p33_read(0x09u);
    return fm1_p33_timeouts == timeouts && (mode & 0x0Cu) == 0x08u &&
           (io & 0x37u) == 0x34u && (vdc14 & 7u) == 7u && (sysvdd & 15u) == 15u;
}

/* The registers as the boot loader left them (read only, before the sequence: none of its transfers change), the stock
 * setup, and its result. A read here that times out leaves its byte in fm1_power_before only. */
static void fm1_power_boot(void)
{
    uint32_t t;
    fm1_power_before = (uint32_t)fm1_p33_read(0x09u) | (uint32_t)fm1_p33_read(0x06u) << 8 |
                       (uint32_t)fm1_p33_read(0x05u) << 16 | (uint32_t)fm1_p33_read(0x00u) << 24;
    t = fm1_p33_timeouts;
    fm1_power_ready = (uint8_t)fm1_power_init();
    t = fm1_p33_timeouts - t;
    fm1_power_lost = (uint8_t)(t > 255u ? 255u : t);
    fm1_power_state = fm1_power_ready ? FM1_POWER_OK : FM1_POWER_FAILED;
}

static uint32_t fm1_power_report(void)
{
    return (uint32_t)fm1_power_state | (uint32_t)fm1_power_step << 8 | (uint32_t)fm1_power_lost << 16;
}
