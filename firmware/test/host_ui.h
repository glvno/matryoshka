/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The device's UI on a host: the stand-ins for the HAL, the LCD (a 240 x 240 RGB565 framebuffer `fb`) and the parts of
 * proto.c the UI reads, then the UI itself (ui.c, pages_ui.c, sandbox_ui.c, menu.c, seq_ui.c, splash.c) on the engine. No libc: the
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
static uint32_t lcd_px, lcd_xfers;         /* the pixels sent to the LCD and the transfers (a window each) since zeroed: the cost of a draw */
static uint32_t fm1_ticks(void) { return 0; }
static uint32_t eng_us_last = 316, eng_us_max = 358;
static uint8_t eng_overload;               /* audio.c: the overload guard muted the patch */
static int32_t patch_gain;                 /* audio.c: the mixer level */
static volatile uint8_t snd_muted;         /* audio.c: sandbox mode muted the FM-1 */
static uint8_t m1_edited;                  /* proto.c: the running patch was edited */
#define M1_SLOTS 64u
static uint64_t bank_mask = 0x3FFFu;     /* slotstore.c: the occupied slots (the preview: the factory patches) */
static uint8_t pv_bin[4096];               /* the previewed patch (proto.c's m1_cur) */
static uint32_t pv_len;
#define FELUCCA_VERSION "v1.5.1-DEV"
#define FM1_TICKS_PER_US 24u

/* lcd.c's shared line buffer and its rule: on the device the DMA reads it after the transfer call returns, until the next
 * lcd_sync (or LCD access). Here a transfer from it keeps a copy, and the next sync / transfer counts a change made
 * meanwhile in lcd_line_clobbers (panel_test.c wants none) */
static uint16_t lcd_line[240];
static uint16_t lcd_line_sent[240];
static uint32_t lcd_line_busy, lcd_line_clobbers;  /* pixels of lcd_line the transfer still reads; writes into them */
static void lcd_line_done(void)
{
    uint32_t i;
    for (i = 0; i < lcd_line_busy; i++)
        if (lcd_line[i] != lcd_line_sent[i]) {
            lcd_line_clobbers++;
            break;
        }
    lcd_line_busy = 0;
}
static void lcd_line_sending(uint32_t n)
{
    uint32_t i;
    lcd_line_busy = n < 240u ? n : 240u;
    for (i = 0; i < lcd_line_busy; i++)
        lcd_line_sent[i] = lcd_line[i];
}
#include "../src/screen_text.h"           /* the texts on the screen, as text (#291): lcd.c's */
static void (*lcd_service)(void);
#ifdef FB_WATCH
static void (*lcd_test_transfer)(void); /* test arrival of input while a draw is in progress */
#endif
static void (*lcd_yield)(void);            /* lcd.c's: called before each transfer here (on the device while one runs) */
static void lcd_fill(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint16_t c)
{
    uint32_t i, j;
#ifdef FB_WATCH
    if (lcd_test_transfer)
        lcd_test_transfer();
#endif
    if (lcd_service)
        lcd_service();
    if (lcd_yield)
        lcd_yield();
    lcd_line_done();
    if (w && h && x < 240u && y < 240u)
        scr_erase(x, y, x + w > 240u ? 240u - x : w, y + h > 240u ? 240u - y : h);
    if (w && h && x < 240u && y < 240u) {  /* lcd.c fills lcd_line with whole rows of the colour and sends from it */
        uint32_t ww = x + w > 240u ? 240u - x : w, k = 240u / ww * ww;
        for (i = 0; i < k; i++)
            lcd_line[i] = (uint16_t)((c >> 8) | (c << 8));
        lcd_line_sending(k);
    }
    lcd_px += w * h;
    lcd_xfers++;
    for (j = 0; j < h; j++)
        for (i = 0; i < w; i++)
            if (x + i < 240u && y + j < 240u)
                FB_PUT((y + j) * 240u + x + i, c);
    fb_dirty = 1;
}
static void lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px)
{
    uint32_t i, j;
#ifdef FB_WATCH
    if (lcd_test_transfer)
        lcd_test_transfer();
#endif
    if (lcd_service)
        lcd_service();
    if (lcd_yield)
        lcd_yield();
    lcd_line_done();
    if (px == lcd_line)
        lcd_line_sending(w * h);
    lcd_px += w * h;
    lcd_xfers++;
    for (j = 0; j < h; j++)
        for (i = 0; i < w; i++)
            if (x + i < 240u && y + j < 240u) {
                uint16_t v = px[j * w + i];
                FB_PUT((y + j) * 240u + x + i, (uint16_t)((v >> 8) | (v << 8)));   /* the LCD takes big endian */
            }
    fb_dirty = 1;
}
static void lcd_sync(void) { lcd_line_done(); }
static void lcd_line_out(uint32_t x, uint32_t y, uint32_t w)   /* lcd.c's */
{
    uint32_t i;
    for (i = 0; i < w; i++)
        lcd_line[i] = (uint16_t)((lcd_line[i] >> 8) | (lcd_line[i] << 8));
    scr_line(x, y, w);
    lcd_blit(x, y, w, 1, lcd_line);
}

