/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* SysEx protocol of the editor (web/src/protocol.ts documents the wire format): patch upload in chunks, commit,
 * store to flash, live parameter changes. Self-contained: the includer provides
 *   static int  m1_apply(const uint8_t *patch, uint32_t len);   switch the engine to a patch, 0 = ok, else eng_load's error
 *   static int  m1_store(const uint8_t *patch, uint32_t len);   write it to flash, 0 = ok
 *   static int  m1_flash_ok(void);
 *   static void m1_send(const uint8_t *f, uint32_t n);          a full F0 .. F7 message to the host
 *   static int  m1_slot_write(uint32_t slot, const char *name, const uint8_t *p, uint32_t len);   preset bank: 0 = ok
 *   static int  m1_slot_erase(uint32_t slot);
 *   static int  m1_slot_info(uint32_t slot, char *name, uint32_t *len);                          1 = the slot holds a preset
 *   static uint32_t m1_diag(uint32_t page, uint8_t *out);       DIAG: up to 32 bytes of page n of the diagnostics, 0 = past the end
 *   static void m1_ui_rows(void);                               a live parameter changed: the page's rows need a redraw
 *   static void m1_live(uint32_t paused);                       LIVE: the editor drives the FM-1 (PRESET and program change wait);
 *                                                               paused: its patch is over the budget, so not here (#200)
 *   static uint32_t m1_presets(uint32_t k, uint32_t *structure, char *name, uint32_t *n);   the FM-1's user presets (#195): how
 *                                                               many; with k below that, preset k's structure, name (17 bytes), value count
 *   static int  m1_preset_get(uint32_t structure, const char *name, int32_t *vals, uint32_t *n);   0 = found
 *   static int  m1_preset_put(uint32_t structure, const char *name, const int32_t *vals, uint32_t n);   0 = ok, -2 full, else flash
 *   static int  m1_preset_del(uint32_t structure, const char *name);   0 = ok, -1 none
 *   static void m1_sandbox(const sb_page_t *s);                 SANDBOX: the editor's page while its patch is a sandbox patch
 *   static int  m1_midi_out(void);                              MENU > MIDI OUT is on (INFO says so, with feature bit 8)
 *   static int  m1_test_key(uint32_t id, int down);             the device test mode (#291): a panel key held / let go as if
 *                                                               by a hand (ids as the HAL's: 0..13 buttons, 14..40 the keys); 0 = ok
 *   static int  m1_test_turn(uint32_t enc, int32_t clicks);     an encoder turned (0 SELECT, 1 ALGO, 2..5 K1..K4, 6 PRESET); 0 = ok
 *   static uint32_t m1_test_screen(uint32_t k, uint8_t *out);   the screen as text: k 0xFF its head (count, page, flags), else
 *                                                               text k (x, y, w, h, n, n characters); the bytes written, 0 = none
 *   static uint32_t m1_test_peak(void);                         the output's peak (16 bit, before MASTER) since the last call, bit
 *                                                               16 the engine runs, 17 the sound is muted (sandbox mode), 18 MASTER
 *                                                               is all the way down
 * and calls m1_handle() with every received frame (the bytes between F0 and F7). */
#include "engine.h"
#include "defs.h"
#include "sandbox_msg.h"

#define M1_PATCH_MAX 3840u                                   /* a bank slot is one 4 KB sector: 256 B of header, the patch */
#define M1_VERSION 1

enum { C_HELLO = 0x01, C_CHUNK = 0x10, C_COMMIT = 0x11, C_STORE = 0x12, C_PARAM = 0x20, C_ATT = 0x21, C_BYPASS = 0x22, C_RANGE = 0x23, C_TRANSPORT = 0x25, C_MUTE = 0x27, C_FOCUS = 0x29, C_TRACK = 0x2A, C_DIAG = 0x2B, C_LIVE = 0x2C, C_PRESETS = 0x2D, C_PRESET_GET = 0x2E, C_PRESET_PUT = 0x2F, C_PRESET_DEL = 0x30, C_SANDBOX = 0x31, C_TEST_KEY = 0x32, C_TEST_TURN = 0x33, C_TEST_SCREEN = 0x34, C_TEST_PEAK = 0x35, C_PATTERN = 0x36, C_SONG = 0x37, C_SLOT = 0x13, C_SLOT_ERASE = 0x14, C_SLOT_INFO = 0x15, R_ACK = 0x40, R_INFO = 0x41, R_SLOT = 0x42, R_SLOT_NOW = 0x43, R_MUTE = 0x45, R_PARAM_NOW = 0x47, R_FOCUS_NOW = 0x48, R_TRACK = 0x49, R_DIAG = 0x4B, R_PRESET = 0x4C, R_PRESET_DATA = 0x4D, R_PRESET_STORED = 0x4E, R_SCREEN = 0x50, R_PEAK = 0x51, R_PATTERN_NOW = 0x52, R_SONG_NOW = 0x53 };
#define M1_FEATURES 246u                                     /* INFO byte 5: bit 1 = the TRANSPORT command, bit 2 = MUTE, bit 4 = FOCUS / PARAM_NOW / FOCUS_NOW, bit 5 = TRACK / TRACK_NOW, bit 6 = LIVE, bit 7 = the presets (#195) (bit 0 ARP, bit 3 STEPVAL and STEP are retired) */
#define M1_FEATURES2 255u                                     /* INFO byte 6, feature bits 8..15: bit 8 = sandbox mode (LIVE paused mutes the FM-1, SANDBOX, the MIDI OUT flag), bit 9 = the device test mode (TEST_KEY, TEST_TURN, TEST_SCREEN, TEST_PEAK; #291), bit 10 = TEST_PEAK reads before MASTER and flags MASTER down, bit 11 = reads format 35, bit 12 = reads format 36, bit 13 = reads format 37, bit 14 = reads format 38, bit 15 = reads format 39 (legacy editor compatibility; INFO bytes 7..8 report the readable range) */
#define M1_INFO_MIDI_OUT 4u                                  /* INFO byte 3 (flags) bit 2: MENU > MIDI OUT is on (with feature bit 8) */
#define M1_PNAME 16u                                         /* a preset's name (presetstore.c PS_NAME) */
#define M1_PVALS 88u                                         /* a preset's values at most (presetstore.c PS_MAXV) */
#define M1_SLOTS 64u                                         /* the bank (slotstore.c) */
#define M1_NAME 20u
enum { S_OK, S_RANGE, S_CRC, S_LOAD, S_FLASH, S_CMD, S_NONE, S_FULL, S_MISSING };

static uint8_t m1_up[M1_PATCH_MAX] ENG_POOL, m1_cur[M1_PATCH_MAX] ENG_POOL;     /* the patch as it runs (parameter edits included) */
static uint32_t m1_up_got, m1_up_total, m1_cur_len;

static uint16_t m1_crc16(const uint8_t *d, uint32_t n)       /* CRC-16/CCITT-FALSE */
{
    uint32_t c = 0xFFFFu, i, k;
    for (i = 0; i < n; i++) {
        c ^= (uint32_t)d[i] << 8;
        for (k = 0; k < 8; k++)
            c = c & 0x8000u ? ((c << 1) ^ 0x1021u) & 0xFFFFu : (c << 1) & 0xFFFFu;
    }
    return (uint16_t)c;
}

static uint32_t m1_unpack7(const uint8_t *in, uint32_t n, uint8_t *out, uint32_t max)
{
    uint32_t acc = 0, nb = 0, o = 0;
    while (n--) {
        acc |= (uint32_t)(*in++ & 0x7Fu) << nb;
        nb += 7u;
        if (nb >= 8u) {
            if (o < max)
                out[o] = (uint8_t)acc;
            o++;
            acc >>= 8;
            nb -= 8u;
        }
    }
    return o;
}

static uint32_t m1_pack7(const uint8_t *in, uint32_t n, uint8_t *out)
{
    uint32_t acc = 0, nb = 0, o = 0;
    while (n--) {
        acc |= (uint32_t)*in++ << nb;
        nb += 8u;
        while (nb >= 7u) {
            out[o++] = (uint8_t)(acc & 0x7Fu);
            acc >>= 7;
            nb -= 7u;
        }
    }
    if (nb)
        out[o++] = (uint8_t)(acc & 0x7Fu);
    return o;
}

static void m1_reply(uint32_t cmd, const uint8_t *payload, uint32_t n)
{
    uint8_t f[48];
    uint32_t w = 0;
    f[w++] = 0xF0;
    f[w++] = 0x7D;
    f[w++] = 0x4D;
    f[w++] = 0x31;
    f[w++] = (uint8_t)cmd;
    w += m1_pack7(payload, n, f + w);
    f[w++] = 0xF7;
    m1_send(f, w);
}

/* unasked: the slot the FM-1 plays now and its name (a patch from the panel, program change or boot; the editor shows it) */
static void m1_slot_now(uint32_t slot, const char *name)
{
    uint8_t p[1u + M1_NAME];
    uint32_t i;
    p[0] = (uint8_t)slot;
    for (i = 0; i < M1_NAME; i++)
        p[1u + i] = name && name[i] && (!i || p[i]) ? (uint8_t)name[i] : 0u;
    m1_reply(R_SLOT_NOW, p, sizeof p);
}

/* INFO: the answer to HELLO, and unasked when MENU > MIDI OUT changed under the editor's Live (live.c) */
static void m1_info(void)
{
    uint8_t p[9];
    p[0] = M1_VERSION;
    p[1] = ENG_MAX_MODULES;
    p[2] = ENG_MAX_CABLES;
    p[3] = (uint8_t)((m1_flash_ok() ? 1u : 0u) | (m1_cur_len ? 2u : 0u) | (m1_midi_out() ? M1_INFO_MIDI_OUT : 0u));
    p[4] = ENG_NDELAY;                                       /* delay lines (shared by the voices) */
    p[5] = M1_FEATURES;
    p[6] = M1_FEATURES2;
    p[7] = ENG_PATCH_COMPAT_VERSION;
    p[8] = ENG_PATCH_VERSION;
    m1_reply(R_INFO, p, 9);
}

static void m1_ack(uint32_t cmd, uint32_t seq, uint32_t status, uint32_t aux)
{
    uint8_t p[4];
    p[0] = (uint8_t)cmd;
    p[1] = (uint8_t)seq;
    p[2] = (uint8_t)status;
    p[3] = (uint8_t)aux;
    m1_reply(R_ACK, p, 4);
}

/* a patch the firmware already runs (boot: from flash or a factory patch): what STORE writes and PARAM edits */
static uint32_t m1_gen;                                     /* counts patches set as current: the LCD reads the device pages again */
static uint8_t m1_edited;                                    /* the running patch differs from what was loaded (SAVE clears it; the LCD shows *) */

static void m1_set_current(const uint8_t *p, uint32_t len)
{
    uint32_t i;
    if (len > M1_PATCH_MAX)
        return;
    for (i = 0; i < len; i++)
        m1_cur[i] = p[i];
    m1_cur_len = len;
    (void)eng_upgrade(m1_cur, &m1_cur_len, M1_PATCH_MAX);   /* an older format's patch in today's (SAVE keeps edits of the
                                                         * parameters added since); one that would not fit stays as it is */
    m1_edited = 0;
    m1_gen++;
}

#define M1_BYPASS 0x80u                                     /* bit 7 of a record's type byte: the module is bypassed */
#define M1_TYPE(b) ((b) & 0x7Fu)

/* byte offset of module `mod`'s record in the patch binary, 0 if the binary is malformed */
static uint32_t m1_record(uint32_t mod)
{
    uint32_t at = eng_records_at(m1_cur, m1_cur_len), i;
    if (!at || mod >= m1_cur[2])
        return 0;
    for (i = 0; i < mod; i++) {
        const def_t *d;
        if (at >= m1_cur_len || M1_TYPE(m1_cur[at]) >= N_TYPES)
            return 0;
        d = &DEFS[M1_TYPE(m1_cur[at])];
        at += eng_record_size(d, m1_cur[1]);
    }
    return at < m1_cur_len && M1_TYPE(m1_cur[at]) < N_TYPES ? at : 0;
}

static void m1_put32(uint32_t at, int32_t v)
{
    m1_cur[at] = (uint8_t)v;
    m1_cur[at + 1] = (uint8_t)((uint32_t)v >> 8);
    m1_cur[at + 2] = (uint8_t)((uint32_t)v >> 16);
    m1_cur[at + 3] = (uint8_t)((uint32_t)v >> 24);
}

/* the stored copy follows live edits: write the value into the binary patch */
static void m1_patch_param(uint32_t mod, uint32_t par, int32_t v)
{
    uint32_t at = m1_record(mod);
    if (!at || par >= eng_npar(&DEFS[M1_TYPE(m1_cur[at])], m1_cur[1]))   /* (an older format's record without it: m1_set_current
                                                                         * upgrades the binary, unless it would not fit) */
        return;
    m1_put32(at + 1u + 4u * par, v);
    m1_edited = 1;
}

/* the panel section of the running patch (engine.h eng_panel_at), 0 without one */
static const uint8_t *m1_panel(void)
{
    uint32_t at = eng_panel_at(m1_cur, m1_cur_len);
    return at ? m1_cur + at : 0;
}

/* the switched-on buttons into the running patch (SAVE keeps them) */
static void m1_panel_on(uint32_t mask)
{
    uint32_t at = eng_panel_at(m1_cur, m1_cur_len);
    if (!at)
        return;
    m1_cur[at + 2u] = (uint8_t)mask;
    m1_cur[at + 3u] = (uint8_t)(mask >> 8);
    m1_edited = 1;
}

static void m1_patch_att(uint32_t mod, uint32_t input, int32_t v)
{
    uint32_t at = m1_record(mod);
    if (!at || input >= 2u || DEFS[M1_TYPE(m1_cur[at])].cvbase < 0)
        return;
    m1_put32(at + 1u + 4u * eng_npar(&DEFS[M1_TYPE(m1_cur[at])], m1_cur[1]) + 4u * input, v);
    m1_edited = 1;
}

/* where a Steps module's name starts in the running binary, 0 if `mod` is not one */
static uint32_t m1_track_at(uint32_t mod)
{
    uint32_t at = m1_record(mod);
    const def_t *d;
    if (!at || M1_TYPE(m1_cur[at]) != T_STEPS)
        return 0;
    d = &DEFS[T_STEPS];
    at += eng_record_size(d, m1_cur[1]) - d->ndata;
    return at + TRACK_NAME_MAX <= m1_cur_len ? at : 0;
}

/* a Steps module's name as the LCD shows it (TRACK_NAME_MAX + 1 bytes, 0-terminated; empty without one) */
static void m1_track_name(uint32_t mod, char *out)
{
    uint32_t at = m1_track_at(mod), i;
    for (i = 0; i < TRACK_NAME_MAX; i++)
        out[i] = at && m1_cur[at + i] >= 32u && m1_cur[at + i] < 127u && (!i || out[i - 1]) ? (char)m1_cur[at + i] : 0;
    out[TRACK_NAME_MAX] = 0;
}

/* row r's name of a Drum map in the running patch (the #139 follow-up), 0 when it has none */
static int m1_drum_name(uint32_t map, uint32_t r, char *out) { return eng_drum_name(m1_cur, m1_cur_len, map, r, out); }

static void m1_patch_track(uint32_t mod);

/* a step edit (the SEQ page's step view, eng_steps_set) / a step's note and velocity into the running engine and the
 * binary (SAVE keeps them) */
static void m1_patch_step(uint32_t mod, uint32_t k, uint32_t b)
{
    eng_steps_set(mod, k, b);
    m1_patch_track(mod);
}
static void m1_patch_stepval(uint32_t mod, uint32_t k, uint32_t note, uint32_t vel)
{
    eng_steps_value_set(mod, k, note, vel);
    m1_patch_track(mod);
}
/* a track's notes changed in the engine (#139: step entry's chord, a live take): into the running binary */
static void m1_patch_notes(uint32_t mod) { m1_patch_track(mod); }
/* a track armed or disarmed on the panel (#139): the editor is not told (the FM-1 tab's emulator is) */
static void m1_arms_now(uint32_t lo, uint32_t hi) { (void)lo; (void)hi; }   /* (the device tells no one of its arming: #139, #191) */

/* unasked: a track's notes after an edit on the panel (the editor follows): module, n, n u32 LE */
static void m1_track_now(uint32_t mod)
{
    static uint8_t f[8u + (8u * (3u + 4u * TRACK_NOTES_MAX) + 6u) / 7u];
    const uint32_t *w;
    int n = eng_steps_notes(mod, &w);
    uint32_t o = 0, k, len, acc = 0, nb = 0;
    if (n < 0)
        return;
    f[o++] = 0xF0;
    f[o++] = 0x7D;
    f[o++] = 0x4D;
    f[o++] = 0x31;
    f[o++] = R_TRACK;
    len = 3u + 4u * (uint32_t)n;
    for (k = 0; k < len; k++) {   /* m1_pack7 of the payload, a byte at a time from the engine's words (no 514 B copy); last
                                   * the pattern they are (format 48: the one the track plays) */
        uint32_t b = k == 0u ? mod & 255u : k == 1u ? (uint32_t)n & 255u : k == len - 1u ? (uint32_t)eng_pattern_playing(mod) & 255u : (w[(k - 2u) >> 2] >> (8u * ((k - 2u) & 3u))) & 255u;
        acc |= b << nb;
        nb += 8u;
        while (nb >= 7u) {
            f[o++] = (uint8_t)(acc & 0x7Fu);
            acc >>= 7;
            nb -= 7u;
        }
    }
    if (nb)
        f[o++] = (uint8_t)(acc & 0x7Fu);
    f[o++] = 0xF7;
    m1_send(f, o);
}
/* a parameter turned on the FM-1 (K1..K4 on a device page): module, parameter, the value Q16.16 */
static void m1_param_now(uint32_t mod, uint32_t par, int32_t v)
{
    uint8_t p[6];
    p[0] = (uint8_t)mod;
    p[1] = (uint8_t)par;
    p[2] = (uint8_t)v;
    p[3] = (uint8_t)((uint32_t)v >> 8);
    p[4] = (uint8_t)((uint32_t)v >> 16);
    p[5] = (uint8_t)((uint32_t)v >> 24);
    m1_reply(R_PARAM_NOW, p, 6);
}
/* the device page the FM-1 shows now (indices into the device pages section) */
static void m1_focus_now(uint32_t dev, uint32_t pg)
{
    uint8_t p[2];
    p[0] = (uint8_t)dev;
    p[1] = (uint8_t)pg;
    m1_reply(R_FOCUS_NOW, p, 2);
}
static void m1_mute_now(uint32_t mod, int on)
{
    uint8_t p[2];
    p[0] = (uint8_t)mod;
    p[1] = (uint8_t)(on != 0);
    m1_reply(R_MUTE, p, 2);
}

static void m1_patch_bypass(uint32_t mod, int on)
{
    uint32_t at = m1_record(mod);
    if (!at)
        return;
    m1_cur[at] = (uint8_t)(on ? m1_cur[at] | M1_BYPASS : m1_cur[at] & ~M1_BYPASS);
    m1_edited = 1;
}

/* a patch binary that eng_load would at least not reject for its framing: header, record sizes add up to the length */
static int m1_valid(const uint8_t *p, uint32_t len)
{
    uint32_t at = eng_records_at(p, len);
    if (!at || p[0] != 0xA1 || (p[1] > ENG_PATCH_VERSION || p[1] < ENG_PATCH_COMPAT_VERSION) || p[3] > POLY_MAX_GROUPS)
        return 0;
    if ((p[7] & ~(ENG_FLAG_EXTRAS | ENG_FLAG_MORPH_MODULES | ENG_FLAG_PATTERNS)) || ((p[7] & ENG_FLAG_MORPH_MODULES) && (p[1] < 36u || !(p[6] & 1u))) || ((p[7] & ENG_FLAG_PATTERNS) && p[1] < 48u) || (p[1] < 34u && p[7]) || (p[1] < 33u && (p[6] & 128u)) || (p[1] < 17u && (p[6] & 4u)) || (p[1] < 18u && (p[6] & 8u)) || (p[1] < 27u && (p[6] & 16u)) || (p[1] < 30u && (p[6] & 64u)))
        return 0;
    if (p[2] > ENG_MAX_MODULES || ((uint32_t)p[4] | (uint32_t)p[5] << 8) > ENG_MAX_CABLES)
        return 0;
    for (uint32_t g = 0; g < p[3]; g++)
        if (!eng_group_valid(p + 8u + ENG_GROUP_REC * g, p[1])) return 0;
    if (!(at = eng_cables_end(p, len)))                         /* the records (in the binary's format), cables, morph B set */
        return 0;
    if (p[6] & 4u) at += p[2];                              /* switched fixed-input links, before ranges */
    if ((p[6] & 8u) && !(at = eng_routes_end(p, len, at)))
        return 0;
    if (!(at = eng_steps_end(p, len, at)))      /* flag bit 4: the tracks' notes; flag bit 10: the patterns and songs */
        return 0;
    if ((p[6] & 32u) && !(at = eng_devices_end(p, len, at)))    /* flag bit 5: the device pages */
        return 0;
    if ((p[7] & ENG_FLAG_EXTRAS) && !(at = eng_extras_end(p, len, at)))   /* flag bit 8: the device extras */
        return 0;
    if ((p[6] & 64u) && !(at = eng_buttons_end(p, len, at)))    /* flag bit 6: the button kinds */
        return 0;
    if ((p[6] & 128u) && !(at = eng_names_end(p, len, at)))     /* flag bit 7: the Drum maps' row names */
        return 0;
    if (p[6] & 2u) {                                            /* flag bit 1: the macro ranges after that */
        if (at >= len)
            return 0;
        at += 1u + 5u * p[at];
    }
    return at == len;
}

/* the offset in the current patch where the notes section starts (or would start: after the side-input routes), 0 if
 * the binary is malformed */
static uint32_t m1_notes_at(void)
{
    uint32_t at = m1_cur_len >= 8u ? eng_cables_end(m1_cur, m1_cur_len) : 0;
    if (!at)
        return 0;
    if (m1_cur[6] & 4u) at += m1_cur[2];
    if ((m1_cur[6] & 8u) && !(at = eng_routes_end(m1_cur, m1_cur_len, at)))
        return 0;
    return at <= m1_cur_len ? at : 0;
}

/* the offset of the device pages section (its count byte) in the current patch, 0 if the patch has none */
static uint32_t m1_devices_at(void)
{
    uint32_t at;
    if (!(m1_cur[6] & 32u) || !(at = m1_notes_at()))
        return 0;
    if (!(at = eng_steps_end(m1_cur, m1_cur_len, at)))
        return 0;
    return at < m1_cur_len ? at : 0;
}

/* the offset of the macro range section (its count byte) in the current patch, 0 if the patch has none */
static uint32_t m1_range_section(void)
{
    uint32_t at;
    if (!(m1_cur[6] & 2u) || !(at = m1_notes_at()))
        return 0;
    if (!(at = eng_steps_end(m1_cur, m1_cur_len, at)))
        return 0;
    if ((m1_cur[6] & 32u) && !(at = eng_devices_end(m1_cur, m1_cur_len, at)))   /* the device pages come before the ranges */
        return 0;
    if ((m1_cur[7] & ENG_FLAG_EXTRAS) && !(at = eng_extras_end(m1_cur, m1_cur_len, at)))   /* then the device extras */
        return 0;
    if ((m1_cur[6] & 64u) && !(at = eng_buttons_end(m1_cur, m1_cur_len, at)))   /* then the button kinds */
        return 0;
    if ((m1_cur[6] & 128u) && !(at = eng_names_end(m1_cur, m1_cur_len, at)))    /* then the Drum maps' row names */
        return 0;
    return at < m1_cur_len ? at : 0;
}

/* `old` bytes at `at` of the current patch become `len` bytes (to be written): what follows moves */
static void m1_splice(uint32_t at, uint32_t old, uint32_t len)
{
    uint32_t j;
    if (len > old)
        for (j = m1_cur_len; j-- > at + old;)
            m1_cur[j + len - old] = m1_cur[j];
    else if (len < old)
        for (j = at + old; j < m1_cur_len; j++)
            m1_cur[j - (old - len)] = m1_cur[j];
    m1_cur_len = m1_cur_len + len - old;
}

static uint32_t m1_presets(uint32_t k, uint32_t *structure, char *name, uint32_t *n);
static int m1_preset_get(uint32_t structure, const char *name, int32_t *vals, uint32_t *n);
static int m1_preset_put(uint32_t structure, const char *name, const int32_t *vals, uint32_t n);
static int m1_preset_del(uint32_t structure, const char *name);

/* a preset's key in a frame: u32 LE structure, M1_PNAME name bytes (zero padded) */
static void m1_pkey(uint8_t *p, uint32_t structure, const char *name)
{
    uint32_t i, end = 0;
    p[0] = (uint8_t)structure;
    p[1] = (uint8_t)(structure >> 8);
    p[2] = (uint8_t)(structure >> 16);
    p[3] = (uint8_t)(structure >> 24);
    for (i = 0; i < M1_PNAME; i++) {
        end |= !name[i];
        p[4u + i] = end ? 0u : (uint8_t)name[i];
    }
}
static uint32_t m1_pkey_get(const uint8_t *d, char *name)
{
    uint32_t i;
    for (i = 0; i < M1_PNAME; i++)
        name[i] = (char)d[4u + i];
    name[M1_PNAME] = 0;
    return (uint32_t)d[0] | (uint32_t)d[1] << 8 | (uint32_t)d[2] << 16 | (uint32_t)d[3] << 24;
}

/* a long frame to the host (a preset's values) */
static void m1_reply_long(uint32_t cmd, const uint8_t *payload, uint32_t n)
{
    static uint8_t f[8u + (8u * (21u + 4u * M1_PVALS) + 6u) / 7u];
    uint32_t w = 0;
    f[w++] = 0xF0;
    f[w++] = 0x7D;
    f[w++] = 0x4D;
    f[w++] = 0x31;
    f[w++] = (uint8_t)cmd;
    w += m1_pack7(payload, n, f + w);
    f[w++] = 0xF7;
    m1_send(f, w);
}

/* a preset was stored on the FM-1 (#194): the editor hears of it (#195: PRESET_STORED, unasked) */
static void m1_preset_stored(uint32_t structure, const char *name)
{
    uint8_t p[4u + M1_PNAME];
    m1_pkey(p, structure, name);
    m1_reply(R_PRESET_STORED, p, sizeof p);
}

/* the name of the preset device `dev` (the device pages section's index) was set to, into its device extras (format 34,
 * #194: SAVE keeps it); what follows moves. 0 = done, -1 the patch has no extras or would outgrow M1_PATCH_MAX */
static int m1_preset_name(uint32_t dev, const char *name)
{
    uint32_t at = m1_devices_at(), k, cnt, n = 0, old;
    if (!at || !(m1_cur[7] & ENG_FLAG_EXTRAS) || !(at = eng_devices_end(m1_cur, m1_cur_len, at)) || !eng_extras_end(m1_cur, m1_cur_len, at))
        return -1;
    cnt = m1_cur[at++];
    if (dev >= cnt)
        return -1;
    for (k = 0; k < dev; k++) {
        at += 6u + m1_cur[at + 5u];
        at += 1u + 2u * m1_cur[at];
        at += 1u + m1_cur[at];
    }
    while (name[n] && n < 12u)                      /* (the editor's NAME_MAX) */
        n++;
    old = m1_cur[at + 5u];
    if (m1_cur_len + n > M1_PATCH_MAX + old)
        return -1;
    m1_splice(at + 6u, old, n);
    m1_cur[at + 5u] = (uint8_t)n;
    for (k = 0; k < n; k++)
        m1_cur[at + 6u + k] = (uint8_t)name[k];
    m1_edited = 1;
    return 0;
}

/* a track's notes as the engine has them into the binary (SAVE keeps them): its entry in the notes section replaced,
 * added in module order or removed; the section created or dropped; what follows (device pages, button kinds, macro
 * ranges) moves. A patch that would outgrow M1_PATCH_MAX keeps its old entry. */
static void m1_patch_patterns(void);
static void m1_patch_track(uint32_t mod)
{
    const uint32_t *w;
    int n = eng_pattern_notes(mod, 0, &w), i;
    uint32_t sec, at, cnt, old = 0, len, has = m1_cur[6] & 16u;
    if (n < 0 || !m1_track_at(mod) || !(sec = m1_notes_at()) || (has && !eng_notes_end(m1_cur, m1_cur_len, sec)))
        return;
    m1_patch_patterns();                             /* (the pattern edited may be any: both sections follow the engine) */
    cnt = has ? m1_cur[sec] : 0u;
    at = has ? sec + 1u : sec;
    for (i = 0; i < (int)cnt; i++) {                 /* the entry, or where it goes */
        if (m1_cur[at] >= mod) {
            if (m1_cur[at] == mod)
                old = 2u + 4u * m1_cur[at + 1u];
            break;
        }
        at += 2u + 4u * m1_cur[at + 1u];
    }
    len = n ? 2u + 4u * (uint32_t)n : 0u;
    if (!has && !n)
        return;
    if (m1_cur_len + (has ? 0u : 1u) + len - old > M1_PATCH_MAX)
        return;
    if (!has) {
        m1_splice(sec, 0, 1u);
        m1_cur[sec] = 0;
        m1_cur[6] |= 16u;
        at = sec + 1u;
    }
    m1_splice(at, old, len);
    if (n) {
        m1_cur[at] = (uint8_t)mod;
        m1_cur[at + 1u] = (uint8_t)n;
        for (i = 0; i < n; i++)
            m1_put32(at + 2u + 4u * (uint32_t)i, (int32_t)w[i]);
    }
    cnt = cnt - (old ? 1u : 0u) + (n ? 1u : 0u);
    m1_cur[sec] = (uint8_t)cnt;
    if (!cnt) {                                      /* the section is empty: it goes */
        m1_splice(sec, 1u, 0);
        m1_cur[6] &= (uint8_t)~16u;
    }
    m1_edited = 1;
}

/* the patterns and songs as the engine has them into the binary (format 48, SAVE keeps them): the section replaced, made or
 * dropped, what follows moves. A patch of an older format (one too big to upgrade) or one that would outgrow M1_PATCH_MAX
 * keeps its old section. */
static void m1_patch_patterns(void)
{
    uint32_t sec = m1_notes_at(), old = 0;
    int n;
    if (!sec || m1_cur[1] < 48u)
        return;
    if ((m1_cur[6] & 16u) && !(sec = eng_notes_end(m1_cur, m1_cur_len, sec)))
        return;
    if ((m1_cur[7] & ENG_FLAG_PATTERNS) && !(old = eng_patterns_end(m1_cur, m1_cur_len, sec)))
        return;
    old = old ? old - sec : 0u;
    n = eng_patterns_record(0, 0);
    if (n < 0 || (!n && !old) || m1_cur_len - old + (uint32_t)n > M1_PATCH_MAX)
        return;
    m1_splice(sec, old, (uint32_t)n);
    (void)eng_patterns_record(m1_cur + sec, (uint32_t)n);
    m1_cur[7] = (uint8_t)(n ? m1_cur[7] | ENG_FLAG_PATTERNS : m1_cur[7] & ~ENG_FLAG_PATTERNS);
    m1_edited = 1;
}

/* unasked: the patch's pattern and song as the FM-1 chose them (PRESET on the SEQ page, the SONG page; the editor follows) */
static void m1_pattern_now(void)
{
    uint8_t p[2];
    p[0] = (uint8_t)eng_pattern();
    p[1] = (uint8_t)eng_song();
    m1_reply(R_PATTERN_NOW, p, 2);
}
/* unasked: song s's entries after an edit on the SONG page: s, n, n (pattern, shift) */
static void m1_song_now(uint32_t s)
{
    static uint8_t p[2u + 2u * ENG_SONG_LEN];
    static uint8_t f[8u + (8u * sizeof p + 6u) / 7u];
    uint32_t n = (uint32_t)eng_song_len(s), k, w = 0;
    p[0] = (uint8_t)s;
    p[1] = (uint8_t)n;
    for (k = 0; k < n; k++) {
        int e = eng_song_get(s, k);
        p[2u + 2u * k] = (uint8_t)e;
        p[3u + 2u * k] = (uint8_t)(e >> 8);
    }
    f[w++] = 0xF0;
    f[w++] = 0x7D;
    f[w++] = 0x4D;
    f[w++] = 0x31;
    f[w++] = R_SONG_NOW;
    w += m1_pack7(p, 2u + 2u * n, f + w);
    f[w++] = 0xF7;
    m1_send(f, w);
}

/* the stored copy follows a macro range edit: update, append or remove the entry (the section is last in the binary) */
static void m1_patch_range(uint32_t mod, uint32_t pin, uint32_t par, int on, uint32_t lo, uint32_t hi)
{
    uint32_t sec = m1_range_section(), i, n, at;
    if (!sec) {
        if (!on || m1_cur_len + 6u > M1_PATCH_MAX || m1_cur_len < 8u)
            return;
        sec = m1_cur_len;
        m1_cur[6] |= 2u;
        m1_cur[sec] = 0;
        m1_cur_len = sec + 1u;
    }
    n = m1_cur[sec];
    for (i = 0, at = sec + 1u; i < n; i++, at += 5)
        if (m1_cur[at] == mod && m1_cur[at + 1] == pin && m1_cur[at + 2] == par)
            break;
    if (i < n && !on) {                                         /* remove: the last entry moves into its place */
        uint32_t last = sec + 1u + 5u * (n - 1u), k;
        for (k = 0; k < 5u; k++)
            m1_cur[at + k] = m1_cur[last + k];
        m1_cur[sec] = (uint8_t)(n - 1u);
        m1_cur_len = last;
        if (n == 1u) {                                          /* the section is empty: drop it */
            m1_cur[6] &= (uint8_t)~2u;
            m1_cur_len = sec;
        }
        return;
    }
    if (!on)
        return;
    if (i == n) {
        if (m1_cur_len + 5u > M1_PATCH_MAX || n >= 255u)
            return;
        m1_cur[sec] = (uint8_t)(n + 1u);
        m1_cur_len += 5u;
    }
    m1_cur[at] = (uint8_t)mod;
    m1_cur[at + 1] = (uint8_t)pin;
    m1_cur[at + 2] = (uint8_t)par;
    m1_cur[at + 3] = (uint8_t)lo;
    m1_cur[at + 4] = (uint8_t)hi;
}

/* f: the bytes between F0 and F7. Returns 1 if the frame was ours (and is consumed). */
static int m1_handle(const uint8_t *f, uint32_t n)
{
    uint8_t d[2u + 4u * TRACK_NOTES_MAX + 8u];         /* (the largest frame: TRACK) */
    uint32_t len;
    if (n < 4u || f[0] != 0x7D || f[1] != 0x4D || f[2] != 0x31)
        return 0;
    len = m1_unpack7(f + 4, n - 4u, d, sizeof d);
    if (len > sizeof d)
        return 1;                                            /* more than any of our frames carries */
    switch (f[3]) {
    case C_HELLO:
        m1_info();
        break;
    case C_DIAG: {                                           /* bring-up diagnostics (main.c m1_diag): [page, bytes] */
        uint8_t p[33];
        p[0] = len ? d[0] : 0u;
        m1_reply(R_DIAG, p, 1u + m1_diag(p[0], p + 1));
        break;
    }
    case C_CHUNK: {
        uint32_t seq, off, total, data, i;
        if (len < 5u) {
            m1_ack(C_CHUNK, 0, S_RANGE, 0);
            break;
        }
        seq = d[0];
        off = (uint32_t)d[1] | (uint32_t)d[2] << 8;
        total = (uint32_t)d[3] | (uint32_t)d[4] << 8;
        data = len - 5u;
        if (total == 0u || total > M1_PATCH_MAX || off + data > total) {
            m1_ack(C_CHUNK, seq, S_RANGE, 0);
            break;
        }
        if (off == 0u) {                                     /* a new upload */
            m1_up_got = 0;
            m1_up_total = total;
        }
        if (total != m1_up_total || off > m1_up_got) {       /* a chunk was lost: the host resends from m1_up_got */
            m1_ack(C_CHUNK, seq, S_RANGE, 0);
            break;
        }
        for (i = 0; i < data; i++)                           /* (a repeated chunk overwrites the same bytes) */
            m1_up[off + i] = d[5 + i];
        if (off + data > m1_up_got)
            m1_up_got = off + data;
        m1_ack(C_CHUNK, seq, S_OK, 0);
        break;
    }
    case C_COMMIT: {
        uint32_t total, crc;
        int rc;
        if (len < 4u) {
            m1_ack(C_COMMIT, 0, S_RANGE, 0);
            break;
        }
        total = (uint32_t)d[0] | (uint32_t)d[1] << 8;
        crc = (uint32_t)d[2] | (uint32_t)d[3] << 8;
        if (total != m1_up_total || total != m1_up_got || total < 8u) {
            m1_ack(C_COMMIT, 0, S_RANGE, 0);
            break;
        }
        if (m1_crc16(m1_up, total) != crc) {
            m1_ack(C_COMMIT, 0, S_CRC, 0);
            break;
        }
        rc = m1_apply(m1_up, total);
        if (rc) {                                            /* refused: back to the patch that ran before */
            if (m1_cur_len)
                (void)m1_apply(m1_cur, m1_cur_len);
            m1_ack(C_COMMIT, 0, S_LOAD, (uint32_t)-rc);
            break;
        }
        m1_set_current(m1_up, total);
        m1_up_got = m1_up_total = 0;
        m1_ack(C_COMMIT, 0, S_OK, 0);
        break;
    }
    case C_STORE:
        if (!m1_cur_len)
            m1_ack(C_STORE, 0, S_NONE, 0);
        else
            m1_ack(C_STORE, 0, m1_store(m1_cur, m1_cur_len) ? S_FLASH : S_OK, 0);
        break;
    case C_PARAM:
        if (len >= 6u) {
            int32_t v = (int32_t)((uint32_t)d[2] | (uint32_t)d[3] << 8 | (uint32_t)d[4] << 16 | (uint32_t)d[5] << 24);
            eng_set_param(d[0], d[1], v);
            m1_patch_param(d[0], d[1], v);
            m1_ui_rows();                                    /* the LCD shows the value the editor set */
        }
        break;
    case C_SLOT: {                                           /* the uploaded patch into preset slot n, without loading it */
        uint32_t slot, total, crc, i;
        char name[M1_NAME + 1];
        if (len < 1u + M1_NAME + 4u) {
            m1_ack(C_SLOT, 0, S_RANGE, 0);
            break;
        }
        slot = d[0];
        for (i = 0; i < M1_NAME; i++)
            name[i] = (char)(d[1 + i] >= 32u && d[1 + i] < 127u ? d[1 + i] : 0);
        name[M1_NAME] = 0;
        total = (uint32_t)d[1 + M1_NAME] | (uint32_t)d[2 + M1_NAME] << 8;
        crc = (uint32_t)d[3 + M1_NAME] | (uint32_t)d[4 + M1_NAME] << 8;
        if (slot >= M1_SLOTS || total != m1_up_total || total != m1_up_got || total < 8u) {
            m1_ack(C_SLOT, slot, S_RANGE, 0);
            break;
        }
        if (m1_crc16(m1_up, total) != crc) {
            m1_ack(C_SLOT, slot, S_CRC, 0);
            break;
        }
        if (!m1_valid(m1_up, total)) {
            m1_ack(C_SLOT, slot, S_LOAD, 0);
            break;
        }
        m1_ack(C_SLOT, slot, m1_slot_write(slot, name, m1_up, total) ? S_FLASH : S_OK, 0);
        m1_up_got = m1_up_total = 0;
        break;
    }
    case C_SLOT_ERASE:
        if (len < 1u || d[0] >= M1_SLOTS)
            m1_ack(C_SLOT_ERASE, 0, S_RANGE, 0);
        else
            m1_ack(C_SLOT_ERASE, d[0], m1_slot_erase(d[0]) ? S_FLASH : S_OK, 0);
        break;
    case C_SLOT_INFO: {
        uint8_t r[4 + M1_NAME];
        char name[M1_NAME + 1];
        uint32_t n = 0, i, ok;
        if (len < 1u || d[0] >= M1_SLOTS) {
            m1_ack(C_SLOT_INFO, 0, S_RANGE, 0);
            break;
        }
        for (i = 0; i <= M1_NAME; i++)
            name[i] = 0;
        ok = (uint32_t)m1_slot_info(d[0], name, &n);
        r[0] = d[0];
        r[1] = (uint8_t)ok;
        r[2] = (uint8_t)n;
        r[3] = (uint8_t)(n >> 8);
        for (i = 0; i < M1_NAME; i++)
            r[4 + i] = (uint8_t)name[i];
        m1_reply(R_SLOT, r, sizeof r);
        break;
    }
    case C_ATT:
        if (len >= 6u) {
            int32_t v = (int32_t)((uint32_t)d[2] | (uint32_t)d[3] << 8 | (uint32_t)d[4] << 16 | (uint32_t)d[5] << 24);
            eng_set_att(d[0], d[1], v);
            m1_patch_att(d[0], d[1], v);
        }
        break;
    case C_TRANSPORT:                                        /* the transport (PLAY): run u8 */
        if (len >= 1u)
            m1_transport(d[0] != 0u);
        break;
    case C_RANGE:
        if (len >= 6u) {
            if (eng_set_range(d[0], d[1], d[2], d[3] != 0, d[4], d[5]))
                m1_patch_range(d[0], d[1], d[2], d[3] != 0, d[4], d[5]);
            m1_ui_changed();
        }
        break;
    case C_TRACK:                                            /* module u8, n u8, n u32 LE notes (track.ts noteWord), [pattern u8
                                                              * (format 48; without it: the one the track plays)] */
        if (len >= 2u && len >= 2u + 4u * d[1]) {
            uint32_t w[TRACK_NOTES_MAX], i, n = d[1] < TRACK_NOTES_MAX ? d[1] : TRACK_NOTES_MAX;
            int pat = len >= 3u + 4u * d[1] ? d[2u + 4u * d[1]] : eng_pattern_playing(d[0]);
            for (i = 0; i < n; i++)
                w[i] = (uint32_t)d[2 + 4 * i] | (uint32_t)d[3 + 4 * i] << 8 | (uint32_t)d[4 + 4 * i] << 16 | (uint32_t)d[5 + 4 * i] << 24;
            if (pat >= 0 && eng_pattern_set_notes(d[0], (uint32_t)pat, w, n))
                m1_patch_track(d[0]);
            m1_ui_changed();
        }
        break;
    case C_PATTERN:                                          /* pattern u8 (0-based), song u8 (0 none): as PRESET / the SONG
                                                              * page choose them (each track from the end of its pass) */
        if (len >= 2u && d[0] < ENG_PATTERNS && d[1] <= ENG_SONGS) {
            if ((int)d[0] != eng_pattern())
                eng_pattern_set(d[0]);
            if ((int)d[1] != eng_song())
                eng_song_set(d[1]);
            m1_patch_patterns();
            m1_ui_changed();
        }
        break;
    case C_SONG:                                             /* song u8 (0-based), n u8, n (pattern u8, shift i8): its entries */
        if (len >= 2u && d[0] < ENG_SONGS && d[1] <= ENG_SONG_LEN && len >= 2u + 2u * d[1]) {
            uint32_t k;
            while (eng_song_len(d[0]) > 0)
                (void)eng_song_delete(d[0], 0);
            for (k = 0; k < d[1]; k++)
                (void)eng_song_put(d[0], k, d[2u + 2u * k] < ENG_PATTERNS ? d[2u + 2u * k] : 0u, (int8_t)d[3u + 2u * k]);
            m1_patch_patterns();
            m1_ui_changed();
        }
        break;
    case C_FOCUS:                                            /* device u8, page u8: show that device page */
        if (len >= 2u)
            m1_focus(d[0], d[1]);
        break;
    case C_PRESETS: {                                        /* #195: one PRESET frame per user preset (one with count 0: none) */
        uint8_t p[2u + 4u + M1_PNAME + 1u];
        char name[M1_PNAME + 1u];
        uint32_t cnt = m1_presets(0xFFFFFFFFu, 0, 0, 0), k, st, nv;
        for (k = 0; k == 0u || k < cnt; k++) {
            p[0] = (uint8_t)k;
            p[1] = (uint8_t)cnt;
            if (cnt && m1_presets(k, &st, name, &nv) > k) {
                m1_pkey(p + 2, st, name);
                p[2u + 4u + M1_PNAME] = (uint8_t)nv;
            } else {
                uint32_t i;
                for (i = 2; i < sizeof p; i++)
                    p[i] = 0;
            }
            m1_reply(R_PRESET, p, sizeof p);
        }
        break;
    }
    case C_PRESET_GET: {                                     /* #195: structure, name -> PRESET_DATA (count 0xFF: none) */
        static uint8_t p[4u + M1_PNAME + 1u + 4u * M1_PVALS];
        static int32_t v[M1_PVALS];
        char name[M1_PNAME + 1u];
        uint32_t st, nv = 0, i;
        if (len < 4u + M1_PNAME)
            break;
        st = m1_pkey_get(d, name);
        m1_pkey(p, st, name);
        if (m1_preset_get(st, name, v, &nv) || nv > M1_PVALS) {
            p[4u + M1_PNAME] = 0xFF;
            m1_reply_long(R_PRESET_DATA, p, 4u + M1_PNAME + 1u);
            break;
        }
        p[4u + M1_PNAME] = (uint8_t)nv;
        for (i = 0; i < nv; i++) {
            uint32_t x = (uint32_t)v[i];
            p[5u + M1_PNAME + 4u * i] = (uint8_t)x;
            p[6u + M1_PNAME + 4u * i] = (uint8_t)(x >> 8);
            p[7u + M1_PNAME + 4u * i] = (uint8_t)(x >> 16);
            p[8u + M1_PNAME + 4u * i] = (uint8_t)(x >> 24);
        }
        m1_reply_long(R_PRESET_DATA, p, 5u + M1_PNAME + 4u * nv);
        break;
    }
    case C_PRESET_PUT: {                                     /* #195: structure, name, n, n i32 values -> ACK */
        static int32_t v[M1_PVALS];
        char name[M1_PNAME + 1u];
        uint32_t st, nv, i;
        int rc;
        if (len < 5u + M1_PNAME || (nv = d[4u + M1_PNAME]) > M1_PVALS || len < 5u + M1_PNAME + 4u * nv) {
            m1_ack(C_PRESET_PUT, 0, S_RANGE, 0);
            break;
        }
        st = m1_pkey_get(d, name);
        for (i = 0; i < nv; i++)
            v[i] = (int32_t)((uint32_t)d[5u + M1_PNAME + 4u * i] | (uint32_t)d[6u + M1_PNAME + 4u * i] << 8 | (uint32_t)d[7u + M1_PNAME + 4u * i] << 16 | (uint32_t)d[8u + M1_PNAME + 4u * i] << 24);
        rc = name[0] ? m1_preset_put(st, name, v, nv) : -3;
        m1_ack(C_PRESET_PUT, 0, rc == 0 ? S_OK : rc == -2 ? S_FULL : rc == -3 ? S_RANGE : S_FLASH, 0);
        break;
    }
    case C_PRESET_DEL: {                                     /* #195: structure, name -> ACK */
        char name[M1_PNAME + 1u];
        if (len < 4u + M1_PNAME) {
            m1_ack(C_PRESET_DEL, 0, S_RANGE, 0);
            break;
        }
        m1_ack(C_PRESET_DEL, 0, m1_preset_del(m1_pkey_get(d, name), name) ? S_MISSING : S_OK, 0);
        break;
    }
    case C_LIVE:                                             /* every 2 s while the editor's Live is on: no reply; [paused u8] (#200) */
        m1_live(len >= 1u ? d[0] : 0u);
        break;
    case C_SANDBOX: {                                        /* the editor's page in sandbox mode (sandbox_msg.h): no reply */
        static sb_page_t s;
        if (!sb_parse(d, len, &s))
            m1_sandbox(&s);
        break;
    }
    case C_TEST_KEY:                                         /* #291: id u8, down u8 -> ACK */
        m1_ack(C_TEST_KEY, len >= 1u ? d[0] : 0u, len >= 2u && !m1_test_key(d[0], d[1] != 0u) ? S_OK : S_RANGE, 0);
        break;
    case C_TEST_TURN:                                        /* #291: encoder u8, clicks i8 -> ACK */
        m1_ack(C_TEST_TURN, len >= 1u ? d[0] : 0u, len >= 2u && !m1_test_turn(d[0], (int8_t)d[1]) ? S_OK : S_RANGE, 0);
        break;
    case C_TEST_SCREEN: {                                    /* #291: SCREEN 0xFF (count, page, flags), then one SCREEN per text */
        uint8_t p[1u + 6u + 32u];
        uint32_t n, k, cnt;
        p[0] = 0xFF;
        n = m1_test_screen(0xFFu, p + 1);
        m1_reply_long(R_SCREEN, p, 1u + n);
        cnt = n ? p[1] : 0u;
        for (k = 0; k < cnt; k++) {
            p[0] = (uint8_t)k;
            n = m1_test_screen(k, p + 1);
            m1_reply_long(R_SCREEN, p, 1u + n);
        }
        break;
    }
    case C_TEST_PEAK: {                                      /* #291: -> PEAK peak u16, flags u8 */
        uint32_t v = m1_test_peak();
        uint8_t p[3];
        p[0] = (uint8_t)v;
        p[1] = (uint8_t)(v >> 8);
        p[2] = (uint8_t)(v >> 16);
        m1_reply(R_PEAK, p, 3);
        break;
    }
    case C_MUTE:                                             /* module u8, on u8: not saved */
        if (len >= 2u) {
            eng_steps_mute(d[0], d[1] != 0u);
            m1_ui_changed();
        }
        break;
    case C_BYPASS:
        if (len >= 2u) {
            eng_set_bypass(d[0], d[1]);
            m1_patch_bypass(d[0], d[1]);
            m1_ui_changed();
        }
        break;
    default:
        m1_ack(f[3], 0, S_CMD, 0);
        break;
    }
    return 1;
}
