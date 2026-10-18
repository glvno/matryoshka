/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Fixed-point patch engine: the C port of web/src/engine.ts and modules.ts. Integer only (the FM-1 has no FPU).
 * Signals and parameters are Q16.16 (1.0 = 65536); the sample rate is ENG_SR. One patch plays at a time. Polyphony is per
 * poly group (a poly assembly of the editor): up to POLY_MAX_GROUPS per patch, each running its modules once per part
 * (1..ENG_MAX_PARTS), as the reference. */
#pragma once
#include <stdint.h>

#define ENG_SR 44118u          /* the FM-1's I2S rate (M-VAVE fm1_open, FM1_AUDIO_HARDWARE_RATE); was 44100 until 1.1 */
#define ENG_BLOCK 128u
#define ENG_ONE 65536
#define ENG_PATCH_VERSION 25   /* 25: the group record's MIDI channel and key range; 24: the panel section, the Main module's k5 / k6 and button outputs; 23: the group record's note source */
#define ENG_PATCH_COMPAT_VERSION 25
#define ENG_MAX_PARTS 8               /* parts of a poly group (notes it plays at once) */
#define ENG_GROUP_REC (8u + 5u * ENG_MAX_PARTS)   /* a poly group record: parts, assign, legato (bit 7: unison), priority, five flaw bytes per part, the note source, MIDI channel, lowest and highest key (patchbin.ts GROUP_REC) */

#define ENG_PANEL_BUTTONS 9            /* the patch buttons: FX SCL ENV LFO EDIT GLO ARP SEQ REC (modules.ts PANEL_BUTTONS) */
#define ENG_PANEL_LABELS 15            /* K1..K6, then the buttons (patch.ts PANEL_LABEL_KEYS) */
#define ENG_PANEL_LABEL 10             /* bytes per label (PANEL_LABEL_MAX), zero padded */
#define ENG_PANEL_BYTES (4u + ENG_PANEL_LABELS * ENG_PANEL_LABEL)   /* the panel section (patchbin.ts PANEL_BYTES) */

/* where the panel section of a patch binary starts: after the 8 header bytes, the poly groups' records (ENG_GROUP_REC each,
 * header byte 3 = their count) and, with any group, one membership byte per module. 0 if the binary is too short. */
static inline uint32_t eng_panel_at(const uint8_t *p, uint32_t len)
{
    uint32_t at;
    if (len < 8u)
        return 0;
    at = 8u + ENG_GROUP_REC * p[3] + (p[3] ? p[2] : 0u);
    return at + ENG_PANEL_BYTES <= len ? at : 0;
}

/* where the module records start: after the panel section. 0 if the binary is too short. */
static inline uint32_t eng_records_at(const uint8_t *p, uint32_t len)
{
    uint32_t at = eng_panel_at(p, len);
    return at ? at + ENG_PANEL_BYTES : 0;
}

/* Install a patch from its binary form (web/src/patchbin.ts) into the selected voice. 0 on success, negative on error
 * (the voice is then silent). Resets all module state. Never call while eng_render runs (stop the audio ISR's call first). */
int eng_load(const uint8_t *p, uint32_t len);
void eng_set_param(uint32_t module, uint32_t param, int32_t q16);
uint32_t delay_div(int32_t time_q16);                               /* the note length (DELAY_DIV_*) a synced delay's time value selects */
int32_t eng_get_param(uint32_t module, uint32_t param);
int32_t eng_get_eff(uint32_t module, uint32_t param);               /* what the last block used: base + modulation */
void eng_set_att(uint32_t module, uint32_t input, int32_t q16);      /* attenuverter of p1 / p2, Q16 */
int32_t eng_att(uint32_t module, uint32_t input);
/* a macro range of input 0 / 1 (p1 / p2) on a parameter: the input's value lands between lo and hi (0..255 of the
 * parameter's range, octaves for a log one) instead of adding to the base; on 0 removes it. 0 = no room / bad arguments */
