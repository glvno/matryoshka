/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The font area (#602, docs/ledger/device-ui.md D-1190): the screen type's larger sizes (FONT_M .. FONT_T, about 37 KB)
 * live in 10 flash sectors outside the firmware, which the installer writes after the firmware, as it does the factory
 * region. The sectors (font_bc.h FA_SECTOR_LIST, tools/gen_font.py AREA_RUNS) are three runs no Matryoshka firmware
 * wrote before: 0x93000 .. 0x96FFF, 0xE7000 .. 0xE9FFF and 0xFC000 .. 0xFEFFF; the image's sector n is the list's n.
 * The update loader never writes them (it writes only the firmware's area below 0x93000), and an older firmware never
 * reads them: it has its type compiled in.
 *
 * The image (web/public/firmware/matryoshka-font.bin, written by tools/gen_font.py with font_bc.h), little endian: a
 * 64-byte header, u32 magic "MFN1" (programmed last: the commit), u8 layout (FA_LAYOUT), u8 sectors, u16 spare, u32 the
 * image's length, u32 the CRC-32 of its bytes 16 .. its end (the font's id), u16 the flash sector (offset / 4096) of
 * each of its sectors; then the tables at fixed places, which font_bc.h's FONT_AREA defines read through the flash's read
 * window (XIP). This firmware takes only the image it was built with: FA_ID, FA_LEN.
 *
 * At boot fa_scan checks the header and the CRC through the read window, exactly as the type is read; until it passes
 * (no image, another font, a cut install, damage) every size draws FONT_S's letters (font_bc.c font_use) and the FM-1
 * says SCREEN FONT MISSING (main.c). Writing over the editor link (proto.c FONT), power-cut safe in the factory region's
 * order (factory.c): BEGIN erases sector 0 (the header goes: the fallback draws from then on), WRITE programs pages
 * (offset 0 of sectors 1.. erases the sector first; sector 0 keeps bytes 0..63 for the header), SUM gives a sector's
 * CRC-16 so a repeated install skips the sectors already written, COMMIT checks the header against FA_ID and FA_LEN,
 * programs its bytes 4..63, checks the CRC as the read window shows the image, then programs the magic.
 * Needs st_read / st_erase / st_prog (storage_hw.c), flash_ok, fc_page, fc_sector_sum, fc_crc32, fc_u32 (factory.c),
 * font_ok (font_bc.c), the status codes (proto.c) and m1_font_changed (main.c: the screen redrawn). Host tests:
 * tools/font_area_test.sh. */
#define FA_MAGIC 0x314E464Du            /* "MFN1" */
#define FA_LAYOUT 1u
#define FA_HDR 64u
#ifndef FA_PTR
#define FA_PTR(off) fm1_xip_ptr(off)    /* flash offset off through the read window (hal/fm1_xip.h) */
#endif

static const uint8_t fa_sec[FA_SECTORS] = FA_SECTOR_LIST;
static uint8_t fa_writing;              /* BEGIN ran since boot (no commit yet) */

static uint32_t fa_addr(uint32_t s) { return (uint32_t)fa_sec[s] << 12; }

/* the CRC-32 of the image's bytes 16 .. FA_LEN as the type reads them (the read window) */
static uint32_t fa_crc(void)
{
    uint32_t c = 0xFFFFFFFFu, s, o = 16u;
    for (s = 0; o < FA_LEN; s++) {
        uint32_t e = (s + 1u) * 0x1000u < FA_LEN ? (s + 1u) * 0x1000u : FA_LEN;
        c = fc_crc32(c, FA_PTR(fa_addr(s) + (o & 0xFFFu)), e - o);
        o = e;
    }
    return ~c;
}

/* 1: the font area holds this firmware's font, whole */
static int fa_valid(void)
{
    const uint8_t *h = FA_PTR(fa_addr(0));
    return fc_u32(h) == FA_MAGIC && h[4] == FA_LAYOUT && fc_u32(h + 8) == FA_LEN && fc_u32(h + 12) == FA_ID && fa_crc() == FA_ID;
}

/* at boot, before the first page is drawn */
static void fa_scan(void)
{
    font_ok = (uint8_t)fa_valid();
}

/* INFO bytes 20..24 (proto.c): flags (bit 0 this firmware reads its type from the font area: the FONT command; bit 1 the
 * area holds that font; bit 2 BEGIN ran, no commit yet), then FA_ID (u32) */
static void m1_font_info(uint8_t *p)
{
    uint32_t k;
    p[0] = (uint8_t)(1u | (font_ok ? 2u : 0u) | (fa_writing ? 4u : 0u));
    for (k = 0; k < 4u; k++)
        p[1u + k] = (uint8_t)(FA_ID >> (8u * k));
}

/* FONT BEGIN: the header's sector erased; the fallback draws until a commit */
static uint32_t m1_font_begin(void)
{
    if (!flash_ok)
        return S_FLASH;
    font_ok = 0;
    fa_writing = 1;
    m1_font_changed();
    return st_erase(fa_addr(0)) ? S_FLASH : S_OK;
}

/* FONT WRITE: n bytes at offset off of the image's sector s, inside one page (offset 0 of sectors 1.. erases the sector
 * first); read back and compared */
static uint32_t m1_font_write(uint32_t s, uint32_t off, const uint8_t *p, uint32_t n)
{
    if (!flash_ok)
        return S_FLASH;
    if (!fa_writing)
        return S_NONE;
    if (s >= FA_SECTORS || (!s && off < FA_HDR))
        return S_RANGE;
    return fc_page(fa_addr(s), off, p, n, s != 0u);
}

/* FONT SUM: CRC-16 of the image's sector s (4096 bytes) into *crc: 0 ok */
static int m1_font_sum(uint32_t s, uint32_t *crc)
{
    return flash_ok && s < FA_SECTORS ? fc_sector_sum(fa_addr(s), crc) : -1;
}

/* FONT COMMIT: the 64-byte header h checked (this firmware's font: S_LOAD otherwise), its bytes 4..63 programmed, the
 * image's CRC checked as the read window shows it (S_CRC), then the magic. A status (S_OK ..) */
static uint32_t m1_font_commit(const uint8_t *h)
{
    uint8_t b[FA_HDR];
    uint32_t i;
    if (!flash_ok)
        return S_FLASH;
    if (!fa_writing)
        return S_NONE;
    if (fc_u32(h) != FA_MAGIC || h[4] != FA_LAYOUT || fc_u32(h + 8) != FA_LEN || fc_u32(h + 12) != FA_ID)
        return S_LOAD;
    if (st_read(fa_addr(0), b, FA_HDR))
        return S_FLASH;
    for (i = 0; i < FA_HDR; i++)
        if (b[i] != 0xFFu)
            return S_RANGE;                            /* (a header is there: BEGIN first) */
    if (st_prog(fa_addr(0) + 4u, h + 4, FA_HDR - 4u))
        return S_FLASH;
    if (fa_crc() != FA_ID)
        return S_CRC;
    if (st_prog(fa_addr(0), h, 4u))
        return S_FLASH;
    fa_writing = 0;
    fa_scan();
    m1_font_changed();
    return font_ok ? S_OK : S_FLASH;
}
