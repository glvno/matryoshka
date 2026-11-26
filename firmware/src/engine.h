/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Fixed-point patch engine: the C port of web/src/engine.ts and modules.ts. Integer only (the FM-1 has no FPU).
 * Signals and parameters are Q16.16 (1.0 = 65536); the sample rate is ENG_SR. One patch plays at a time. Polyphony is per
 * poly group (a poly assembly of the editor): up to POLY_MAX_GROUPS per patch, each running its modules once per part
 * (1..ENG_MAX_PARTS), as the reference. */
#pragma once
#include <stdint.h>

/* Step-entry scratch belongs to the loaded chained-keys patch, not every firmware session. */
typedef struct {
    uint8_t note[128], vel[128], at[128], end[128], hold[128];
    uint8_t of[27][8], count[27], audition[27][8], audition_count[27];
} eng_step_entry_t;
uint32_t eng_generation(void); /* changes before every load, including a failed load */
eng_step_entry_t *eng_steps_entry_memory(void); /* NULL for legacy routes */
/* D-1114, #979: the float kernels' result bits for a fixed input, one hash a case (engine.c), on lane 0 (core 0) or 1 */
#define ENG_PROBE_CASES 7u
void eng_fpu_probe(uint32_t lane, uint32_t *h);

#define ENG_SR 44118u          /* the FM-1's I2S rate (M-VAVE fm1_open, FM1_AUDIO_HARDWARE_RATE); was 44100 until 1.1 */
/* Allocation-rule discovery (#824). Comparison builds retain conservative admission. */
#ifndef ENG_BUF_REUSE
#define ENG_BUF_REUSE 1
#endif
#ifndef ENG_AOT
#define ENG_AOT 0
#endif
#ifndef ENG_BUF_ACCOUNTING
#define ENG_BUF_ACCOUNTING 1
#endif
#define ENG_BUFFER_ALLOCATION ((ENG_BUF_ACCOUNTING && ENG_BUF_REUSE && !ENG_AOT) ? 1u : 0u)

#define ENG_BLOCK 128u
#define ENG_ONE 65536
#define ENG_PATCH_VERSION 68   /* 68 (1.28, patchbin.ts FORMAT_1_28): the Harmonizer's `invkeys` appended (HARM_P_INVKEYS, the inversion keys, #1311); 67 (1.27, patchbin.ts FORMAT_1_27): more than 128 modules (ENG_MAX_MODULES 254, #1286) and a device's member count past 127 (ENG_MEMBER_WIDE); 66 (1.26.3, patchbin.ts FORMAT_RACK): flag bit 14 is the FX rack instead of the master FX bus: the patch's effects and FX drawers (eng_rack_end, ENG_FX_EFFECTS, #1214); 65 (the release after 1.22, patchbin.ts FORMAT_1_23): the MIDI learn mappings as the binary's last section (eng_maps, ENG_MAPS, #1067); 64 (the release after 1.21, patchbin.ts FORMAT_1_22): the EQ type (T_EQ, #1107) appended after the Euclid, and the shorter panel labels, cables and Drum map row names (ENG_SLIM, D-1025); 63 (release 1.20, patchbin.ts FORMAT_1_20): the Arpeggiator's `swing` appended and its bar rates past 1/32 (#1010, #1012), the Euclid type (T_EUCLID, #1018) appended after the Limiter, and Steps notes' timing words, ratchets and micro timing (ENG_TIME_BIT, #675, #677); 62 (release 1.19, patchbin.ts FORMAT_1_19): the Low pass gate (T_LPG, #1018) and the Limiter (T_LIMIT, #1019) types appended after the Harmonizer; 61: a cable into a Part's priority input (PART_I_PRIORITY, #976); 60: trig conditions, a note's condition word after it (ENG_NOTE_COND, #674); 59: the stored pattern links (ENG_FLAG_LINKS, #901) after the P-locks; 58: the Oscillator's `phase` (where sync restarts the cycle, #691) appended; 57: the ADSR's `ads` (release at the decay's time, D-745) appended; 56: Env L/R's `curve` (a linear fall, #689) appended; 55: optional validated master FX bus after format54 origins and before macro ranges */
#define ENG_COUNTED 51                /* the first format whose module records carry their parameter count (patchbin.ts COUNTED, #667) */
#define ENG_SLIM 64                   /* the first format with the panel labels by their length (eng_panel_bytes), the cables
                                       * grouped by the module they go into (eng_cables_grouped) and only the Drum map row
                                       * names off their default (eng_names_end): patchbin.ts SLIM, D-1025 */
