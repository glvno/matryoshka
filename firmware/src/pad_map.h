/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* The global pad map (#1067): for drum rows 1..PAD_ROWS, the rows Main's keys reach in their bank order (engine.h
 * eng_keys_rows, D-520), the MIDI note of the outside pad that plays that row. One map for every patch, in the settings
 * (settings_ext.h, after the master EQ), not in a patch: it plays whatever Drum map the keys reach, in any kit, and does
 * nothing while they reach none. A patch's learned note wins over it (midi_learn.c map_midi). One pad per row, one row
 * per pad. Learned in learn mode (midi_learn.c pad_pick, pad_learn), shown and cleared on GLO > MIDI 4/4 and over the
 * link (PADS, PADS_NOW). Included by modular.c ahead of ui.c (FACTORY RESET empties it). */

#define PAD_ROWS 24u
#define PAD_NONE 0xFFu
#define PAD_BYTES (1u + PAD_ROWS)                       /* (in the settings extension: PAD MAP on, then the rows' notes) */
static uint8_t pad_on = 1;                              /* GLO > MIDI 4/4 PAD MAP: 1 on */
static uint8_t pad_note[PAD_ROWS] = {PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE,
                                     PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE,
                                     PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE, PAD_NONE};

/* every row's pad gone (GLO > MIDI 4/4 CLEAR ALL, PADS 0xFE); PAD MAP stays as it is */
static void pad_clear_all(void)
{
    uint32_t r;
    for (r = 0; r < PAD_ROWS; r++)
        pad_note[r] = PAD_NONE;
}

/* empty and on: as made, FACTORY RESET, a settings record without the map */
static void pad_defaults(void)
{
    pad_on = 1;
    pad_clear_all();
}

/* row r's pad: note n (0..127; a row that had it lets it go), or PAD_NONE */
static void pad_set(uint32_t r, uint32_t n)
{
    uint32_t k;
    if (r >= PAD_ROWS)
        return;
    if (n < 128u)
        for (k = 0; k < PAD_ROWS; k++)
            if (pad_note[k] == n)
                pad_note[k] = PAD_NONE;
    pad_note[r] = (uint8_t)(n < 128u ? n : PAD_NONE);
}

/* the row note n plays, or -1 */
static int pad_row_of(uint32_t n)
{
    uint32_t r;
    for (r = 0; r < PAD_ROWS; r++)
        if (pad_note[r] == n)
            return (int)r;
    return -1;
}

/* the rows with a pad */
static uint32_t pad_count(void)
{
    uint32_t r, c = 0;
    for (r = 0; r < PAD_ROWS; r++)
        c += pad_note[r] != PAD_NONE;
    return c;
}

/* as the settings extension's bytes (PAD_BYTES): PAD MAP, then the notes */
static void pad_pack(uint8_t *d)
{
    uint32_t r;
    d[0] = pad_on;
    for (r = 0; r < PAD_ROWS; r++)
        d[1u + r] = pad_note[r];
}
static void pad_unpack(const uint8_t *d)
{
    uint32_t r;
    pad_defaults();
    pad_on = (uint8_t)(d[0] & 1u);
    for (r = 0; r < PAD_ROWS; r++)
        if (d[1u + r] < 128u)
            pad_set(r, d[1u + r]);
}
