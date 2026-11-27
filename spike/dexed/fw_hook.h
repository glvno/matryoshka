/* SPDX-License-Identifier: GPL-3.0-only */
/* Spike #1338 (never merged): msfa's voices beside the patch. Every key the engine hears (eng_note_on / eng_note_off,
 * in the main loop) also plays an msfa voice of SPIKE 1: the keys wait in a ring the audio interrupt empties, then
 * dxs_render makes the half's 128 samples after eng_render and adds them to both sides at half level. The time shows in
 * blocktime's BT_ENG_OUT span and in the whole ISR (audio.c reads REND1 after it). */
#pragma once
#include "../../spike/dexed/core/dxs.h"

static volatile uint8_t dxs_ring[64][2] ENG_POOL;    /* note | 0x80 for on, velocity */
static volatile uint32_t dxs_w ENG_POOL, dxs_r ENG_POOL;
static int32_t dxs_buf[128] ENG_POOL;
static uint8_t dxs_ready ENG_POOL;

static void dxs_key(uint32_t note, uint32_t vel, int on)
{
    if (dxs_w - dxs_r >= 64u)
        return;
    dxs_ring[dxs_w & 63u][0] = (uint8_t)(note | (on ? 0x80u : 0u));
    dxs_ring[dxs_w & 63u][1] = (uint8_t)vel;
    dxs_w++;
}

static void dxs_half(int32_t *l, int32_t *r, uint32_t n)
{
    uint32_t i;
    if (!dxs_ready) {
        dxs_init();
        dxs_ready = 1;
    }
    while (dxs_r != dxs_w) {
        uint8_t k = dxs_ring[dxs_r & 63u][0], v = dxs_ring[dxs_r & 63u][1];
        if (k & 0x80u)
            dxs_note_on(k & 0x7F, v);
        else
            dxs_note_off(k);
        dxs_r++;
    }
    for (i = 0; i < n; i++)
        dxs_buf[i] = 0;
    dxs_render(dxs_buf, n);
    for (i = 0; i < n; i++) {
        l[i] += dxs_buf[i] >> 1;
        r[i] += dxs_buf[i] >> 1;
    }
}
