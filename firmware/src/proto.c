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
 *   static void m1_live(void);                                  LIVE: the editor drives the FM-1 (PRESET and program change wait)
 * and calls m1_handle() with every received frame (the bytes between F0 and F7). */
#include "engine.h"
#include "defs.h"

#define M1_PATCH_MAX 3840u                                   /* a bank slot is one 4 KB sector: 256 B of header, the patch */
#define M1_VERSION 1

enum { C_HELLO = 0x01, C_CHUNK = 0x10, C_COMMIT = 0x11, C_STORE = 0x12, C_PARAM = 0x20, C_ATT = 0x21, C_BYPASS = 0x22, C_RANGE = 0x23, C_TRANSPORT = 0x25, C_MUTE = 0x27, C_FOCUS = 0x29, C_TRACK = 0x2A, C_DIAG = 0x2B, C_LIVE = 0x2C, C_SLOT = 0x13, C_SLOT_ERASE = 0x14, C_SLOT_INFO = 0x15, R_ACK = 0x40, R_INFO = 0x41, R_SLOT = 0x42, R_SLOT_NOW = 0x43, R_MUTE = 0x45, R_PARAM_NOW = 0x47, R_FOCUS_NOW = 0x48, R_TRACK = 0x49, R_DIAG = 0x4B };
#define M1_FEATURES 118u                                     /* INFO byte 5: bit 1 = the TRANSPORT command, bit 2 = MUTE, bit 4 = FOCUS / PARAM_NOW / FOCUS_NOW, bit 5 = TRACK / TRACK_NOW, bit 6 = LIVE (bit 0 ARP, bit 3 STEPVAL and STEP are retired) */
#define M1_SLOTS 64u                                         /* the bank (slotstore.c) */
#define M1_NAME 20u
enum { S_OK, S_RANGE, S_CRC, S_LOAD, S_FLASH, S_CMD, S_NONE };

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
        at += 1u + 4u * d->npar + (d->cvbase >= 0 ? 20u : 0u) + d->ndata;
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
    if (!at || par >= DEFS[M1_TYPE(m1_cur[at])].npar)
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
    m1_put32(at + 1u + 4u * DEFS[M1_TYPE(m1_cur[at])].npar + 4u * input, v);
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
    at += 1u + 4u * d->npar + (d->cvbase >= 0 ? 20u : 0u);
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
static void m1_arm_now(int mod) { (void)mod; }

/* unasked: a track's notes after an edit on the panel (the editor follows): module, n, n u32 LE */
static void m1_track_now(uint32_t mod)
{
    static uint8_t p[2u + 4u * TRACK_NOTES_MAX], f[8u + (8u * sizeof p + 6u) / 7u];
    const uint32_t *w;
    int n = eng_steps_notes(mod, &w), i;
    uint32_t o = 0;
    if (n < 0)
        return;
    p[0] = (uint8_t)mod;
    p[1] = (uint8_t)n;
    for (i = 0; i < n; i++) {
        p[2 + 4 * i] = (uint8_t)w[i];
        p[3 + 4 * i] = (uint8_t)(w[i] >> 8);
        p[4 + 4 * i] = (uint8_t)(w[i] >> 16);
        p[5 + 4 * i] = (uint8_t)(w[i] >> 24);
    }
    f[o++] = 0xF0;
    f[o++] = 0x7D;
    f[o++] = 0x4D;
    f[o++] = 0x31;
    f[o++] = R_TRACK;
    o += m1_pack7(p, 2u + 4u * (uint32_t)n, f + o);
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
    uint32_t at = eng_records_at(p, len), i, nmod, ncab, npar = 0;
    if (!at || p[0] != 0xA1 || (p[1] > ENG_PATCH_VERSION || p[1] < ENG_PATCH_COMPAT_VERSION) || p[3] > POLY_MAX_GROUPS)
        return 0;
    if ((p[7] & ~ENG_FLAG_EXTRAS) || (p[1] < 34u && p[7]) || (p[1] < 33u && (p[6] & 128u)) || (p[1] < 17u && (p[6] & 4u)) || (p[1] < 18u && (p[6] & 8u)) || (p[1] < 27u && (p[6] & 16u)) || (p[1] < 30u && (p[6] & 64u)))
        return 0;
    nmod = p[2];
    ncab = (uint32_t)p[4] | (uint32_t)p[5] << 8;
    if (nmod > ENG_MAX_MODULES || ncab > ENG_MAX_CABLES)
        return 0;
    for (i = 0; i < nmod; i++) {
        const def_t *d;
        if (at >= len || M1_TYPE(p[at]) >= N_TYPES)
            return 0;
        d = &DEFS[M1_TYPE(p[at])];
        at += 1u + 4u * d->npar + (d->cvbase >= 0 ? 20u : 0u) + d->ndata;
        npar += d->npar;
    }
    at += 4u * ncab + ((p[6] & 1u) ? 4u * npar : 0u);           /* flag bit 0: the morph B set after the cables */
    if (p[6] & 4u) at += nmod;                              /* switched fixed-input links, before ranges */
    if (p[6] & 8u) {
        if (at >= len) return 0;
        at += 1u + 4u * p[at];
    }
    if ((p[6] & 16u) && !(at = eng_notes_end(p, len, at)))      /* flag bit 4: the tracks' notes */
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
    uint32_t at = eng_records_at(m1_cur, m1_cur_len), i, nmod, ncab, npar = 0;
    if (!at)
        return 0;
    nmod = m1_cur[2];
    ncab = (uint32_t)m1_cur[4] | (uint32_t)m1_cur[5] << 8;
    for (i = 0; i < nmod; i++) {
        const def_t *d;
        if (at >= m1_cur_len || M1_TYPE(m1_cur[at]) >= N_TYPES)
            return 0;
        d = &DEFS[M1_TYPE(m1_cur[at])];
        at += 1u + 4u * d->npar + (d->cvbase >= 0 ? 20u : 0u) + d->ndata;
        npar += d->npar;
    }
    at += 4u * ncab + ((m1_cur[6] & 1u) ? 4u * npar : 0u);
    if (m1_cur[6] & 4u) at += nmod;
    if (m1_cur[6] & 8u) {
        if (at >= m1_cur_len) return 0;
        at += 1u + 4u * m1_cur[at];
    }
    return at <= m1_cur_len ? at : 0;
}

