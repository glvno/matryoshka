/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The manual page of the settings menu (MANUAL tab): a short text, one line per entry, at most MAN_COLS characters after
 * the marker. The first character is the style: '#' a heading (accent colour), ' ' text, '~' dim (font_bc.c, FONT_S). Keep it in step with the buttons (main.c), the MIDI handling (midi_drain) and the limits (engine.c, proto.c). */
#define MAN_COLS 35u

static const char *const MANUAL[] = {
    "#THE DEVICE PLAYS PATCHES",
    " PRESET: NEXT / PREV PATCH (BANK)",
    " PLAY: TRANSPORT RUN / STOP",
    " PLAY HELD + PRESET: TEMPO",
    " SAVE: THE PATCH INTO ITS SLOT, AND",
    "   THE PANEL SETTINGS (CLOSES MENU)",
    " OCT- / OCT+: OCTAVE",
    "#DEVICES: THE PATCH'S TOP CARDS",
    " SELECT: THE DEVICE, ALGO: ITS PAGE",
    " K1-K4: THE FOUR ROWS OF THE PAGE",
    " HOME: BACK ONE STEP (OUT OF SEQ,",
    "   OF THIS MENU), HELD: THIS MENU",
    " ALGO MOVES SIDEWAYS, SELECT PICKS",
    " THE OTHER BUTTONS: THE PATCH'S",
    " AT POWER-ON: SAVE HELD = SAFE MODE,",
    "   OCT- + OCT+ HELD = UPDATE MODE",
    "#SEQ: THE PATCH'S DRUM TRACKS",
    " SEQ: OPEN / CLOSE THE STEP PAGE",
    " BLACK KEYS / ALGO: PICK A TRACK",
    " WHITE KEYS: STEPS ON / OFF,",
    "   ENV HELD: ACCENT",
    " HOLD A STEP + SELECT: ITS CHANCE,",
    "   + K1: ITS NOTE, + K2: VELOCITY",
    " OCT- / OCT+: STEPS 17-32 ...",
    " REC: BLACK KEYS RECORD HITS",
    " SEQ HELD + BLACK KEY: MUTE TRACK",
    " IN THIS MENU: ALGO TABS, SELECT",
    "   ROWS, K1-K4 / OCT VALUE",
    "#MIDI OUT: EVERY CONTROL",
    " KEYS: NOTES, K1-K4: CC 16-19",
    " SELECT / ALGO / PRESET: CC 20 / 21",
    "   / 23, RELATIVE",
    " MASTER: CC 7",
    " BUTTONS: CC 80-93, 127 / 0 ON PRESS",
    "   AND RELEASE, PLAY ALSO START/STOP",
    "~MORE: GLVNO.GITHUB.IO/MATRYOSHKA",
};
#define MAN_N ((uint32_t)(sizeof MANUAL / sizeof MANUAL[0]))
