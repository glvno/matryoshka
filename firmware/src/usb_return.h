/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* Stereo USB playback, PCM16/44100. TIMER5 owns w and the stream epoch;
 * the audio ISR owns r and priming. The producer NEVER advances r or
 * overwrites unread samples, even when it interrupts the consumer. A new
 * epoch discards queued audio on the next consumer sample. */
#ifndef UR_MEM
#define UR_MEM
#endif
#define UR_N 512u
#define UR_PRIME 256u
#define UR_NOMINAL ((44100u * 16384u) / 1000u)
static uint32_t ur_ring[UR_N] UR_MEM;
static volatile uint32_t ur_w, ur_r, ur_epoch;
static volatile uint8_t ur_alt;
static uint32_t ur_seen;
static uint8_t ur_playing;
static volatile uint8_t ur_level = 50;  /* percent, independent of MASTER */
static int32_t ur_fill_q8;
static uint32_t ur_underruns, ur_overruns;

static void ur_start(uint32_t alt)
{
    ur_alt = 0;
    ur_epoch++;
    ur_fill_q8 = 256 * 256;
    RING_PUBLISH();
    ur_alt = (uint8_t)alt;
}
static void ur_receive(const uint8_t *p, uint32_t bytes)
{
    uint32_t n = bytes / 4u, w = ur_w;
    if (!ur_alt || bytes % 4u || n > 45u) return;
    if (n > UR_N - (w - ur_r)) { ur_overruns++; return; }
    for (uint32_t i = 0; i < n; i++, p += 4)
        ur_ring[(w + i) & (UR_N-1u)] = p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
    RING_PUBLISH();
    ur_w = w + n;
}
/* UAC1 10.14 frames/ms. One call per USB frame. A slow fill servo adjusts
 * the host's packet sizes to the FM-1 clock; no resampling of audio. */
static uint32_t ur_feedback(void)
{
    ur_fill_q8 += ((int32_t)(ur_w - ur_r) * 256 - ur_fill_q8) / 32;
    int32_t correction = (256 * 256 - ur_fill_q8) / 16;
    if (correction > 8192) correction = 8192;
    if (correction < -8192) correction = -8192;
    return (uint32_t)((int32_t)UR_NOMINAL + correction);
}
static int32_t ur_clip(int32_t x)
{
    return x > 8388607 ? 8388607 : x < -8388608 ? -8388608 : x;
}
/* After the recording tap and count-in click; before analog mono/off.
 * Consume even at level zero. A stopped host becomes silence, never a
 * repeated final sample. No stream allocation and no floating point. */
static void ur_mix(int32_t *out, uint32_t n)
{
    uint32_t epoch = ur_epoch, r = ur_r;
    if (ur_seen != epoch || !ur_alt) {
        ur_seen = epoch; ur_playing = 0; ur_r = ur_w;
        return;
    }
    if (!ur_playing) {
        if (ur_w-r < UR_PRIME) return;
        ur_playing = 1;
    }
    int32_t gain = ((int32_t)ur_level * 256) / 100;
    for (uint32_t i = 0; i < n; i++) {
        if (ur_epoch != epoch || !ur_alt) { ur_playing = 0; ur_r = ur_w; return; }
        if (r == ur_w) { ur_playing = 0; ur_underruns++; break; }
        uint32_t s = ur_ring[r & (UR_N-1u)];
        out[2*i] = ur_clip(out[2*i] + (int16_t)s * gain);
        out[2*i+1] = ur_clip(out[2*i+1] + (int16_t)(s>>16) * gain);
        r++;
        RING_PUBLISH();
        ur_r = r;
    }
}
