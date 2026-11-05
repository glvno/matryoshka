/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Kerem Kilic (Ellic Studio)
 * Portions Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments */
/* From Melodee (github.com/keremimo/melodee, commit 165d177), firmware/hal/fm1_core1_stop.h. Changed for Matryoshka
 * (#271): the MELODEE_DUAL_CORE / MELODEE_CACHE_RAM switch and the host-test macros are gone (always built), the
 * registers are written in place. */
/* Safe CPU1 hold, adapted from Felucca 1.6.1 fm1_cpu1_halt:
 * Release commit a53ecf428c29c780108fd70a31b71a32a6b5c313;
 * related dual-core PR: https://github.com/hugelton/Felucca/pull/247
 * Holding CPU1 can abort an outstanding bus access and raise a delayed
 * bus-invalid flag on CPU0. Mask those traps, hold, drain and clear the
 * flags, then restore the debug enables and write-lock state. Registers
 * only: also used before application RAM is initialized. */
#pragma once
#include <stdint.h>
#include "fm1_cc.h"

FM1_INLINE void fm1_core1_stop(void)
{
    uint32_t locked = !(*(volatile uint32_t *)0x1EEE240u & 1u), en, bus = 0x003F0030u;
    volatile uint32_t n;
    /* Do not fold ~bus into a stock-ROM-looking address (build.py check). */
    __asm__("" : "+r"(bus));
    if (locked)
        *(volatile uint32_t *)0x1EEE240u = 0xE7u;
    en = *(volatile uint32_t *)0x1EEE340u;
    *(volatile uint32_t *)0x1EEE340u = en & ~bus;
    __asm__ volatile("csync" ::: "memory");
    *(volatile uint32_t *)0x1EEE004u |= 2u;
    *(volatile uint32_t *)0x1EEE004u &= ~8u;
    __asm__ volatile("csync" ::: "memory");
    for (n = 0; n < 256u; n++)            /* let the delayed bus flag arrive */
        ;
    *(volatile uint32_t *)0x1EEE248u = bus;
    __asm__ volatile("csync" ::: "memory");
    *(volatile uint32_t *)0x1EEE340u = en;
    if (locked && (*(volatile uint32_t *)0x1EEE240u & 1u))
        *(volatile uint32_t *)0x1EEE240u = 0xE7u;
    __asm__ volatile("csync" ::: "memory");
}
