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
#define ENG_PATCH_VERSION 33   /* 33: the Drum maps' row names section (flag bit 7, the #139 follow-up); 32: the Drum map module (#137; its record's data byte: where its keys come from); 31: the Steps module holds notes (#133: its record only its name, the notes section at flag bit 4, a keys output instead of acc, a group's note source may be a Steps module); 30: the button kinds section (flag bit 6); 29: the device pages section (flag bit 5), the Main module without the knob outputs / parameters k1..k6, the panel section with 7 labels, the Macro module; 28: env shot (one-shot); 27: step values (flag bit 4), the Steps module's transpose input and pitch / vel outputs; 26: the Steps module (name + pattern in its record), 7 panel buttons; 25: the group record's MIDI channel and key range; 24: the panel section, the Main module's k5 / k6 and button outputs; 23: the group record's note source */
#define ENG_PATCH_COMPAT_VERSION 31   /* (a format 31 patch reads the same) */
#define ENG_MAX_PARTS 8               /* parts of a poly group (notes it plays at once) */
#define ENG_GROUP_REC (8u + 5u * ENG_MAX_PARTS)   /* a poly group record: parts, assign, legato (bit 7: unison), priority, five flaw bytes per part, the note source, MIDI channel, lowest and highest key (patchbin.ts GROUP_REC) */

#define ENG_PANEL_BUTTONS 7            /* the patch buttons: FX SCL ENV LFO EDIT GLO ARP (modules.ts PANEL_BUTTONS); SEQ and REC are the step page's */
#define ENG_PANEL_LABELS 7             /* the buttons (patch.ts PANEL_LABEL_KEYS); the knobs show their rows' names */
#define ENG_PANEL_LABEL 10             /* bytes per label (PANEL_LABEL_MAX), zero padded */
#define ENG_PANEL_BYTES (4u + ENG_PANEL_LABELS * ENG_PANEL_LABEL)   /* the panel section (patchbin.ts PANEL_BYTES) */
#define ENG_BTN_TARGETS 128            /* the modules the Toggle buttons bypass, all together (patchbin.ts BUTTON_TARGETS_MAX) */
#define ENG_BTN_GATE 0u                /* a button's kind (buttons.ts KIND_CODE): on while held / switched, its jack only */
#define ENG_BTN_NOTHING 1u             /* unassigned: its jack still goes high while held */
#define ENG_BTN_TOGGLE 2u              /* bypasses its modules while on */
#define ENG_BTN_PAGE 3u                /* a list of device pages for K1..K4 (#117: the panel's, panel.c; the engine skips it) */

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

/* the end of the button kinds section (patchbin.ts, header flag bit 6) that starts at `at`, 0 when it is cut short:
 * ENG_PANEL_BUTTONS u8 kinds, then per Toggle (kind 2) button u8 n and n u8 module indices, per Page (kind 3) button u8 n
 * and n (u8 device, u8 page) pairs (the device pages section's indices, as FOCUS) */
static inline uint32_t eng_buttons_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t b;
    const uint8_t *k = p + at;
    if (at + ENG_PANEL_BUTTONS > len)
        return 0;
    at += ENG_PANEL_BUTTONS;
    for (b = 0; b < ENG_PANEL_BUTTONS; b++) {
        if (k[b] != 2u && k[b] != 3u)
            continue;
        if (at >= len)
            return 0;
        at += 1u + (k[b] == 3u ? 2u : 1u) * p[at];
    }
    return at <= len ? at : 0;
}

/* the end of the tracks' notes section (flag bit 4, patchbin.ts) that starts at `at`: u8 count, then per track u8 module,
 * u8 n, n u32 notes; 0 if it runs past `len` */
static inline uint32_t eng_notes_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t n, i;
    if (at >= len)
        return 0;
    n = p[at++];
    for (i = 0; i < n; i++) {
        if (at + 2u > len)
            return 0;
        at += 2u + 4u * p[at + 1u];
    }
    return at <= len ? at : 0;
}
/* the end of the device pages section (patchbin.ts, header flag bit 5) that starts at `at`, 0 when it is cut short:
 * u8 devices; per device u8 kind (0: u8 a plain module's index; 1: a text name, u8 pages, per page a text name, u8 part,
 * u8 parts, u8 display, u8 rows, per row u8 module, u8 parameter, a text label); a text is u8 length + that many bytes */
static inline uint32_t eng_devices_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t n, d, g, r, np, nr;
    if (at >= len)
        return 0;
    n = p[at++];
    for (d = 0; d < n; d++) {
        if (at >= len)
            return 0;
        if (p[at] == 0u) {
            at += 2u;
            continue;
        }
        if (p[at++] != 1u || at >= len)
            return 0;
        at += 1u + p[at];
        if (at >= len)
            return 0;
        np = p[at++];
        for (g = 0; g < np; g++) {
            if (at >= len)
                return 0;
            at += 1u + p[at];
            if (at + 4u > len)
                return 0;
            nr = p[at + 3u];
            at += 4u;
            for (r = 0; r < nr; r++) {
                at += 2u;
                if (at >= len)
                    return 0;
                at += 1u + p[at];
            }
        }
    }
    return at <= len ? at : 0;
}

