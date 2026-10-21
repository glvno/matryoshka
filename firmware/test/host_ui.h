/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The device's UI on a host: the stand-ins for the HAL, the LCD (a 240 x 240 RGB565 framebuffer `fb`) and the parts of
 * proto.c the UI reads, then the UI itself (ui.c, pages_ui.c, menu.c, seq_ui.c, splash.c) on the engine. No libc: the
 * includer brings libc.c (and stdint.h) first. Used by ui_preview.c, panel_test.c and the WebAssembly build
 * (firmware/wasm/fm1_ui.c). The running patch is pv_bin / pv_len (bump pv_gen when another one goes in). */
static uint16_t fb[240 * 240];
static uint8_t fb_dirty;                   /* the framebuffer changed since the host last looked */
#ifdef FB_WATCH
static uint8_t fb_changes[240 * 240];      /* panel_test.c: how often each pixel changed value since fb_watch_reset() */
#define FB_PUT(p, c) (fb_changes[p] += fb[p] != (c) && fb_changes[p] < 255u, fb[p] = (c))
#else
#define FB_PUT(p, c) (fb[p] = (c))
#endif
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
#define FELUCCA_VERSION "v1.0.0-DEV"
#define FM1_TICKS_PER_US 24u

static void lcd_fill(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint16_t c)
{
    uint32_t i, j;
    for (j = 0; j < h; j++)
        for (i = 0; i < w; i++)
            if (x + i < 240u && y + j < 240u)
                FB_PUT((y + j) * 240u + x + i, c);
    fb_dirty = 1;
}
static void lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px)
{
    uint32_t i, j;
    for (j = 0; j < h; j++)
        for (i = 0; i < w; i++)
            if (x + i < 240u && y + j < 240u) {
                uint16_t v = px[j * w + i];
                FB_PUT((y + j) * 240u + x + i, (uint16_t)((v >> 8) | (v << 8)));   /* the LCD takes big endian */
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
/* The LEDs, as the HAL keeps them (one byte per matrix column, a bit per row: lit, dim glow, the mid level, breathing),
 * over a host matrix where row r, column p is id (r - 1) * FM1_NCOL + p: so the firmware's own LED code (seq_ui.c's
 * step cells, main.c's glows) lands here and host_led_mask reads it back by id (0..13 buttons, 14..40 keys). */
#define FM1_NCOL 11u
static const int8_t FM1_KEYMAP[6][FM1_NCOL] = {
    {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1},
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
    {11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21},
    {22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32},
    {33, 34, 35, 36, 37, 38, 39, 40, -1, -1, -1},
    {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1},
};
static uint8_t fm1_led[FM1_NCOL], fm1_led_dim[FM1_NCOL], fm1_led_mid[FM1_NCOL], fm1_led_breath[FM1_NCOL];
static void host_led_set(uint8_t *a, uint32_t id, int on)
{
    if (id > 43u)
        return;
    if (on)
        a[id % FM1_NCOL] |= (uint8_t)(1u << (id / FM1_NCOL + 1u));
    else
        a[id % FM1_NCOL] &= (uint8_t)~(1u << (id / FM1_NCOL + 1u));
}
/* ids first .. first + 31 of one LED array as bits */
static uint32_t host_led_mask(const uint8_t *a, uint32_t first)
{
    uint32_t m = 0, i;
    for (i = 0; i < 32u && first + i < 41u; i++)
        if (a[(first + i) % FM1_NCOL] >> ((first + i) / FM1_NCOL + 1u) & 1u)
            m |= 1u << i;
    return m;
}
static void fm1_led_key(uint32_t id, int on) { host_led_set(fm1_led, id, on); fb_dirty |= 2; }
#ifndef HOST_LED_HOOKS                      /* (the wasm build lights them as main.c does) */
static void leds_avail(void) {}
static void leds_octave(void) {}
#else
static void leds_avail(void);
static void leds_octave(void);
#endif
static void update_only(const char *why) { (void)why; }
static void defaults_now(void) {}
#include "../src/menu.c"
/* what seq_ui.c reaches in proto.c and the HAL, for the preview */
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
static void m1_patch_stepval(uint32_t mod, uint32_t k, uint32_t note, uint32_t vel) { eng_steps_value_set(mod, k, note, vel); }
static void m1_patch_notes(uint32_t mod) { (void)mod; }
static int m1_drum_name(uint32_t map, uint32_t r, char *out) { return eng_drum_name(pv_bin, pv_len, map, r, out); }
#ifndef HOST_STEP_HOOKS                     /* (the wasm build tells the page instead) */
static void m1_track_now(uint32_t mod) { (void)mod; }
static void m1_mute_now(uint32_t mod, int on) { (void)mod; (void)on; }
static void m1_arm_now(int mod) { (void)mod; }
#endif
#include "../src/seq_ui.c"
static uint16_t lcd_fillbuf[240];          /* lcd.c's, the splash's row buffer */
#include "../src/splash.c"