#define ENG_SIDES 67                  /* the first format with stereo modules (ENG_REC_STEREO) and the side section right after
                                       * the cables (eng_cables_to, #1141, patchbin.ts sideRecord): in every binary of it, u8 n
                                       * (0: no side cable) */
#define ENG_WIDE 67                   /* the first format with patterns of more than ENG_NOTES_1_26 words (ENG_COUNT_ESC) and a
                                       * link of pattern 1 (index 0) to the pattern store (#1292, patchbin.ts FORMAT_1_27) */
#define ENG_NOTES_1_26 128u           /* the most words a pattern had before ENG_WIDE (TRACK_NOTES_MAX is 256 since) */
#define ENG_COUNT_ESC 0xFEu           /* a word count of 254 or more (ENG_WIDE; a store payload of version 2) is this byte,
                                       * then u8 count - 254; any other count one byte (track.ts COUNT_ESC) */
/* a word count at p[at] (ENG_COUNT_ESC; at + 1 must be in the binary when p[at] is the escape): its value, its bytes in *b */
static inline uint32_t eng_count_at(const uint8_t *p, uint32_t at, uint32_t *b)
{
    *b = p[at] == ENG_COUNT_ESC ? 2u : 1u;
    return *b == 2u ? ENG_COUNT_ESC + p[at + 1u] : p[at];
}
/* Format 51's record (patchbin.ts, D-1000): u8 type, u8 count (bits 0..5: the parameters it holds; bit 7, ENG_REC_TEMPLATE,
 * on a type with parameter inputs: its attenuverters and p1 / p2 masks are at their template, eng_mask_template, and left
 * out), the values, then on such a type without bit 7 a presence byte (ENG_PRES_*) and only the items it marks, in the
 * order att1, att2 (i32), p1, p2 (eng_mask_bytes each); then the type's data */
#define ENG_REC_COUNT 0x3Fu
#define ENG_REC_TEMPLATE 0x80u
#define ENG_REC_STEREO 0x40u           /* bit 6 (format 67, #1141, patchbin.ts REC_STEREO): the module runs in stereo mode, two
                                       * copies (eng_rec_ok: only on a DEF_STEREO type; eng_load: only outside the poly groups) */
#define ENG_PRES_ATT1 1u
#define ENG_PRES_ATT2 2u
#define ENG_PRES_P1 4u
#define ENG_PRES_P2 8u
#define ENG_PRES_ALL 15u
#define ENG_FLAG_CABLES3 16u          /* p[7] bit 4 (flag bit 12, format 51, D-1002): every cable is 3 bytes, u8 from module, u8 to
                                       * module, u8 from output << 4 | to input; since ENG_SLIM (D-1025) the cables are grouped
                                       * by the module they go into instead (eng_cables_grouped), without it 4 bytes each */
#define ENG_MEMBER_RUN 0x80u          /* bit 7 of a device's member count in the device extras (format 51, D-1003): the members
                                       * are one run, u8 first follows, the count is the low 7 bits */
#define ENG_MEMBER_WIDE 0x80u         /* a count byte of 0x80 (a run of none, never written before format 67, #1286): u8 n
                                       * (128..254), u8 form (0: the n module indices follow, 1: one run, u8 first follows) */
#define ENG_PATCH_COMPAT_VERSION 31   /* (a format 31 patch reads the same; 31..34 with the parameter counts of their format) */
#define ENG_MAX_PARTS 8               /* parts of a poly group (notes it plays at once) */
/* the modules of a patch (#721, D-256; 254 since 1.27, #1286): the binary's count is a byte, and index 253 is the last
 * the Drum map's keys source (2 + index) and key_src's 0xFF sentinel leave room for; past 128 a patch is format 67 (a
 * device's member count then takes ENG_MEMBER_WIDE). A node takes ENG_NODE_BYTES of the arena (#649), and the order and
 * Output tables a byte per module there too, so a patch pays for its own modules */
#define ENG_MAX_MODULES 254u
/* a set of modules (the armed ones, #191; what arming a device arms): bit m & 31 of w[m >> 5] = module m. The link carries
 * it as ENG_MSET_WORDS u32 LE (ARMS / ARMS_NOW: feature bit 36 all of them, bit 21 the first four, older firmware and
 * editors the first two). Keep in step with patch.ts ARM_WORDS */
#define ENG_MSET_WORDS ((ENG_MAX_MODULES + 31u) / 32u)
typedef struct { uint32_t w[ENG_MSET_WORDS]; } eng_mset_t;
static inline eng_mset_t mset_none(void) { eng_mset_t s = {{0}}; return s; }
static inline eng_mset_t mset_one(uint32_t m)   /* {m}, empty past ENG_MAX_MODULES */
{
    eng_mset_t s = {{0}};
    if (m < ENG_MAX_MODULES)
        s.w[m >> 5] = 1u << (m & 31u);
    return s;
}
static inline int mset_has(eng_mset_t s, uint32_t m) { return m < ENG_MAX_MODULES && (s.w[m >> 5] >> (m & 31u) & 1u); }
static inline int mset_any(eng_mset_t s)
{
    uint32_t i, a = 0;
    for (i = 0; i < ENG_MSET_WORDS; i++)
        a |= s.w[i];
    return a != 0u;
}
static inline int mset_eq(eng_mset_t a, eng_mset_t b)
{
    uint32_t i;
    for (i = 0; i < ENG_MSET_WORDS; i++)
        if (a.w[i] != b.w[i])
            return 0;
    return 1;
}
static inline eng_mset_t mset_or(eng_mset_t a, eng_mset_t b)
{
    uint32_t i;
    for (i = 0; i < ENG_MSET_WORDS; i++)
        a.w[i] |= b.w[i];
    return a;
}
static inline eng_mset_t mset_and(eng_mset_t a, eng_mset_t b)
{
    uint32_t i;
    for (i = 0; i < ENG_MSET_WORDS; i++)
        a.w[i] &= b.w[i];
    return a;
}
static inline eng_mset_t mset_minus(eng_mset_t a, eng_mset_t b)   /* a without b */
{
    uint32_t i;
    for (i = 0; i < ENG_MSET_WORDS; i++)
        a.w[i] &= ~b.w[i];
    return a;
}
static inline eng_mset_t mset_flip(eng_mset_t s, uint32_t m)      /* m in or out */
{
    if (m < ENG_MAX_MODULES)
        s.w[m >> 5] ^= 1u << (m & 31u);
    return s;
}
/* from n u32 LE words (the link; the rest 0), into ENG_MSET_WORDS of them (4 * ENG_MSET_WORDS bytes) */
static inline eng_mset_t mset_read(const uint8_t *p, uint32_t n)
{
    eng_mset_t s = {{0}};
    uint32_t i;
    for (i = 0; i < n && i < ENG_MSET_WORDS; i++)
        s.w[i] = (uint32_t)p[4u * i] | (uint32_t)p[4u * i + 1u] << 8 | (uint32_t)p[4u * i + 2u] << 16 | (uint32_t)p[4u * i + 3u] << 24;
    return s;
}
static inline void mset_write(eng_mset_t s, uint8_t *p)
{
    uint32_t i;
    for (i = 0; i < 4u * ENG_MSET_WORDS; i++)
        p[i] = (uint8_t)(s.w[i >> 2] >> (8u * (i & 3u)));
}
#define ENG_GROUP_REC (8u + 5u * ENG_MAX_PARTS)   /* a poly group record: parts (low nibble; high nibble unison count), assign, legato (bit 7: unison, bit 6: shared), priority (bit 7: no stealing), five flaw bytes per part, the note source, MIDI channel, lowest and highest key (patchbin.ts GROUP_REC) */

/* Validate the group settings without accepting new flags in older formats. */
static inline int eng_group_valid(const uint8_t *q, uint32_t version)
{
    return (q[0] & 15u) >= 1u && (q[0] & 15u) <= ENG_MAX_PARTS
        && (q[0] >> 4) <= (version >= 38u ? ENG_MAX_PARTS : 0u) && q[1] <= (version >= 37u ? 3u : 2u)
        && (q[2] & 0x3Fu) <= 2u && (!(q[2] & 0x40u) || (version >= 39u && (q[2] & 0x80u)))
        && (q[3] & 0x7Fu) <= 2u && (version >= 37u || !(q[3] & 0x80u));
}

/* the header's flags (p[6], p[7]) are ones the binary's format has (eng_load, proto.c m1_valid); format 51's morph B set
 * starts with the module mask, so a B set there has it (flag bit 9) */
static inline int eng_flags_ok(const uint8_t *p)
{
    const uint32_t f7 = 1u | 2u | 4u | 8u | 16u | 32u | 64u | 128u;
    return (!(p[7] & 64u) || (p[1] >= 55u && (p[6] & 32u))) && (!(p[7] & 32u) || p[1] >= 54u) && !(p[7] & ~f7) && (!(p[7] & 2u) || (p[1] >= 36u && (p[6] & 1u))) && (!(p[7] & 4u) || p[1] >= 48u)
        && (!(p[7] & 8u) || p[1] >= 49u) && (!(p[7] & 16u) || p[1] >= ENG_COUNTED) && (!(p[7] & 128u) || p[1] >= 59u) && (p[1] < ENG_COUNTED || !(p[6] & 1u) || (p[7] & 2u))
        && (p[1] >= 34u || !p[7]) && (p[1] >= 33u || !(p[6] & 128u)) && (p[1] >= 17u || !(p[6] & 4u)) && (p[1] >= 18u || !(p[6] & 8u))
        && (p[1] >= 27u || !(p[6] & 16u)) && (p[1] >= 30u || !(p[6] & 64u));
}

#define ENG_PANEL_BUTTONS 7            /* the patch buttons: FX SCL ENV LFO EDIT GLO ARP (modules.ts PANEL_BUTTONS); SEQ and REC are the step page's */
#define ENG_PANEL_LABELS 7             /* the buttons (patch.ts PANEL_LABEL_KEYS); the knobs show their rows' names */
#define ENG_PANEL_LABEL 10             /* bytes per label (PANEL_LABEL_MAX), zero padded before ENG_SLIM */
#define ENG_PANEL_BYTES (4u + ENG_PANEL_LABELS * ENG_PANEL_LABEL)   /* the panel section before ENG_SLIM (patchbin.ts PANEL_BYTES) */
#define ENG_BTN_TARGETS 128            /* the modules the Toggle buttons bypass, all together (patchbin.ts BUTTON_TARGETS_MAX) */
#define ENG_BTN_GATE 0u                /* a button's kind (buttons.ts KIND_CODE): on while held / switched, its jack only */
#define ENG_BTN_NOTHING 1u             /* unassigned: its jack still goes high while held */
#define ENG_BTN_TOGGLE 2u              /* bypasses its modules while on */
#define ENG_BTN_PAGE 3u                /* a list of device pages for K1..K4 (#117: the panel's, panel.c; the engine skips it) */

/* bytes of the panel section that starts at p[at] (patchbin.ts panelBytes): ENG_PANEL_BYTES before ENG_SLIM; since, the two
 * masks, u8 the labels it holds (bit i: label i) and each of them as u8 length (1..ENG_PANEL_LABEL) and its characters.
 * 0 if it is cut short or malformed */
uint32_t eng_panel_bytes(const uint8_t *p, uint32_t len, uint32_t at);

/* where the panel section of a patch binary starts: after the 8 header bytes, the poly groups' records (ENG_GROUP_REC each,
 * header byte 3 = their count) and, with any group, one membership byte per module. 0 if the binary is too short. */
static inline uint32_t eng_panel_at(const uint8_t *p, uint32_t len)
{
    uint32_t at;
    if (len < 8u)
        return 0;
    at = 8u + ENG_GROUP_REC * p[3] + (p[3] ? p[2] : 0u);
    return eng_panel_bytes(p, len, at) ? at : 0;
}

/* where the module records start: after the panel section. 0 if the binary is too short. */
static inline uint32_t eng_records_at(const uint8_t *p, uint32_t len)
{
    uint32_t at = eng_panel_at(p, len);
    return at ? at + eng_panel_bytes(p, len, at) : 0;
}

/* label i of a patch binary's panel section (patchbin.ts PANEL_LABEL_KEYS order) into out (ENG_PANEL_LABEL + 1 bytes,
 * 0-terminated); its length, 0 when it has none */
uint32_t eng_panel_label(const uint8_t *p, uint32_t len, uint32_t i, char *out);

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
 * n (ENG_COUNT_ESC), n u32 notes; 0 if it runs past `len` */
static inline uint32_t eng_notes_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t n, i, b, c;
    if (at >= len)
        return 0;
    n = p[at++];
    for (i = 0; i < n; i++) {
        if (at + 3u > len)
            return 0;
        c = eng_count_at(p, at + 1u, &b);
        at += 1u + b + 4u * c;
    }
    return at <= len ? at : 0;
}
/* the end of the patterns and songs section (patchbin.ts patternRecord, flag bit 10 = p[7] bit 2, format 48) that starts
 * at `at`: u8 selected pattern, u8 song playing, u8 tracks, per track u8 module, u8 P, per pattern n (0xFF: none; else
 * ENG_COUNT_ESC), with n != 0xFF u8 len (bit 7: short words), u8 rate and n u16 / u32 words; u8 songs, per song u8
 * entries, 2 bytes each. 0 if it runs past `len` */
#define ENG_FLAG_PATTERNS 4u                    /* in p[7] */
static inline uint32_t eng_patterns_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t nt, t, np, k, n, ns, b;
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
            if (at + 1u >= len)
                return 0;
            if (p[at] == 0xFFu) {
                at++;
                continue;
            }
            n = eng_count_at(p, at, &b);
            at += b;
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
/* the end of the P-locks section (patchbin.ts lockRecord, flag bit 11 = p[7] bit 3, format 49, #524) that starts at `at`:
 * u8 tracks, per track u8 module, u8 T rows, per row u8 n and n (module, parameter), u8 P, per pattern u8 its number, u8 L
 * and L locks of 6 bytes (step, row, i32 value). 0 if it runs past `len` */
#define ENG_FLAG_LOCKS 8u                       /* in p[7] */
static inline uint32_t eng_locks_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t nt, t, k, n;
    if (at >= len)
        return 0;
    nt = p[at++];
    for (t = 0; t < nt; t++) {
        if (at + 2u > len)
            return 0;
        n = p[at + 1u];
        at += 2u;
        for (k = 0; k < n; k++) {
            if (at >= len)
                return 0;
            at += 1u + 2u * p[at];
        }
        if (at >= len)
            return 0;
        n = p[at++];
        for (k = 0; k < n; k++) {
            if (at + 2u > len)
                return 0;
            at += 2u + 6u * p[at + 1u];
        }
    }
    return at <= len ? at : 0;
}
/* the end of the stored pattern links section (format 59, flag bit 15 = p[7] bit 7, #901; patchbin.ts) that
 * starts at `at`: u8 count (1..63; 64 since ENG_WIDE), count x (u8 pattern index 1..63, since ENG_WIDE 0..63: pattern 1
 * too, #1292; u16 LE store id 1..ENG_LINK_ID_MAX), ascending. 0 if
 * it runs past `len`. The engine checks the links and plays nothing from them: the FM-1 copies a linked pattern's content
 * from its pattern store into the engine after the load (patlink.c) */
