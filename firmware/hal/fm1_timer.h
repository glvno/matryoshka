/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments */
/* FM-1 TIMER5: the 10 kHz system tick (input scan, USB poll, ms count).
 * TIMER4 is the free-running time base (fm1_time.h); both are unused by the
 * ROM and the SPL. JL_TIMER5 = 0x10900: CON, CNT +4, PRD +8.
 *
 *   fm1_timer5_start(isr, prio)   OSC /4 = 6 MHz, PRD 600 -> 10 kHz, IRQ 63
 *   fm1_timer5_ack()              first thing in the ISR
 */
#pragma once
#include <stdint.h>
#include "fm1_cc.h"
#include "fm1_irq.h"

#define FM1_T5_CON (*(volatile uint32_t *)0x10900u)
#define FM1_T5_CNT (*(volatile uint32_t *)0x10904u)
#define FM1_T5_PRD (*(volatile uint32_t *)0x10908u)

FM1_INLINE void fm1_timer5_start(void (*isr)(void), uint32_t prio)   /* IRQs off */
{
    FM1_T5_CON = 0x4000u;
    FM1_T5_CNT = 0;
    FM1_T5_PRD = 600u;
    fm1_irq_attach(FM1_IRQ_TIMER5, isr, prio);
    FM1_T5_CON = 0x4019u;
}

FM1_INLINE void fm1_timer5_ack(void) { FM1_T5_CON |= 0x4000u; }

/* TIMER2 (0x10600: CON, CNT +4, PRD +8; IRQ 6), a one-shot at the crystal's 24 MHz (TIMER4's tick): unused by the ROM,
 * the SPL and the rest of the firmware. The input scan ends a split dim pulse in it (fm1_input.h, #803).
 *   fm1_timer2_init(isr, prio)    stopped, its IRQ attached (IRQs off)
 *   fm1_timer2_once(ticks)        fires once, ticks (>= 1) from now; returns 1
 *   fm1_timer2_stop()             first thing in its ISR: stopped, the pending flag cleared */
#define FM1_T2_CON (*(volatile uint32_t *)0x10600u)
#define FM1_T2_CNT (*(volatile uint32_t *)0x10604u)
#define FM1_T2_PRD (*(volatile uint32_t *)0x10608u)
FM1_INLINE void fm1_timer2_init(void (*isr)(void), uint32_t prio)
{
    FM1_T2_CON = 0x4000u;
    fm1_irq_attach(FM1_IRQ_TIMER2, isr, prio);
}
FM1_INLINE int fm1_timer2_once(uint32_t ticks)
{
    FM1_T2_CON = 0x4000u;
    FM1_T2_CNT = 0;
    FM1_T2_PRD = ticks;
    FM1_T2_CON = 0x4009u;                        /* on, the crystal, no prescaler */
    return 1;
}
FM1_INLINE void fm1_timer2_stop(void) { FM1_T2_CON = 0x4000u; }
