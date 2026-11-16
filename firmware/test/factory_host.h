/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The factory region (#915, firmware/src/factory.c) on the host: its 18 sectors as RAM that behaves like NOR (an erase
 * sets 0xFF, a write only clears bits), holding the generated image (factory_region.h, export-defs) from the first access
 * on, so a harness that reads the factory content sees the full factory set; host_fr_blank() erases it (the firmware tier
 * alone plays), host_fr_load() puts the image back. Each harness's st_read / st_erase / st_prog reaches these bytes through
 * host_fr(off, n). With HOST_FR_ST the region is the whole flash: st_read / st_erase / st_prog and flash_ok are defined here
 * (preset_pattern_test.c, which has proto.c); HOST_FR_STANDALONE adds m1_crc16, M1_NAME, M1_PATCH_MAX and proto.c's status
 * codes (bank_new_test.c, factory_test.c). No libc. Call fc_scan() after changing the bytes under a scanned factory.c. */
#include "factory_region.h"

#define HOST_FR_BASE 0xEA000u
#define HOST_FR_SIZE (18u * 0x1000u)
static uint8_t host_fr_flash[HOST_FR_SIZE];
static uint8_t host_fr_ready;                   /* the bytes are set (else the image goes in at the first access) */

static void host_fr_blank(void)
{
    uint32_t i;
    for (i = 0; i < HOST_FR_SIZE; i++)
        host_fr_flash[i] = 0xFFu;
    host_fr_ready = 1;
}
static void host_fr_load(void)
{
    uint32_t i;
    host_fr_blank();
    for (i = 0; i < sizeof FACTORY_REGION_IMG; i++)
        host_fr_flash[i] = FACTORY_REGION_IMG[i];
}
/* the RAM behind region bytes off .. off + n, 0 when they are not all in the region */
static uint8_t *host_fr(uint32_t off, uint32_t n)
{
    if (off < HOST_FR_BASE || off - HOST_FR_BASE > HOST_FR_SIZE || n > HOST_FR_SIZE - (off - HOST_FR_BASE))
        return 0;
    if (!host_fr_ready)
        host_fr_load();
    return host_fr_flash + off - HOST_FR_BASE;
}

#ifdef HOST_FR_STANDALONE
#define HOST_FR_ST
#define M1_NAME 20u
#define M1_PATCH_MAX 3840u
enum { S_OK, S_RANGE, S_CRC, S_LOAD, S_FLASH, S_CMD, S_NONE, S_FULL, S_MISSING, S_USED };
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
#endif
#ifdef HOST_FR_ST
static uint8_t flash_ok = 1;
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    const uint8_t *f = host_fr(off, n);
    uint32_t i;
    if (!f)
        return -8;
    for (i = 0; i < n; i++)
        ((uint8_t *)dst)[i] = f[i];
    return 0;
}
static int st_erase(uint32_t off)
{
    uint8_t *f = host_fr(off, 0x1000u);
    uint32_t i;
    if (!f || (off & 0xFFFu))
        return -8;
    for (i = 0; i < 0x1000u; i++)
        f[i] = 0xFFu;
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    uint8_t *f = host_fr(off, n);
    uint32_t i;
    if (!f)
        return -8;
    for (i = 0; i < n; i++)
        f[i] &= ((const uint8_t *)src)[i];
    return 0;
}
#endif