#define ENG_FLAG_LINKS 128u                     /* in p[7] */
#define ENG_LINK_ID_MAX 0xEFFFu
static inline uint32_t eng_links_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    if (at >= len)
        return 0;
    at += 1u + 3u * p[at];
    return at <= len ? at : 0;
}
/* the sections after the side-input routes, in their order in a binary (eng_section_at): ENG_SEC_FX is where the master
 * FX bus (formats 55..65) or the FX rack (format 66) would start, right after the pattern origins */
enum { ENG_SEC_NOTES, ENG_SEC_PATTERNS, ENG_SEC_LOCKS, ENG_SEC_LINKS, ENG_SEC_DEVICES, ENG_SEC_EXTRAS, ENG_SEC_BUTTONS,
       ENG_SEC_NAMES, ENG_SEC_ORIGINS, ENG_SEC_FX };
/* where section `sec` (ENG_SEC_*) starts in binary p, or would start, past every section before it that the binary has;
 * 0 if one of those is cut short. Past the routes it can exceed `len` when the binary has none of those sections: the
 * callers check. The one walk over the sections that every "where does X start" asks (#901) */
uint32_t eng_section_at(const uint8_t *p, uint32_t len, uint32_t sec);
/* where the stored pattern links section starts in binary p, or would start (right after the P-locks), 0 if the binary is
 * malformed (#901: proto.c m1_patch_links, patlink.c) */
uint32_t eng_links_at(const uint8_t *p, uint32_t len);
/* the end of the Steps sections from `at` (the notes, flag bit 4; the patterns and songs, ENG_FLAG_PATTERNS; the P-locks,
 * ENG_FLAG_LOCKS; the stored pattern links, ENG_FLAG_LINKS): `at` when the patch has none, 0 when one is cut short */
static inline uint32_t eng_steps_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    if ((p[6] & 16u) && !(at = eng_notes_end(p, len, at)))
        return 0;
    if ((p[7] & ENG_FLAG_PATTERNS) && !(at = eng_patterns_end(p, len, at)))
        return 0;
    if ((p[7] & ENG_FLAG_LOCKS) && !(at = eng_locks_end(p, len, at)))
        return 0;
    if ((p[7] & ENG_FLAG_LINKS) && !(at = eng_links_end(p, len, at)))
        return 0;
    return at;
}
/* bit 6 of a page row's parameter byte (format 35, #357 / #358): the row's extras follow its label: u8 n, n (u8 module,
 * u8 parameter): the further parameters it sets to its value; u8 k, k texts: its positions' names. On a poly row (bit 7;
 * format 51, only the voices row) the extras are u8 top: the most voices its VOICES row offers (patchbin.ts polyTop) */
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
/* a device of the device pages section's kind 2 (format 49, #518; patchbin.ts NAMED_MODULE): a plain module with its own
 * name, u8 its index and a text: its name */
#define ENG_DEV_NAMED 2u
/* the end of the device pages section (patchbin.ts, header flag bit 5) that starts at `at`, 0 when it is cut short:
 * u8 devices; per device u8 kind (0: u8 a plain module's index; 2, ENG_DEV_NAMED: u8 a plain module's index, a text name; 1: a text name, u8 pages, per page a text name, u8 part,
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
        if (p[at] == ENG_DEV_NAMED) {
            if (at + 2u >= len)
                return 0;
            at += 3u + p[at + 2u];
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
                more = p[at + 1u] & ENG_ROW_MORE ? (p[at + 1u] & 0x80u ? 1u : 2u) : 0u;   /* (1: a poly row's top) */
                at += 2u;
                if (at >= len)
                    return 0;
                at += 1u + p[at];
                if (more == 1u && ++at > len)
                    return 0;
                if (more == 2u && !(at = eng_row_more_end(p, len, at)))
                    return 0;
            }
        }
    }
    return at <= len ? at : 0;
}

