/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The preset store (firmware/src/presetstore.c, #194) on the host, over a RAM flash that behaves like NOR: an erase sets a
 * sector to 0xFF, a program only clears bits. A program can be cut after n bytes (a power cut). tools/preset_test.sh. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define FLASH_LO 0x99000u
#define FLASH_N (7u * 0x1000u)
static uint8_t flash[FLASH_N];
static long cut_after = -1;            /* bytes the next programs may write before the "power" goes, -1 no cut */
static int erases;

static void fm1_wdt_feed(void) {}
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    if (off < FLASH_LO || off + n > FLASH_LO + FLASH_N)
        return -8;
    memcpy(dst, flash + (off - FLASH_LO), n);
    return 0;
}
static int st_erase(uint32_t off)
{
    if (off < FLASH_LO || off + 0x1000u > FLASH_LO + FLASH_N || (off & 0xFFFu))
        return -8;
    memset(flash + (off - FLASH_LO), 0xFF, 0x1000u);
    erases++;
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    const uint8_t *s = src;
    uint32_t i;
    if (off < FLASH_LO || off + n > FLASH_LO + FLASH_N)
        return -8;
    for (i = 0; i < n; i++) {
        if (cut_after == 0)
            return -9;
        if (cut_after > 0)
            cut_after--;
        flash[off - FLASH_LO + i] &= s[i];
    }
    return 0;
}
static uint16_t m1_crc16(const uint8_t *p, uint32_t n)
{
    uint16_t c = 0xFFFFu;
    while (n--) {
        uint32_t b;
        c ^= (uint16_t)(*p++ << 8);
        for (b = 0; b < 8u; b++)
            c = (uint16_t)(c & 0x8000u ? (c << 1) ^ 0x1021u : c << 1);
    }
    return c;
}

#include "../src/presetstore.c"

static int fails;
#define CHECK(c, what) do { if (c) printf("ok    %s\n", what); else { printf("FAIL  %s\n", what); fails++; } } while (0)

static int get(uint32_t structure, const char *name, int32_t *v0, uint32_t *n)
{
    int i = ps_find(structure, name);
    uint32_t st;
    char nm[PS_NAME + 1];
    if (i < 0 || ps_read((uint32_t)i, &st, nm, n))
        return -1;
    *v0 = *n ? ps_vbuf[0] : 0;
    return 0;
}

