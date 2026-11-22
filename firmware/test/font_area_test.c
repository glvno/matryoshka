/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The font area (#602, firmware/src/font_area.c) on the host, over a whole flash chip in RAM that behaves like NOR (an
 * erase sets 0xFF, a write only clears bits):
 *   - today's image (web/public/firmware/matryoshka-font.bin, tools/gen_font.py) placed in its sectors is this firmware's
 *     font; a blank area, a changed byte in any of the image's sectors or another font's header is not (FONT_S draws);
 *   - the image holds font_bc.h's tables of every size it carries, at the place each table's FONT_AREA define reads;
 *   - the link's install (FONT BEGIN, WRITE, SUM, COMMIT) and its refusals;
 *   - a power cut after every byte the install programs and inside every erase: the next boot finds the font or none,
 *     never the font before its header's magic; the install run again from a cut finishes it;
 *   - the update loader's record sweep (firmware/loader/ldr_record.h) leaves the image alone, and the image never puts a
 *     record's bytes where the sweep looks.
 *   tools/font_area_test.sh */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "../src/engine.h"

static uint8_t flash[0x100000];
#define LDR_REC_LO 0x93000u
#define LDR_REC_HI 0xFC000u
#define LDR_DATA_LO 0x97000u
#define LDR_DATA_HI 0xE0000u
static int ldr_fread(uint32_t off, void *p, uint32_t n) { memcpy(p, flash + off, n); return 0; }
static int ldr_erase(uint32_t off) { memset(flash + off, 0xFF, 0x1000u); return 0; }

/* proto.c's and storage_hw.c's parts factory.c needs */
#define M1_NAME 20u
#define M1_PATCH_MAX 3840u
enum { S_OK, S_RANGE, S_CRC, S_LOAD, S_FLASH, S_CMD, S_NONE, S_FULL, S_MISSING, S_USED };
static uint8_t flash_ok = 1;
static uint16_t m1_crc16(const uint8_t *p, uint32_t n)
{
    uint32_t c = 0xFFFFu, k;
    while (n--) {
        c ^= (uint32_t)*p++ << 8;
        for (k = 0; k < 8u; k++)
            c = c & 0x8000u ? ((c << 1) ^ 0x1021u) & 0xFFFFu : (c << 1) & 0xFFFFu;
    }
    return (uint16_t)c;
}
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    if (off >= sizeof flash || n > sizeof flash - off)
        return -8;
    memcpy(dst, flash + off, n);
    return 0;
}
/* every program and erase the install makes: each programmed byte is probed (the boot after a power cut right after it);
 * cut_erase cuts the next erase short (half the sector erased) and stops the writes */
static void (*probe)(void);
static int cut_erase = -1, cut_hit;
static int st_erase(uint32_t off)
{
    if (cut_hit || (off & 0xFFFu) || off >= sizeof flash)
        return -8;
    if (cut_erase == 0) {
        memset(flash + off, 0xFF, 0x800u);
        cut_hit = 1;
        return -1;
    }
    if (cut_erase > 0)
        cut_erase--;
    memset(flash + off, 0xFF, 0x1000u);
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    uint32_t k;
    if (cut_hit)
        return -1;
    if (off >= sizeof flash || n > sizeof flash - off)
        return -8;
    for (k = 0; k < n; k++) {
        flash[off + k] &= ((const uint8_t *)src)[k];
        if (probe)
            probe();
    }
    return 0;
}
#include "../src/factory.c"

/* font_bc.c's flag and main.c's hook */
static uint8_t font_ok;
static uint32_t font_changes;
static void m1_font_changed(void) { font_changes++; }
#include "../src/font_bc.h"
#define FA_PTR(off) ((const uint8_t *)flash + (off))
#include "../src/font_area.c"

static int fails;
static void check(const char *what, int ok)
{
    printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
    if (!ok)
        fails++;
}

static uint8_t img[FA_SECTORS * 0x1000u];
static uint32_t img_len;

static void place(void)
{
    uint32_t s;
    for (s = 0; s < FA_SECTORS; s++) {
        memset(flash + fa_addr(s), 0xFF, 0x1000u);
        if (s * 0x1000u < img_len)
            memcpy(flash + fa_addr(s), img + s * 0x1000u, img_len - s * 0x1000u < 0x1000u ? img_len - s * 0x1000u : 0x1000u);
    }
}
static void blank(void)
{
    uint32_t s;
    for (s = 0; s < FA_SECTORS; s++)
        memset(flash + fa_addr(s), 0xFF, 0x1000u);
}
/* the image's byte at offset o, as the flash holds it */
static uint8_t *at(uint32_t o) { return flash + fa_addr(o >> 12) + (o & 0xFFFu); }