/* the end of the device extras section (patchbin.ts, header flag bit 8 = bit 0 of p[7], format 34; right after the device
 * pages) that starts at `at`, 0 when it is cut short: u8 devices (the device pages section's count), per device u8 track (the
 * device index of the Steps track that drives it, ENG_NO_TRACK none, ENG_KEYS_UNREACHED none and an engine no keys cable
 * reaches, #215; ENG_KEYS_UNREACHED_TRACK | t: the track t drives it through other cables, and it is an engine no keys
 * cable reaches, #633), u32 LE structure (an assembly's fingerprint, structure.ts; 0 a plain module), a text: the name of the preset it was set to (u8 length + that many bytes, 0 none),
 * u8 n and n (u8 module, u8 parameter byte as a page row's): its card rows in the canonical order of a preset's values
 * (0xFF 0xFF: a row the FM-1 has not got), u8 m and m module indices: the modules it is made of (#191; format 51: with
 * ENG_MEMBER_RUN in m, u8 first: the m & 0x7F modules from it on; format 67: ENG_MEMBER_WIDE, eng_members) */
#define ENG_FLAG_EXTRAS 1u                      /* in p[7] */
#define ENG_FLAG_MORPH_MODULES 2u /* header byte 7 bit 1 (flag bit 9), after the B set */
#define ENG_NO_TRACK 0xFFu
#define ENG_KEYS_UNREACHED 0xFEu                /* the track byte: no track, and an engine no keys cable reaches (#215, D-905;
                                                 * firmware before 1.9 finds no such device: no track) */
#define ENG_KEYS_UNREACHED_TRACK 0x80u          /* the track byte's bit: | the device index of the Steps track that drives
                                                 * it through pitch / gate, and an engine no keys cable reaches (#633, D-295;
                                                 * firmware before 1.10 finds no such device: no track) */
/* a device's members at p[at] in its device extras: *n modules, one run from p[*from] (*run 1) or the indices p[*from..];
 * the bytes they take */
static inline uint32_t eng_members(const uint8_t *p, uint32_t at, uint32_t *n, uint32_t *run, uint32_t *from)
{
    if (p[at] == ENG_MEMBER_WIDE) {
        *n = p[at + 1u];
        *run = p[at + 2u] != 0u;
        *from = at + 3u;
    } else {
        *n = p[at] & ~ENG_MEMBER_RUN & 0xFFu;
        *run = (p[at] & ENG_MEMBER_RUN) != 0u;
        *from = at + 1u;
    }
    return *from - at + (*run ? 1u : *n);
}
static inline uint32_t eng_members_size(const uint8_t *p, uint32_t at)
{
    uint32_t n, run, from;
    return eng_members(p, at, &n, &run, &from);
}
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
        if (at >= len || (p[at] == ENG_MEMBER_WIDE && at + 2u >= len))
            return 0;
        at += eng_members_size(p, at);
    }
    return at <= len ? at : 0;
}

/* the end of the Drum maps' row names section (patchbin.ts, header flag bit 7, format 33) that starts at `at`, 0 when it is
 * cut short: u8 count, then per map u8 module index and ENG_DRUM_ROWS names of ENG_DRUM_NAME bytes; since ENG_SLIM per map
 * u8 module index, u8 the rows it names (bit r: row r) and each of those names as u8 length (0..ENG_DRUM_NAME) and its
 * characters (the others are their default, defs.h DRUM_ROW_NAME) */
#define ENG_DRUM_ROWS 8u
#define ENG_DRUM_NAME 8u
uint32_t eng_names_end(const uint8_t *p, uint32_t len, uint32_t at);
/* Format 54, flag bit 13: u16 count followed by sorted unique (u8 Steps module,
 * u8 pattern 0..63, u32 immutable default identity) records, before macro ranges.
 * Identity zero is a cleared origin; an unknown nonzero identity is retained, never inferred. */
#define ENG_FLAG_ORIGINS 32u
uint32_t eng_origins_end(const uint8_t *p, uint32_t len, uint32_t at);
uint32_t eng_origins_at(const uint8_t *p, uint32_t len);
uint32_t eng_origin_record(const uint8_t *p, uint32_t len, uint32_t module, uint32_t pattern);
/* Formats 55..65 (D-1010), flag bit 14: the master FX bus. u8 count (1..4), then in signal order u8 kind, device, first
 * page, target count, and that many device-form module indices. The optional record precedes macro ranges. The engine
 * loads its stages as the effects of one Output drawer (eng_rack_*), each effect on the bus device and its page.
 * Format 66 (#1214), flag bit 14: the FX rack, in the same place:
 *   u8 E (0..ENG_FX_EFFECTS): the patch's effects in device order, each E x { u8 device (its own device's index), u8 n
 *   (0..ENG_FX_TARGETS_MAX), n x u8 module (its targets, unique across the section; at most ENG_FX_RUNS in all) },
 *   then u8 D (0..ENG_FX_DRAWERS): its FX drawers, each D x { u8 owner (the instrument's device index, ENG_RACK_OUTPUT
 *   for the Output drawer), u8 first (its first effect's place in the list above), u8 count (0: an empty drawer) };
 *   E + D is at least 1.
 * A target runs as a master FX stage's did (D-1100): a Delay or a Reverb rings out, any other type fades over 1024
 * samples, and the only target of an effect that is a Reverb returns its wet sound only. All targets of an effect share
 * its on/off. An effect with n = 0 (the editor's fallback past 8 targets or ENG_FX_RUNS in all, or with a target that
 * cannot run so) switches by ordinary bypass: eng_fx_set only keeps its state. */
#define ENG_FLAG_FX_BUS (1u << 14)
#define ENG_FX_STAGE_COUNT 4u /* formats 55..65: maximum; sparse records contain 1..4 ordered unique kinds */
#define ENG_FX_TARGETS_MAX 8u
#define ENG_FX_EFFECTS 32u    /* format 66: the most effects in the rack */
#define ENG_FX_RUNS 32u       /* the most targets of all effects together (the bus's 4 x 8) */
#define ENG_FX_DRAWERS 16u    /* format 66: the most FX drawers */
#define ENG_RACK_OUTPUT 0xFFu /* eng_rack_owner: the Output drawer */
enum { ENG_FX_DRIVE, ENG_FX_CHORUS, ENG_FX_DELAY, ENG_FX_REVERB };
const uint8_t *eng_skip_fx(const uint8_t *p, const uint8_t *end, uint16_t flags); /* formats 55..65; NULL: malformed */
uint32_t eng_rack_end(const uint8_t *p, uint32_t len, uint32_t at); /* past bit 14's section at `at` (any format); 0: malformed */
uint32_t eng_fx_count(void);                 /* the effects */
uint32_t eng_fx_kind(uint32_t e);            /* the master FX kind of its first target's type (ENG_FX_*), UINT32_MAX: none */
uint32_t eng_fx_device(uint32_t e);          /* its device's index in the binary; UINT32_MAX: no such effect */
uint32_t eng_fx_page(uint32_t e);            /* formats 55..65: the stage's first page; format 66: 0 */
uint32_t eng_fx_targets(uint32_t e, const uint8_t **targets);
int eng_fx_on(uint32_t e);                   /* desired UI state, independent of a processing tail */
void eng_fx_set(uint32_t e, int on);         /* every target of the effect; does not change parameter values */
uint32_t eng_rack_count(void);               /* the FX drawers */
uint32_t eng_rack_owner(uint32_t r);         /* the instrument's device index, ENG_RACK_OUTPUT; UINT32_MAX: no such drawer */
uint32_t eng_rack_first(uint32_t r);         /* its first effect (eng_fx_*) */
uint32_t eng_rack_len(uint32_t r);           /* its effects, consecutive from eng_rack_first */
/* The MIDI mappings (#1067, MIDI learn): the last section of a binary, after the macro ranges (or where they would be).
 * u8 count (1..ENG_MAPS_MAX), then per mapping u8 source (a CC 0..119, ENG_MAP_BEND, or ENG_MAP_NOTE + a note), u8 the row's module and u8 its
 * parameter byte as a device page row has them, u8 low end, u8 high end (0..255 of the row's range: the control's lowest
 * value lands on the low end; low above high turns it round). No section: no mappings. The editor writes it from format
 * ENG_MAPS on; the FM-1 reads it in a binary of any format and its MIDI learn writes it into a copy of any format (an
 * older firmware's eng_load ignores the bytes; only an upload is checked to end where the sections do). One source per
 * mapping, one mapping per row. The engine never reads it: midi_learn.c does, from the running patch's binary. */
