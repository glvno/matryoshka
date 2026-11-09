/* SPDX-License-Identifier: GPL-3.0-only */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#define FM1_TICKS_PER_US 24u
#include "../src/usb_poll_clock.h"

/* Flash steps merge multiple 100 us timer events into one delivered IRQ.
 * Test the production scheduling decision at those actual entry times. */
static void cadence(uint32_t spacing_us, uint32_t allowed_gap_us)
{
    uint32_t at = 0, now = 0, previous = 0, polls = 0, worst = 0;
    for (uint32_t i = 0; i < 1000; i++) {
        now += spacing_us * FM1_TICKS_PER_US;
        if (usb_poll_due(&at, now)) {
            uint32_t gap = now - previous;
            if (polls && gap > worst) worst = gap;
            previous = now;
            polls++;
        }
    }
    printf("IRQ spacing %u us: longest poll gap %u us (limit %u)\n",
           spacing_us, worst / FM1_TICKS_PER_US, allowed_gap_us);
    fflush(stdout);
    assert(polls > 0 && worst <= allowed_gap_us * FM1_TICKS_PER_US);
    if (spacing_us == 100u) assert(polls == 200u && worst == 500u * FM1_TICKS_PER_US);
}

int main(void)
{
    cadence(100, 500);
    /* Even one tick of normal IRQ-entry jitter must not shift every next
     * deadline onto a later 100 us timer event (600 us instead of 500 us). */
    uint32_t phase = 0, polls = 0, previous = 0, worst = 0;
    for (uint32_t i = 1; i <= 1000; i++) {
        uint32_t now = i * 100u * FM1_TICKS_PER_US + (i & 1u);
        if (usb_poll_due(&phase, now)) {
            uint32_t gap = now - previous;
            if (polls && gap > worst) worst = gap;
            previous = now;
            polls++;
        }
    }
    printf("One-tick IRQ jitter: %u polls in 100 ms, longest gap %u ticks\n", polls, worst);
    fflush(stdout);
    assert(polls == 200u && worst <= 500u * FM1_TICKS_PER_US + 1u);
    cadence(450, 900);
    cadence(550, 550);
    uint32_t at = 0;
    assert(!usb_poll_due(&at, 499u * FM1_TICKS_PER_US));
    assert(usb_poll_due(&at, 500u * FM1_TICKS_PER_US));
    /* One late service, never a burst of catch-up polls. */
    uint32_t delayed = 5000u * FM1_TICKS_PER_US;
    assert(usb_poll_due(&at, delayed));
    for (uint32_t i = 0; i < 5; i++)
        assert(!usb_poll_due(&at, delayed + i * 100u * FM1_TICKS_PER_US));
    assert(usb_poll_due(&at, delayed + 500u * FM1_TICKS_PER_US));
    /* TIMER4 wraps about every 179 seconds; compare unsigned differences. */
    at = UINT32_MAX - 5999u;
    assert(!usb_poll_due(&at, 5999u));
    assert(usb_poll_due(&at, 6000u));
    assert(!usb_poll_due(&at, 6000u));
    assert(!usb_poll_due(&at, 17999u));
    assert(usb_poll_due(&at, 18000u));
    /* A long delay past the signed half-range still triggers exactly once. */
    at = 1234u;
    delayed = at + 0x80000000u;
    assert(usb_poll_due(&at, delayed));
    assert(!usb_poll_due(&at, delayed));
    puts("USB poll clock: normal cadence, coalesced IRQs, delayed service and timer wrap passed");
}
