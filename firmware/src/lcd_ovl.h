/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The overlay under a card (help_ui.c: the controls sheet and the quick start, D-245 / D-247). The device has no
 * framebuffer, so the page under a card is not read back and dimmed: while lcd_ovl is set, whatever the pages draw is
 * dimmed to 40 % as it goes out and kept off the card's square (OVL_A..OVL_B both ways), so the page goes on drawing
 * itself, partial redraws too, as a dim frame around the card, and nothing it draws ever paints over the card. The card
 * draws with lcd_ovl_self set, as plain. The page's texts under the overlay are not reported (screen_text.h): the card's
 * are. Included by the LCD driver (lcd.c on the device, host_ui.h on the host) after its lcd_fill_raw, lcd_line_out_raw,
 * lcd_blit and lcd_line_flip. */
#ifndef LCD_OVL_H
#define LCD_OVL_H

#define OVL_A 16u                                   /* the card's square: x and y from OVL_A up to (not with) OVL_B */
#define OVL_B 224u
static uint8_t lcd_ovl;                             /* a card shows: the rest is the page under it, dimmed */
static uint8_t lcd_ovl_self;                        /* the card is drawing itself */

/* a colour (RGB565) 40 % as bright, channel by channel */
static uint16_t lcd_dim40(uint16_t c)
{
    uint32_t r = (c >> 11) & 31u, g = (c >> 5) & 63u, b = c & 31u;
    return (uint16_t)((r * 40u / 100u) << 11 | (g * 40u / 100u) << 5 | (b * 40u / 100u));
}

static void lcd_fill(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint16_t c)
{
    uint32_t y0, y1;
    if (!lcd_ovl || lcd_ovl_self) {
        lcd_fill_raw(x, y, w, h, c);
        return;
    }
    if (!w || !h || x >= 240u || y >= 240u)
        return;
    w = x + w > 240u ? 240u - x : w;
    h = y + h > 240u ? 240u - y : h;
    c = lcd_dim40(c);
    y0 = y > OVL_A ? y : OVL_A;                     /* the rows the card's square shares with the fill */
    y1 = y + h < OVL_B ? y + h : OVL_B;
    if (y0 >= y1 || x >= OVL_B || x + w <= OVL_A) {
        lcd_fill_raw(x, y, w, h, c);
        return;
    }
    if (y < y0)                                     /* above the card */
        lcd_fill_raw(x, y, w, y0 - y, c);
    if (x < OVL_A)                                  /* left of it */
        lcd_fill_raw(x, y0, OVL_A - x, y1 - y0, c);
    if (x + w > OVL_B)                              /* right of it */
        lcd_fill_raw(OVL_B, y0, x + w - OVL_B, y1 - y0, c);
    if (y + h > y1)                                 /* below it */
        lcd_fill_raw(x, y1, w, y + h - y1, c);
}

static void lcd_line_out(uint32_t x, uint32_t y, uint32_t w)
{
    uint32_t i;
    if (!lcd_ovl || lcd_ovl_self) {
        lcd_line_out_raw(x, y, w);
        return;
    }
    scr_npend = 0;                                  /* (the page's texts under a card are not reported) */
    if (!w || x >= 240u || y >= 240u)
        return;
    w = x + w > 240u ? 240u - x : w;
    for (i = 0; i < w; i++) {                       /* dimmed, then big endian as the LCD takes it */
        uint16_t c = lcd_dim40(lcd_line[i]);
        lcd_line[i] = (uint16_t)((c >> 8) | (c << 8));
    }
    if (y < OVL_A || y >= OVL_B || x >= OVL_B || x + w <= OVL_A) {
        lcd_line_send(x, y, w);
        return;
    }
    if (x < OVL_A)
        lcd_blit(x, y, OVL_A - x, 1, lcd_line);
    if (x + w > OVL_B)
        lcd_blit(OVL_B, y, x + w - OVL_B, 1, lcd_line + (OVL_B - x));
    lcd_line_flip();
}
#endif
