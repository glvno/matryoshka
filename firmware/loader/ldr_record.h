/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Matryoshka (glvno). */
/* Update records as the update loader finds and erases them (ldr_core.c, step 4; moved here for #915 so the factory
 * region's writer and the host tests share the loader's own rule). A record is the 80 bytes at a 4K boundary - 256
 * between LDR_REC_LO and LDR_REC_HI, outside Felucca's store [LDR_DATA_LO, LDR_DATA_HI), with "AT" at bytes 6..7 and a
 * nonzero CRC-16 of bytes 2..79 at 0..1; the loader erases each such sector once an update is written. The factory region
 * (0xEA000 .. 0xFBFFF, firmware/src/factory.c) is in that range: its image never has such bytes there
 * (web/scripts/factory-region.ts), and the firmware refuses to program them (factory.c m1_fact_write).
 * ldr_records_clear needs LDR_REC_LO / LDR_REC_HI / LDR_DATA_LO / LDR_DATA_HI and the hooks ldr_fread, ldr_erase
 * (ldr_core.c, or a host test's). */
#pragma once
#include <stdint.h>

#define LDR_REC_LEN 80u

static uint32_t ldr_rec_crc16(const uint8_t *p, uint32_t n)   /* poly 0x1021, init 0 (ota.c ota_crc16) */
{
    uint32_t c = 0, k;
    while (n--) {
        c ^= (uint32_t)*p++ << 8;
        for (k = 0; k < 8u; k++)
            c = c & 0x8000u ? (c << 1) ^ 0x1021u : c << 1;
        c &= 0xFFFFu;
    }
    return c;
}

/* r: the 80 bytes at a sector's offset 0xF00. 1: the loader takes them for an update record */
static int ldr_is_record(const uint8_t *r)
{
    uint32_t crc = (uint32_t)r[0] | (uint32_t)r[1] << 8;
    return ((uint32_t)r[6] | (uint32_t)r[7] << 8) == 0x5441u && crc && crc == ldr_rec_crc16(r + 2, LDR_REC_LEN - 2u);
}

#ifdef LDR_REC_HI
/* the flash records invalidated: each sector whose last 256 bytes hold one is erased (Felucca's store skipped: user data
 * that may look like one) */
static void ldr_records_clear(void)
{
    uint32_t s;
    for (s = LDR_REC_HI; s > LDR_REC_LO; s -= 0x1000u) {
        uint8_t r[LDR_REC_LEN];
        if (s - 0x1000u >= LDR_DATA_LO && s - 0x1000u < LDR_DATA_HI)
            continue;
        if (ldr_fread(s - 0x100u, r, LDR_REC_LEN))
            break;
        if (ldr_is_record(r))
            ldr_erase(s - 0x1000u);
    }
}
#endif
