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
#define ENG_PATCH_VERSION 48   /* 48: the patterns and songs section (flag bit 10 = p[7] bit 2, ENG_FLAG_PATTERNS: Steps patterns 2..64 with short note words, the selected pattern, up to eight songs), written only by patches that have patterns or songs; 47: filter osc parameter (self-oscillation) appended; 46: appended Follower module (esp); 45: filter hp6 output after existing ports; 44: Steps play direction; 43: appended Ratio module; 42: appended Rate Env module; 41: ADSR hold input after existing ports; 40: LFO wide-rate parameter; 39: group legato bit 6 selects shared unison with bit 7; 38: group parts byte high nibble is unison count (0 means all); 37: group priority bit 7 disables stealing, assign 3 rotates with key-release reset; 36: flag bit 9 is the mask of modules with a morph B side; 35: Tier 1 of #351: the types pd, env8, select; a device page row's extras (bit 6 of its parameter byte, ENG_ROW_MORE: the further parameters it sets, its positions' names; #357, #358); a type with more than 16 parameters writes its masks as u32; parameters appended to adsr (long), lfo (phase, range, dir, mult), delay (note, swell), reverb (freeze), pulse (inf), drummap (repeat): an older binary's record holds the parameters of its own format (eng_npar, defs.h psince) and the rest take their defaults; the Steps rates 7..8 and swing past 75 (ptop); 34: the device extras section (flag bit 8: p[7] bit 0; #194, #197): per device its driving Steps track, its structure, its preset's name; 33: the Drum maps' row names section (flag bit 7, the #139 follow-up); 32: the Drum map module (#137; its record's data byte: where its keys come from); 31: the Steps module holds notes (#133: its record only its name, the notes section at flag bit 4, a keys output instead of acc, a group's note source may be a Steps module); 30: the button kinds section (flag bit 6); 29: the device pages section (flag bit 5), the Main module without the knob outputs / parameters k1..k6, the panel section with 7 labels, the Macro module; 28: env shot (one-shot); 27: step values (flag bit 4), the Steps module's transpose input and pitch / vel outputs; 26: the Steps module (name + pattern in its record), 7 panel buttons; 25: the group record's MIDI channel and key range; 24: the panel section, the Main module's k5 / k6 and button outputs; 23: the group record's note source */
#define ENG_PATCH_COMPAT_VERSION 31   /* (a format 31 patch reads the same; 31..34 with the parameter counts of their format) */
#define ENG_MAX_PARTS 8               /* parts of a poly group (notes it plays at once) */
#define ENG_GROUP_REC (8u + 5u * ENG_MAX_PARTS)   /* a poly group record: parts (low nibble; high nibble unison count), assign, legato (bit 7: unison, bit 6: shared), priority (bit 7: no stealing), five flaw bytes per part, the note source, MIDI channel, lowest and highest key (patchbin.ts GROUP_REC) */

/* Validate the group settings without accepting new flags in older formats. */
static inline int eng_group_valid(const uint8_t *q, uint32_t version)
{
    return (q[0] & 15u) >= 1u && (q[0] & 15u) <= ENG_MAX_PARTS
        && (q[0] >> 4) <= (version >= 38u ? ENG_MAX_PARTS : 0u) && q[1] <= (version >= 37u ? 3u : 2u)
        && (q[2] & 0x3Fu) <= 2u && (!(q[2] & 0x40u) || (version >= 39u && (q[2] & 0x80u)))
        && (q[3] & 0x7Fu) <= 2u && (version >= 37u || !(q[3] & 0x80u));
}

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
/* the end of the patterns and songs section (patchbin.ts patternRecord, flag bit 10 = p[7] bit 2, format 48) that starts
 * at `at`: u8 selected pattern, u8 song playing, u8 tracks, per track u8 module, u8 P, per pattern u8 n (0xFF: none), with
 * n != 0xFF u8 len (bit 7: short words), u8 rate and n u16 / u32 words; u8 songs, per song u8 entries, 2 bytes each. 0 if it
 * runs past `len` */