#define ENG_MAPS 65                         /* (patchbin.ts FORMAT_1_23) */
#define ENG_MAPS_MAX 16u
#define ENG_MAP_BEND 127u                   /* the source byte of pitch bend (CC 127 is never learned) */
#define ENG_MAP_NOTE 128u                   /* the source byte of MIDI note n: 128 + n (D-1027) */
#define ENG_MAP_BYTES 5u
/* where the mapping section of binary p starts (its count byte), len when it has none; 0 when a section before it is
 * malformed */
uint32_t eng_maps_at(const uint8_t *p, uint32_t len);
/* the mappings of binary p: their count, and *e at the first one's bytes; 0 when there are none or the section does not
 * end the binary */
uint32_t eng_maps(const uint8_t *p, uint32_t len, const uint8_t **e);
/* binary p's mappings become the n mappings at e (ENG_MAP_BYTES each; n = 0: none), *len changes. 0: malformed, more than
 * ENG_MAPS_MAX or past cap (left as it was) */
int eng_maps_set(uint8_t *p, uint32_t *len, uint32_t cap, const uint8_t *e, uint32_t n);
/* binary p maps source src to module mod's row byte par, low end lo, high end hi (on), or drops src's mapping (!on): the
 * source's mapping before and the row's are replaced. 0: malformed, no room (ENG_MAPS_MAX or cap: left as it was) or,
 * dropping, no such mapping */
int eng_map_edit(uint8_t *p, uint32_t *len, uint32_t cap, uint32_t src, uint32_t mod, uint32_t par, uint32_t lo, uint32_t hi, int on);
/* row r's name of the Drum map `module` in a patch binary (the #139 follow-up; at most ENG_DRUM_NAME characters and a 0 into out), 0 when
 * the binary has none for it (before format 33) */
int eng_drum_name(const uint8_t *p, uint32_t len, uint32_t module, uint32_t r, char *out);
/* the Drum map a Steps module's keys out goes into (the #139 follow-up: the SEQ page shows its rows), -1 none; its row r's note */
int eng_steps_drummap(uint32_t module);
int eng_drummap_note(uint32_t map, uint32_t r);
/* a drum track's rows as one list (D-520): the rows of every Drum map the track plays (directly or through its
 * Arpeggiator), the maps in module order; with two maps or more, the rows whose note is 0 left out. Each row's map and
 * its row in that map into map[i], row[i]; the count (0: no Drum map). The panel shows them in banks of ENG_DRUM_ROWS */
#define ENG_DRUM_BANKS 3u
#define ENG_DRUM_LIST (ENG_DRUM_ROWS * ENG_DRUM_BANKS)
uint32_t eng_steps_rows(uint32_t module, uint8_t *map, uint8_t *row);
/* 1: the Drum map `map` repeats its rows over the keybed (#184: its repeat is on), so every key plays a row */
int eng_drummap_repeat(uint32_t map);
/* a drum track's step (the #139 follow-up): does a note on `note` start on step k (its note word, 0 none); switch it on (one step at
 * `vel`) / off; a hit on a row (sounds now, while the track plays into the nearest step: the step it went into, -1 heard
 * only) */
uint32_t eng_steps_note(uint32_t module, uint32_t k, uint32_t note);
void eng_steps_toggle(uint32_t module, uint32_t k, uint32_t note, uint32_t vel);
/* a note tied across the loop point (#384, format 50; track.ts NOTE_WRAP, StepNote.wrap): bit 31 of its word. Its length
 * runs on past the end of the pass into the next pass's first steps; with the most length (64) it is a drone, tied back
 * onto its own step (eng_note_drone). The helpers below are track.ts noteThrough, endOn, cutBefore on a word, in grid
 * order on a pattern of `len` steps */
#define ENG_NOTE_WRAP 0x80000000u
static inline int eng_note_drone(uint32_t w) { return (w & ENG_NOTE_WRAP) && ((w >> 6) & 63u) == 63u && (w & 127u << 19); }   /* (a timing word, #675, is no note) */
/* does the note sound on step k without starting there */
static inline int eng_note_through(uint32_t w, uint32_t k, uint32_t len)
{
    uint32_t at = w & 63u, n = ((w >> 6) & 63u) + 1u;
    if (!(w & 127u << 19))                       /* (a condition word, velocity 0, is no note: ENG_NOTE_COND) */
        return 0;
    if (at < k && k < at + n)
        return 1;
    if (!(w & ENG_NOTE_WRAP) || at >= len || k >= at)
        return 0;
    return eng_note_drone(w) || k + len < at + n;
}
/* the note made to end on step k (k its last step): tied across the loop point when k comes before its start */
static inline uint32_t eng_note_end_on(uint32_t w, uint32_t k, uint32_t len)
{
    uint32_t at = w & 63u, n = k >= at ? k - at + 1u : len - at + k + 1u;
    return (w & ~(ENG_NOTE_WRAP | 63u << 6)) | (n - 1u) << 6 | (k < at ? ENG_NOTE_WRAP : 0u);
}
/* the note cut to end just before step k (a note through k; k is not its start) */
static inline uint32_t eng_note_cut_before(uint32_t w, uint32_t k, uint32_t len)
{
    uint32_t at = w & 63u;
    if (k > at)
        return (w & ~(ENG_NOTE_WRAP | 63u << 6)) | (k - at - 1u) << 6;
    if (k)
        return eng_note_end_on(w, k - 1u, len);
    return (w & ~(ENG_NOTE_WRAP | 63u << 6)) | (len - at - 1u) << 6;
}
int eng_steps_hit_note(uint32_t module, uint32_t note, int accent, int record);
/* trig conditions (#674, format 60, D-830; track.ts StepNote.cond, noteWords): a note with a condition has chance code
 * ENG_NOTE_COND, and its condition word comes right after it: velocity 0, the note's start and note, the condition byte
 * (track.ts COND_*: bit 6 the inverse, bits 3..5 B - 1 and bits 0..2 A - 1 of A:B, else 1 FILL, 2 PRE, 3 NEI, 4 1ST) in
 * bits 6..11 (its low six bits) and 26 (bit 6). The tracks keep the words as the binary has them (eng_steps_notes too);
 * a word of velocity 0 is no note. FILL: the performer's (eng_fill, held or not). A note's condition (0 none) and setting
 * it (0: none; a note on `note` must start on step k; -1 when there is none or no room for the word) */
#define ENG_NOTE_COND 31u
#define ENG_COND_WORD(w, c) (((w) & 0x7F03Fu) | ((c) & 63u) << 6 | ((c) >> 6 & 1u) << 26)
#define ENG_COND_OF(x) ((((x) >> 6) & 63u) | (((x) >> 26) & 1u) << 6)
void eng_fill(int on);
int eng_fill_on(void);
uint32_t eng_steps_cond(uint32_t module, uint32_t k, uint32_t note);
int eng_steps_cond_set(uint32_t module, uint32_t k, uint32_t note, uint32_t cond);
/* ratchets and micro timing (#675, #677, format 63; track.ts StepNote.ratchet / micro, timeWord): a note with either is
 * followed by its timing word, after its condition word if it has one: velocity 0, the note's start and note, bit 31
 * (ENG_TIME_BIT, which a condition word never has), micro timing + 32 in bits 6..11 (MICRO_STEPS-ths of a step,
 * -MICRO_MAX..MICRO_MAX: negative early) and the ratchet - 1 in bits 26..28 (it plays 1..RATCHET_MAX times inside its
 * step). A note's timing word (0: none) and setting it (ratchet 1 and micro 0: none; -1 when there is no such note or no
 * room for the word) */