/* sector s of the image as the flash holds it before the commit (the header's 64 bytes erased) */
static uint32_t sector_sum(uint32_t s)
{
    uint8_t b[0x1000];
    uint32_t k;
    memset(b, 0xFF, sizeof b);
    for (k = 0; k < 0x1000u && s * 0x1000u + k < img_len; k++)
        b[k] = (s || k >= FA_HDR) ? img[s * 0x1000u + k] : 0xFFu;
    return fc_crc16(0xFFFFu, b, sizeof b);
}
/* the editor's install (web/src/font-content.ts, tools/m1_link.py font_install): BEGIN, each sector whose SUM differs
 * written in pages, then COMMIT. The status of the first step that failed, else S_OK */
static uint32_t install(const uint8_t *hdr)
{
    uint32_t st, s, off, crc, sectors = (img_len + 0xFFFu) / 0x1000u;
    if ((st = m1_font_begin()) != S_OK)
        return st;
    for (s = 0; s < sectors; s++) {
        if (!m1_font_sum(s, &crc) && crc == sector_sum(s))
            continue;
        for (off = s ? 0u : FA_HDR; off < 0x1000u && s * 0x1000u + off < img_len; off = (off | 0xFFu) + 1u) {
            uint32_t n = 256u - (off & 0xFFu), a = s * 0x1000u + off;
            uint8_t page[256];
            if (a + n > img_len)
                n = img_len - a;
            memcpy(page, img + a, n);
            if ((off & 0xF00u) == 0xF00u && n < LDR_REC_LEN) {       /* (the record's page: written whole, 0xFF after) */
                memset(page + n, 0xFF, 256u - n);
                n = 256u;
            }
            if ((st = m1_font_write(s, off, page, n)) != S_OK)
                return st;
        }
        if (m1_font_sum(s, &crc) || crc != sector_sum(s))
            return S_CRC;
    }
    return m1_font_commit(hdr);
}

/* the boot after a power cut: the area holds the font whole, or the firmware finds none */
static int probe_bad;
static void boot_probe(void)
{
    uint32_t i;
    fa_scan();
    if (font_ok) {                                       /* (a font found: every byte the image's) */
        for (i = 0; i < img_len; i++)
            if (*at(i) != img[i]) {
                probe_bad++;
                return;
            }
    }
}

/* table t (n bytes) of font_bc.h is in the flash, its first and last bytes in the font area's sectors (a FONT_AREA build
 * reads it there; the image keeps a table inside one run of sectors) */
static int table_ok(const char *name, const void *t, uint32_t n)
{
    uint32_t o, s, in;
    for (o = 0x93000u; o + n <= sizeof flash; o++)
        if (!memcmp(flash + o, t, n)) {
            for (in = 0, s = 0; s < FA_SECTORS; s++)
                in += fa_addr(s) == (o & ~0xFFFu) || fa_addr(s) == ((o + n - 1u) & ~0xFFFu);
            if (in == 2u || (in == 1u && (o >> 12) == ((o + n - 1u) >> 12)))
                return 1;
        }
    printf("  (%s not found in the font area)\n", name);
    return 0;
}