#define ENG_FLAG_PATTERNS 4u                    /* in p[7] */
static inline uint32_t eng_patterns_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t nt, t, np, k, n, ns;
    if (at + 3u > len)
        return 0;
    nt = p[at + 2u];
    at += 3u;
    for (t = 0; t < nt; t++) {
        if (at + 2u > len)
            return 0;
        np = p[at + 1u];
        at += 2u;
        for (k = 0; k < np; k++) {
            if (at >= len)
                return 0;
            n = p[at++];
            if (n == 0xFFu)
                continue;
            if (at + 2u > len)
                return 0;
            at += 2u + n * ((p[at] & 0x80u) ? 2u : 4u);
        }
    }
    if (at >= len)
        return 0;
    ns = p[at++];
    for (k = 0; k < ns; k++) {
        if (at >= len)
            return 0;
        at += 1u + 2u * p[at];
    }
    return at <= len ? at : 0;
}
/* the end of the Steps sections from `at` (the notes, flag bit 4; the patterns and songs, ENG_FLAG_PATTERNS): `at` when
 * the patch has neither, 0 when one is cut short */
static inline uint32_t eng_steps_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    if ((p[6] & 16u) && !(at = eng_notes_end(p, len, at)))
        return 0;
    if ((p[7] & ENG_FLAG_PATTERNS) && !(at = eng_patterns_end(p, len, at)))
        return 0;
    return at;
}
/* bit 6 of a page row's parameter byte (format 35, #357 / #358): the row's extras follow its label: u8 n, n (u8 module,
 * u8 parameter): the further parameters it sets to its value; u8 k, k texts: its positions' names */
#define ENG_ROW_MORE 0x40u
/* the end of a page row's extras that start at `at`, 0 when they are cut short */
static inline uint32_t eng_row_more_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t k;
    if (at >= len)
        return 0;
    at += 1u + 2u * p[at];
    if (at >= len)
        return 0;
    k = p[at++];
    while (k--) {
        if (at >= len)
            return 0;
        at += 1u + p[at];
    }
    return at <= len ? at : 0;
}
/* the end of the device pages section (patchbin.ts, header flag bit 5) that starts at `at`, 0 when it is cut short:
 * u8 devices; per device u8 kind (0: u8 a plain module's index; 1: a text name, u8 pages, per page a text name, u8 part,
 * u8 parts, u8 display, u8 rows, per row u8 module, u8 parameter, a text label, with ENG_ROW_MORE in the parameter its
 * extras); a text is u8 length + that many bytes */
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
                uint32_t more;
                if (at + 2u > len)
                    return 0;
                more = (p[at + 1u] & 0x80u) == 0u && (p[at + 1u] & ENG_ROW_MORE);
                at += 2u;
                if (at >= len)
                    return 0;
                at += 1u + p[at];
                if (more && !(at = eng_row_more_end(p, len, at)))
                    return 0;
            }
        }
    }
    return at <= len ? at : 0;
}

/* the end of the device extras section (patchbin.ts, header flag bit 8 = bit 0 of p[7], format 34; right after the device
 * pages) that starts at `at`, 0 when it is cut short: u8 devices (the device pages section's count), per device u8 track (the
 * device index of the Steps track that drives it, ENG_NO_TRACK none), u32 LE structure (an assembly's fingerprint,
 * structure.ts; 0 a plain module), a text: the name of the preset it was set to (u8 length + that many bytes, 0 none),
 * u8 n and n (u8 module, u8 parameter byte as a page row's): its card rows in the canonical order of a preset's values
 * (0xFF 0xFF: a row the FM-1 has not got), u8 m and m module indices: the modules it is made of (#191) */
