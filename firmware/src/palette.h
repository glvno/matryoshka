/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The palette (#1196): up to 8 entries, each a bank slot (checked by its patch's name), every device's preset and the
 * selected pattern, switched with HOME + a black key. What the device's palette.c, the overview and gestures' pal_ui.c,
 * panel.c and proto.c share. The record's and the link's bytes: docs/ARCHITECTURE.md "The palette". */
#ifndef PALETTE_H
#define PALETTE_H

#define PAL_N 8u                                 /* positions, 1..8 on the black keys F#3..A#4 (seq_black 0..7) */
#define PAL_NONE 0xFFu                           /* pal_cur / pal_next: none */
#define PAL_NAME 20u                             /* a patch's name in an entry (the slot's, zero padded) */
#define PAL_DEVS 12u                             /* devices with a preset an entry keeps at most */
#define PAL_PNAME 16u                            /* a preset's name at most (presetstore.c PS_NAME) */
#define PAL_FIXED 23u                            /* an entry's fixed part: slot, pattern, name, ndev */
#define PAL_DEV_MAX (10u + PAL_PNAME)            /* one device: dev, structure, pstructure, nl, name */
#define PAL_ENTRY_MAX (PAL_FIXED + PAL_DEVS * PAL_DEV_MAX)   /* 335 */
#define PAL_HOLD_MS 1000u                        /* HOME + a black key held this long: save to that position */
#define PAL_VIEW_MS 300u                         /* HOME held alone this long: the overview shows */
#define PAL_NEXT_NAME 18u                        /* the bar's NEXT: n NAME cuts the name to this (C1) */
enum { PAL_EMPTY, PAL_OK, PAL_MISSING };         /* a position's state (PALETTE_NOW's too) */

/* the index in RAM, made from the record at boot and after every change to the bank or the palette (palette.c
 * pal_check): the slot, the pattern, the state, the entry's hash (CRC-16 of its bytes), the slot's binary length now
 * (0 when empty or missing) and the patch's name */
typedef struct {
    uint8_t slot, pattern, state, rsv;
    uint16_t hash, len;
    char name[PAL_NAME];
} pal_ix_t;
static pal_ix_t pal_ix[PAL_N];
static uint8_t pal_cur = PAL_NONE;               /* the position playing (the last switched to or saved), PAL_NONE none */
static uint8_t pal_next = PAL_NONE;              /* the position waiting for the bar line, PAL_NONE none */

/* palette.c on the device (the editor's FM-1 tab: imports; panel_test: stand-ins).
 * pal_request: switch to pos (0..7): now when stopped, else at the next bar line; pos == pal_next cancels; PAL_NONE
 * cancels. Returns proto.c's status (S_OK, S_NONE empty, S_MISSING, S_CMD sandbox mode), aux (may be 0): 0 switched at
 * once, 1 waiting, 2 cancelled. Draws nothing (the caller says what it refused).
 * pal_save: the running sound to pos (HOME + a black key held 1 s): the slot first when edited or in no slot, then the
 * entry; says what it did on the bar */
static uint32_t pal_request(uint32_t pos, uint32_t *aux);
static void pal_save(uint32_t pos);

#endif