int main(int argc, char **argv)
{
    FILE *fp = fopen(argc > 1 ? argv[1] : "web/public/firmware/matryoshka-font.bin", "rb");
    uint8_t other[FA_HDR];
    uint32_t s, k, st;
    int ok;
    if (!fp) {
        printf("FAIL: no image\n");
        return 1;
    }
    img_len = (uint32_t)fread(img, 1, sizeof img, fp);
    fclose(fp);
    memset(flash, 0xFF, sizeof flash);

    check("the image is this firmware's font's (FA_LEN, FA_ID in its header)", img_len == FA_LEN && fc_u32(img + 12) == FA_ID &&
          fc_u32(img) == FA_MAGIC && img[4] == FA_LAYOUT && img[5] == FA_SECTORS);
    for (ok = 1, s = 0; s < FA_SECTORS; s++)
        ok &= img[16u + 2u * s] == fa_sec[s] && img[17u + 2u * s] == 0;
    check("its header lists FA_SECTOR_LIST", ok);

    fa_scan();
    check("a blank area: no font (FONT_S draws)", !font_ok);
    place();
    fa_scan();
    check("today's image in its sectors: this firmware's font", font_ok);
    /* every table of the area's sizes, found where the image puts it (gen_font.py writes both from one layout) */
    ok = 1;
#define T(x) ok &= table_ok(#x, x, sizeof x)
    T(font_m_map); T(font_m_g); T(font_m_bits); T(font_l_map); T(font_l_g); T(font_l_bits); T(font_f_map); T(font_f_g);
    T(font_f_bits); T(font_h_map); T(font_h_g); T(font_h_bits); T(font_n_map); T(font_n_g); T(font_n_bits); T(font_v_map);
    T(font_v_g); T(font_v_bits); T(font_t_map); T(font_t_g); T(font_t_bits);
#undef T
    check("the image holds every table of FONT_M .. FONT_T (font_bc.h's bytes)", ok);
    for (ok = 1, s = 0; s < FA_SECTORS; s++) {
        uint32_t o = s * 0x1000u + 0x10u + (s * 997u) % 0xFE0u;  /* (a byte of each sector, header bytes 16.. included) */
        if (o >= img_len)
            continue;
        *at(o) ^= 0x01u;
        fa_scan();
        ok &= !font_ok;
        *at(o) ^= 0x01u;
    }
    fa_scan();
    check("one changed byte in any of its sectors: no font; put back: the font", ok && font_ok);
    memcpy(other, img, FA_HDR);
    other[12] ^= 1u;                                       /* (another font's id) */
    memcpy(at(0), other, FA_HDR);
    fa_scan();
    check("another font's header: no font", !font_ok);
    place();

    /* the update loader's sweep: the image's sectors stay; the image never has a record where it looks */
    ldr_records_clear();
    fa_scan();
    for (ok = 1, s = 0; s < FA_SECTORS; s++)
        ok &= !ldr_is_record(flash + fa_addr(s) + 0xF00u);
    check("the update loader's record sweep leaves the font area alone", font_ok && ok);

    /* the link's install */
    blank();
    fa_scan();
    check("WRITE before BEGIN: refused", m1_font_write(1, 0, img, 16) == S_NONE);
    check("COMMIT before BEGIN: refused", m1_font_commit(img) == S_NONE);
    font_changes = 0;
    st = install(img);
    check("the install: S_OK, the font found, the screen drawn again at BEGIN and COMMIT", st == S_OK && font_ok && font_changes == 2u);
    fa_scan();
    check("the next boot finds it", font_ok);
    check("BEGIN: the font goes (FONT_S draws) until the commit", m1_font_begin() == S_OK && !font_ok);
    check("WRITE into the header's 64 bytes: refused", m1_font_write(0, 0, img, 16) == S_RANGE);
    check("WRITE past the area's sectors: refused", m1_font_write(FA_SECTORS, 0, img, 16) == S_RANGE);
    check("WRITE across a page: refused", m1_font_write(1, 0xF0, img, 32) == S_RANGE);
    check("SUM past the area's sectors: none", m1_font_sum(FA_SECTORS, &k) != 0);
    check("COMMIT of another font's header: refused (S_LOAD)", m1_font_commit(other) == S_LOAD);
    *at(0x2000u + 5u) ^= 0x10u;                            /* (a bit set again where the image has it clear: as if damaged) */
    st = m1_font_commit(img);
    check("COMMIT over a damaged sector: S_CRC, no font", st == S_CRC && !font_ok);
    check("the install run again after that: S_OK", install(img) == S_OK && font_ok);

    /* a power cut after every programmed byte, then the install run again */
    blank();
    probe = boot_probe;
    probe_bad = 0;
    fa_writing = 0;
    st = install(img);
    probe = 0;
    fa_scan();
    check("a power cut after any programmed byte: the next boot finds the font whole or none", probe_bad == 0 && st == S_OK && font_ok);
    for (k = 0; k < (img_len + 0xFFFu) / 0x1000u; k++) {
        blank();                                           /* (every sector written, so each has its erase) */
        cut_erase = (int)k;
        cut_hit = 0;
        (void)install(img);
        cut_hit = 0;
        cut_erase = -1;
        fa_scan();
        ok = !font_ok;
        st = install(img);
        if (!ok || st != S_OK || !font_ok) {
            printf("  (cut in erase %u)\n", k);
            break;
        }
    }
    check("a power cut inside any erase: no font, the install run again finishes it", k == (img_len + 0xFFFu) / 0x1000u);

    printf(fails ? "FAIL: %d\n" : "all font area checks passed\n", fails);
    return fails ? 1 : 0;
}
