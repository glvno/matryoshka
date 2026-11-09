/* SPDX-License-Identifier: GPL-3.0-only */
/* TIMER5 normally enters every 100 us, but flash writes can merge several
 * timer events into one IRQ. Use elapsed TIMER4 ticks, not five IRQ entries,
 * for the 500 us USB/MIDI service period. Unsigned subtraction handles wrap.
 * Keep the scheduled phase through ordinary entry jitter. If a whole extra
 * period was missed, serve once and rebase: lost USB packets cannot be
 * recovered by a burst of catch-up polls. */
static int usb_poll_due(uint32_t *at, uint32_t now)
{
    const uint32_t period = 500u * FM1_TICKS_PER_US;
    uint32_t elapsed = now - *at;
    if (elapsed < period)
        return 0;
    *at = elapsed < 2u * period ? *at + period : now;
    return 1;
}
