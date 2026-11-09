/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Kerem Kilic (Ellic Studio) */
/* From Melodee (github.com/keremimo/melodee, commit 165d177), tests/power_test.c. Changed for Matryoshka (#735): the
 * include path, and checks of what Matryoshka adds around the sequence (hal/fm1_power.h): the step a failure stopped
 * at, the registers read before it, the result and the DIAG page 131 report. Run by tools/power_test.sh. */
/* Supply boot against the stock V15 transaction trace, including warm starts,
 * failed transfers and incorrect read-back. No physical voltage is simulated.
 * Oracle: FM-1_015 SHA256 db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a,
 * app 0x02004F90..0x0200509A, helper 0x01C0108C. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct { char op; uint8_t reg, value; } event_t;
static event_t trace[64];
static uint8_t regfile[256];
static uint32_t used, transfers, fail_at, corrupt_at, corrupt_mask, fm1_p33_timeouts;
static int transfer(char op, uint32_t reg, uint8_t value)
{
    assert(used < sizeof trace / sizeof *trace && reg <= 0x17u);
    trace[used++] = (event_t){op, (uint8_t)reg, value};
    if (++transfers == fail_at) {
        fm1_p33_timeouts++;
        return 0;
    }
    return 1;
}
static uint8_t fm1_p33_read(uint32_t reg)
{
    if (!transfer('R', reg, 0)) return 0x5E;
    return regfile[reg] ^ (transfers == corrupt_at ? corrupt_mask : 0u);
}
static void fm1_p33_write(uint32_t reg, uint8_t v)
{
    if (transfer('W', reg, v)) regfile[reg] = v;
}
static void fm1_p33_or(uint32_t reg, uint8_t v)
{
    if (transfer('O', reg, v)) regfile[reg] |= v;
}
static void fm1_p33_and(uint32_t reg, uint8_t v)
{
    if (transfer('A', reg, v)) regfile[reg] &= v;
}
static void fm1_power_settle(void)
{
    assert(used < sizeof trace / sizeof *trace);
    trace[used++] = (event_t){'D', 0, 0};
}
#define FM1_POWER_HOST_TEST 1
#include "../hal/fm1_power.h"

static void reset(uint8_t mode)
{
    memset(regfile, 0xAB, sizeof regfile);
    regfile[0] = mode;
    used = transfers = fail_at = corrupt_at = 0;
    corrupt_mask = 1;
    fm1_p33_timeouts = 17;                        /* older unrelated timeouts are allowed */
}

static void stock_trace(uint8_t mode)
{
    /* Resolved bus transactions from V15, plus our four final reads. RMWs
     * preserve the inherited upper bits; the five full analog writes do not. */
    const event_t expected[] = {
        {'R',0,0}, {'W',0,mode|4}, {'D',0,0},
        {'R',0,0}, {'W',0,mode|12}, {'D',0,0},
        {'R',0,0}, {'W',0,(mode|8)&~4}, {'D',0,0},
        {'W',1,0x20}, {'W',5,0x40}, {'W',6,0x0C}, {'W',7,0xA5}, {'W',8,0x96},
        {'R',9,0}, {'W',9,0xBB},
        {'R',5,0}, {'W',5,0x44}, {'R',6,0}, {'W',6,0x0F}, {'R',5,0}, {'W',5,0x74},
        {'R',6,0}, {'R',5,0}, {'R',5,0}, {'O',0,0x80},
        {'R',0x16,0}, {'W',0x16,0x80}, {'O',2,0x40}, {'A',0x17,0xDF},
        {'R',9,0}, {'W',9,0xBF},
        {'R',0,0}, {'R',5,0}, {'R',6,0}, {'R',9,0}
    };
    assert(used == sizeof expected / sizeof *expected);
    for (uint32_t i = 0; i < used; i++) {
        assert(trace[i].op == expected[i].op && trace[i].reg == expected[i].reg);
        assert(trace[i].value == expected[i].value);
    }
    assert((regfile[0] & 0x0Cu) == 8u && (regfile[6] & 7u) == 7u && (regfile[9] & 15u) == 15u);
    for (uint32_t i = 0; i < sizeof regfile; i++)
        if (i != 0 && i != 1 && i != 2 && (i < 5 || i > 9) && i != 0x16 && i != 0x17)
            assert(regfile[i] == 0xAB);           /* no watchdog/reset/RTC writes */
}

