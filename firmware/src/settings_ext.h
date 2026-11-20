/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* Needs slotstore.c (sl_ext, SL_EXT_MAX), m1_crc16 (proto.c), the master EQ's meq_pack, meq_unpack, meq_defaults and
 * MEQ_BYTES (master_eq.h) and the pad map's pad_pack, pad_unpack, pad_defaults and PAD_BYTES (pad_map.h). Included by
 * main.c; firmware/test/device_identity_test.c checks it on the flash. */
/* The settings record's extension (slotstore.c sl_write_ext, #1107): settings the 16-byte record has no room for, in
 * the same sector, written with every settings record. Byte 0 its version (SET_EXT_VERSION), byte 1 how many bytes
 * follow before the CRC (later settings append, and an older reader takes the bytes it knows), then the master EQ
 * (master_eq.h meq_pack: LOW, MID, HIGH, MID FREQ), then the pad map (pad_map.h pad_pack: PAD MAP, the 24 rows' notes,
 * #1067), then the CRC-16 of everything before it. A settings record without one (an older firmware's: the erased flash
 * reads 0xFF) or with a bad CRC leaves the master EQ flat and the pad map empty; one from before the pad map (4 bytes)
 * keeps its EQ and leaves the map empty. A firmware before it never reads there, and a settings record it writes has
 * none. */
#define SET_EXT_VERSION 1u
#define SET_EXT_N (MEQ_BYTES + PAD_BYTES)
#define SET_EXT_LEN (2u + SET_EXT_N + 2u)
static void settings_ext_pack(uint8_t *d)
{
    uint32_t crc;
    d[0] = SET_EXT_VERSION;
    d[1] = SET_EXT_N;
    meq_pack(d + 2);
    pad_pack(d + 2 + MEQ_BYTES);
    crc = m1_crc16(d, 2u + SET_EXT_N);
    d[2u + SET_EXT_N] = (uint8_t)crc;
    d[3u + SET_EXT_N] = (uint8_t)(crc >> 8);
}
/* the settings record's extension into the settings (patch_boot, after the record) */
static void settings_ext_load(void)
{
    uint8_t d[SL_EXT_MAX];
    uint32_t n;
    meq_defaults();
    pad_defaults();
    if (sl_ext(SL_SETTINGS, d, SL_EXT_MAX) || d[0] != SET_EXT_VERSION || d[1] < MEQ_BYTES || (n = 2u + d[1]) + 2u > SL_EXT_MAX
        || m1_crc16(d, n) != (uint32_t)(d[n] | d[n + 1u] << 8))
        return;
    meq_unpack(d + 2);
    if (d[1] >= MEQ_BYTES + PAD_BYTES)
        pad_unpack(d + 2 + MEQ_BYTES);
}
