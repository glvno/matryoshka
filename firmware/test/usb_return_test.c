/* SPDX-License-Identifier: GPL-3.0-only */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#include "../src/usb_return.h"
static void packet(unsigned n, unsigned start)
{
    uint32_t p[46];
    for (unsigned i = 0; i < n; i++) p[i] = (uint16_t)(start+i) | ((uint32_t)(uint16_t)-(int)(start+i) << 16);
    ur_receive((const uint8_t *)p, n*4);
}
int main(void)
{
    int32_t o[256];
    ur_level = 100;
    ur_start(1);
    memset(o, 0, sizeof o);
    ur_mix(o, 128); /* acknowledge new stream */
    for (unsigned i = 0; i < 8; i++) packet(44, i*44+1);
    ur_mix(o, 128);
    for (unsigned i = 0; i < 128; i++) { assert(o[2*i] == (int)(i+1)*256); assert(o[2*i+1] == -(int)(i+1)*256); }
    ur_start(0);
    memset(o, 0, sizeof o); ur_mix(o, 128);
    for (unsigned i = 0; i < 256; i++) assert(o[i] == 0);
    ur_start(1); ur_mix(o,128);
    for (unsigned i=0;i<8;i++) packet(44,1);
    for(unsigned i=0;i<256;i++) o[i]=8388600;
    ur_mix(o,128); assert(o[0]==8388607);
    memset(o,0,sizeof o); ur_mix(o,128);
    memset(o,0,sizeof o); ur_mix(o,128); /* partial underrun ends in silence */
    for(unsigned i=192;i<256;i++) assert(o[i]==0);
    memset(o,0,sizeof o); ur_mix(o,128);
    for(unsigned i=0;i<256;i++) assert(o[i]==0);
    uint32_t w=ur_w;
    uint8_t bad[185]={0}; ur_receive(bad,3); ur_receive(bad,185); assert(ur_w==w);
    /* A host follows the explicit feedback, with up to 16 ms of response lag.
     * Consume 128-frame halves at measured and nearby clocks, varied render phase.
     * Verify no lost/duplicated PCM frames after priming during 60 seconds. */
    for(unsigned rate=44080; rate<=44140; rate+=19) for(unsigned lag=0;lag<=16;lag+=8) {
        ur_start(1); memset(o,0,sizeof o); ur_mix(o,128);
        uint32_t history[32]; for(unsigned i=0;i<32;i++) history[i]=UR_NOMINAL;
        uint64_t host=0;
        double render_at=0;
        unsigned sent=1, got=0, active=0, block=0;
        uint32_t under=ur_underruns, over=ur_overruns;
        for(unsigned ms=0;ms<60000;ms++) {
            host+=history[(ms+32-lag)%32]; unsigned n=host>>14; host&=16383;
            packet(n,sent); sent+=n;
            /* Render completion varies by almost a whole audio half:
             * TIMER5 keeps filling the ring while the engine renders. */
            while(render_at < (double)(ms+1)*1000) {
                memset(o,0,sizeof o); ur_mix(o,128);
                if(ur_playing) {
                    for(unsigned i=0;i<128;i++) {
                        if(!active) { got=(uint16_t)(o[2*i]/256); active=1; }
                        if(o[2*i] != (int16_t)got*256) { printf("rate %u lag %u ms %u i %u got %d expected %d fill %u under %u over %u\n",rate,lag,ms,i,o[2*i]/256,(int16_t)got,ur_w-ur_r,ur_underruns-under,ur_overruns-over); return 1; } got++;
                    }
                }
                block++;
                render_at=(double)block*128000000/rate + (block%3==0 ? 2800 : block%3==1 ? 100 : 1400);
            }
            history[ms%32]=ur_feedback();
        }
        assert(active && ur_underruns==under && ur_overruns==over);
    }
    puts("USB return: stereo order, saturation, stop, underrun, malformed packets and clock drift passed");
}
