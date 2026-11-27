/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The key scan (firmware/hal/fm1_input.h fm1_input_tick, fm1_input_tick_end) on the host, against a model of the
 * board: the 74HC595 chain (shifted on SRCLK's rising edge, its outputs changed on RCLK's), the diode matrix and the
 * rows' pull-ups. A row a closed key pulls low falls at once, but rises slowly when its column lets go: read within
 * ROW_RISE_US of a latch, a row still shows the column before. The scan must read each column only after its latch has
 * settled, also when a split dim pulse's end (TIMER2, #803) comes late, as it does when the USB poll in TIMER5's
 * interrupt runs long: else a key reads as its right-hand neighbour (LFO as SEQ).
 *   tools/input_test.sh */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

/* the HAL's time base and GPIO registers, the board's instead: included first, then replaced (fm1_input.h's own
 * includes are skipped: #pragma once) */
#define fm1_ticks fm1_ticks_hw
#include "../hal/fm1_time.h"
#undef fm1_ticks
#include "../hal/fm1_gpio.h"
#undef FM1_PR

static uint32_t now;                                /* TIMER4 ticks (24 MHz) */
static uint32_t fm1_ticks(void) { return ++now; }   /* (a read takes a tick: the scan's waits end) */
static volatile uint32_t *sim_reg(uint32_t p, uint32_t r);
#define FM1_PR(p, r) (*sim_reg((p), (r)))

static int t2_armed;                                /* the one-shot (main.c's TIMER2): armed, and when it fires */
static uint32_t t2_at;
static int sim_arm(uint32_t ticks)
{
    t2_armed = 1;
    t2_at = now + ticks;
    return 1;
}
#define FM1_TICK_SPLIT_ARM(ticks) sim_arm(ticks)

#include "../hal/fm1_input.h"

/* ---- the board */
#define ROW_RISE_US 5u
static volatile uint32_t reg[8][8];                 /* port, register / 4: what the scan wrote (FM1_OUT) or reads (FM1_IN) */
static uint32_t pa_seen;                            /* PA's outputs as the board last saw them */
static uint32_t sr, latched = 0xFFFFu, before = 0xFFFFu, latch_t;   /* the 595: shifted, driven now, driven before the latch */
static uint64_t held;                               /* the keys closed (bit id) */

static void board_commit(void)                      /* the edges of PA's last write */
{
    uint32_t o = reg[FM1_PA][FM1_OUT / 4u];
    if ((o & ~pa_seen) >> 3 & 1u)                   /* SRCLK up: SER in */
        sr = (sr << 1 | (o >> 4 & 1u)) & 0xFFFFu;
    if ((o & ~pa_seen) >> 1 & 1u) {                 /* RCLK up: the outputs */
        before = latched;
        latched = sr;
        latch_t = now;
    }
    pa_seen = o;
}

static uint32_t rows_low(uint32_t cols)             /* the rows the closed keys of the low columns pull down (bit 1..4) */
{
    uint32_t r, c, low = 0;
    for (r = 1; r < 5u; r++)
        for (c = 0; c < FM1_NCOL; c++)
            if (!(cols >> c & 1u) && FM1_KEYMAP[r][c] >= 0 && (held >> FM1_KEYMAP[r][c] & 1u))
                low |= 1u << r;
    return low;
}

static volatile uint32_t *sim_reg(uint32_t p, uint32_t r)
{
    board_commit();
    if (r == FM1_IN && p == FM1_PA) {               /* rows 1..4 on PA5..PA8, pulled up; row 0 (PA0) the encoders, open */
        uint32_t low = rows_low(latched);
        if (now - latch_t < ROW_RISE_US * FM1_TICKS_PER_US)
            low |= rows_low(before);                /* (a row the last column pulled down has not risen yet) */
        reg[p][r / 4u] = ~(low << 4);
    } else if (r == FM1_IN) {
        reg[p][r / 4u] = 0xFFFFFFFFu;               /* (PB7: encoder 6's row, open) */
    }
    return &reg[p][r / 4u];
}

