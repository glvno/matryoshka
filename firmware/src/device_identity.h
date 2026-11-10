/* SPDX-License-Identifier: GPL-3.0-only */
#pragma once
/* Settings-header extension, leaving the legacy 16-byte payload unchanged.
 * Bytes 0..15 name (printable ASCII, zero padded), 16 return percent,
 * 17 version marker, 18..19 CRC16. The physical flash UID is read-only. */
#define DI_NAME_MAX 16u
static char di_name[DI_NAME_MAX + 1];
static uint8_t di_serial[16];
static uint8_t di_level = 50;
static int di_valid_name(const uint8_t *p)
{
    int ended = 0;
    for (uint32_t i=0; i<DI_NAME_MAX; i++) {
        if (!p[i]) ended = 1;
        else if (ended || p[i] < 32u || p[i] > 126u) return 0;
    }
    return 1;
}
static uint16_t di_crc(const uint8_t *p)
{
    uint16_t crc=0xffff;
    for (uint32_t i=0;i<18;i++) {
        crc ^= (uint16_t)p[i]<<8;
        for (uint32_t k=0;k<8;k++) crc = (uint16_t)((crc<<1) ^ ((crc&0x8000) ? 0x1021 : 0));
    }
    return crc;
}
static void di_pack(uint8_t *p)
{
    for (uint32_t i=0;i<16;i++) p[i]=(uint8_t)di_name[i];
    p[16]=di_level; p[17]=0xd1;
    uint16_t crc=di_crc(p); p[18]=(uint8_t)crc; p[19]=(uint8_t)(crc>>8);
}
static int di_encoded_valid(const uint8_t *p)
{
    return p[17]==0xd1 && p[16]<=100 && di_crc(p)==(p[18] | (uint16_t)p[19]<<8) && di_valid_name(p);
}
static int di_record_valid(const uint8_t *p)
{
    uint8_t any=0;
    for (uint32_t i=0;i<20;i++) any |= p[i];
    return !any || di_encoded_valid(p); /* old settings headers were all zero */
}
static int di_unpack(const uint8_t *p)
{
    if (!di_encoded_valid(p)) return 0;
    for (uint32_t i=0;i<16;i++) di_name[i]=(char)p[i];
    di_name[16]=0; di_level=p[16]; return 1;
}
