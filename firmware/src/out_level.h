/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* GLO > SYSTEM's level settings (#600 USB LEVEL): 0 KNOB, the MASTER knob sets the level, as before; 1..7 a fixed level the
 * knob does not change, in dB under the knob at its top: -24, -18, -12, -9, -6, -3, 0. In Q12, as master_q12 (the knob at
 * its top reads 4088, audio.c). audio.c applies them, menu.c shows and steps them; saved with the settings (main.c). */
#define LVL_N 8u
static const uint16_t LVL_Q12[LVL_N] = {0, 258, 515, 1027, 1450, 2049, 2894, 4088};
static const uint8_t LVL_DB[LVL_N] = {0, 24, 18, 12, 9, 6, 3, 0};
/* the level a setting gives: its fixed one, or the knob's (`knob`, Q12) at KNOB */
static uint32_t lvl_q12(uint32_t setting, uint32_t knob) { return setting && setting < LVL_N ? LVL_Q12[setting] : knob; }