/* Matryoshka's step count: the step of the transfer number `bad` in the stock trace (the field steps are a read and a
 * write, the others one transfer; the check after the 20 steps is step 21) */
static uint32_t step_of(uint32_t bad)
{
    static const uint8_t transfers_of[20] = { 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 2, 1, 1, 2 };
    uint32_t s, n = 0;
    for (s = 0; s < 20u; s++) {
        n += transfers_of[s];
        if (bad <= n)
            return s + 1u;
    }
    return FM1_POWER_CHECK_STEP;
}

int main(void)
{
    reset(4); fm1_power_ready = fm1_power_init();
    assert(fm1_power_ready); stock_trace(4);
    assert(fm1_power_step == FM1_POWER_CHECK_STEP);
    uint32_t count = transfers;
    reset(0x88); assert(fm1_power_init()); stock_trace(0x88); /* stock DCDC state after soft reset */
    for (uint32_t bad = 1; bad <= count; bad++) {
        reset(4); fail_at = bad;
        assert(!fm1_power_init() && fm1_p33_timeouts == 18);
        assert(fm1_power_step == step_of(bad));
        uint32_t seen = 0;
        for (uint32_t i = 0; i < used; i++) {
            if (trace[i].op == 'D') continue;
            if (++seen > bad) assert(trace[i].op == 'R'); /* never write after a timeout */
        }
    }
    /* A dropped hardware bit despite successful transactions also refuses
     * readiness. Mode corruption uses bit 2 (LDO), selectors use bit 0. */
    for (uint32_t bad = count - 3; bad <= count; bad++) {
        reset(4); corrupt_at = bad;
        if (bad == count - 3) corrupt_mask = 4;
        assert(!fm1_power_init());
        assert(fm1_power_step == FM1_POWER_CHECK_STEP);
    }
    reset(4); fail_at = 1;
    assert(!fm1_power_field(9, 0, 4, 15) && used == 1 && regfile[9] == 0xAB);

    /* fm1_power_boot (Matryoshka): four reads of the registers as the boot loader left them, then the stock trace */
    reset(4);
    regfile[9] = 0x0B; regfile[6] = 0x03; regfile[5] = 0x07; /* the boot loader's levels on the test rig (#735) */
    fm1_power_boot();
    assert(fm1_power_before == (0x0Bu | 0x03u << 8 | 0x07u << 16 | 0x04u << 24));
    assert(used == 4u + 36u);
    for (uint32_t i = 0; i < 4u; i++)
        assert(trace[i].op == 'R');
    assert(trace[0].reg == 9 && trace[1].reg == 6 && trace[2].reg == 5 && trace[3].reg == 0);
    assert(fm1_power_ready && fm1_power_state == FM1_POWER_OK && fm1_power_lost == 0);
    assert((regfile[9] & 15u) == 15u && (regfile[6] & 7u) == 7u && (regfile[5] & 0x37u) == 0x34u);
    assert(fm1_power_report() == (FM1_POWER_OK | FM1_POWER_CHECK_STEP << 8));
    /* a timeout in those reads only spoils its byte there; the sequence counts its own */
    reset(4); fail_at = 2;
    fm1_power_boot();
    assert(((fm1_power_before >> 8) & 0xFFu) == 0x5Eu && fm1_power_state == FM1_POWER_OK && fm1_power_lost == 0);
    /* a timeout in the sequence: failed, where, how many */
    reset(4); fail_at = 4u + 9u;                  /* the sequence's 9th transfer: the third write, step 6 */
    fm1_power_boot();
    assert(!fm1_power_ready && fm1_power_state == FM1_POWER_FAILED && fm1_power_step == 6u && fm1_power_lost == 1u);
    assert(fm1_power_report() == (FM1_POWER_FAILED | 6u << 8 | 1u << 16));
    /* a wrong read-back: failed at the check, no timeout */
    reset(4); corrupt_at = 4u + count;
    fm1_power_boot();
    assert(fm1_power_state == FM1_POWER_FAILED && fm1_power_step == FM1_POWER_CHECK_STEP && fm1_power_lost == 0);
    puts("power: stock V15 trace, cold/warm starts, every transfer timeout and rail read-back faults passed");
    return 0;
}
