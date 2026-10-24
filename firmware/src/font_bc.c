/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The LCD's brand type (font_bc.h, tools/gen_font.py: Barlow Condensed SemiBold at four sizes, 4-bit coverage). A text is
 * drawn as one block of the font's line box, row by row like text_dots: the field is painted in the paper colour, each
 * glyph's coverage blended from paper to ink (16 steps, per channel). Mixed case. */
#include "font_bc.h"

/* the width of the first n characters of s (n < 0: all of it) */
static uint32_t text_w(const font_t *f, const char *s, int32_t n)
{
    uint32_t w = 0;
    int32_t i;
    for (i = 0; s[i] && (n < 0 || i < n); i++) {
        uint32_t c = (uint8_t)s[i];
        uint8_t g = c >= 0x20u && c < 0x7Fu ? f->map[c - 0x20u] : 255u;
        if (g != 255u)
            w += f->g[g].adv;
    }
    return w;
}

/* the ink -> paper ramp of one text (16 coverage steps) */
static void text_ramp(uint16_t *lut, uint16_t fg, uint16_t bg)
{
    int32_t r0 = bg >> 11, g0 = (bg >> 5) & 63, b0 = bg & 31, r1 = fg >> 11, g1 = (fg >> 5) & 63, b1 = fg & 31, a;
    for (a = 0; a < 16; a++)
        lut[a] = (uint16_t)(((r0 + ((r1 - r0) * a + 7) / 15) << 11) | ((g0 + ((g1 - g0) * a + 7) / 15) << 5) | (b0 + ((b1 - b0) * a + 7) / 15));
}

#define TA_LEFT 0u
#define TA_RIGHT 1u
#define TA_CENTER 2u

/* the first n characters of s (n < 0: all) at (x, y) inside a field `field` px wide (0: as wide as the text), aligned
 * TA_LEFT / TA_RIGHT / TA_CENTER and cut at the field's edge; the field is painted bg first. Returns the text's width. */
static uint32_t text_bcn(const font_t *f, uint32_t x, uint32_t y, const char *s, int32_t n, uint16_t fg, uint16_t bg, uint32_t field, uint32_t align)
{
    uint16_t *row = lcd_line;                   /* (lcd.c's) */
    uint16_t lut[16];
    uint32_t tw = text_w(f, s, n), w = field ? field : tw, x0, r, i;
    int32_t k;
    if (x >= 240u || !w)
        return tw;
    if (x + w > 240u)
        w = 240u - x;
    x0 = align == TA_RIGHT ? (tw < w ? w - tw : 0u) : align == TA_CENTER ? (tw < w ? (w - tw) / 2u : 0u) : 0u;
    text_ramp(lut, fg, bg);
    scr_pend(x0, tw, f->h, s, n);
    for (r = 0; r < f->h; r++) {
        uint32_t px = x0;
        lcd_sync();                             /* the last row may still be on its way out of lcd_line */
        for (i = 0; i < w; i++)
            row[i] = bg;
        for (k = 0; s[k] && (n < 0 || k < n); k++) {
            uint32_t c = (uint8_t)s[k], gw, rb, j;
            const fglyph_t *g;
            const uint8_t *bits;
            uint8_t gi = c >= 0x20u && c < 0x7Fu ? f->map[c - 0x20u] : 255u;
            if (gi == 255u)
                continue;
            g = &f->g[gi];
            gw = g->w;
            rb = (gw + 1u) / 2u;
            bits = f->bits + g->off + r * rb;
            for (j = 0; j < gw; j++) {
                uint32_t a = (j & 1u) ? bits[j >> 1] & 15u : bits[j >> 1] >> 4, at = px + (uint32_t)((int32_t)j + g->x);
                if (a && at < w)
                    row[at] = lut[a];
            }
            px += g->adv;
            if (px >= w)
                break;
        }
        lcd_line_out(x, y + r, w);
    }
    return tw;
}

static uint32_t text_bc(const font_t *f, uint32_t x, uint32_t y, const char *s, uint16_t fg, uint16_t bg, uint32_t field, uint32_t align)
{
    return text_bcn(f, x, y, s, -1, fg, bg, field, align);
}