#define ENG_FLAG_EXTRAS 1u                      /* in p[7] */
#define ENG_FLAG_MORPH_MODULES 2u /* header byte 7 bit 1 (flag bit 9), after the B set */
#define ENG_NO_TRACK 0xFFu
static inline uint32_t eng_extras_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t n, d;
    if (at >= len)
        return 0;
    n = p[at++];
    for (d = 0; d < n; d++) {
        at += 5u;
        if (at >= len)
            return 0;
        at += 1u + p[at];
        if (at >= len)
            return 0;
        at += 1u + 2u * p[at];
        if (at >= len)
            return 0;
        at += 1u + p[at];
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
/* 1: the Drum map `map` repeats its rows over the keybed (#184: its repeat is on), so every key plays a row */
int eng_drummap_repeat(uint32_t map);
/* a drum track's step (the #139 follow-up): does a note on `note` start on step k (its note word, 0 none); switch it on (one step at
 * `vel`) / off; a hit on a row (sounds now, while the track plays into the nearest step: the step it went into, -1 heard
 * only) */
uint32_t eng_steps_note(uint32_t module, uint32_t k, uint32_t note);
void eng_steps_toggle(uint32_t module, uint32_t k, uint32_t note, uint32_t vel);
int eng_steps_hit_note(uint32_t module, uint32_t note, int accent, int record);

/* Install a patch from its binary form (web/src/patchbin.ts) into the selected voice. 0 on success, negative on error
 * (the voice is then silent). Resets all module state. Never call while eng_render runs (stop the audio ISR's call first). */
int eng_load(const uint8_t *p, uint32_t len);
/* Rewrite a binary of an older format (ENG_PATCH_COMPAT_VERSION.. ENG_PATCH_VERSION - 1) in place into today's: the
 * parameters added to a type since (defs.h psince) go in at their defaults, in its record and its morph B set. It plays the
 * same; eng_load reads the older binary the same way without it. *len grows, up to cap; 0 = done or already today's,
 * -1 malformed or too big for cap (left as it was). */
int eng_upgrade(uint8_t *p, uint32_t *len, uint32_t cap);
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
/* a setting of poly group g (0 = the first): ENG_POLY_* (assign 0..3, legato/priority 0..2, unison 0..2, steal 0..1, stack 0..8), -1 if none.
 * eng_poly_set changes all but parts/unison at once (0 = refused); parts/unison need a reload (the binary's group record). */
enum { ENG_POLY_PARTS, ENG_POLY_ASSIGN, ENG_POLY_LEGATO, ENG_POLY_PRIORITY, ENG_POLY_UNISON, ENG_POLY_STEAL, ENG_POLY_STACK, ENG_NPOLY };
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
/* the patch buttons' LEDs (the FM-1, the EMU view): eng_buttons_get, but ARP as a Toggle of Arpeggiators is lit while
 * they play, not while they are bypassed (D-231; the editor: buttons.ts arpLitInverted) */
uint32_t eng_buttons_lit(void);
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
/* Patterns and songs (format 48; modules.ts StepsState, engine.ts setPattern / setSong): the patch's pattern (0-based)
 * plays on each track from the end of its pass (at once while the transport is stopped); a song (1..ENG_SONGS, 0 none)
 * plays its entries, a pattern and a shift each, a pass each, from its first again after its last. */
#define ENG_PATTERNS 64
#define ENG_SONGS 8
#define ENG_SONG_LEN 64
#define ENG_SHIFT_MAX 12
void eng_pattern_set(uint32_t p);
int eng_pattern(void);                               /* the selected pattern (0-based), -1 no patch */
int eng_pattern_playing(uint32_t module);            /* the pattern a track plays (0-based; one it has not got plays its first), -1 */
int eng_pattern_queued(uint32_t module);             /* the pattern a track plays from the end of its pass, -1 none */
int eng_pattern_has(uint32_t module, uint32_t p);    /* the track has pattern p (pattern 0 always) */
int eng_pattern_rate(uint32_t module, uint32_t p);   /* its own length / rate, 0 / -1 the track's */
int eng_pattern_len(uint32_t module, uint32_t p);
int eng_steps_len(uint32_t module);                  /* the length of the pattern a track plays, -1 */
int eng_pattern_notes(uint32_t module, uint32_t p, const uint32_t **w);   /* pattern p's notes as eng_steps_notes, -1 */
int eng_pattern_set_notes(uint32_t module, uint32_t p, const uint32_t *notes, uint32_t n);   /* as eng_steps_set_notes */
void eng_song_set(uint32_t n);
int eng_song(void);                                  /* the song playing (0 none) */
int eng_song_entry(uint32_t module);                 /* the entry a track plays in the song, -1 none yet */
int eng_song_len(uint32_t s);                        /* song s's entries (0-based s) */
int eng_song_get(uint32_t s, uint32_t k);            /* entry k: pattern | (shift & 0xFF) << 8, -1 none */
int eng_song_put(uint32_t s, uint32_t k, uint32_t pat, int32_t shift);   /* entry k set (k = its length: appended); 0 = done */
int eng_song_insert(uint32_t s, uint32_t k);         /* a copy of entry k before it; 0 = done */
int eng_song_delete(uint32_t s, uint32_t k);
/* the patterns and songs section as the engine has it now (patchbin.ts patternRecord), into out (cap bytes): its length,
 * 0 when there is nothing to write (pattern 1, no song, no patterns, no entries), -1 when it does not fit */
int eng_patterns_record(uint8_t *out, uint32_t cap);
/* arming and recording from the keys (#139): the armed Steps module (-1 none); live recording on a track; the notes it
 * recorded, one at a time (0: none); step entry's chord; a recorded note laid over the track */
void eng_arm(int module);
int eng_armed(void);
/* arm a set of modules (#191; engine.ts arm / arm.ts armView): while the mask is not 0 Main's keys go only to the key
 * listeners among them (a group's Part or cards, a Drum map, an Arpeggiator, a Steps track, cabled from Main or not for a
 * track) and to nothing else (not the shared keyboard); 0: the cables decide. eng_arm(module) is the one-track form. */
void eng_arm_mask(uint64_t mask);
uint64_t eng_arm_mask_get(void);
/* whether module m hears Main's keys when armed: a Steps track, a Part or card of a group that takes the keys, a Drum map on
 * the keys, an Arpeggiator */
int eng_listens(uint32_t m);
/* the Drum map Main's keys reach (the armed set's, else the ones cabled), when they reach one and nothing that plays them as
 * notes (a group, the shared keyboard, an Arpeggiator, a track into no Drum map): the panel's black keys 1..8 play its rows
 * (panel.c panel_key); -1 none */
int eng_keys_drummap(void);
void eng_steps_rec(uint32_t module, int on);
int eng_steps_take(uint32_t *module, uint32_t *word);
void eng_steps_chord(uint32_t module, uint32_t k, const uint8_t *notes, uint32_t n, uint32_t vel);
void eng_steps_overdub(uint32_t module, uint32_t word);
/* the performance controls: ENG_CTL_BEND (-1..1 Q16: +-2 semitones on the Main module's pitch and its bend
 * output), ENG_CTL_MOD (the mod wheel, 0..1, the mod output), ENG_CTL_AT (channel aftertouch), ENG_CTL_BREATH / SUSTAIN / FOOT (CC 2 / 64 / 65), all 0..1 */
enum { ENG_CTL_BEND, ENG_CTL_MOD, ENG_CTL_AT, ENG_CTL_BREATH, ENG_CTL_SUSTAIN, ENG_CTL_FOOT, ENG_NCTL };
void eng_ctl(uint32_t which, int32_t q16);
/* n frames of stereo, Q16, clamped to +-1.0; any n, processed in blocks of ENG_BLOCK */
void eng_render(int32_t *l, int32_t *r, uint32_t n);
/* overload: one part fewer in the poly group with the most (the audio ISR, before a render); 0 = none left to drop */
int eng_shed(void);