int main(void)
{
    int32_t v[PS_MAXV], got;
    uint32_t n, i, k;
    char name[PS_NAME + 1];
    uint8_t list[PS_SLOTS];
    memset(flash, 0xFF, sizeof flash);
    for (i = 0; i < PS_MAXV; i++)
        v[i] = (int32_t)(i * 65536);
    ps_scan();
    CHECK(ps_list(0, 0, 0) == 0u, "an erased store: no presets");

    CHECK(ps_put(0xABCD1234u, "GLASS", v, 24) == 0, "store a preset");
    v[0] = 7;
    CHECK(ps_put(0xABCD1234u, "DUSK", v, 24) == 0, "and another of the same structure");
    CHECK(ps_put(0x11111111u, "KIT", v, 8) == 0, "and one of another structure");
    CHECK(ps_list(0xABCD1234u, list, PS_SLOTS) == 2u, "two of the first structure");
    CHECK(!ps_read(list[0], &k, name, &n) && !strcmp(name, "DUSK") && n == 24u && ps_vbuf[0] == 7, "in name order: DUSK first, its values");
    v[0] = 99;
    CHECK(ps_put(0xABCD1234u, "GLASS", v, 24) == 0 && !get(0xABCD1234u, "GLASS", &got, &n) && got == 99, "overwrite: the new values");
    CHECK(ps_list(0xABCD1234u, 0, 0) == 2u, "still two");
    v[0] = 98;
    CHECK(ps_put(0xABCD1234u, "Glass", v, 24) == 0 && ps_list(0xABCD1234u, 0, 0) == 2u && !get(0xABCD1234u, "GLASS", &got, &n) && got == 98,
          "a name in another case is the same preset (the editor's Glass is the panel's GLASS)");
    v[0] = 99;
    CHECK(ps_put(0xABCD1234u, "GLASS", v, 24) == 0, "(back to its values)");
    ps_scan();
    CHECK(ps_list(0, 0, 0) == 3u && !get(0xABCD1234u, "GLASS", &got, &n) && got == 99, "after a power cycle: the same three, the new values");
    CHECK(ps_del(0x11111111u, "KIT") == 0 && ps_list(0, 0, 0) == 2u && ps_del(0x11111111u, "KIT") == -1, "delete one; again: none");
    CHECK(ps_put(1, "X", v, PS_MAXV + 1u) == -3, "too many values: refused");

    /* a cut write: the old record stays */
    v[0] = 5;
    cut_after = 40;                                     /* the values go, the header not */
    CHECK(ps_put(0xABCD1234u, "GLASS", v, 24) != 0, "a write cut before its header: an error");
    cut_after = -1;
    ps_scan();
    CHECK(!get(0xABCD1234u, "GLASS", &got, &n) && got == 99, "after the power comes back: the old values");
    cut_after = 24 * 4 + 20;                            /* the values, the header half written, no magic */
    (void)ps_put(0xABCD1234u, "GLASS", v, 24);
    cut_after = -1;
    ps_scan();
    CHECK(!get(0xABCD1234u, "GLASS", &got, &n) && got == 99 && ps_list(0, 0, 0) == 2u, "a half-written header: the old record, no ghost");

    /* a cut between the new record and the old one's kill: both valid, the newer wins at the next scan */
    {
        int old = ps_find(0xABCD1234u, "GLASS"), s = ps_clean_slot(PS_NSEC);
        v[0] = 123;
        CHECK(s >= 0 && ps_prog((uint32_t)s, 0xABCD1234u, "GLASS", v, 24) == 0 && old >= 0, "(a new copy written, the old not killed)");
        ps_scan();
        CHECK(!get(0xABCD1234u, "GLASS", &got, &n) && got == 123 && ps_list(0xABCD1234u, 0, 0) == 2u, "the next scan: the newer copy, one GLASS");
    }

    /* fill it: compaction makes room until PS_MAX live presets, then full */
    for (i = 0; ; i++) {
        char nm[PS_NAME];
        int rc;
        snprintf(nm, sizeof nm, "P%u", i);
        v[0] = (int32_t)i;
        rc = ps_put(0x22222222u, nm, v, 30);
        if (rc) {
            CHECK(rc == -2, "full: refused as full");
            break;
        }
        if (i > 500u)
            break;
    }
    CHECK(ps_list(0, 0, 0) == PS_MAX, "full at PS_MAX live presets (about 60)");
    for (i = 0; i < 2000u; i++) {                       /* overwrites go on forever: compaction keeps up */
        char nm[PS_NAME];
        snprintf(nm, sizeof nm, "P%u", i % 20u);
        v[0] = (int32_t)(1000 + i);
        if (ps_put(0x22222222u, nm, v, 30)) {
            printf("      (overwrite %u failed)\n", i);
            break;
        }
    }
    CHECK(i == 2000u && erases > 0, "2000 overwrites in a full store: every one fits (compaction)");
    ps_scan();
    CHECK(ps_list(0, 0, 0) == PS_MAX && !get(0x22222222u, "P19", &got, &n) && got == 1000 + 1999, "after a power cycle: all there, the newest values");

    /* foreign bytes: another firmware's data in the sectors */
    for (i = 0; i < FLASH_N; i++)
        flash[i] = (uint8_t)(i * 37u + 11u);
    ps_scan();
    CHECK(ps_list(0, 0, 0) == 0u, "foreign bytes: no presets read");
    CHECK(ps_put(0xABCD1234u, "NEW", v, 10) == 0 && ps_list(0, 0, 0) == 1u, "and storing works (dead slots compacted)");
    printf(fails ? "preset store test FAILED\n" : "preset store test passed\n");
    return fails != 0;
}
