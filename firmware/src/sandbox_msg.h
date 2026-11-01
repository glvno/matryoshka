/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The SANDBOX message (proto.c C_SANDBOX, web/src/protocol.ts sandboxFrame): the editor's device page while its patch is
 * a sandbox patch, which the browser plays with the FM-1 as its controller (sandbox_ui.c draws it). Fixed fields, names
 * zero padded:
 *   rows u8 (bit k: row k is there), index u8, count u8 (the page's place among its device's pages, from 0),
 *   patch 20, device 12, page 16 (its title as the FM-1's chips have it: "FILTER 1/2"),
 *   four rows of label 12, value 10, unit 6, position u8 (0..255 of the row's range), steps u8 (0: continuous, n: n choices)
 * and after them, from editors of 1.8 on (D-468: older firmware reads only the fields above, an older editor sends only
 * those, and sb_parse then fills these in from them, sb_guess):
 *   devices u8, the device's place u8, page groups u8, the group's place u8, pages of the group u8, the page's place in it u8
 *   (places from 0), tempo u16 (bpm; 0: none to show), flags u8 (bit 0: the patch has unsaved edits), armed u32 (bit d:
 *   device d is armed; 0: the keys are wired)
 * Shared by proto.c, which parses it, and the UI (host_ui.h includes it for the host builds). */
#ifndef SANDBOX_MSG_H
#define SANDBOX_MSG_H
#define SB_ROWS 4u
#define SB_PATCH 20u
#define SB_DEV 12u
#define SB_PAGE 16u
#define SB_LABEL 12u
#define SB_VALUE 10u
#define SB_UNIT 6u
#define SB_ROW_BYTES (SB_LABEL + SB_VALUE + SB_UNIT + 2u)
#define SB_HEAD_BYTES (3u + SB_PATCH + SB_DEV + SB_PAGE)
#define SB_BYTES (SB_HEAD_BYTES + SB_ROWS * SB_ROW_BYTES)
#define SB_EXT_BYTES 13u                                /* the fields after the rows */
#define SB_UNSAVED 1u                                   /* flags: the patch has unsaved edits */

typedef struct {
    uint8_t rows, index, count;
    uint8_t ext;                                        /* the fields after the rows came (a 1.8 editor), else guessed */
    uint8_t ndev, dev_at, ngroup, group_at, npage, page_at, flags;
    uint16_t tempo;
    uint32_t armed;
    char patch[SB_PATCH + 1u], dev[SB_DEV + 1u], page[SB_PAGE + 1u];
    char label[SB_ROWS][SB_LABEL + 1u], value[SB_ROWS][SB_VALUE + 1u], unit[SB_ROWS][SB_UNIT + 1u];
    uint8_t pos[SB_ROWS], steps[SB_ROWS];
} sb_page_t;

/* n bytes of a name field into out (n + 1 bytes): printable ASCII up to the first zero */
static void sb_str(char *out, const uint8_t *d, uint32_t n)
{
    uint32_t i;
    for (i = 0; i < n && d[i]; i++)
        out[i] = d[i] >= 32u && d[i] < 127u ? (char)d[i] : '?';
    out[i] = 0;
}

/* the title's last word as "p/n" (the FM-1's chips: "FILTER 1/2"): p - 1 into *at, n into *n, and where its space is as
 * the result (0: no such word) */
static uint32_t sb_part(const char *t, uint8_t *at, uint8_t *n)
{
    uint32_t len = 0, w, j, p = 0, q = 0;
    while (t[len])
        len++;
    for (w = len; w > 0u && t[w - 1u] != ' '; w--)
        ;
    if (w < 2u)
        return 0;
    for (j = w; j < len && t[j] >= '0' && t[j] <= '9'; j++)
        p = p * 10u + (uint32_t)(t[j] - '0');
    if (j == w || j >= len || t[j] != '/' || ++j >= len)
        return 0;
    for (; j < len && t[j] >= '0' && t[j] <= '9'; j++)
        q = q * 10u + (uint32_t)(t[j] - '0');
    if (j != len || !p || p > q || q > 255u)
        return 0;
    *at = (uint8_t)(p - 1u);
    *n = (uint8_t)q;
    return w - 1u;
}

/* an older editor's page (no fields after the rows): what the title tells. The devices and the page groups are not
 * known: no dashes for them (0); the group's pages from "1/2", else one; no tempo; whether anything is armed not known */
static void sb_guess(sb_page_t *s)
{
    uint8_t at = 0, n = 1;
    s->ext = 0;
    s->ndev = s->dev_at = s->ngroup = s->group_at = 0;
    (void)sb_part(s->page, &at, &n);
    s->npage = n;
    s->page_at = at;
    s->tempo = 0;
    s->flags = 0;
    s->armed = 0;
}

/* a SANDBOX payload into s: 0 = done, -1 too short */
static int sb_parse(const uint8_t *d, uint32_t len, sb_page_t *s)
{
    uint32_t k, at = SB_HEAD_BYTES;
    if (len < SB_BYTES)
        return -1;
    s->rows = d[0] & 15u;
    s->index = d[1];
    s->count = d[2];
    sb_str(s->patch, d + 3, SB_PATCH);
    sb_str(s->dev, d + 3u + SB_PATCH, SB_DEV);
    sb_str(s->page, d + 3u + SB_PATCH + SB_DEV, SB_PAGE);
    for (k = 0; k < SB_ROWS; k++, at += SB_ROW_BYTES) {
        sb_str(s->label[k], d + at, SB_LABEL);
        sb_str(s->value[k], d + at + SB_LABEL, SB_VALUE);
        sb_str(s->unit[k], d + at + SB_LABEL + SB_VALUE, SB_UNIT);
        s->pos[k] = d[at + SB_LABEL + SB_VALUE + SB_UNIT];
        s->steps[k] = d[at + SB_LABEL + SB_VALUE + SB_UNIT + 1u];
    }
    if (len < SB_BYTES + SB_EXT_BYTES) {
        sb_guess(s);
        return 0;
    }
    d += SB_BYTES;
    s->ext = 1;
    s->ndev = d[0];
    s->dev_at = d[1];
    s->ngroup = d[2];
    s->group_at = d[3];
    s->npage = d[4];
    s->page_at = d[5];
    s->tempo = (uint16_t)(d[6] | d[7] << 8);
    s->flags = d[8];
    s->armed = (uint32_t)d[9] | (uint32_t)d[10] << 8 | (uint32_t)d[11] << 16 | (uint32_t)d[12] << 24;
    return 0;
}
#endif
