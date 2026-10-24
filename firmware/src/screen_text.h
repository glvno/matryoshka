/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The texts on the LCD now, as text (#291, the device test mode): the link's SCREEN command (proto.c) reports them, so
 * a script reads the screen of a real FM-1 as the emulator's `text` reads its pixels.
 *
 * Every text is drawn scanline by scanline through lcd_line_out (font5x7.c text_dots, font_bc.c text_bcn, pages_ui.c
 * text_onto into a row of its own). A renderer announces a text with scr_pend (its x in the scanline, its box) before
 * the scanline that holds its top row goes out; scr_line, called by lcd_line_out, places it there. A run of scanlines
 * one below the other (same x and width) is one band: a scanline erases the texts it crosses that earlier drawing left,
 * not those of its own band; lcd_fill (scr_erase) erases what it covers. Included by the LCD driver (lcd.c on the
 * device, host_ui.h's stand-ins on the host) before lcd_fill and lcd_line_out. */
#ifndef SCREEN_TEXT_H
#define SCREEN_TEXT_H
#include <stdint.h>

#define SCR_N 48u                        /* texts kept (a full device page has about 25) */
#define SCR_CH 31u                       /* characters kept of each */
#define SCR_PEND 8u                      /* texts announced for the next scanline */
#ifndef SCR_POOL
#define SCR_POOL                         /* (the device keeps them in the pool: modular.c) */
#endif

typedef struct {
    uint8_t x, y, w, h;                  /* the text's box, in pixels (w 0: a free entry) */
    uint16_t band;                       /* the band that drew it */
    char s[SCR_CH + 1u];
} scr_text_t;
static scr_text_t scr_text[SCR_N] SCR_POOL;
static struct {
    uint16_t x, w, h;
    char s[SCR_CH + 1u];
} scr_pending[SCR_PEND] SCR_POOL;
static uint32_t scr_npend;
static uint16_t scr_band;
static uint32_t scr_lx = 0xFFFFu, scr_ly, scr_lw;   /* the last scanline (a band goes on below it) */
static uint32_t scr_ox = 0xFFFFu;                   /* a part of a scanline goes out: x of the whole one, which the texts
                                                     * announced count from (pages_ui.c row_bar_part); 0xFFFF none */

static int scr_meets(const scr_text_t *t, uint32_t x, uint32_t y, uint32_t w, uint32_t h)
{
    return t->w && x < (uint32_t)t->x + t->w && (uint32_t)t->x < x + w && y < (uint32_t)t->y + t->h && (uint32_t)t->y < y + h;
}

/* lcd_fill painted (x, y, w, h): the texts under it are gone, and a band ends */
static void scr_erase(uint32_t x, uint32_t y, uint32_t w, uint32_t h)
{
    uint32_t i;
    for (i = 0; i < SCR_N; i++)
        if (scr_meets(&scr_text[i], x, y, w, h))
            scr_text[i].w = 0;
    scr_lx = 0xFFFFu;
}

/* a text whose top row is in the next scanline: the first n characters of s (n < 0: all), x px into the scanline, w x h */
static void scr_pend(uint32_t x, uint32_t w, uint32_t h, const char *s, int32_t n)
{
    uint32_t k;
    if (scr_npend >= SCR_PEND || !w || !h || !s[0] || !n)
        return;
    for (k = 0; k < SCR_CH && s[k] && (n < 0 || (int32_t)k < n); k++)
        scr_pending[scr_npend].s[k] = s[k];
    scr_pending[scr_npend].s[k] = 0;
    scr_pending[scr_npend].x = (uint16_t)x;
    scr_pending[scr_npend].w = (uint16_t)w;
    scr_pending[scr_npend].h = (uint16_t)h;
    scr_npend++;
}

/* a scanline went out at (x, y), w px: it erases what earlier drawing left there, and places the texts announced */
static void scr_line(uint32_t x, uint32_t y, uint32_t w)
{
    uint32_t i, j;
    if (!(x == scr_lx && w == scr_lw && y == scr_ly + 1u))
        scr_band++;
    scr_lx = x;
    scr_ly = y;
    scr_lw = w;
    for (i = 0; i < SCR_N; i++)
        if (scr_text[i].band != scr_band && scr_meets(&scr_text[i], x, y, w, 1))
            scr_text[i].w = 0;
    for (j = 0; j < scr_npend; j++) {
        uint32_t tx = (scr_ox != 0xFFFFu ? scr_ox : x) + scr_pending[j].x, tw = scr_pending[j].w, th = scr_pending[j].h, k;
        if ((scr_ox == 0xFFFFu && scr_pending[j].x >= w) || tx >= 240u || y >= 240u)
            continue;
        if (scr_ox == 0xFFFFu && tw > w - scr_pending[j].x)
            tw = w - scr_pending[j].x;
        for (i = 0; i < SCR_N; i++)              /* a text drawn over another in the same band replaces it */
            if (scr_meets(&scr_text[i], tx, y, tw, th))
                scr_text[i].w = 0;
        for (i = 0; i < SCR_N && scr_text[i].w; i++)
            ;
        if (i == SCR_N)
            break;                               /* (full: SCR_N is well above a screen's count) */
        for (k = 0; k <= SCR_CH; k++)
            scr_text[i].s[k] = scr_pending[j].s[k];
        scr_text[i].x = (uint8_t)tx;
        scr_text[i].y = (uint8_t)y;
        scr_text[i].w = (uint8_t)(tw > 255u ? 255u : tw);
        scr_text[i].h = (uint8_t)(th > 255u ? 255u : th);
        scr_text[i].band = scr_band;
    }
    scr_npend = 0;
}

/* the texts in reading order (top to bottom, then left to right) as indices into scr_text; returns how many */
static uint32_t scr_list(uint8_t *idx)
{
    uint32_t i, j, n = 0;
    for (i = 0; i < SCR_N; i++)
        if (scr_text[i].w) {
            for (j = n; j > 0u; j--) {
                const scr_text_t *a = &scr_text[idx[j - 1u]], *b = &scr_text[i];
                if (a->y < b->y || (a->y == b->y && a->x <= b->x))
                    break;
                idx[j] = idx[j - 1u];
            }
            idx[j] = (uint8_t)i;
            n++;
        }
    return n;
}
#endif
