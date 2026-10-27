/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Host test of usb.c's USB audio (FELUCCA_UAC) with a stand-in for the SIE (hal/fm1_usb.h):
 *   - the configuration descriptors, walked: every bLength, wTotalLength, the interface numbering and alt settings,
 *     endpoint counts, IADs, the audio control / MIDI streaming headers' lengths and collections, the 44.1-only format;
 *   - EP0 requests with the audio function presented and without it (update mode: SET_INTERFACE / SET_CUR / GET_CUR on
 *     the audio interface stall, as on a MIDI-only device);
 *   - the ring and packet logic over 60 s of drift both ways: renders of 128 frames at the I2S rate (44118 Hz and
 *     others), each tapped up to 2.6 ms after it started, one packet per 1 ms USB frame at 44100: every frame arrives
 *     exactly once, in order, no underrun / overrun, the fill stays in its band;
 *   - SysEx in on EP1 while the MIDI ring is full of TRS clock (#177): refused (NAK) while the ring holds back, taken
 *     once midi_in_quiet (an update session, update mode) drops MIDI in;
 *   - SysEx out to a host that stops reading (#375): ota_wire_send waits at most 50 ms once, then gives up at once until
 *     the host takes a packet; a host that reads never loses a message.
 *   usb_test            (all of the above; built by tools/usb_test.sh in several configurations)
 *   usb_test dump       (the MIDI-only device + configuration descriptors as hex: the script compares them with a
 *                        FELUCCA_UAC=0 build's, which must be the same bytes) */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- the SIE stand-in (fm1_usb.h's functions) ---- */
#define FM1_USB_HAL_MOCK 1
static uint32_t sie_index, sie_rd_reg, sie_rd_val;
static uint32_t csr0_in;                 /* what a read of CSR0 (index 0) returns */
static uint32_t count0_in;               /* COUNT0 */
static uint32_t txcsr1_ep4;              /* TXCSR1 of EP4: bit 0 = a packet is still queued */
static uint32_t rxcsr1_ep1, rxcount_ep1; /* EP1 OUT: bit 0 = a packet waits (RxPktRdy), its length */
static int csr0_last = -1;               /* the last value written to CSR0 */
static uint8_t ep0_sent[512];
static uint32_t ep0_sent_n;
static uint32_t ep4_sent[64];
static uint32_t ep4_sent_n;              /* bytes */
static uint32_t sim_regs(uint32_t r)
{
    if (r == 17u && sie_index == 0u)
        return csr0_in;
    if (r == 22u && sie_index == 0u)
        return count0_in;
    if (r == 17u && sie_index == 4u)
        return txcsr1_ep4;
    if (r == 20u && sie_index == 1u)
        return rxcsr1_ep1;
    if (r == 22u && sie_index == 1u)
        return rxcount_ep1;
    return 0;
}
static void fm1_usb_reset(void) {}
static void fm1_usb_attach(void *p) { (void)p; }
static void fm1_usb_off(void) {}
static uint32_t fm1_usb_sie_on(void) { return 1; }
static void fm1_usb_sie_wr_start(uint32_t r, uint32_t v)
{
    if (r == 14u)
        sie_index = v;
    if (r == 17u && sie_index == 0u)
        csr0_last = (int)v;
    if (r == 20u && sie_index == 1u)
        rxcsr1_ep1 = 0;                  /* ep1_rx releases the packet */
}
static void fm1_usb_sie_rd_start(uint32_t r) { sie_rd_reg = r; sie_rd_val = sim_regs(r); }
static uint32_t fm1_usb_sie_done(void) { return 0x8000u; }
static uint32_t fm1_usb_sie_data(void) { return sie_rd_val & 0xFFu; }
static void fm1_usb_ep0_buf(void *p) { (void)p; }
static void fm1_usb_ep_txbuf(uint32_t ep, void *p) { (void)ep; (void)p; }
static void fm1_usb_ep_rxbuf(uint32_t ep, void *p) { (void)ep; (void)p; }
static void fm1_usb_ep0_send(void *p, uint32_t n)
{
    if (ep0_sent_n + n <= sizeof ep0_sent)
        memcpy(ep0_sent + ep0_sent_n, p, n);
    ep0_sent_n += n;
}
static void fm1_usb_ep_send(uint32_t ep, void *p, uint32_t n) { (void)ep; (void)p; (void)n; }
static void fm1_usb_ep4_txbuf(void *p) { (void)p; }
static void fm1_usb_ep4_send(void *p, uint32_t n)
{
    memcpy(ep4_sent, p, n);
    ep4_sent_n = n;
}
static void fm1_usb_rx_sync(void) {}
static void fm1_usb_ep_enable(uint32_t m) { (void)m; }
static uint32_t fm1_usb_sof_take(void) { return 1; }
static void fm1_delay_ms(uint32_t ms) { (void)ms; }

#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#define HALF_FRAMES 128u
#ifndef FELUCCA_OTA
#define FELUCCA_OTA 0
#endif
#include "../src/usb.c"
#if FELUCCA_OTA
/* a send that waits for room calls ota_idle in a loop while the TIMER5 ISR moves the clock and, with a host that reads,
 * ep1_tx hands queued packets to it: here each call is one millisecond, the host taking a packet every host_every ms */
static uint32_t host_every;                                     /* 0: the host takes nothing (no app reads the FM-1) */
static void ep1_tx(void);
static uint32_t ota_now_ms(void) { return fm1_ms; }
static void ota_idle(void)
{
    fm1_ms++;
    if (host_every && fm1_ms % host_every == 0u)
        ep1_tx();
}
#include "../src/midi_uart.c"   /* the TRS jack's parser, fed through its DMA ring (uart_midi_take) */
#endif

#if FELUCCA_UAC && !FELUCCA_UAC_48K
static int fails;
#define CHECK(c, ...)                                                                                                \
    do {                                                                                                             \
        if (!(c)) {                                                                                                  \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);                                                              \
            printf(__VA_ARGS__);                                                                                     \
            printf("\n");                                                                                            \
            fails++;                                                                                                 \
        }                                                                                                            \
    } while (0)

/* ------------------------------------------------------------------ descriptors --- */
static uint32_t le16(const uint8_t *p) { return p[0] | (uint32_t)p[1] << 8; }

/* walk one configuration descriptor; uac: the audio streaming interface must be there */
static void walk_config(const char *what, const uint8_t *c, uint32_t len, int uac, int cdc)
{
    uint32_t off, nif = c[4], seen_if = 0, i;
    int cur_if = -1, cur_alt = -1, cur_cls = -1, cur_sub = -1, eps_want = 0, eps_got = 0;
    uint32_t ep_addrs = 0, iads = 0, rates = 0, as_seen = 0;
    int alts[16];
    uint32_t ac_off = 0, ac_cs_sum = 0, ac_total = 0, ms_off = 0, ms_sum = 0, ms_total = 0;
    uint8_t ac_coll[8], ac_ncoll = 0;
    for (i = 0; i < 16u; i++)
        alts[i] = -1;
    CHECK(len >= 9u && c[0] == 9u && c[1] == 2u, "%s: configuration header", what);
    CHECK(le16(c + 2) == len, "%s: wTotalLength %u, sent %u", what, le16(c + 2), len);
    for (off = 0; off < len;) {
        const uint8_t *d = c + off;
        uint32_t bl = d[0];
        CHECK(bl >= 2u && off + bl <= len, "%s: descriptor at %u: bLength %u runs past the end", what, off, bl);
        if (bl < 2u || off + bl > len)
            return;
        switch (d[1]) {
        case 4:                                                 /* interface */
            CHECK(bl == 9u, "%s: interface bLength %u", what, bl);
            CHECK(eps_got == eps_want, "%s: IF %d alt %d: %d endpoints, bNumEndpoints %d", what, cur_if, cur_alt,
                  eps_got, eps_want);
            if (ms_off) {
                CHECK(ms_sum == ms_total, "%s: MIDI streaming wTotalLength %u, descriptors %u", what, ms_total, ms_sum);
                ms_off = 0;
            }
            cur_if = d[2];
            cur_alt = d[3];
            eps_want = d[4];
            eps_got = 0;
            cur_cls = d[5];
            cur_sub = d[6];
            CHECK(cur_if < 16, "%s: interface %d", what, cur_if);
            if (cur_if < 16) {
                CHECK(cur_alt == alts[cur_if] + 1, "%s: IF %d alt %d follows alt %d", what, cur_if, cur_alt,
                      alts[cur_if]);
                alts[cur_if] = cur_alt;
                if (cur_alt == 0) {
                    CHECK((uint32_t)cur_if == seen_if, "%s: interface %d out of order (expected %u)", what, cur_if,
                          seen_if);
                    seen_if++;
                }
            }
            if (cur_cls == 1 && cur_sub == 2 && cur_alt == 1)
                as_seen++;
            if (cur_cls == 1 && cur_sub == 3) {
                ms_off = off;
                ms_sum = 0;
            }
            break;
        case 5:                                                 /* endpoint */
            eps_got++;
            {
                uint32_t bit = 1u << ((d[2] & 0x0Fu) + (d[2] & 0x80u ? 16u : 0u));
                CHECK(!(ep_addrs & bit) || (d[2] == 0x84u && cur_alt == 1), "%s: endpoint %02X twice", what, d[2]);
                ep_addrs |= bit;
            }
            if (d[2] == 0x84u) {
                CHECK(uac, "%s: EP 0x84 without the audio function", what);
                CHECK(bl == 9u && d[3] == 0x05u, "%s: EP4 isochronous async (bLength %u attr %02X)", what, bl, d[3]);
                CHECK(le16(d + 4) >= 46u * 4u && le16(d + 4) <= 1023u, "%s: EP4 wMaxPacketSize %u", what, le16(d + 4));
                CHECK(d[6] == 1u, "%s: EP4 bInterval %u", what, d[6]);
            }
            if (ms_off)
                ms_sum += bl;
            break;
        case 0x25:                                              /* class-specific endpoint */
            if (ms_off)
                ms_sum += bl;
            break;
        case 0x0B:                                              /* IAD */
            iads++;
            CHECK(bl == 8u, "%s: IAD bLength %u", what, bl);
            CHECK(d[2] == seen_if, "%s: IAD first interface %u, next interface %u", what, d[2], seen_if);
            CHECK((uint32_t)d[2] + d[3] <= nif, "%s: IAD %u + %u past %u interfaces", what, d[2], d[3], nif);
            break;
        case 0x24:                                              /* class-specific interface */
            if (cur_cls == 1 && cur_sub == 1) {                 /* audio control */
                if (d[2] == 1u) {
                    ac_off = off;
                    ac_total = le16(d + 5);
                    ac_cs_sum = 0;
                    ac_ncoll = d[7];
                    CHECK(bl == 8u + ac_ncoll, "%s: AC header bLength %u for %u interfaces", what, bl, ac_ncoll);
                    for (i = 0; i < ac_ncoll && i < sizeof ac_coll; i++)
                        ac_coll[i] = d[8 + i];
                }
                if (ac_off)
                    ac_cs_sum += bl;
            } else if (cur_cls == 1 && cur_sub == 3) {          /* MIDI streaming */
                if (d[2] == 1u)
                    ms_total = le16(d + 5);
                ms_sum += bl;
            } else if (cur_cls == 1 && cur_sub == 2 && d[2] == 2u) {   /* AS format type I */
                CHECK(d[3] == 1u && d[4] == 2u && d[5] == 2u && d[6] == 16u, "%s: format: PCM 2 ch 16 bit", what);
                CHECK(d[7] == 1u && bl == 11u, "%s: format: %u rates (one expected: 44.1 only)", what, d[7]);
                CHECK((d[8] | d[9] << 8 | d[10] << 16) == 44100, "%s: rate %u", what, d[8] | d[9] << 8 | d[10] << 16);
                rates++;
            } else if (cur_cls == 1 && cur_sub == 2 && d[2] == 1u) {   /* AS general */
                CHECK(d[3] == 2u, "%s: AS general links terminal %u (the USB streaming output is 2)", what, d[3]);
            }
            break;
        default:
            break;
        }
        off += bl;
    }
    CHECK(off == len, "%s: descriptors end at %u of %u", what, off, len);
    CHECK(eps_got == eps_want, "%s: last interface: %d endpoints, bNumEndpoints %d", what, eps_got, eps_want);
    if (ms_off)
        CHECK(ms_sum == ms_total, "%s: MIDI streaming wTotalLength %u, descriptors %u", what, ms_total, ms_sum);
    CHECK(seen_if == nif, "%s: bNumInterfaces %u, interfaces %u", what, nif, seen_if);
    CHECK(ac_off != 0 || c[9 + (c[10] == 0x0B ? 8 : 0) + 1] == 4, "%s: no audio control", what);
    CHECK(ac_total == ac_cs_sum, "%s: AC header wTotalLength %u, class descriptors %u", what, ac_total, ac_cs_sum);
    CHECK(ac_ncoll == (uac ? 2u : 1u), "%s: AC collection has %u interfaces", what, ac_ncoll);
    if (uac && ac_ncoll == 2u) {
        uint32_t base = (uint32_t)ac_coll[0] > ac_coll[1] ? ac_coll[1] - 1u : ac_coll[0] - 1u;
        CHECK(ac_coll[0] == base + 2u && ac_coll[1] == base + 1u,
              "%s: the AS interface first in the collection (#67): %u %u", what, ac_coll[0], ac_coll[1]);
    }
    CHECK(as_seen == (uac ? 1u : 0u), "%s: %u audio streaming alt 1 settings", what, as_seen);
    CHECK(rates == (uac ? 1u : 0u), "%s: %u format descriptors", what, rates);
    CHECK(iads == (cdc ? 2u : 0u), "%s: %u IADs", what, iads);
}

static void test_descriptors(void)
{
    const uint8_t *d;
    uint16_t l;
    usb_uac_on = 1;
    CHECK(get_desc(0x0100, &d, &l) && l == 18u && d[0] == 18u && d[1] == 1u, "device descriptor");
    CHECK(d[12] == BCD_LO(USB_CDC_ON) && d[13] == 3u, "bcdDevice %02X%02X", d[13], d[12]);
    CHECK(d[12] == (USB_CDC_ON ? 0x19u + 2u * FELUCCA_USB_LAYOUT : 0x18u), "bcdDevice 3.18 (+CDC): %02X", d[12]);
    CHECK(get_desc(0x0200, &d, &l), "configuration descriptor");
    walk_config("audio + MIDI", d, l, 1, USB_CDC_ON);
#if FELUCCA_CDC
    usb_cdc_on = 0;
    CHECK(get_desc(0x0200, &d, &l), "configuration descriptor");
    walk_config("audio + MIDI, no console", d, l, 1, 0);
    usb_cdc_on = 1;
#endif
    usb_uac_on = 0;
    CHECK(get_desc(0x0100, &d, &l) && l == 18u && d[12] == 0u && d[13] == 3u && d[4] == 0u, "MIDI-only device");
    CHECK(get_desc(0x0200, &d, &l) && l == 101u, "MIDI-only configuration %u", l);
    walk_config("MIDI only", d, l, 0, 0);
    usb_uac_on = 1;
}

/* ------------------------------------------------------------------ EP0 --- */
/* one SETUP through ep0_service; returns the CSR0 written last (0x48 ack, 0x60 stall, 0x0A / 0x02 data sent,
 * 0x40 waiting for a data stage) */
static int setup(uint8_t rt, uint8_t rq, uint16_t val, uint16_t idx, uint16_t len)
{
    uint8_t s[8] = {rt, rq, (uint8_t)val, (uint8_t)(val >> 8), (uint8_t)idx, (uint8_t)(idx >> 8), (uint8_t)len,
                    (uint8_t)(len >> 8)};
    memcpy(ep0buf, s, 8);
    csr0_in = 0x01;
    csr0_last = -1;
    ep0_sent_n = 0;
    ep0_service();
    return csr0_last;
}

static int data_stage(const uint8_t *p, uint32_t n)
{
    memcpy(ep0buf, p, n);
    csr0_in = 0x01;
    count0_in = n;
    csr0_last = -1;
    ep0_service();
    return csr0_last;
}

static void test_ep0(void)
{
    static const uint8_t R48[3] = {0x80, 0xBB, 0x00};
    int r;
    usb.up = 1;
    usb_uac_on = 1;
    CHECK(setup(0x00, 9, 1, 0, 0) == 0x48 && usb.config == 1u, "SET_CONFIGURATION 1");
    CHECK(setup(0x01, 11, 1, UAC_AS_IF, 0) == 0x48 && uac.alt == 1u, "SET_INTERFACE AS alt 1");
    CHECK(setup(0x81, 10, 0, UAC_AS_IF, 1) == 0x0A && ep0_sent_n == 1u && ep0_sent[0] == 1u, "GET_INTERFACE AS");
    r = setup(0x22, 1, 0x0100, 0x84, 3);
    CHECK(r == 0x40, "SET_CUR rate: data stage expected (%d)", r);
    CHECK(data_stage(R48, 3) == 0x48, "SET_CUR 48000: acknowledged");
    CHECK(setup(0xA2, 0x81, 0x0100, 0x84, 3) == 0x0A && ep0_sent_n == 3u &&
              (ep0_sent[0] | ep0_sent[1] << 8 | ep0_sent[2] << 16) == 44100,
          "GET_CUR after SET_CUR 48000: still 44100");
    CHECK(setup(0xA2, 0x83, 0x0100, 0x84, 3) == 0x0A && (ep0_sent[0] | ep0_sent[1] << 8 | ep0_sent[2] << 16) == 44100,
          "GET_MAX: 44100");
    CHECK(setup(0x02, 1, 0, 0x84, 0) == 0x48, "CLEAR_FEATURE EP 0x84");
    CHECK(setup(0x01, 11, 0, UAC_AS_IF, 0) == 0x48 && uac.alt == 0u, "SET_INTERFACE AS alt 0");
    CHECK(setup(0x80, 6, 0x0200, 0, 255) == 0x02 && ep0_sent_n == 64u, "GET_DESCRIPTOR config: the first 64 bytes");
    usb.e0_tx = 0;                                              /* (the rest is not asked for here) */

    usb_uac_switch(0);                                          /* update mode */
    CHECK(usb.up == 0u && usb.config == 0u, "usb_uac_switch(0) detaches");
    usb.up = 1;
    CHECK(setup(0x00, 9, 1, 0, 0) == 0x48, "MIDI only: SET_CONFIGURATION 1");
    CHECK(setup(0x01, 11, 1, 2, 0) == 0x60 && uac.alt == 0u, "MIDI only: SET_INTERFACE 2 alt 1 stalls");
    CHECK(setup(0x22, 1, 0x0100, 0x84, 3) == 0x60, "MIDI only: SET_CUR stalls");
    CHECK(setup(0xA2, 0x81, 0x0100, 0x84, 3) == 0x60, "MIDI only: GET_CUR stalls");
    CHECK(setup(0x02, 1, 0, 0x84, 0) == 0x60, "MIDI only: CLEAR_FEATURE EP 0x84 stalls");
    CHECK(setup(0x01, 11, 0, 1, 0) == 0x48, "MIDI only: SET_INTERFACE 1 alt 0");
    r = setup(0x80, 6, 0x0200, 0, 255);
    CHECK(r == 0x02 && ep0_sent_n == 64u, "MIDI only: GET_DESCRIPTOR config, first 64 bytes (%d %u)", r, ep0_sent_n);
    usb.e0_tx = 0;
    uac_service();
    CHECK(ep4_sent_n == 0u, "MIDI only: no audio packets");
    usb_uac_switch(1);
    usb.up = 0;
    usb.config = 0;
}

/* ------------------------------------------------------------------ MIDI in, #177 --- */
#if FELUCCA_OTA
/* #177: a controller on the TRS jack (Active Sensing, clock) while the installer talks SysEx over USB. The two parsers are
 * separate (usb.c sysex_byte / sx_frame, midi_uart.c um_byte); they share only the MIDI-in ring, which ep1_take checks
 * for room. In an update session or update mode nothing drains it, so without midi_in_quiet the ring fills and EP1 is
 * NAKed for good. */
static uint32_t trs_n;                                          /* TRS bytes fed so far (picks the next one) */
static void trs_feed(uint32_t n)                                /* n bytes through the jack's DMA ring, as the ISR takes them */
{
    static const uint8_t TRS[] = {0xFE, 0xF8, 0x90, 0x3C, 0xF8, 0x40, 0xF0, 0x01, 0xFE, 0x02, 0xF7, 0xF8, 0xB0, 0x10,
                                  0x7F, 0xFE, 0xF8, 0x80, 0x3C, 0x00};   /* AS, clock, a note on / off, a CC, a SysEx */
    uint32_t i;
    for (i = 0; i < n; i++, trs_n++)
        um_ring[(um.rd + um.pend + i) & (UM_RING - 1u)] = TRS[trs_n % sizeof TRS];
    uart_midi_take(n);
}

static void trs_second(void)                                    /* a second of a busy jack, 3000 bytes, the ISR's polls */
{
    uint32_t i;
    for (i = 0; i < 1000u; i++)
        trs_feed(3);
}

/* one EP1 OUT packet through ep1_rx; 1 = taken (else NAKed: it stays for the next poll) */
static int ep1_packet(const uint8_t *p, uint32_t n)
{
    memcpy(ep1rx, p, n);
    rxcsr1_ep1 = 1;
    rxcount_ep1 = n;
    usb.rx_pend = 1;
    ep1_rx();
    return rxcsr1_ep1 == 0u;
}

/* The editor sends LIVE, TRANSPORT and SANDBOX together. The pending frame belongs to the main loop; the rest of this
 * USB packet must wait, then resume without repeating the MIDI events before it. */
static void test_sysex_burst(void)
{
    const uint8_t burst[] = {
        0x09, 0x90, 60, 100,
        0x04, 0xF0, 0x7D, 0x4D, 0x07, 0x31, 0x2C, 0xF7,
        0x04, 0xF0, 0x7D, 0x4D, 0x07, 0x31, 0x25, 0xF7,
        0x04, 0xF0, 0x7D, 0x4D, 0x07, 0x31, 0x31, 0xF7,
        0x08, 0x80, 60, 0,
    };
    const uint8_t commands[] = {0x2C, 0x25, 0x31};
    const uint8_t *frame;
    uint32_t n, i;
    mi_r = mi_w = 0;
    midi_in_resume();
    CHECK(!ep1_packet(burst, sizeof burst), "SysEx burst: packet waits for its first frame to be handled");
    for (i = 0; i < sizeof commands; i++) {
        CHECK(ota_frame_get(&frame, &n) && n == 4u && frame[3] == commands[i], "SysEx burst: frame %u is delivered in order", i);
        CHECK(mi_w == 1u, "SysEx burst: leading note is delivered once, trailing note waits");
        ota_frame_done();
        ep1_rx();
    }
    CHECK(!ota_frame_get(&frame, &n), "SysEx burst: no duplicate frame");
    CHECK(rxcsr1_ep1 == 0u && mi_w == 2u, "SysEx burst: packet released after the trailing note");
    mi_r = mi_w;
}

/* msg (F0 .. F7) from the host as USB-MIDI events, 16 to an EP1 packet, a realtime event (FE / F8, CIN F) after every
 * rt_every of them; TRS bytes between the packets; drain: the main loop empties the ring at each poll. A NAKed packet
 * is offered again for up to 2000 polls (1 s). 1 = all taken. */
static int host_sysex(const uint8_t *msg, uint32_t len, uint32_t rt_every, int drain)
{
    uint8_t pk[64];
    uint32_t i = 0, n = 0, ev = 0, tries;
    while (i < len || n) {
        if (i < len && n < 64u) {
            uint32_t k = len - i >= 3u ? 3u : len - i, cin;
            if (rt_every && ev && ev % rt_every == 0u && (n == 0u || pk[n - 4u] != 0x0Fu)) {
                pk[n] = 0x0F;
                pk[n + 1u] = ev / rt_every % 2u ? 0xFE : 0xF8;
                pk[n + 2u] = pk[n + 3u] = 0;
                n += 4u;
                continue;
            }
            cin = k == 3u && i + 3u < len ? 4u : 4u + k;            /* 4 continues, 5 / 6 / 7 end */
            pk[n] = (uint8_t)cin;
            pk[n + 1u] = msg[i];
            pk[n + 2u] = k > 1u ? msg[i + 1u] : 0;
            pk[n + 3u] = k > 2u ? msg[i + 2u] : 0;
            n += 4u;
            i += k;
            ev++;
            continue;
        }
        for (tries = 0;; tries++) {
            trs_feed(2);                                        /* ~0.5 ms of a busy jack (31250 baud: 1.5 bytes / poll) */
            if (drain)
                mi_r = mi_w;
            if (ep1_packet(pk, n))
                break;
            if (tries == 2000u)
                return 0;
        }
        n = 0;
    }
    return 1;
}

/* the frame usb.c handed to the main loop is msg's body (between F0 and F7); released after */
static int frame_is(const uint8_t *msg, uint32_t len)
{
    const uint8_t *f;
    uint32_t n;
    int ok = ota_frame_get(&f, &n) && n == len - 2u && !memcmp(f, msg + 1, n);
    ota_frame_done();
    return ok;
}

static void test_midi_in_quiet(void)
{
    static const uint8_t HS[10] = {0xF0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7F, 0xF7};   /* the handshake */
    static const uint8_t UPGRADE[6] = {0xF0, 0x22, 0x24, 0x35, 0x7F, 0xF7};
    static uint8_t resp[605];                                   /* a 512-byte read answer's size on the wire */
    uint32_t i, w;
    resp[0] = 0xF0;
    for (i = 1; i + 1u < sizeof resp; i++)
        resp[i] = (uint8_t)((i * 37u + i / 7u) & 0x7Fu);
    resp[sizeof resp - 1u] = 0xF7;
    usb.up = 1;
    usb.config = 1;
    mi_r = mi_w = 0;
    usb.ota_req = 0;

    /* the running firmware between sessions (the main loop drains): TRS and USB realtime inside the SysEx change nothing */
    CHECK(host_sysex(HS, sizeof HS, 1, 1) && frame_is(HS, sizeof HS), "running: the handshake with realtime around it");
    CHECK(host_sysex(UPGRADE, sizeof UPGRADE, 1, 1) && usb.ota_req, "running: UPGRADE with realtime around it");
    usb.ota_req = 0;
    CHECK(host_sysex(resp, sizeof resp, 5, 1) && frame_is(resp, sizeof resp), "running: a 605-byte answer, TRS + realtime");
    CHECK(um.msgs > 0u && !midi_in_overflow, "running: the TRS messages were queued");

    /* the old session: nobody drains, so TRS fills the ring and EP1 is NAKed; it stays so after the jack goes quiet */
    trs_second();                                               /* the host's 2 s after UPGRADE, the device's request */
    CHECK(!host_sysex(resp, sizeof resp, 0, 0), "undrained: TRS clock makes EP1 NAK the answer (the stall of #177)");
    for (i = 0; i < 1000u; i++)
        if (ep1_packet(ep1rx, 64))
            break;
    CHECK(i == 1000u, "undrained: still NAKed with the jack quiet (deaf until power-off)");
    ota_frame_done();
    usb.sx_on = 0;                                              /* (the half-sent frame: the host starts a new one) */

    /* midi_in_quiet (an update session, update mode): nothing is queued, the SysEx always gets through */
    midi_in_quiet();
    CHECK(mi_r == mi_w && !midi_in_overflow, "midi_in_quiet empties the ring");
    w = mi_w;
    trs_second();
    CHECK(host_sysex(HS, sizeof HS, 1, 0) && frame_is(HS, sizeof HS), "quiet: the handshake with TRS + realtime, undrained");
    for (i = 0; i < 20u; i++) {                                 /* the reads of step 1, a second of a busy jack before each */
        trs_second();
        CHECK(host_sysex(resp, sizeof resp, 3, 0) && frame_is(resp, sizeof resp), "quiet: answer %u arrives whole", i);
    }
    CHECK(mi_w == w && !midi_in_overflow, "quiet: nothing was queued, no overflow");
    midi_in_resume();
    CHECK(midi_enqueue(0xFu | 0xF8u << 8, 1u) == 1 && mi_w == w + 1u, "resumed: MIDI in is queued again");
    mi_r = mi_w;
    usb.up = 0;
    usb.config = 0;
}
#endif
#if FELUCCA_OTA
/* #375: the FM-1 on a computer where no app reads its MIDI. Every unasked message for the editor (TRACK_NOW after a step
 * entered on the SEQ page, PARAM_NOW after a knob) goes through ota_wire_send from the main loop; once the 64-packet
 * ring is full, a send that waited 200 ms each time stalled the panel (7.4 s of keys_poll for a run of steps). The main
 * loop may wait at most DEAF_WAIT_MAX once for a host that takes nothing, then not at all until the host takes a packet;
 * a host that reads, however slowly, never loses a message. */
#define DEAF_WAIT_MAX 50u                                       /* ms: one send's longest wait (the fix's SX_WAIT_MS) */
static uint32_t timed_send(int *rc)                             /* one 48-byte message (16 packets); the ms it took */
{
    uint8_t msg[48];
    uint32_t i, t0 = fm1_ms;
    msg[0] = 0xF0;
    for (i = 1; i + 1u < sizeof msg; i++)
        msg[i] = (uint8_t)(i & 0x7Fu);
    msg[sizeof msg - 1u] = 0xF7;
    *rc = ota_wire_send(msg, sizeof msg);
    return fm1_ms - t0;
}

static void test_deaf_host(void)
{
    uint32_t i, ms, worst, bad;
    int rc;
    usb.up = 1;
    usb.config = 1;
    usb.suspended = 0;
    so_w = so_r = 0;
    mo_w = mo_r = 0;
    fm1_ms = 1000;

    /* a host that reads (a packet of 16 events every 1 ms, then every 20 ms): 200 messages, none refused */
    host_every = 1;
    for (i = 0, worst = 0, bad = 0; i < 200u; i++) {
        ms = timed_send(&rc);
        bad += rc != 0;
        worst = ms > worst ? ms : worst;
    }
    CHECK(bad == 0u, "reading host: %u of 200 messages refused", bad);
    CHECK(worst <= 1u, "reading host: a send waited %u ms", worst);
    host_every = 20;
    for (i = 0, worst = 0, bad = 0; i < 200u; i++) {
        ms = timed_send(&rc);
        bad += rc != 0;
        worst = ms > worst ? ms : worst;
    }
    CHECK(bad == 0u, "slow host (a packet every 20 ms): %u of 200 messages refused", bad);
    CHECK(worst <= 20u, "slow host: a send waited %u ms", worst);
    while (so_r != so_w)
        ep1_tx();

    /* a host that takes nothing: four messages fill the ring at once; the fifth waits at most DEAF_WAIT_MAX and is
     * refused, the next 30 (a run of steps entered by hand) are refused without waiting */
    host_every = 0;
    for (i = 0; i < 4u; i++) {
        ms = timed_send(&rc);
        CHECK(rc == 0 && ms == 0u, "deaf host: message %u fits in the ring (rc %d, %u ms)", i, rc, ms);
    }
    ms = timed_send(&rc);
    CHECK(rc != 0, "deaf host: the ring full, a send is refused");
    CHECK(ms > 0u && ms <= DEAF_WAIT_MAX + 1u, "deaf host: the first refused send waited %u ms (want 1..%u)", ms,
          DEAF_WAIT_MAX + 1u);
    for (i = 0, worst = 0, bad = 0; i < 30u; i++) {
        ms = timed_send(&rc);
        bad += rc == 0;
        worst += ms;
    }
    CHECK(bad == 0u, "deaf host: %u of the next 30 sends were taken", bad);
    CHECK(worst == 0u, "deaf host: the next 30 sends waited %u ms in all (want 0: the main loop goes on)", worst);

    /* the host takes one USB packet (16 events): a message fits again; the one after finds the ring full and waits
     * again (the host may be reading now), then gives up at once as before */
    ep1_tx();
    ms = timed_send(&rc);
    CHECK(rc == 0 && ms == 0u, "host back: a message fits in the room it made (rc %d, %u ms)", rc, ms);
    ms = timed_send(&rc);
    CHECK(rc != 0 && ms > 0u && ms <= DEAF_WAIT_MAX + 1u, "host back: the next send waits again (rc %d, %u ms)", rc, ms);
    ms = timed_send(&rc);
    CHECK(rc != 0 && ms == 0u, "host back, then deaf again: refused at once (rc %d, %u ms)", rc, ms);

    /* the host reads again (the ISR hands it packets between the main loop's sends too): nothing is refused */
    host_every = 1;
    for (i = 0, bad = 0; i < 50u; i++) {
        ota_idle();                                             /* a millisecond of the main loop's other work */
        timed_send(&rc);
        bad += rc != 0;
    }
    CHECK(bad == 0u, "host reads again: %u of 50 messages refused", bad);
    host_every = 0;
    so_w = so_r = 0;
    usb.up = 0;
    usb.config = 0;
}
#endif

/* ------------------------------------------------------------------ the stream --- */
static uint32_t rng = 12345u;
static uint32_t rnd(uint32_t n)
{
    rng = rng * 1664525u + 1013904223u;
    return (rng >> 8) % n;
}

/* fs: the I2S rate; host: frames per second the host takes (44100 nominal); tap_max_us: the render's tap comes up to
 * this long after the half started */
static void stream(double fs, double secs, uint32_t tap_max_us)
{
    double t_half = HALF_FRAMES / fs, t_pkt = 0.001;
    double next_half = 0.0137, next_tap = 1e9, next_pkt = 0.001;
    uint32_t produced = 0, expect = 0, got = 0, zeros = 0, bad = 0, settle_lo = 0xFFFFFFFFu, settle_hi = 0;
    uint32_t adj0_up = 0, adj0_down = 0;
    int32_t out[2u * HALF_FRAMES];
    double t_end = secs, t_settle = 1.0;
    int settled = 0;
    memset(&uac, 0, sizeof uac);
    ua_w = ua_r = 0;
    usb.up = 1;
    usb.config = 1;
    usb_uac_on = 1;
    uac_ep4_reset();
    uac_stream(1);
    txcsr1_ep4 = 0;
    for (;;) {
        double t = next_half < next_tap ? next_half : next_tap;
        if (next_pkt < t)
            t = next_pkt;
        if (t > t_end)
            break;
        if (!settled && t >= t_settle) {
            settled = 1;
            adj0_up = uac.adj_up;
            adj0_down = uac.adj_down;
        }
        if (t == next_pkt) {                                    /* the host took the last packet: the next is queued */
            uint32_t i, n, primed = uac.go;                     /* (not primed: a silence packet, not from the ring) */
            ep4_sent_n = 0;
            uac_service();
            n = ep4_sent_n / 4u;
            CHECK(n >= 43u && n <= 46u, "packet of %u frames", n);
            for (i = 0; i < n; i++) {
                uint32_t v = ep4_sent[i], l = v & 0xFFFFu, r = v >> 16, f = l | r << 15;
                if (!v && !primed)
                    continue;
                if (!v) {
                    if (got)
                        bad++;                                  /* silence after the stream began: a gap */
                    else
                        zeros++;
                    continue;
                }
                if (f != expect + 1u && bad < 10u)
                    printf("  at %.3f s: frame %u after %u\n", t, f, expect);
                if (f != expect + 1u)
                    bad++;
                expect = f;
                got++;
            }
            next_pkt += t_pkt * (1.0 + rnd(5) * 1e-5 - 2e-5);   /* -20 .. +20 ppm on a ms */
            if (settled) {
                if (uac.fill_min < settle_lo)
                    settle_lo = uac.fill_min;
                if (uac.fill_min > settle_hi)
                    settle_hi = uac.fill_min;
            }
        } else if (t == next_half) {                            /* a half starts: the fill is sampled */
            uac_render_start();
            next_tap = t + (100 + rnd(tap_max_us - 100)) * 1e-6;
            next_half += t_half;
        } else {                                                /* ... the render ends: its frames go to the ring */
            uint32_t i;
            for (i = 0; i < HALF_FRAMES; i++) {
                uint32_t f = uac.feed ? ++produced : 0u;        /* frame numbers as L (15 bit) | R (15 bit), 24-bit words */
                out[2u * i] = (int32_t)((f & 0x7FFFu) << UAC_IN_SHIFT);
                out[2u * i + 1u] = (int32_t)(((f >> 15) & 0x7FFFu) << UAC_IN_SHIFT);
            }
            uac_tap(out, HALF_FRAMES);
            next_tap = 1e9;
        }
    }
    {
        int32_t net = (int32_t)(uac.adj_up - adj0_up) - (int32_t)(uac.adj_down - adj0_down);
        double want = (fs - 44100.0) * (secs - t_settle);
        uint32_t left = ua_w - ua_r;
        printf("  fs %.0f, tap <= %u us: %u frames, %u packets, adj +%u -%u (net %d, drift %.0f), fill %u..%u after 1 s, "
               "underruns %u overruns %u\n",
               fs, tap_max_us, got, uac.pkts, uac.adj_up, uac.adj_down, net, want, settle_lo, settle_hi,
               uac.underruns, uac.overruns);
        CHECK(bad == 0u, "fs %.0f: %u frames out of order / lost / repeated", fs, bad);
        CHECK(uac.underruns == 0u && uac.overruns == 0u, "fs %.0f: underruns %u overruns %u", fs, uac.underruns,
              uac.overruns);
        CHECK(expect + left == produced, "fs %.0f: last frame %u + %u in the ring != %u produced", fs, expect, left,
              produced);
        CHECK(zeros == UA_PRIME, "fs %.0f: %u silent frames from the ring ahead of the music (prime %u)", fs, zeros,
              UA_PRIME);
        CHECK(settle_lo >= 46u, "fs %.0f: the fill fell to %u (a packet must stay in hand)", fs, settle_lo);
        CHECK(settle_lo + 8u >= UA_LO && settle_hi <= UA_HI + 8u, "fs %.0f: fill %u..%u outside %u..%u", fs, settle_lo,
              settle_hi, UA_LO, UA_HI);
        CHECK(net > want - 60.0 && net < want + 60.0, "fs %.0f: net adjustments %d, drift %.0f frames", fs, net, want);
    }
    uac_stream(0);
}
#endif

int main(int argc, char **argv)
{
    if (argc > 1 && !strcmp(argv[1], "dump")) {                 /* the MIDI-only descriptors (or a UAC=0 build's) */
        const uint8_t *d;
        uint16_t l, i;
#if FELUCCA_UAC
        usb_uac_on = 0;
#endif
        get_desc(0x0100, &d, &l);
        for (i = 0; i < l; i++)
            printf("%02X", d[i]);
        printf("\n");
        get_desc(0x0200, &d, &l);
        for (i = 0; i < l; i++)
            printf("%02X", d[i]);
        printf("\n");
        return 0;
    }
#if !FELUCCA_UAC || FELUCCA_UAC_48K
    printf("usb_test needs FELUCCA_UAC=1 FELUCCA_UAC_48K=0\n");
    return 2;
#else
    test_descriptors();
    test_ep0();
#if FELUCCA_OTA
    test_midi_in_quiet();
    test_sysex_burst();
    test_deaf_host();
#endif
    stream(44118.0, 60.0, 2600u);                               /* the FM-1: 18 frames a second too many */
    stream(44082.0, 60.0, 2600u);                               /* the other way */
    stream(44100.0, 60.0, 2600u);
    stream(44160.0, 60.0, 2600u);                               /* 1360 ppm both ways: far beyond a crystal */
    stream(44040.0, 60.0, 2600u);
    stream(44118.0, 60.0, 300u);                                /* light renders: the tap right after the start */
    stream(44118.0, 60.0, 2900u);                               /* a render that takes the whole half */
    stream(44082.0, 60.0, 2900u);
    if (fails) {
        printf("usb_test: %d failures\n", fails);
        return 1;
    }
    printf("usb_test: ok\n");
    return 0;
#endif
}