#include "../src/engine.c"
#include "../src/presets.h"
/* the preset store (presetstore.c, #194) over 7 sectors of RAM flash (all 0xFF until host_ps_init) */
static uint8_t host_ps_flash[7u * 0x1000u];
static void fm1_wdt_feed(void) {}
static int host_ps_in(uint32_t off, uint32_t n) { return off >= 0x99000u && off + n <= 0x99000u + sizeof host_ps_flash; }
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    uint32_t i;
    if (!host_ps_in(off, n))
        return -8;
    for (i = 0; i < n; i++)
        ((uint8_t *)dst)[i] = host_ps_flash[off - 0x99000u + i];
    return 0;
}
static int st_erase(uint32_t off)
{
    uint32_t i;
    if (!host_ps_in(off, 0x1000u))
        return -8;
    for (i = 0; i < 0x1000u; i++)
        host_ps_flash[off - 0x99000u + i] = 0xFFu;
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    uint32_t i;
    if (!host_ps_in(off, n))
        return -8;
    for (i = 0; i < n; i++)
        host_ps_flash[off - 0x99000u + i] &= ((const uint8_t *)src)[i];
    return 0;
}
static uint16_t m1_crc16(const uint8_t *p, uint32_t n)
{
    uint16_t c = 0xFFFFu;
    while (n--) {
        uint32_t b;
        c ^= (uint16_t)(*p++ << 8);
        for (b = 0; b < 8u; b++)
            c = (uint16_t)(c & 0x8000u ? (c << 1) ^ 0x1021u : c << 1);
    }
    return c;
}
#include "../src/presetstore.c"
static void host_ps_init(void)
{
    uint32_t i;
    for (i = 0; i < sizeof host_ps_flash; i++)
        host_ps_flash[i] = 0xFFu;
    ps_scan();
}
static int m1_preset_name(uint32_t dev, const char *name) { (void)dev; (void)name; m1_edited = 1; return 0; }   /* (the preview keeps no patch) */
static uint32_t host_preset_stored;         /* presets stored on the panel (#194) */
static void m1_preset_stored(uint32_t structure, const char *name) { (void)structure; (void)name; host_preset_stored++; }
#include "../src/font5x7.c"
#include "../src/font_bc.c"
static const uint8_t *m1_panel(void) { uint32_t at = eng_panel_at(pv_bin, pv_len); return at ? pv_bin + at : 0; }
#define BATT_START 900                     /* the battery (ui.c): full, no USB host (fm1_open's simulator has 900 too) */
#include "../src/sandbox_msg.h"
#include "../src/ui.c"
#include "../src/pages_ui.c"
#include "../src/sandbox_ui.c"
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
static int host_updates, host_defaults;    /* UPDATE MODE / FACTORY RESET reached (panel_test.c) */
static void update_only(const char *why) { (void)why; host_updates++; }
static void defaults_now(void) { host_defaults++; }
#include "../src/menu.c"
/* what seq_ui.c reaches in proto.c and the HAL, for the preview */
static struct { uint32_t buttons; } fm1_in;
static void m1_track_name(uint32_t mod, char *out)     /* (proto.c's, on the previewed binary) */
{
    uint32_t at = eng_records_at(pv_bin, pv_len), i;
    for (i = 0; i < mod; i++) {
        const def_t *d = &DEFS[pv_bin[at] & 0x7Fu];
        at += eng_record_size(d, pv_bin[1]);
    }
    at += eng_record_size(&DEFS[T_STEPS], pv_bin[1]) - DEFS[T_STEPS].ndata;
    for (i = 0; i < TRACK_NAME_MAX && pv_bin[at + i]; i++)
        out[i] = (char)pv_bin[at + i];
    out[i] = 0;
}
static void m1_patch_step(uint32_t mod, uint32_t k, uint32_t b) { eng_steps_set(mod, k, b); }
static void m1_patch_notes(uint32_t mod) { (void)mod; }
static void m1_patch_patterns(void) {}             /* (the preview keeps no patch: the engine has the patterns and songs) */
static int m1_drum_name(uint32_t map, uint32_t r, char *out) { return eng_drum_name(pv_bin, pv_len, map, r, out); }
#ifndef HOST_STEP_HOOKS                     /* (the wasm build tells the page instead) */
static void m1_track_now(uint32_t mod) { (void)mod; }
static void m1_mute_now(uint32_t mod, int on) { (void)mod; (void)on; }
static void m1_arms_now(uint32_t lo, uint32_t hi) { (void)lo; (void)hi; }
static uint32_t host_pattern_told, host_song_told;   /* (panel_test.c: PATTERN_NOW / SONG_NOW sent) */
static void m1_pattern_now(void) { host_pattern_told++; }
static void m1_song_now(uint32_t s) { (void)s; host_song_told++; }
#endif
#include "../src/seq_ui.c"
#include "../src/splash.c"