/* the end of the Drum maps' row names section (patchbin.ts, header flag bit 7, format 33) that starts at `at`, 0 when it is
 * cut short: u8 count, then per map u8 module index and ENG_DRUM_ROWS names of ENG_DRUM_NAME bytes */
#define ENG_DRUM_ROWS 8u
#define ENG_DRUM_NAME 8u
static inline uint32_t eng_names_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    if (at >= len)
        return 0;
    at += 1u + p[at] * (1u + ENG_DRUM_ROWS * ENG_DRUM_NAME);
    return at <= len ? at : 0;
}
/* row r's name of the Drum map `module` in a patch binary (the #139 follow-up; at most ENG_DRUM_NAME characters and a 0 into out), 0 when
 * the binary has none for it (before format 33) */
int eng_drum_name(const uint8_t *p, uint32_t len, uint32_t module, uint32_t r, char *out);
/* the Drum map a Steps module's keys out goes into (the #139 follow-up: the SEQ page shows its rows), -1 none; its row r's note */
int eng_steps_drummap(uint32_t module);
int eng_drummap_note(uint32_t map, uint32_t r);
/* a drum track's step (the #139 follow-up): does a note on `note` start on step k (its note word, 0 none); switch it on (one step at
 * `vel`) / off; a hit on a row (sounds now, while the track plays into the nearest step: the step it went into, -1 heard
 * only) */
uint32_t eng_steps_note(uint32_t module, uint32_t k, uint32_t note);
void eng_steps_toggle(uint32_t module, uint32_t k, uint32_t note, uint32_t vel);
int eng_steps_hit_note(uint32_t module, uint32_t note, int accent, int record);

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
/* the poly group a module runs in, 1-based (0: none); whether group g (0 = the first) plays in unison */
int eng_module_group(uint32_t module);
int eng_poly_unison(uint32_t g);
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
/* what button b does (ENG_BTN_*), and a Toggle's modules (their count; *list points at their indices) */
uint32_t eng_button_kind(uint32_t b);
uint32_t eng_button_targets(uint32_t b, const uint8_t **list);
uint32_t eng_ticks(void);                 /* the clock's ticks so far (24 a quarter note) */
int eng_clock_is_external(void);          /* MIDI clock drives the clock */
uint32_t eng_buttons_get(void);
/* Steps modules (the SEQ page): how many the patch has and the module of the t-th (patch order); a step as a byte (the
 * step view of its notes, track.ts: bit 0 on, bit 1 accent, bits 2..6 the chance code, bit 7 tie; -1 if no such module /
 * step) and setting it, a step's note / velocity (note | vel << 8) and setting them (the running track; the caller keeps
 * the binary in step); the step playing (-1 while stopped or before the first); muting (not saved, a load clears it); a
 * hit from the panel (sounds now; with `record` while playing it goes into the nearest step: returned, else -1); a
 * track's notes (track.ts noteWord, sorted) and replacing them (0: they do not fit) */
int eng_steps_count(void);
int eng_steps_module(uint32_t t);
int eng_steps_get(uint32_t module, uint32_t k);
void eng_steps_set(uint32_t module, uint32_t k, uint32_t b);
int eng_steps_value(uint32_t module, uint32_t k);
void eng_steps_value_set(uint32_t module, uint32_t k, uint32_t note, uint32_t vel);
int eng_steps_pos(uint32_t module);
void eng_steps_mute(uint32_t module, int on);
int eng_steps_muted(uint32_t module);
int eng_steps_hit(uint32_t module, int accent, int record);
int eng_steps_notes(uint32_t module, const uint32_t **w);
int eng_steps_set_notes(uint32_t module, const uint32_t *notes, uint32_t n);
/* arming and recording from the keys (#139): the armed Steps module (-1 none); live recording on a track; the notes it
 * recorded, one at a time (0: none); step entry's chord; a recorded note laid over the track */
void eng_arm(int module);
int eng_armed(void);
void eng_steps_rec(uint32_t module, int on);
int eng_steps_take(uint32_t *module, uint32_t *word);
void eng_steps_chord(uint32_t module, uint32_t k, const uint8_t *notes, uint32_t n, uint32_t vel);
void eng_steps_overdub(uint32_t module, uint32_t word);
/* the performance controls: ENG_CTL_BEND (-1..1 Q16: +-2 semitones on the Main module's pitch and its bend
 * output), ENG_CTL_MOD (the mod wheel, 0..1, the mod output), ENG_CTL_AT (channel aftertouch, 0..1, the at output) */
enum { ENG_CTL_BEND, ENG_CTL_MOD, ENG_CTL_AT, ENG_NCTL };
void eng_ctl(uint32_t which, int32_t q16);
/* n frames of stereo, Q16, clamped to +-1.0; any n, processed in blocks of ENG_BLOCK */
void eng_render(int32_t *l, int32_t *r, uint32_t n);
/* overload: one part fewer in the poly group with the most (the audio ISR, before a render); 0 = none left to drop */
int eng_shed(void);
