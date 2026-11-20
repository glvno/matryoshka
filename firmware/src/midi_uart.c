/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Portions Copyright (C) 2026 Kerem Kilic (Ellic Studio)
 * Modified for Modular-1 (morgulbrut) and Matryoshka (glvno): the messages feed the one voice through midi_drain (main.c). */
/* MIDI IN on the TRS jack: PH8 -> input channel 1 -> UART1 RX, 31250 baud,
 * RX DMA into a 128-byte ring, polled from the TIMER5 ISR (no UART IRQ).
 * Channel messages go into midi_in_q next to USB, as USB-MIDI packets (cable 0, CIN = status >> 4), on any channel;
 * Clock/Start/Continue/Stop and Song Position are queued too (clock_in.h); other realtime, system common and SysEx are
 * ignored (no SysEx->UBOOT from DIN).
 *
 * The ring is read by content, not by the DMA count (Melodee's reader, github.com/keremimo/melodee commit 165d177,
 * firmware/src/midi_uart.c): every slot not yet given to the parser holds UM_EMPTY, and the reader takes bytes until it
 * meets one. The count (HRXCNT, latched every poll) can miss a byte that is already in the ring. Read by the count, the
 * reader then stayed one byte behind until power-off, so each message ended only with the next byte: a pad on a
 * controller with no clock or active sensing between its messages (a Korg nanoPAD2 through a USB MIDI host box) sounded
 * when it was let go, and its note-off waited for the next pad. Following the content cannot drift. The count still
 * tells an overrun (more than the ring since the last poll). */
#include "../hal/fm1_uart.h"   /* registers; relative, so the host tests find it too */

#define UM_RING 128u
#define UM_EMPTY 0xFDu         /* an undefined MIDI realtime byte, never sent: marks a slot not yet read */
static volatile uint8_t um_ring[UM_RING] __attribute__((aligned(16)));
static struct {
    uint32_t rd;
    volatile uint32_t bytes, drops, msgs;          /* TIMER5 writes; read-only CDC diagnostics */
    uint8_t st, need, got, d0, sysex;
} um;

static void um_ring_clear(void)                    /* every slot unread, the reader at the DMA's start (and the host tests) */
{
    uint32_t i;
    for (i = 0; i < UM_RING; i++)
        um_ring[i] = UM_EMPTY;
    um.rd = 0;
}

static void uart_midi_init(void)                   /* before timer5_start(): PORTH RMW */
{
    um_ring_clear();
    fm1_uart1_midi_init(um_ring, UM_RING);
}

static uint32_t um_len(uint32_t s)                 /* data bytes of a channel status */
{
    return (s & 0xE0u) == 0xC0u ? 1u : 2u;         /* Cx Dx: 1, else 2 */
}

static void um_byte(uint32_t b)
{
    if (b >= 0xF8u) {
        if (b == 0xF8u || b == 0xFAu || b == 0xFBu || b == 0xFCu) {
            if (midi_enqueue(0xFu | b << 8, 2u))
                um.msgs++;
            else
                um.drops++;
        }
        return;                                    /* realtime keeps running status */
    }
    if (b & 0x80u) {
        um.sysex = b == 0xF0u;
        um.st = b < 0xF0u || b == 0xF2u ? (uint8_t)b : 0;   /* other system common / SysEx: running status ends */
        um.need = (uint8_t)um_len(b);
        um.got = 0;
        return;
    }
    if (um.sysex || !um.st)
        return;
    if (um.need == 2u && !um.got) {
        um.d0 = (uint8_t)b;
        um.got = 1;
        return;
    }
    {
        uint32_t d1 = um.need == 2u ? um.d0 : b, d2 = um.need == 2u ? b : 0u;
        uint32_t pkt = (um.st == 0xF2u ? 3u : um.st >> 4) | (uint32_t)um.st << 8 | d1 << 16 | d2 << 24;
        um.got = 0;
        if (um.st == 0xF2u)                        /* (Song Position, clock_in.h: no running status) */
            um.st = 0;
        if (midi_enqueue(pkt, 2u)) {
            um.msgs++;
        } else {
            midi_in_overflow = 1;
            um.drops++;
        }
    }
}

/* the bytes the DMA wrote since the last call, by content; n, the DMA's count, only tells an overrun (the DMA went round
 * the ring past unread bytes: the newest UM_RING are read, the rest counted as drops). A received UM_EMPTY (line noise)
 * is passed over once the byte after it has landed: the DMA writes in order */
static void uart_midi_take(uint32_t n)
{
    uint32_t k;
    if (n > UM_RING) {
        um.drops += n - UM_RING;
        um.rd = (um.rd + n - UM_RING) & (UM_RING - 1u);
        um.st = um.got = um.sysex = 0;              /* lost bytes: wait for a complete new status */
        midi_in_overflow = 1;
    }
    for (k = 0; k < UM_RING; k++) {
        uint32_t b = um_ring[um.rd];
        if (b == UM_EMPTY && um_ring[(um.rd + 1u) & (UM_RING - 1u)] == UM_EMPTY)
            break;
        um_ring[um.rd] = UM_EMPTY;
        um.rd = (um.rd + 1u) & (UM_RING - 1u);
        um.bytes++;
        um_byte(b);                                 /* (a UM_EMPTY is an unknown realtime byte: ignored) */
    }
}
static void uart_midi_poll(void)                   /* TIMER5 ISR, same context as usb_poll */
{
    uart_midi_take(fm1_uart1_rx_take());
}
