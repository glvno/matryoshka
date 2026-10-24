/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The SANDBOX message (proto.c C_SANDBOX, web/src/protocol.ts sandboxFrame): the editor's device page while its patch is
 * a sandbox patch, which the browser plays with the FM-1 as its controller (sandbox_ui.c draws it). Fixed fields, names
 * zero padded:
 *   rows u8 (bit k: row k is there), index u8, count u8 (the page's place among its device's pages, from 0),
 *   patch 20, device 12, page 16 (its title as the FM-1's chips have it: "FILTER 1/2"),
 *   four rows of label 12, value 10, unit 6, position u8 (0..255 of the row's range), steps u8 (0: continuous, n: n choices)
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

typedef struct {
    uint8_t rows, index, count;
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
    return 0;
}
#endif
