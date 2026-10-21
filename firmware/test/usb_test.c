/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Host test of usb.c's USB audio (FELUCCA_UAC) with a stand-in for the SIE (hal/fm1_usb.h):
 *   - the configuration descriptors, walked: every bLength, wTotalLength, the interface numbering and alt settings,
 *     endpoint counts, IADs, the audio control / MIDI streaming headers' lengths and collections, the 44.1-only format;
 *   - EP0 requests with the audio function presented and without it (update mode: SET_INTERFACE / SET_CUR / GET_CUR on
 *     the audio interface stall, as on a MIDI-only device);
 *   - the ring and packet logic over 60 s of drift both ways: renders of 128 frames at the I2S rate (44118 Hz and
 *     others), each tapped up to 2.6 ms after it started, one packet per 1 ms USB frame at 44100: every frame arrives
 *     exactly once, in order, no underrun / overrun, the fill stays in its band.
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