/* ---- the interrupts (main.c fm1_timer5_irq, fm1_timer2_irq): TIMER5 every 100 us runs the scan's tick, then the USB /
 * MIDI poll when it is due (usb_poll_clock.h: 500 us after the last), which takes `poll` us: about 5 with a host, and
 * far more while each SIE register read waits out its timeout (usb.c sie_rd: 20000 polls). Then every TIMER5 entry is
 * late enough for the poll to be due again. TIMER2 has TIMER5's priority, so its interrupt waits for TIMER5's to return.
 * A TIMER5 interrupt still running when the next one is due leaves it pending (one: the periods past it are lost).
 * `t5_first`: when both wait, TIMER5's runs first */
#include "../src/usb_poll_clock.h"
#define T5_PERIOD (100u * FM1_TICKS_PER_US)
static uint32_t t5_due = T5_PERIOD;
static volatile uint32_t usb_at;
static void run_ticks(uint32_t n, uint32_t poll, int t5_first)
{
    while (n) {
        uint32_t t5 = now > t5_due ? now : t5_due, t2 = now > t2_at ? now : t2_at;
        if (t2_armed && (t2 < t5 || (t2 == t5 && !t5_first))) {   /* TIMER2: the split pulse's end */
            now = t2;
            t2_armed = 0;
            fm1_input_tick_end();                   /* (nothing if a tick ended it first: split_late) */
            board_commit();
            continue;
        }
        now = t5;                                   /* TIMER5: the tick, then the poll if due */
        fm1_input_tick();
        board_commit();
        if (usb_poll_due(&usb_at, t5))
            now += poll * FM1_TICKS_PER_US;
        t5_due += T5_PERIOD;
        if (now >= t5_due)                          /* (it ran past the next one's time: that one waits, the rest are lost) */
            t5_due += (now - t5_due) / T5_PERIOD * T5_PERIOD;
        n--;
    }
}

static int fails;
static void check(const char *what, int ok)
{
    printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
    fails += !ok;
}

/* key `id` held for 40 frames' worth of ticks, then let go as long: the buttons the scan saw down at any moment */
static uint32_t hold_buttons(uint32_t id, uint32_t poll, int t5_first)
{
    uint32_t seen = 0, f;
    held = 1ull << id;
    for (f = 0; f < 40u; f++) {
        run_ticks(FM1_NCOL, poll, t5_first);
        seen |= fm1_in.buttons;
    }
    held = 0;
    for (f = 0; f < 40u; f++)
        run_ticks(FM1_NCOL, poll, t5_first);
    return seen;
}

int main(void)
{
    /* the poll's cost: a host's (5 us) up to many SIE register reads each waiting out their timeout (sie_rd's 20000 polls) */
    static const uint32_t POLLS[] = {0, 5, 50, 95, 100, 150, 300, 400, 450, 500, 1000, 3300};
    uint32_t c, i, o, id;
    fm1_input_init();
    board_commit();
    fm1_led_dim_level(2);                           /* DIM HIGH, as made: the pulse ends in TIMER2 (#803) */
    for (c = 0; c < FM1_NCOL; c++)                  /* (every column glowing: every tick a split pulse) */
        fm1_led_dim[c] = 0x1Eu;
    run_ticks(200, 5, 0);
    check("with a host's 5 us poll the split pulses end in TIMER2, none late", fm1_in_stat.dim_n > 150u && !fm1_in_stat.split_late);
    for (o = 0; o < 2u; o++)
        for (i = 0; i < sizeof POLLS / sizeof POLLS[0]; i++) {
            char m[200];
            uint32_t bad = 0, first = 0, late = fm1_in_stat.split_late;
            for (id = 0; id < 14u; id++) {          /* every button alone: it, and nothing else, reads down */
                uint32_t seen = hold_buttons(id, POLLS[i], (int)o);
                if (seen != 1u << id && !bad++)
                    first = id << 16 | seen;
            }
            snprintf(m, sizeof m, "USB poll %u us%s: each button held reads as itself only (%u wrong; %u late ends)", POLLS[i],
                     o ? ", TIMER5 first" : "", bad, fm1_in_stat.split_late - late);
            if (bad)
                snprintf(m + strlen(m), sizeof m - strlen(m), "; button %u read as 0x%04x", first >> 16, first & 0xFFFFu);
            check(m, !bad && !fm1_in.buttons);
        }
    check("LFO (5) held while the poll takes 1 ms: not SEQ (11)", !(hold_buttons(5, 1000, 0) >> 11 & 1u));
    printf("%s\n", fails ? "input_test: FAILED" : "input_test: all passed");
    return fails != 0;
}