#define ENG_TIME_BIT 0x80000000u
#define ENG_IS_TIME(x) (!((x) & 127u << 19) && ((x) & ENG_TIME_BIT))
#define ENG_TIME_WORD(w, r, m) (((w) & 0x7F03Fu) | (uint32_t)((int32_t)(m) + 32) << 6 | ((uint32_t)(r) - 1u) << 26 | ENG_TIME_BIT)
#define ENG_TIME_RATCHET(x) ((((x) >> 26) & 7u) + 1u)
#define ENG_TIME_MICRO(x) ((int32_t)(((x) >> 6) & 63u) - 32)
uint32_t eng_steps_time(uint32_t module, uint32_t k, uint32_t note);
int eng_steps_time_set(uint32_t module, uint32_t k, uint32_t note, uint32_t ratchet, int32_t micro);

/* Install a patch from its binary form (web/src/patchbin.ts) into the selected voice. 0 on success, negative on error
 * (the voice is then silent). Resets all module state. Never call while eng_render runs (stop the audio ISR's call first). */
int eng_load(const uint8_t *p, uint32_t len);
/* Rewrite a binary of a format before ENG_COUNTED (ENG_PATCH_COMPAT_VERSION..) in place into counted records, as the editor
 * writes format 51 (patchbin.ts): every record gets its parameter count, and the parameters at the end of a record that
 * are at their defaults (on both morph sides) leave it (storedParams); the knob masks go, and the attenuverters and p1 /
 * p2 masks at their template; the morph B set keeps only the values off A, after the module mask. The cables stay 4
 * bytes, and the panel labels and row names stay as they are: the result is format ENG_UPGRADED, the last before
 * ENG_SLIM (D-299). It plays the same; eng_load reads the older binary the same way without it. Only a binary that fits
 * cap with every byte it gains (counts, presence bytes, bitmaps, the module mask) and none it loses is rewritten. *len
 * changes; 0 = done or already counted, -1 malformed or too big for cap (left as it was). */
#define ENG_UPGRADED (ENG_SLIM - 1)
int eng_upgrade(uint8_t *p, uint32_t *len, uint32_t cap);
/* Rewrite a binary of a format from ENG_SLIM (without a master FX bus before format 66: its flag bit 14 is the FX rack
 * since) in place as format ENG_WIDE, the empty side section after the cables (the editor writes the same patch so):
 * what an FM-1 edit needs for a pattern past ENG_NOTES_1_26 words or a link of pattern 1 (#1292). *len grows by 1, up to
 * cap; 0 = done or already ENG_WIDE, -1 older, with an FX bus, malformed or too big (left as it was). eng_can_wide: its
 * format allows it (ENG_WIDE already, or eng_widen's formats). eng_narrow: the other way, back to format v
 * (ENG_SLIM..ENG_WIDE - 1), when the side section is empty (else left as it is) */
int eng_widen(uint8_t *p, uint32_t *len, uint32_t cap);
static inline int eng_can_wide(const uint8_t *p)
{
    return p[1] >= ENG_WIDE || (p[1] >= ENG_SLIM && (p[1] >= 66u || !(p[7] & (ENG_FLAG_FX_BUS >> 8))));
}
/* a binary's format lets eng_rec_grow raise it for a parameter appended later: counted, without a master FX bus before
 * format 66 (one before ENG_SLIM takes SLIM's layout first) */
static inline int eng_can_raise(const uint8_t *p)
{
    return p[1] >= ENG_COUNTED && (p[1] >= 66u || !(p[7] & (ENG_FLAG_FX_BUS >> 8)));
}
void eng_narrow(uint8_t *p, uint32_t *len, uint32_t v);
/* A counted binary's (ENG_COUNTED) record of module `mod` holds at least `npar` parameters (at most its type's): the
 * missing ones go in at their defaults (and its morph B bitmap grows: their B is their A), so an edit of one can be
 * written in place. A parameter appended after the binary's format raises the binary to that format first
 * (eng_can_raise: one before ENG_SLIM takes SLIM's layout, then it is made ENG_WIDE, then the format byte: the
 * Harmonizer's `invkeys`, format 68, #1311; the FM-1 does not turn a row a binary cannot be raised for: pages_ui.c
 * row_old). *len grows (or shrinks: SLIM's layout), up to cap; 0 = done (or it held them), -1 malformed, not counted, a
 * master FX bus for an appended parameter, or too big for cap (left as it was). eng_narrow never narrows a binary raised
 * past ENG_WIDE. */
int eng_rec_grow(uint8_t *p, uint32_t *len, uint32_t cap, uint32_t mod, uint32_t npar);
/* Before parameter `par` of module `mod` (one its record holds: eng_rec_grow first) gets a new A value in a counted
 * binary with a morph B set: a module with a B side whose B set leaves that parameter out (its B is its A) gets its A
 * value as an explicit B value, so the B side stays where it was (D-1005). *len grows by 4 at most; 0 = done (or nothing
 * to do), -1 malformed or too big for cap (left as it was). */
int eng_b_keep(uint8_t *p, uint32_t *len, uint32_t cap, uint32_t mod, uint32_t par);
/* The attenuverters and p1 / p2 masks of module `mod` (a type with parameter inputs) written out whole in a counted
 * binary (presence byte ENG_PRES_ALL; the ones it left out at their template), so an edit can go in place: they start
 * at the returned offset, att1, att2, p1, p2. 0: malformed, no parameter inputs, or too big for cap (left as it was). */
uint32_t eng_rec_matrix(uint8_t *p, uint32_t *len, uint32_t cap, uint32_t mod);
void eng_set_param(uint32_t module, uint32_t param, int32_t q16);
/* a knob's click (K1..K4 = knob 0..3, or MIDI CC 16..19; #405), or a move of a learned MIDI control (knob ENG_KNOBS + its
 * ramp slot, #1067): the parameter takes the value at once, what the module uses reaches it over ENG_RAMP_BLOCKS blocks;
 * a choice parameter (defs.h pchoice) is set at once */
#define ENG_KNOBS 4u
#define ENG_MAP_RAMPS 4u             /* ramp slots of the learned MIDI controls (#1067): mapping i ramps in slot i % 4 (four
                                      * controls glide at once; a fifth moving with them takes a slot over) */
#define ENG_RAMPS (ENG_KNOBS + ENG_MAP_RAMPS)
#define ENG_RAMP_BLOCKS 8            /* 8 x 128 frames = 23 ms at ENG_SR (a power of two: the step is a shift) */
void eng_knob_param(uint32_t knob, uint32_t module, uint32_t param, int32_t q16);
uint32_t delay_div(int32_t time_q16);                               /* the note length (DELAY_DIV_*) a synced delay's time value selects */
int32_t eng_get_param(uint32_t module, uint32_t param);
int32_t eng_get_eff(uint32_t module, uint32_t param);               /* what the last block used: base + modulation */
void eng_set_att(uint32_t module, uint32_t input, int32_t q16);      /* attenuverter of p1 / p2, Q16 */
int32_t eng_att(uint32_t module, uint32_t input);
/* a macro range of input 0 / 1 (p1 / p2) on a parameter: the input's value lands between lo and hi (0..255 of the
 * parameter's range, octaves for a log one) instead of adding to the base; on 0 removes it, bit 1 of on reads the input's
 * -1..1 across the ends (bipolar, #526). 0 = no room / bad arguments */
int eng_set_range(uint32_t module, uint32_t input, uint32_t param, int on, uint32_t lo, uint32_t hi);
/* the range of input 0 / 1 on a parameter, 1 if there is one (lo / hi as above) */
int eng_range(uint32_t module, uint32_t input, uint32_t param, uint32_t *lo, uint32_t *hi);
/* the module whose cable sets a parameter (#1202 K1: a p1 / p2 input with a cable, the parameter in its matrix and a macro
 * range on it, which replaces the row's value), -1 none */
