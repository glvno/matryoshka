/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Renders the device's LCD (firmware/src/ui.c) on the host into a PPM image, to look at the layout without a device.
 *   ui_preview OUT.ppm PRESET_INDEX [SELECTED_MODULE or DEVICE:PAGE [OCTAVE [PAGE [STEP [MENU_TAB [MANUAL_LINE [POLY]]]]]]]
 * Environment: PATCHTOAST=1 PRESET's toast (the factory bank's slot; BANK=n: a bank of n filled slots instead, the patch
 * in slot SLOT, default the preset index), SANDBOX=1 sandbox mode before the editor's first page (the card), SANDBOX=2
 * with a page of the editor's (MIDIOUT=0: MENU > MIDI OUT off), BATT=0..3 or 4 (USB) the battery's level
 * tools/ui_preview.sh converts the image to PNG. With UI_PREVIEW_LIB defined it is only the host's stand-ins and the UI
 * (host_ui.h; panel_test.c includes it so). */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define memset m_memset                     /* libc.c defines the freestanding versions */
#define memcpy m_memcpy
#define memcmp m_memcmp
#include "../src/libc.c"
#undef memset
#undef memcpy
#undef memcmp

#include "host_ui.h"

#ifndef UI_PREVIEW_LIB
int main(int argc, char **argv)
{
    uint32_t i, p;
    FILE *f;
    if (argc < 3)
        return 2;
    p = (uint32_t)atoi(argv[2]);
    if (p >= N_PRESETS) {
        fprintf(stderr, "no such preset\n");
        return 1;
    }
    {   /* a copy of the preset; with argv[9] (parts, 1..8) all its modules go into one poly group of that many parts */
        uint8_t *bin = pv_bin;
        uint32_t len = PRESET_LIST[p].len;
        memcpy(bin, PRESET_LIST[p].data, len);
        if (argc > 9 && !bin[3] && len + ENG_GROUP_REC + bin[2] <= sizeof pv_bin) {
            uint32_t extra = ENG_GROUP_REC + bin[2];
            memmove(bin + 8 + extra, bin + 8, len - 8u);
            memset(bin + 8, 0, extra);
            bin[3] = 1;
            bin[8] = (uint8_t)atoi(argv[9]);
            for (i = 0; i < ENG_MAX_PARTS; i++)
                bin[8 + 4 + 5 * i + 4] = 100;      /* each part's level */
            for (i = 0; i < bin[2]; i++)
                bin[8 + ENG_GROUP_REC + i] = 1;  /* eng_load keeps delay, reverb, chorus, granular and output out */
            len += extra;
        }
        pv_len = len;
        if (eng_load(bin, len)) {
            fprintf(stderr, "eng_load failed\n");
            return 1;
        }
    }
    {   /* one block, so the modules have computed their effective parameters */
        static int32_t l[128], r[128];
        eng_render(l, r, 128);
    }
    sel = argc > 3 ? (uint32_t)atoi(argv[3]) : 0u;
    if (argc > 3 && strchr(argv[3], ':'))                   /* the device page: DEVICE:PAGE */
        pages_focus((uint32_t)atoi(argv[3]), (uint32_t)atoi(strchr(argv[3], ':') + 1));
    if (getenv("PATCHTOAST")) {                             /* PRESET's toast (#170) */
        uint32_t n = getenv("BANK") ? (uint32_t)atoi(getenv("BANK")) : N_PRESETS;
        pages_ensure();                                     /* (a fresh patch would end it) */
        bank_mask = n >= 64u ? ~(uint64_t)0 : ((uint64_t)1 << n) - 1u;
        cur_preset = getenv("SLOT") ? (uint32_t)atoi(getenv("SLOT")) - 1u : p;
        fm1_ms = 1;
        toast_start();
    }
    if (getenv("BATT")) {                                   /* the battery's level (4: USB) */
        int b = atoi(getenv("BATT"));
        batt_usb = b == 4;
        batt_lvl = (uint8_t)(b >= 0 && b <= 3 ? b : 3);
    }
    octave = argc > 4 ? atoi(argv[4]) : 0;
    page = argc > 5 ? (uint8_t)atoi(argv[5]) : 0u;          /* 5: menu, 8: SEQ (SELECTED_MODULE = the track) */
    if (argc > 6)                                           /* the transport running */
        eng_transport(atoi(argv[6]) != 0);
    if (page == PAGE_SEQ) {                                 /* the SEQ page: the track, a muted one, the playhead some steps in */
        static int32_t l[128], r[128];
        seq_trk = (uint8_t)sel;
        if (eng_steps_count() > 2)
            eng_steps_mute((uint32_t)eng_steps_module(2), 1);
        for (i = 0; i < 300u; i++)
            eng_render(l, r, 128);
        seq_rec = argc > 7 && atoi(argv[7]) != 0;
    }
    booting = 0;
    if (argc > 7) {                                         /* page 5: the menu's tab (4 = MANUAL) */
        int t = atoi(argv[7]);
        menu_tab = (uint8_t)(t < 0 ? 0 : t >= MT_COUNT ? MT_COUNT - 1 : t);
    }
    if (argc > 8) {                                         /* .. and the first line of the manual */
        int t = atoi(argv[8]), max = (int)MAN_N - (int)MAN_VIS;
        man_top = (uint32_t)(t < 0 ? 0 : t > max ? max : t);
    }
    patch_label = PRESET_LIST[p].name;
    if (getenv("MIDIOUT"))
        cfg.midi_out = (uint8_t)atoi(getenv("MIDIOUT"));
    if (getenv("SANDBOX")) {                                /* sandbox mode: the card, or (2) a page of the editor's */
        sandbox_live(1, 5000);
        if (atoi(getenv("SANDBOX")) == 2) {
            static sb_page_t s;
            static const char *const LAB[3] = {"Cutoff", "Resonance", "Wave"}, *const VAL[3] = {"2.40", "0.62", "SAW"};
            static const uint8_t POS[3] = {150, 158, 0};
            uint32_t k;
            s.rows = 7;
            s.index = 2;
            s.count = 5;
            strcpy(s.patch, "Sol 29N XL");
            strcpy(s.dev, "Sol filter");
            strcpy(s.page, "FILTER 1/2");
            for (k = 0; k < 3u; k++) {
                strcpy(s.label[k], LAB[k]);
                strcpy(s.value[k], VAL[k]);
                s.pos[k] = POS[k];
                s.steps[k] = k == 2u ? 4u : 0u;
            }
            strcpy(s.unit[0], "kHz");
            m1_sandbox(&s);
        }
    }
    if (page == 9u) {                                       /* the loading screen, the bar 60 % in */
        splash_draw();
        splash_line("LOADING PATCH");
        splash_bar(SPLASH_BAR_W * 3u / 5u);
    } else
        screen_idle();
    f = fopen(argv[1], "wb");
    fprintf(f, "P6\n240 240\n255\n");
    for (i = 0; i < 240u * 240u; i++) {
        uint16_t c = fb[i];
        fputc(((c >> 11) & 31u) * 255u / 31u, f);
        fputc(((c >> 5) & 63u) * 255u / 63u, f);
        fputc((c & 31u) * 255u / 31u, f);
    }
    fclose(f);
    return 0;
}
#endif
