/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The manual page of the settings menu (MANUAL tab): a short text, one line per entry, at most MAN_COLS characters after
 * the marker. The first character is the style: '#' a heading (accent colour), ' ' text, '~' dim. The font has capitals
 * only. Keep it in step with the buttons (main.c), the MIDI handling (midi_drain) and the limits (engine.c, proto.c). */
#define MAN_COLS 35u

static const char *const MANUAL[] = {
    "#THE DEVICE PLAYS PATCHES",
    " PRESET: NEXT / PREV PATCH (BANK)",
    " PLAY: TRANSPORT RUN / STOP",
    " PLAY HELD + PRESET: TEMPO",
    " SAVE: THE PATCH INTO ITS SLOT, AND",
    "   THE PANEL SETTINGS",
    " OCT- / OCT+: OCTAVE",
    " HOME: LEGEND, HELD: THIS MENU",
    " K1-K6 AND THE OTHER BUTTONS: THE",
    "   PATCH'S (HOME SHOWS WHAT THEY DO)",
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
    " IN THIS MENU: ALGO TABS, PRESET OR",
    "   SELECT ROWS, K1-K4 / OCT VALUE",
    "~MORE: GLVNO.GITHUB.IO/MATRYOSHKA",
};
#define MAN_N ((uint32_t)(sizeof MANUAL / sizeof MANUAL[0]))
