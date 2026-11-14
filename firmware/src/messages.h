/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The words the top bar, the toasts and the footer show that the host tests (firmware/test/panel_test.c and the
 * *_test.h it includes) compare: one place to reword each. A message built from parts has its fixed parts here; the
 * code adds the name or number between them (and a test its expected one, by C's string concatenation). A nudge stays
 * within 26 characters (D-249), the bar within 38 (ui.c bar_text). ui.c includes this. */
#ifndef MESSAGES_H
#define MESSAGES_H

/* the keys and the arming (pages_ui.c dev_arm, seq_ui.c seq_arm_key, seq_leave) */
#define MSG_KEYS_WIRED "KEYS WIRED"                     /* also the footer's, after the patch's name */
#define MSG_NO_KEYS_REACH "NO KEYS REACH THIS DEVICE"
#define MSG_NOTHING_TAKES_KEYS "NOTHING HERE TAKES KEYS"
#define MSG_ARMED " ARMED"                              /* after a device's or a track's name */
#define MSG_DISARMED " DISARMED"
#define MSG_ARMED_PLUS " + "                            /* a device + the track that came along: DRUM MAP + DRUMS ARMED */
#define MSG_STAYS_ARMED " STAYS ARMED"
#define MSG_ROW_ARMED "ARMED"                           /* the environment's row status (pages_ui.c env_status) */
#define MSG_ROW_WIRED "WIRED"

/* the device's presets (pages_ui.c) */
#define MSG_PRESET "PRESET "                            /* then the preset's name */
#define MSG_STORED_SHORT "STORED SHORT: SEE EDITOR"
#define MSG_PRESET_DELETED "PRESET DELETED: SOUND KEPT"
#define MSG_NONE_PATCHES "NONE. HOME+PRESET: PATCHES"
#define MSG_OLD_PATCH "OLD PATCH: SEND + SAVE IT"
#define MSG_NONE_YET "NONE YET: ENV+SAVE STORES"

/* the panel (panel.c) */
#define MSG_BANK_EMPTY "BANK EMPTY"
#define MSG_ALL_STEPS_SHOWN "ALL 16 STEPS SHOWN"
#define MSG_NOT_USED ": NOT USED IN PATCH"              /* after the button's name */
#define MSG_ON " ON"                                    /* after a button's or a track's name */
#define MSG_OFF " OFF"
#define MSG_OCTAVE "OCTAVE "                            /* then +1, 0, -1 */
#define MSG_TEMPO "TEMPO "                              /* then the bpm */
#define MSG_TURN_PRESET ": TURN PRESET"                 /* after TEMPO n, PLAY held */
#define MSG_TEMPO_MIDI_CLOCK "TEMPO: MIDI CLOCK"
#define MSG_CHORD "CHORD: "                             /* then the chord's name */
#define MSG_CHORD_NONE "SINGLE NOTES"
#define MSG_DRUMS_BLACK_KEYS "DRUMS: BLACK KEYS 1-8"
#define MSG_COUNT_IN "COUNT-IN"                         /* alone, then with a space and the beat: 2, or bar.beat: 2.2 */
#define MSG_PLAY_ONCE "PLAY ONCE"
#define MSG_OUT35_OFF "3.5MM OUT OFF"
#define MSG_OUT35_ON "3.5MM OUT ON"
#define MSG_QUICK_START_OFF "QUICK START OFF: GLO>SYSTEM"   /* (27 characters, D-247) */

/* sandbox mode and the editor's Live (panel.c, live.c, sandbox_ui.c) */
#define MSG_MIDI_OUT_OFF "TURN ON MIDI OUT: GLO, K3"
#define MSG_SANDBOX_SAVE "SANDBOX: SAVE IN EDITOR"
#define MSG_SANDBOX_REC "SANDBOX: REC IN EDITOR"
#define MSG_SANDBOX_SEQ "SANDBOX: SEQ IN EDITOR"
#define MSG_SANDBOX_ENV "SANDBOX: ENV IN EDITOR"
#define MSG_SANDBOX_ARM "SANDBOX: ARM IN EDITOR"
#define MSG_SANDBOX_TEMPO "SANDBOX: TEMPO IN EDITOR"
#define MSG_SANDBOX_PATCH_STAYS "SANDBOX: PATCH STAYS"
#define MSG_LIVE_PATCH_STAYS "EDITOR LIVE: PATCH STAYS"
#define MSG_SANDBOX "SANDBOX"                           /* the footer, where the patch's name goes */
#define MSG_SANDBOX_EDITED MSG_SANDBOX " *"             /* the same, the patch with unsaved edits */
#define MSG_BROWSER_PLAYS "THE BROWSER PLAYS THIS PATCH"

/* the menu (menu.c) */
#define MSG_TEST_REFUSED "TEST INPUT: REFUSED"
#define MSG_HOLD_GLO "HOLD GLO 2 S"
#define MSG_HOLD_UPDATE MSG_HOLD_GLO ": UPDATE MODE"
#define MSG_HOLD_RESET MSG_HOLD_GLO ": RESET BANK"
#define MSG_LOW_BATTERY "LOW BATTERY"

/* the footer (pages_ui.c foot_layout, seq_ui.c seq_arm_label) */
#define MSG_FOOT_OCT "= OCT ="                          /* no octave shift */
#define MSG_FOOT_OCT_UP "OCT "                          /* then a + per octave */
#define MSG_FOOT_OCT_DOWN " OCT"                        /* after a - per octave */
#define MSG_FOOT_OUT35_OFF "3.5MM OFF"                  /* the mark left of the battery, as SCREEN reads it */
#define MSG_FOOT_ARM "ARM "                             /* then the armed track's name */
#define MSG_FOOT_REC "REC "

/* the SEQ and SONG pages (seq_ui.c) */
#define MSG_NO_STEPS "NO STEPS MODULE"
#define MSG_NO_TRACK "NO TRACK "                        /* then the black key's track number */
#define MSG_MUTED " MUTED"                              /* after the track's name; MSG_ON when unmuted */
#define MSG_TIED "TIED"
#define MSG_TIE_OFF "TIE OFF"
#define MSG_NOTHING_TO_TIE "NOTHING TO TIE"
#define MSG_NO_TIE_PAST_END "NO TIE PAST THE END"
#define MSG_DRONE "DRONE"
#define MSG_DRONE_OFF "DRONE OFF"
#define MSG_NOTHING_TO_DRONE "NOTHING TO DRONE"
#define MSG_NOTE_MEMORY_FULL "PATCH NOTE MEMORY FULL"
#define MSG_NOTE_PREVIEW_ON "NOTE PREVIEW ON"
#define MSG_NOTE_PREVIEW_OFF "NOTE PREVIEW OFF"
#define MSG_REC "REC "                                  /* then the track's name, or the count and MSG_REC_TRACKS */
#define MSG_REC_TRACKS " TRACKS"
#define MSG_REC_NO_TRACK "REC: NO TRACK ARMED"
#define MSG_REC_OFF "REC OFF"
#define MSG_REC_OFF_STEP MSG_REC_OFF ": STEP RECORD"
#define MSG_CLEAR "CLEAR "                              /* CLEAR name? REC AGAIN */
#define MSG_REC_AGAIN "? REC AGAIN"
#define MSG_CLEARED " CLEARED"                          /* after the track's name */
#define MSG_NOT_CLEARED "NOT CLEARED"
#define MSG_BAR_STEP "STEP "                            /* the SEQ bar in step record: STEP n/len, two spaces, the track */
#define MSG_BAR_ARM " ARM"                              /* the SEQ bar: after the track's name */
#define MSG_BAR_REC " REC"
#define MSG_SONG "SONG "                                /* the SONG bar: then the song's number */
#define MSG_SONG_RUNS " PLAYS"
#define MSG_SONG_STOPPED " STOPPED"

#endif
