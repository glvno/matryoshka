/*
 * Copyright 2016-2025 Pascal Gauthier.
 * Copyright 2012 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Spike #1338 (never merged): the smallest synth unit around Dexed's voices, what PluginProcessor.cpp does with them
// (one LFO, the controllers, one FmCore, the 64-sample render and Dexed's clip per voice) behind a C interface, and
// msfa's UnpackPatch (music-synthesizer-for-android patch.cc) for DX7 SysEx voices.
#include "synth.h"
#include "lfo.h"
#include "dx7note.h"
#include "dxs.h"

#ifndef DXS_MAX
#define DXS_MAX 16
#endif

struct Voice {
    Dx7Note note;
    uint8_t midi_note;
    bool keydown;
    bool live;
};

static Voice voices[DXS_MAX];
static Lfo lfo;
static Controllers controllers;
static FmCore core;
static uint8_t patch[156];
static int next_voice;
static int32_t audiobuf[N];

// "SPIKE 1": every operator sounding and modulated, the LFO on pitch and amplitude (the code paths a busy voice takes)
static const uint8_t spike_voice[156] = {
#define OP(ol) 99, 50, 35, 40, 99, 90, 85, 0, 39, 0, 0, 0, 0, 0, 1, 2, ol, 0, 1, 0, 7
    OP(80), OP(80), OP(99), OP(80), OP(80), OP(99),
#undef OP
    99, 99, 99, 99, 50, 50, 50, 50,     // pitch envelope
    0, 6, 1,                            // algorithm 1, feedback 6, oscillator sync
    35, 0, 10, 20, 0, 0, 3,             // LFO speed, delay, PMD, AMD, sync, wave, PMS
    24, 'S', 'P', 'I', 'K', 'E', ' ', '1', ' ', ' ', ' ', 0x3f,
};

// music-synthesizer-for-android patch.cc UnpackPatch: a 128-byte voice of a 32-voice bulk dump to the 156-byte form
extern "C" void dxs_unpack(const uint8_t bulk[128], uint8_t out[156]) {
    for (int op = 0; op < 6; op++) {
        for (int i = 0; i < 11; i++)
            out[op * 21 + i] = bulk[op * 17 + i];
        uint8_t leftrightcurves = bulk[op * 17 + 11];
        out[op * 21 + 11] = leftrightcurves & 3;
        out[op * 21 + 12] = (leftrightcurves >> 2) & 3;
        uint8_t detune_rs = bulk[op * 17 + 12];
        out[op * 21 + 13] = detune_rs & 7;
        out[op * 21 + 20] = detune_rs >> 3;
        uint8_t kvs_ams = bulk[op * 17 + 13];
        out[op * 21 + 14] = kvs_ams & 3;
        out[op * 21 + 15] = kvs_ams >> 2;
        out[op * 21 + 16] = bulk[op * 17 + 14];
        uint8_t fcoarse_mode = bulk[op * 17 + 15];
        out[op * 21 + 17] = fcoarse_mode & 1;
        out[op * 21 + 18] = fcoarse_mode >> 1;
        out[op * 21 + 19] = bulk[op * 17 + 16];
    }
    for (int i = 0; i < 9; i++)
        out[126 + i] = bulk[102 + i];
    uint8_t oks_fb = bulk[111];
    out[135] = oks_fb & 7;
    out[136] = oks_fb >> 3;
    for (int i = 0; i < 4; i++)
        out[137 + i] = bulk[112 + i];
    uint8_t lpms_lfw_lks = bulk[116];
    out[141] = lpms_lfw_lks & 1;
    out[142] = (lpms_lfw_lks >> 1) & 7;
    out[143] = lpms_lfw_lks >> 4;
    for (int i = 0; i < 11; i++)
        out[144 + i] = bulk[117 + i];
    out[155] = 0x3f;
}

extern "C" void dxs_set_voice(const uint8_t v[156]) {
    for (int i = 0; i < 156; i++)
        patch[i] = v[i];
    lfo.reset(patch + 137);
}

extern "C" void dxs_init(void) {
    controllers.core = &core;
    controllers.pitch_cc = 0x2000;
    controllers.pitch_range_up = controllers.pitch_range_dn = 2;
    controllers.wheel.range = controllers.foot.range = controllers.breath.range = controllers.at.range = 50;
    controllers.wheel.pitch = true;
    controllers.refresh();
    dxs_set_voice(spike_voice);
}

extern "C" void dxs_note_on(int midinote, int velocity) {
    int v = -1;
    for (int i = 0; i < DXS_MAX; i++) {
        int k = (next_voice + i) % DXS_MAX;
        if (!voices[k].keydown) {
            v = k;
            break;
        }
    }
    if (v < 0)
        v = next_voice;
    next_voice = (v + 1) % DXS_MAX;
    Voice &vc = voices[v];
    vc.midi_note = (uint8_t)midinote;
    vc.keydown = true;
    vc.live = true;
    vc.note.init(patch, midinote + patch[144] - 24, velocity, 1, &controllers);
    if (patch[136])
        vc.note.oscSync();
    lfo.keydown();
}

extern "C" void dxs_note_off(int midinote) {
    for (int i = 0; i < DXS_MAX; i++)
        if (voices[i].keydown && voices[i].midi_note == midinote) {
            voices[i].keydown = false;
            voices[i].note.keyup();
        }
}

extern "C" int dxs_live(void) {
    int n = 0;
    for (int i = 0; i < DXS_MAX; i++)
        n += voices[i].live;
    return n;
}

extern "C" unsigned dxs_voice_bytes(void) { return sizeof(Voice); }
extern "C" unsigned dxs_shared_bytes(void) { return sizeof lfo + sizeof controllers + sizeof core + sizeof patch + sizeof audiobuf; }

// n samples (a multiple of 64) of every live voice, Q16, added to out
extern "C" void dxs_render(int32_t *out, unsigned n) {
    for (unsigned i = 0; i < n; i += N) {
        int32_t lfovalue = lfo.getsample();
        int32_t lfodelay = lfo.getdelay();
        for (int v = 0; v < DXS_MAX; v++) {
            Voice &vc = voices[v];
            if (!vc.live)
                continue;
            for (int j = 0; j < N; j++)
                audiobuf[j] = 0;
            vc.note.compute(audiobuf, lfovalue, lfodelay, &controllers);
            for (int j = 0; j < N; j++) {
                int32_t val = audiobuf[j] >> 4;
                int32_t clip_val = val < -(1 << 24) ? -0x8000 : val >= (1 << 24) ? 0x7fff : val >> 9;
                out[i + j] += clip_val << 1;     // FM-1: Q16 (Dexed: a float / 0x8000)
            }
            if (!vc.keydown && !vc.note.isPlaying())
                vc.live = false;
        }
    }
}