/* the offset of the device pages section (its count byte) in the current patch, 0 if the patch has none */
static uint32_t m1_devices_at(void)
{
    uint32_t at;
    if (!(m1_cur[6] & 32u) || !(at = m1_notes_at()))
        return 0;
    if ((m1_cur[6] & 16u) && !(at = eng_notes_end(m1_cur, m1_cur_len, at)))
        return 0;
    return at < m1_cur_len ? at : 0;
}

/* the offset of the macro range section (its count byte) in the current patch, 0 if the patch has none */
static uint32_t m1_range_section(void)
{
    uint32_t at;
    if (!(m1_cur[6] & 2u) || !(at = m1_notes_at()))
        return 0;
    if ((m1_cur[6] & 16u) && !(at = eng_notes_end(m1_cur, m1_cur_len, at)))
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

/* a preset was stored on the FM-1 (#194): the editor hears of it (#195; nothing yet) */
static void m1_preset_stored(uint32_t structure, const char *name)
{
    (void)structure;
    (void)name;
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
static void m1_patch_track(uint32_t mod)
{
    const uint32_t *w;
    int n = eng_steps_notes(mod, &w), i;
    uint32_t sec, at, cnt, old = 0, len, has = m1_cur[6] & 16u;
    if (n < 0 || !m1_track_at(mod) || !(sec = m1_notes_at()) || (has && !eng_notes_end(m1_cur, m1_cur_len, sec)))
        return;
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
    case C_HELLO: {
        uint8_t p[6];
        p[0] = M1_VERSION;
        p[1] = ENG_MAX_MODULES;
        p[2] = ENG_MAX_CABLES;
        p[3] = (uint8_t)((m1_flash_ok() ? 1u : 0u) | (m1_cur_len ? 2u : 0u));
        p[4] = ENG_NDELAY;                                   /* delay lines (shared by the voices) */
        p[5] = M1_FEATURES;
        m1_reply(R_INFO, p, 6);
        break;
    }
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
    case C_TRACK:                                            /* module u8, n u8, n u32 LE notes (track.ts noteWord) */
        if (len >= 2u && len >= 2u + 4u * d[1]) {
            uint32_t w[TRACK_NOTES_MAX], i, n = d[1] < TRACK_NOTES_MAX ? d[1] : TRACK_NOTES_MAX;
            for (i = 0; i < n; i++)
                w[i] = (uint32_t)d[2 + 4 * i] | (uint32_t)d[3 + 4 * i] << 8 | (uint32_t)d[4 + 4 * i] << 16 | (uint32_t)d[5 + 4 * i] << 24;
            if (eng_steps_set_notes(d[0], w, n))
                m1_patch_track(d[0]);
            m1_ui_changed();
        }
        break;
    case C_FOCUS:                                            /* device u8, page u8: show that device page */
        if (len >= 2u)
            m1_focus(d[0], d[1]);
        break;
    case C_LIVE:                                             /* no payload, every 2 s while the editor's Live is on: no reply */
        m1_live();
        break;
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
