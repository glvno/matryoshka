/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The global tempo (D-907): GLO > PANEL > TEMPO is GLOBAL (as made: one tempo every patch plays at; PRESET, program change,
 * the editor's patch and a device preset leave it) or PATCH (each patch plays its own, Main's tempo). The engine plays it
 * (eng_tempo_global); here are the setting, its place in the settings record and the write that keeps it without SAVE.
 * Main's tempo row, PLAY held + PRESET and the editor's PARAM move it through eng_set_param; SAVE keeps the patch's own.
 * The editor shares it (proto.c TEMPO / TEMPO_NOW, feature bit 16).
 *
 * The settings record (main.c): byte 5 the tempo's low 8 bits, byte 7 bit 7 set (the mark: an older record has 0 or 1
 * there, CPU in the bar and program change, which no firmware reads any more), bit 1 PATCH, bit 0 the tempo's bit 8.
 * A record without the mark reads as GLOBAL at the tempo of the patch the boot loads (ENG_TEMPO_ADOPT); a tempo of 0
 * means the same. An older firmware ignores both bytes and writes its own there, which then reads as a record without
 * the mark. Needs engine.h. */
#define GT_MARK 0x80u
#define GT_SAVE_MS 5000u                 /* the settings record is written this long after the last change */

static uint8_t gt_patch;                 /* TEMPO: 0 GLOBAL, 1 PATCH */
static uint16_t gt_bpm;                  /* the global tempo, kept while PATCH too (0: not known: the running patch's) */
static uint32_t gt_due;                  /* the settings record is due at this time (ms, never 0); 0 = nothing to write */

/* the setting onto the engine */
static void gt_apply(void)
{
    eng_tempo_global(gt_patch ? 0u : gt_bpm ? gt_bpm : ENG_TEMPO_ADOPT);
}

static void gt_pack(uint8_t *d)
{
    d[5] = (uint8_t)gt_bpm;
    d[7] = (uint8_t)(GT_MARK | (gt_patch ? 2u : 0u) | (gt_bpm >> 8 & 1u));
}

/* a settings record of len bytes (len >= 8) into the setting; the engine follows */
static void gt_unpack(const uint8_t *d, uint32_t len)
{
    uint32_t b = 0;
    gt_patch = 0;
    if (len > 7u && (d[7] & GT_MARK)) {
        gt_patch = d[7] >> 1 & 1u;
        b = (uint32_t)d[5] | (uint32_t)(d[7] & 1u) << 8;
    }
    gt_bpm = (uint16_t)(b >= 20u && b <= 300u ? b : 0u);
    gt_due = 0;
    gt_apply();
}

/* the record is to be written GT_SAVE_MS from now */
static void gt_changed(uint32_t now)
{
    gt_due = (now + GT_SAVE_MS) | 1u;
}

/* TEMPO set (the menu, the editor): mode 0 GLOBAL, 1 PATCH; bpm 20..300, 0 keeps the global tempo as it is */
static void gt_set(uint32_t patch, uint32_t bpm, uint32_t now)
{
    if (eng_tempo_moved() && eng_tempo_global_get())   /* (a move not yet polled) */
        gt_bpm = (uint16_t)eng_tempo_global_get();
    gt_patch = patch ? 1u : 0u;
    if (bpm >= 20u && bpm <= 300u)
        gt_bpm = (uint16_t)bpm;
    gt_apply();
    if (eng_tempo_moved() && eng_tempo_global_get())   /* (adopted the running patch's: that is the global tempo now) */
        gt_bpm = (uint16_t)eng_tempo_global_get();
    gt_changed(now);
}

/* each turn of the main loop: bit 0 = the engine moved the global tempo (a knob, PLAY held + PRESET, the editor's PARAM,
 * a boot that adopted a patch's): tell the editor; bit 1 = the settings record is due and may be written now (`quiet`:
 * nothing plays that a flash write would cut: the transport is stopped) */
static uint32_t gt_poll(uint32_t now, int quiet)
{
    uint32_t r = 0;
    if (eng_tempo_moved() && eng_tempo_global_get()) {
        gt_bpm = (uint16_t)eng_tempo_global_get();
        gt_changed(now);
        r |= 1u;
    }
    if (gt_due && (int32_t)(now - gt_due) >= 0 && quiet) {
        gt_due = 0;
        r |= 2u;
    }
    return r;
}
