/* SPDX-License-Identifier: GPL-3.0-only */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define FELUCCA_DEVICE_IDENTITY 1
#define M1_NAME 20u
#define M1_SLOTS 64u
#define M1_PATCH_MAX 3840u
#define ENG_POOL
#include "../src/device_identity.h"
static uint8_t flash[0x100000], saved[0x100000];
static int cut=-1;
static int st_read(uint32_t a, void *p, uint32_t n) { assert(a+n<=sizeof flash); memcpy(p,flash+a,n); return 0; }
static int st_erase(uint32_t a) { if(cut==0) return -1; if(cut>0) cut--; memset(flash+a,255,4096); return 0; }
static int st_prog(uint32_t a, const uint8_t *p, uint32_t n) {
    for(uint32_t i=0;i<n;i++) { if(cut==0) return -1; if(cut>0) cut--; flash[a+i]&=p[i]; } return 0;
}
static uint16_t m1_crc16(const uint8_t *p,uint32_t n) {
    uint16_t crc=0xffff; for(uint32_t i=0;i<n;i++) { crc^=(uint16_t)p[i]<<8; for(unsigned k=0;k<8;k++) crc=(uint16_t)((crc<<1)^((crc&0x8000)?0x1021:0)); } return crc;
}
static void fm1_wdt_feed(void) {}
#include "../src/slotstore.c"
int main(void) {
    uint8_t p[20]={0}, payload[16]={1,2,3}, read[16]; uint32_t n;
    memset(flash,255,sizeof flash); sl_scan();
    assert(!di_unpack(p)); /* legacy header has no extension */
    strcpy(di_name,"STAGE"); di_level=73; di_pack(p);
    for(unsigned i=0;i<20;i++) { uint8_t old=p[i]; p[i]^=1; assert(!di_unpack(p)); p[i]=old; }
    assert(di_unpack(p));
    assert(sl_write(SL_SETTINGS,0,payload,16)==0);
    sl_hdr_t h; assert(!sl_head(SL_SETTINGS,&h,1)); assert(h.len==16);
    memset(di_name,0,sizeof di_name); assert(di_unpack((uint8_t*)h.name)); assert(!strcmp(di_name,"STAGE") && di_level==73);
    assert(!sl_read(SL_SETTINGS,read,&n,0) && n==16 && !memcmp(read,payload,16));
    memcpy(saved,flash,sizeof flash);
    /* Every possible interrupted byte of the settings transaction leaves
     * either the old settings/name or the complete new settings/name. */
    for(int stop=0;stop<=66;stop++) {
        memcpy(flash,saved,sizeof flash); cut=-1; sl_scan();
        strcpy(di_name,"DESK"); di_level=0; cut=stop;
        (void)sl_write(SL_SETTINGS,0,payload,16);
        cut=-1; sl_scan(); assert(!sl_head(SL_SETTINGS,&h,1)); assert(di_unpack((uint8_t*)h.name));
        assert((!strcmp(di_name,"STAGE") && di_level==73) || (!strcmp(di_name,"DESK") && di_level==0));
    }
    for(unsigned i=0;i<16;i++) di_serial[i]=(uint8_t)(i+1);
    sl_clear_all(); /* physical serial is outside the erased settings */
    for(unsigned i=0;i<16;i++) assert(di_serial[i]==i+1);
    puts("Device identity: legacy payload, CRC, atomic header persistence and reset passed");
}