int eng_set_range(uint32_t module, uint32_t input, uint32_t param, int on, uint32_t lo, uint32_t hi);
/* the range of input 0 / 1 on a parameter, 1 if there is one (lo / hi as above) */
int eng_range(uint32_t module, uint32_t input, uint32_t param, uint32_t *lo, uint32_t *hi);
void eng_set_bypass(uint32_t module, int on);                        /* bypass: the outputs carry the through input (defs.h thru) or silence; the state is kept */
int eng_bypass(uint32_t module);
/* the patch has a morph B set (the Main module's MORPH parameter fades every parameter from A to B) */
int eng_has_morph(void);
int eng_nmodules(void);
int eng_ncables(void);
void eng_cable(uint32_t i, uint32_t *from, uint32_t *from_port, uint32_t *to, uint32_t *to_port);   /* cable i of the patch */
int eng_type(uint32_t module);                                       /* defs.h T_*, -1 if no such module */
/* the matrix: bit mask of the parameters source s (0 p1, 1 p2, 2..5 knobs k1..k4) controls; 0 on modules without a matrix */
uint32_t eng_map(uint32_t module, uint32_t source);
/* the parameters knob k (0..3) changes while the module is selected: its matrix column, and on the modules without a
 * matrix (fm1, output) the k-th parameter */
uint32_t eng_knob_mask(uint32_t module, uint32_t knob);
/* the FM-1 panel module whose knob k drives parameter j of `module` through a cable (then the knob, not the parameter, is turned), else -1 */
int eng_knob_panel(uint32_t module, uint32_t knob, uint32_t j);
/* the value of a parameter after `clicks` knob clicks of `unit_per_click` (Q16 fraction of the range; octaves for the cutoff) */
int32_t eng_step_param(uint32_t module, uint32_t param, int32_t clicks, int32_t unit_per_click);
int eng_param_is_log(uint32_t module, uint32_t param);
/* index of the first module of a type (defs.h T_*), -1 if the patch has none */
int eng_find(uint32_t type);
/* the parts of the patch's first poly group (1 without one: everything plays the shared keyboard), 0 if none is loaded */
int eng_parts(void);
int eng_groups(void);                                                /* the poly groups of the loaded patch */
/* a setting of poly group g (0 = the first): ENG_POLY_* (assign, legato, priority 0..2), -1 if none.
 * eng_poly_set changes all but the parts at once (0 = refused); the parts need a reload (the binary's group record). */
enum { ENG_POLY_PARTS, ENG_POLY_ASSIGN, ENG_POLY_LEGATO, ENG_POLY_PRIORITY, ENG_NPOLY };
int eng_poly_get(uint32_t g, uint32_t field);
int eng_poly_set(uint32_t g, uint32_t field, uint32_t v);
/* a key on MIDI channel ch (1..16; the panel's keys play on the device's channel, or 1): the groups that take it (their
 * channel, or the device's without one, and their key range), the shared keyboard and the Arpeggiators (the device's) */
void eng_note_on(uint32_t note, int32_t vel_q16, uint32_t ch);
void eng_note_off(uint32_t note, uint32_t ch);
void eng_midi_channel(uint32_t ch);   /* the device's channel, 0 = every channel (MENU > MIDI CHANNEL) */
void eng_all_notes_off(void);
/* The clock: 24 ticks per quarter note, from the Main module's tempo, or from MIDI clock while it comes in (eng_clock_external
 * on, then each eng_clock_tick is one). The transport (PLAY, MIDI Start / Stop): the Main module's run output; its clock
 * output pulses once per block that saw a tick while the transport runs. Arpeggiators step on the clock either way. */
void eng_clock_tick(void);
void eng_clock_external(int on);
void eng_transport(int on);
int eng_transport_running(void);
/* the patch buttons (bit i = button i of ENG_PANEL_BUTTONS): held or switched on; the Main module's button outputs */
void eng_buttons(uint32_t mask);
uint32_t eng_ticks(void);                 /* the clock's ticks so far (24 a quarter note) */
int eng_clock_is_external(void);          /* MIDI clock drives the clock */
uint32_t eng_buttons_get(void);
/* the performance controls: ENG_CTL_BEND (-1..1 Q16: +-2 semitones on the Main module's pitch and its bend
 * output), ENG_CTL_MOD (the mod wheel, 0..1, the mod output), ENG_CTL_AT (channel aftertouch, 0..1, the at output) */
enum { ENG_CTL_BEND, ENG_CTL_MOD, ENG_CTL_AT, ENG_NCTL };
void eng_ctl(uint32_t which, int32_t q16);
/* n frames of stereo, Q16, clamped to +-1.0; any n, processed in blocks of ENG_BLOCK */
void eng_render(int32_t *l, int32_t *r, uint32_t n);
/* overload: one part fewer in the poly group with the most (the audio ISR, before a render); 0 = none left to drop */
int eng_shed(void);