int eng_set_by(uint32_t module, uint32_t param);
void eng_set_bypass(uint32_t module, int on);                        /* bypass: the outputs carry the through input (defs.h thru) or silence; the state is kept */
int eng_bypass(uint32_t module);
/* the patch has a morph B set (the Main module's MORPH parameter fades every parameter from A to B) */
int eng_has_morph(void);
int eng_nmodules(void);
int eng_ncables(void);
void eng_cable(uint32_t i, uint32_t *from, uint32_t *from_port, uint32_t *to, uint32_t *to_port);   /* cable i of the patch */
int eng_type(uint32_t module);                                       /* defs.h T_*, -1 if no such module */
/* the value of a parameter after `clicks` knob clicks of `unit_per_click` (Q16 fraction of the range; octaves for the cutoff) */
int32_t eng_step_param(uint32_t module, uint32_t param, int32_t clicks, int32_t unit_per_click);
int32_t eng_step_value(uint32_t module, uint32_t param, int32_t v, int32_t clicks, int32_t unit_per_click);   /* as eng_step_param, from v (a P-lock's) */
int eng_param_is_log(uint32_t module, uint32_t param);
/* index of the first module of a type (defs.h T_*), -1 if the patch has none */
int eng_find(uint32_t type);
/* the parts of the patch's first poly group (1 without one: everything plays the shared keyboard), 0 if none is loaded */
int eng_parts(void);
int eng_groups(void);                                                /* the poly groups of the loaded patch */
uint32_t eng_format(void);                                           /* loaded binary format, 0 without a patch */
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
 * output pulses once per block that saw a tick while the transport runs. Arpeggiators step on the clock either way. On MIDI
 * clock the transport starts on a tick, tick 0, which steps nothing on: the host's first clock after its Start (#870).
 * eng_transport_top (MIDI Start): the transport from the top, running or not; a start while it runs is a block stopped and
 * a start, and the first MIDI tick after it is tick 0 even when MIDI clock does not drive the clock yet.
 * eng_transport_at (Song Position + Continue, #596): the same start, `ticks` clock ticks into the song: every Steps track
 * clocked by the transport takes its steps up to there without a sound, and the step on that tick (if one falls there)
 * is the start's; `wait`: up to 150 ms for a first MIDI tick when no MIDI clock drives yet (eng_transport_top waits) */
void eng_clock_tick(void);
void eng_clock_external(int on);
void eng_transport(int on);
void eng_transport_top(void);
void eng_transport_at(uint32_t ticks, int wait);
int eng_transport_running(void);
/* Play once (#632; engine.ts playOnce): the transport stops, one bar of the meter (eng_meter) is counted in on the clock with a click
 * on each beat (not in eng_render's output: eng_click_mix adds it, D-820), then the transport starts and each Steps track
 * the clock steps plays its pattern once, or the song's entries once each; a shorter track loops on until the longest
 * ends; then the transport stops by itself (its edges then come out of eng_clock_out as 2 / -2). eng_transport ends it where it is. eng_once_state: 0 not, 1 counting in,
 * 2 playing */
#define ENG_PLAY_ONCE
void eng_play_once(void);
int eng_once_state(void);
uint32_t eng_once_beat(void);          /* the count-in's beat, 0.. its beats a bar less one (0 until it counts) */
/* REC's count-in click (D-803; engine.ts countIn): a click on each beat of `bars` bars from the transport's start or, running
 * already at `at` (eng_ticks then), from the next bar line, as seq_ui.c counts them; 0 bars: none. A stop ends it */
#define ENG_COUNT_IN
void eng_count_in(uint32_t at, uint32_t bars);
/* the count-in's click (both count-ins) of the last eng_render, added to (left, right) of its length, each side held to
 * full scale; nonzero when any sounded. It keeps four clicks a render (a render of a block or a few, as the FM-1's). The analog output only: audio.c adds it after USB audio took the half (D-820) */
int eng_click_mix(int32_t *left, int32_t *right, uint32_t total);
/* the patch buttons (bit i = button i of ENG_PANEL_BUTTONS): held or switched on; the Main module's button outputs */
void eng_buttons(uint32_t mask);
/* what button b does (ENG_BTN_*), and a Toggle's modules (their count; *list points at their indices) */
uint32_t eng_button_kind(uint32_t b);
uint32_t eng_button_targets(uint32_t b, const uint8_t **list);
uint32_t eng_ticks(void);                 /* the clock's ticks so far (24 a quarter note) */
int32_t eng_run_ticks(void);              /* ticks since the transport started (the Steps tracks' bars count from there:
                                           * eng_bar_ticks a bar), -1 until the engine has taken the start */
int eng_clock_is_external(void);          /* MIDI clock drives the clock */
/* The palette's bar line (#1196, pal_fade.h), in run ticks (eng_run_ticks' scale). Read between renders: from the audio
 * interrupt, or once from the main loop to arm (a render in between moves them by its half, harmlessly).
 * eng_next_bar: the first bar line of the global time signature (eng_bar_ticks) at least lead_samples ahead of the next
 * render's first sample; -1 while the transport is stopped.
 * eng_samples_to: samples from the next render's first sample to the sample run_tick falls on; exact on the internal
 * clock at a steady tempo, estimated from the measured tick on MIDI clock; 0 once reached or passed, or stopped.
 * eng_tick_mark: the run tick eng_tick_fell reports (-1 none: the render then only tests the mark once a block).
 * eng_tick_fell: after a render, the sample of that whole render (0..n - 1, over its blocks) the marked run_tick fell
 * on; -1 when it did not fall in it or is not the one marked */
int32_t eng_next_bar(uint32_t lead_samples);
uint32_t eng_samples_to(int32_t run_tick);
void eng_tick_mark(int32_t run_tick);
int32_t eng_tick_fell(int32_t run_tick);
/* MIDI clock out (#473, main.c clock_out.h): the ticks of the tempo the last eng_render made (none while MIDI clock
 * drives the clock), up to `max` of their samples in it in *off, and the transport's edge in it in *edge (1 started,
 * -1 stopped, 0 none). A render that starts the transport has a tick on the start's sample: tick 0, where the tracks'
 * first steps sound, so a device that follows counts its steps from the same tick */
uint32_t eng_clock_out(uint32_t *off, uint32_t max, int32_t *edge);
/* The global tempo (GLO > PANEL > TEMPO, D-907; engine.ts tempoGlobal): with one set, every patch plays at it and a load
 * leaves it (Main's tempo parameter shows it; the patch's own value comes back with eng_tempo_global(0)). Main's tempo
 * set with eng_set_param moves it (a knob, PLAY held + PRESET, the editor's PARAM). MIDI clock overrides it as before.
 * bpm: 0 = each patch its own tempo, ENG_TEMPO_ADOPT = global, starting at the tempo of the patch running (or the next
 * one loaded), else 20..300 */
#define ENG_TEMPO_ADOPT 1u
void eng_tempo_global(uint32_t bpm);
uint32_t eng_tempo_global_get(void);      /* the global tempo (bpm), 0 while each patch has its own */
int eng_tempo_moved(void);                /* the global tempo moved by eng_set_param or by adopting a patch's since the last call */
int eng_tempo_row(uint32_t module, uint32_t param);   /* (module, param) is Main's tempo and the tempo is global: the patch's
                                                       * own value stays as it is (proto.c m1_patch_param) */
/* The global time signature (#1011, GLO > PANEL > TIME SIG; engine.ts meter; defs.h METER_*): meter m (0..METER_N - 1,
 * anything else METER_DEFAULT, 4/4, which plays until one is set). A bar of it is what play once and REC count in, with a
 * click on each of its beats, and what the Arpeggiator's bar rates fill. The tempo counts quarter notes in every meter */
#define ENG_METER
void eng_meter(uint32_t m);
uint32_t eng_meter_get(void);
uint32_t eng_bar_ticks(void);             /* a bar of the meter in clock ticks (24 a quarter note) */
uint32_t eng_beat_ticks(void);            /* a count-in click's ticks (METER_BEAT) */
uint32_t eng_buttons_get(void);
/* the patch buttons' LEDs (the FM-1, the EMU view): eng_buttons_get, but ARP as a Toggle of Arpeggiators is lit while
 * they play, not while they are bypassed (D-231; the editor: buttons.ts litWhileEnabled) */
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
/* the glue of the pattern store (#901, patlink.c): pattern p (1..) of a track gets its own length (0 the track's, else
 * 1..TRACK_STEPS) and rate (0xFF the track's, else a STEPS_RATES index), 0 done, -1 the track has not got it or out of
 * range; the track no longer has pattern p (1..): its notes go, it plays its pattern 1 there; n note words are all short
 * words (eng_patterns_record's rule, track.ts isShortNote) */
int eng_pattern_shape(uint32_t module, uint32_t p, uint32_t len, uint32_t rate);
void eng_pattern_drop(uint32_t module, uint32_t p);
int eng_notes_short(const uint32_t *w, uint32_t n);
void eng_song_set(uint32_t n);
int eng_song(void);                                  /* the song playing (0 none) */
int eng_song_entry(uint32_t module);                 /* the entry a track plays in the song, -1 none yet */
int eng_song_len(uint32_t s);                        /* song s's entries (0-based s) */
int eng_song_ticks(uint32_t module, uint32_t s, uint32_t k);   /* clock ticks from song s's top to its entry k on a track, -1 none */
int eng_song_get(uint32_t s, uint32_t k);            /* entry k: pattern | (shift & 0xFF) << 8, -1 none */
int eng_song_put(uint32_t s, uint32_t k, uint32_t pat, int32_t shift);   /* entry k set (k = its length: appended); 0 = done */
int eng_song_insert(uint32_t s, uint32_t k);         /* a copy of entry k before it; 0 = done */
int eng_song_delete(uint32_t s, uint32_t k);
/* the patterns and songs section as the engine has it now (patchbin.ts patternRecord), into out (cap bytes): its length,
 * 0 when there is nothing to write (pattern 1, no song, no patterns, no entries), -1 when it does not fit. The patterns
 * eng_patterns_omit names (bit p) are left out of it, of eng_notes_record (bit 0: pattern 1) and of eng_locks_record, as
 * if no track had them: the clean linked ones, whose content is the pattern store's (#901, #1292, proto.c
 * m1_patch_patterns). A load clears the mask. eng_notes_record: the notes section likewise (pattern 1 of each track
 * with notes, patchbin.ts). eng_notes_wide: a pattern written in either has more than ENG_NOTES_1_26 words (the binary
 * must be ENG_WIDE) */
int eng_patterns_record(uint8_t *out, uint32_t cap);
int eng_notes_record(uint8_t *out, uint32_t cap);
int eng_notes_wide(void);
void eng_patterns_omit(uint64_t mask);
/* P-locks (#524, format 49; track.ts StepLock, engine.ts locksStep): a lock on a step of a pattern sets a row of the
 * device its track plays (the parameters of its locked row, ENG_LOCK_PAIRS at most) in place of their normal values
 * while the track's playhead is on that step. ENG_PAT_LOCKS per pattern, ENG_MAX_LOCKS and ENG_LOCK_TARGETS rows per
 * patch (patchbin.ts DEVICE.locks, locks.ts). */
#define ENG_PAT_LOCKS 64
#define ENG_MAX_LOCKS 256
#define ENG_LOCK_TARGETS 32
#define ENG_LOCK_PAIRS 6
int eng_locks_count(void);                           /* the patch's locks, all tracks and patterns */
/* track `module`'s lock on step k of pattern p on module m's parameter j: 1 and its value in *v (Q16), 0 none */
int eng_lock_get(uint32_t module, uint32_t p, uint32_t k, uint32_t m, uint32_t j, int32_t *v);
/* the locks on step k of pattern p */
int eng_locks_step(uint32_t module, uint32_t p, uint32_t k);
/* that lock set to v (on) or removed; a new row also sets the further parameters `also` lists (a page row's extras as the
 * binary has them, ENG_ROW_MORE: u8 n, n (module, parameter); 0 none). 0 done, -1 no room (ENG_PAT_LOCKS, ENG_MAX_LOCKS,
 * ENG_LOCK_TARGETS) or not a lockable parameter */
int eng_lock_set(uint32_t module, uint32_t p, uint32_t k, uint32_t m, uint32_t j, const uint8_t *also, int32_t v, int on);
/* the pattern the SEQ page's locks go into: the one the track plays; one it has not got is made first, from its pattern 1
 * (its notes and its locks: track.ts, the editor's setLocks). -1 none */
int eng_locks_pattern(uint32_t module);
/* pattern p's locks, 7 bytes each into out (cap bytes): step, module, parameter, i32 LE value; their count, -1 no track.
 * eng_locks_clear: every track's locks of pattern p removed */
int eng_locks_list(uint32_t module, uint32_t p, uint8_t *out, uint32_t cap);
void eng_locks_clear(uint32_t p);
/* the P-locks section as the engine has it now (patchbin.ts lockRecord), into out (cap bytes): its length, 0 when there
 * are no locks, -1 when it does not fit */
int eng_locks_record(uint8_t *out, uint32_t cap);
/* arming and recording from the keys (#139): the armed Steps module (-1 none); live recording on a track; the notes it
 * recorded, one at a time (0: none); cursor entry's chord; a recorded note laid over the track */
void eng_arm(int module);
int eng_armed(void);
/* arm a set of modules (#191; engine.ts arm / arm.ts armView): while the mask is not 0 Main's keys go only to the key
 * listeners among them (a group's Part or cards, a Drum map, an Arpeggiator, a Steps track, cabled from Main or not for a
 * track) and to nothing else (not the shared keyboard); empty: the cables decide. eng_arm(module) is the one-track form. */
void eng_arm_mask(eng_mset_t mask);
eng_mset_t eng_arm_mask_get(void);
/* what arming module m arms (#395; arm.ts armedWith), as a mask: m itself when it hears Main's keys armed (a Steps track,
 * a Part or card of a group that takes the keys, a Drum map on the keys, an Arpeggiator); when its keys come through a
 * key source (a group's or a Drum map's Arpeggiator or track), that source, and the track an Arpeggiator plays; none: empty */
eng_mset_t eng_arms(uint32_t m);
/* module m hears Main's keys now (the armed set's, else by its cables): a Steps track, an Arpeggiator or a Drum map on the
 * keys, a member of a group the keys play; 0 not (the environment marks the devices the cables reach WIRED, #582) */
int eng_hears_keys(uint32_t m);
/* the Drum map Main's keys reach (the armed set's, else the ones cabled), when they reach one and nothing that plays them as
 * notes (a group, the shared keyboard, an Arpeggiator, a track into no Drum map): the first of them; -1 none. And the rows
 * of every Drum map they reach as one list, as eng_steps_rows: the panel's black keys 1..8 play a bank of 8 of them
 * (panel.c panel_key); 0 none */
int eng_keys_drummap(void);
uint32_t eng_keys_rows(uint8_t *map, uint8_t *row);
/* the Harmonizer Main's keys reach (#598; one that hears them, is not bypassed and plays a group): the panel's seven lowest
 * keys are its chord buttons then (panel.c panel_key, the Side layout); -1 none */
int eng_keys_harm(void);
/* chord button b (0..6: sus2 maj sus4 min 7 dim 9, the seven keys from F3 at OCT 0) of the Harmonizers that hear Main's keys
 * pressed or let go (engine.ts chordButton) */
void eng_chord_button(uint32_t b, int down);
/* off: the notes eng_note_on / eng_note_off take next are roots for the Harmonizers whatever their note (the panel's root
 * keys, which an octave shift may move under a split); on (the default): the seven keys under a split are its buttons */
void eng_harm_zone(int on);
/* the chord Harmonizer module m plays now, by name (at most 20 characters: MIN9B5 ADD2 ADD4; "" the root alone) */
void eng_harm_name(uint32_t m, char *out);
#define ENG_HARM 1
void eng_steps_rec(uint32_t module, int on);
/* a note into a track's keys in, armed or not (engine.ts thru; the SEQ page's black keys on a drum track, #368): it sounds
 * through the track until let go (vel 0), and a track recording live (eng_steps_rec) records it as a played note */
void eng_steps_thru(uint32_t module, uint32_t note, uint32_t vel);
#define ENG_STEPS_THRU 1
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

/* Cable-order cursor entry. The caller provides room for eight pitches. */
int eng_steps_harm(uint32_t track);
uint32_t eng_steps_input_notes(uint32_t track, uint32_t root, uint8_t *out);

void eng_steps_chord_button(uint32_t track, uint32_t b, int down);
