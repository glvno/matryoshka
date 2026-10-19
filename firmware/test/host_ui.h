/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The device's UI on a host: the stand-ins for the HAL, the LCD (a 240 x 240 RGB565 framebuffer `fb`) and the parts of
 * proto.c the UI reads, then the UI itself (ui.c, pages_ui.c, menu.c, seq_ui.c, splash.c) on the engine. No libc: the
 * includer brings libc.c (and stdint.h) first. Used by ui_preview.c, panel_test.c and the WebAssembly build
 * (firmware/wasm/fm1_ui.c). The running patch is pv_bin / pv_len (bump pv_gen when another one goes in). */
static uint16_t fb[240 * 240];
static uint8_t fb_dirty;                   /* the framebuffer changed since the host last looked */
static uint32_t host_leds;                 /* the buttons' LEDs (fm1_led_key), matrix ids as bits */
static uint32_t fm1_ms;
static uint32_t fm1_ticks(void) { return 0; }
static uint32_t eng_us_last = 316, eng_us_max = 358;
static uint8_t eng_overload;               /* audio.c: the overload guard muted the patch */
static int32_t patch_gain;                 /* audio.c: the mixer level */
static uint8_t m1_edited;                  /* proto.c: the running patch was edited */
#define M1_SLOTS 64u
static uint64_t bank_mask = 0x3FFFu;     /* slotstore.c: the occupied slots (the preview: the factory patches) */
static uint8_t pv_bin[4096];               /* the previewed patch (proto.c's m1_cur) */
static uint32_t pv_len;
#define FELUCCA_VERSION "M1-PREVIEW"
#define FM1_TICKS_PER_US 24u

static void lcd_fill(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint16_t c)
{
    uint32_t i, j;
    for (j = 0; j < h; j++)
        for (i = 0; i < w; i++)
            if (x + i < 240u && y + j < 240u)
                fb[(y + j) * 240u + x + i] = c;
    fb_dirty = 1;
}
static void lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px)
{
    uint32_t i, j;
    for (j = 0; j < h; j++)
        for (i = 0; i < w; i++)
            if (x + i < 240u && y + j < 240u) {
                uint16_t v = px[j * w + i];
                fb[(y + j) * 240u + x + i] = (uint16_t)((v >> 8) | (v << 8));     /* the LCD takes big endian */
            }
    fb_dirty = 1;
}
static void lcd_sync(void) {}

#include "../src/engine.c"
#include "../src/presets.h"
#include "../src/font5x7.c"
#include "../src/font_bc.c"
static const uint8_t *m1_panel(void) { uint32_t at = eng_panel_at(pv_bin, pv_len); return at ? pv_bin + at : 0; }
#include "../src/ui.c"
#include "../src/pages_ui.c"
static const uint8_t *pages_src(uint32_t *len) { *len = pv_len; return pv_bin; }
static uint32_t pv_gen = 1;               /* another patch in pv_bin: +1 */
static uint32_t pages_gen(void) { return pv_gen; }
static void fm1_led_key(uint32_t id, int on) { host_leds = on ? host_leds | 1u << id : host_leds & ~(1u << id); }
static void leds_avail(void) {}
static void leds_octave(void) {}
static void update_only(const char *why) { (void)why; }
static void defaults_now(void) {}
#include "../src/menu.c"
/* what seq_ui.c reaches in proto.c and the HAL, for the preview */
#define FM1_NCOL 11u
static const int8_t FM1_KEYMAP[6][FM1_NCOL] = {{-1}};
static uint8_t fm1_led[FM1_NCOL], fm1_led_dim[FM1_NCOL], fm1_led_mid[FM1_NCOL];
static struct { uint32_t buttons; } fm1_in;
static void m1_track_name(uint32_t mod, char *out)     /* (proto.c's, on the previewed binary) */
{
    uint32_t at = eng_records_at(pv_bin, pv_len), i;
    for (i = 0; i < mod; i++) {
        const def_t *d = &DEFS[pv_bin[at] & 0x7Fu];
        at += 1u + 4u * d->npar + (d->cvbase >= 0 ? 20u : 0u) + d->ndata;
    }
    at += 1u + 4u * DEFS[T_STEPS].npar + (DEFS[T_STEPS].cvbase >= 0 ? 20u : 0u);
    for (i = 0; i < TRACK_NAME_MAX && pv_bin[at + i]; i++)
        out[i] = (char)pv_bin[at + i];
    out[i] = 0;
}
static void m1_patch_step(uint32_t mod, uint32_t k, uint32_t b) { eng_steps_set(mod, k, b); }
static void m1_step_now(uint32_t mod, uint32_t k, uint32_t b) { (void)mod; (void)k; (void)b; }
static void m1_patch_stepval(uint32_t mod, uint32_t k, uint32_t note, uint32_t vel) { eng_steps_value_set(mod, k, note, vel); }
static void m1_stepval_now(uint32_t mod, uint32_t k, uint32_t note, uint32_t vel) { (void)mod; (void)k; (void)note; (void)vel; }
static void m1_mute_now(uint32_t mod, int on) { (void)mod; (void)on; }
#include "../src/seq_ui.c"
static uint16_t lcd_fillbuf[240];          /* lcd.c's, the splash's row buffer */
#include "../src/splash.c"

