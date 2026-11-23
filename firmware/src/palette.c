/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The palette on the device (#1196): switching to an entry at the next bar line, saving the running sound to a
 * position, and the link's PALETTE command. Included by main.c after preset_load and m1_store; the record is
 * pal_store.h's, the fade at the bar audio.c's (pal_fade.h), the presets written into the slot's bytes pages_ui.c's
 * (pal_presets_into), the overview and the gestures pal_ui.c's and panel.c's.
 *
 * A switch is prepared in bank_buf before the bar line, while the old sound plays: the slot, the entry's presets
 * written into its bytes and its pattern selected (the song off). The audio interrupt fades the old sound out so that
 * it ends on the bar's sample and stops the engine there; pal_switch_poll then loads the prepared patch (the gap is
 * eng_load's time) and the new sound fades in over one half. Stopped, it switches at once after a 5 ms fade. */
#include "pal_store.h"

#define PAL_LEAD_SAMPLES (20u * ENG_SR / 1000u)  /* a bar line at least this far ahead (the fade plus margin) */
#define PAL_DRAW_HOLD 2646u                      /* the redraw waits while the stop is due within 60 ms */

static uint32_t pal_buf_len;                     /* the prepared patch in bank_buf: its length, slot and name */
static uint8_t pal_buf_slot;
static char pal_buf_name[M1_NAME + 1];
static char pal_live_name[PAL_NAME + 1];         /* PALETTE NAME: the editor's name for the patch it sent under Live */
static uint8_t pal_defer, pal_now_due;           /* a link command answers first: PALETTE_NOW after its ACK */

static int32_t pal_last_rt = -1;                 /* the last switch: the run tick at its load (-1: stopped), the bar's */
static uint32_t pal_last_bar, pal_switches;      /* ticks then, switches since power-on (DIAG page 202) */

/* DIAG page 202 (main.c m1_diag): the last switch's run tick at the load (a bar line's when it waited for one), the bar's
 * ticks then, the switches since power-on: three u32 LE (tools/m1_link.py, the scenarios check a switch lands on a bar) */
static uint32_t pal_diag(uint8_t *out)
{
    uint32_t w[3] = { (uint32_t)pal_last_rt, pal_last_bar, pal_switches }, i;
    for (i = 0; i < 12u; i++)
        out[i] = (uint8_t)(w[i / 4u] >> (8u * (i % 4u)));
    return 12;
}
static int pal_slot_name(uint32_t slot, char *name, uint32_t *len)
{
    sl_hdr_t h;
    uint32_t i;
    if (!slot_used(slot) || sl_head(slot, &h, 0))
        return -1;
    for (i = 0; i < PAL_NAME; i++)
        name[i] = h.name[i];
    name[PAL_NAME] = 0;
    *len = h.len;
    return 0;
}

/* PALETTE_NOW's payload (6 + 8 x 27 bytes) */
static uint32_t pal_now_payload(uint8_t *p)
{
    uint32_t i, k, w = 6;
    uint16_t seq = pal_side == PAL_NONE ? 0u : pal_seq;
    p[0] = 1;
    p[1] = pal_cur;
    p[2] = pal_next;
    p[3] = (uint8_t)(m1_edited != 0);
    p[4] = (uint8_t)seq;
    p[5] = (uint8_t)(seq >> 8);
    for (i = 0; i < PAL_N; i++) {
        const pal_ix_t *x = &pal_ix[i];
        p[w++] = x->state;
        p[w++] = x->slot;
        p[w++] = x->pattern;
        p[w++] = (uint8_t)x->hash;
        p[w++] = (uint8_t)(x->hash >> 8);
        p[w++] = (uint8_t)x->len;
        p[w++] = (uint8_t)(x->len >> 8);
        for (k = 0; k < PAL_NAME; k++)
            p[w++] = (uint8_t)x->name[k];
    }
    return w;
}
/* PALETTE_NOW, once the editor asked since its HELLO (an older editor never gets it unasked) */
static void pal_now_send(void)
{
    uint8_t p[6u + PAL_N * 27u];
    pal_now_due = 0;
    if (m1_pal_asked)
        m1_reply_long(R_PALETTE_NOW, p, pal_now_payload(p));
}
/* the palette's state changed: the overview, the bar and the editor */
static void pal_changed(void)
{
    pal_ui_changed();
    if (pal_defer)
        pal_now_due = 1;
    else
        pal_now_send();
}
/* the bank changed (SLOT, SLOT_ERASE, SAVE, factory placement): the MISSING states again */
static void pal_bank_changed(void)
{
    if (pal_check())
        pal_changed();
}

/* a waiting switch dropped: the old sound comes back up (it was never unloaded) */
static int pal_unwait(void)
{
    if (pal_next == PAL_NONE)
        return 0;
    pal_fade_cancel();
    pal_next = PAL_NONE;
    return 1;
}
/* another patch change (program change, PRESET, an editor upload, FACTORY RESET): bank_buf is theirs now, and no entry
 * plays */
static void pal_cancel(void)
{
    int ch = pal_unwait();
    if (pal_cur != PAL_NONE) {
        pal_cur = PAL_NONE;
        ch = 1;
    }
    if (ch)
        pal_changed();
}

/* the patterns section's selected pattern and the song (format 48): the entry's pattern, no song. A binary without the
 * section plays pattern 1 (pattern 0-based 0) */
static void pal_pattern_into(uint8_t *p, uint32_t len, uint32_t pattern)
{
    uint32_t at;
    if (len < 8u || p[1] < 48u || !(p[7] & ENG_FLAG_PATTERNS) || !(at = eng_section_at(p, len, ENG_SEC_PATTERNS)) ||
        at + 2u > len || pattern >= ENG_PATTERNS)
        return;
    p[at] = (uint8_t)pattern;
    p[at + 1u] = 0;
}

/* position pos into bank_buf, ready to load: 0, else -1 (empty, or the slot no longer holds the entry's name) */
static int pal_prepare(uint32_t pos)
{
    uint8_t e[PAL_ENTRY_MAX];
    uint32_t n = pal_entry(pos, e), len = 0;
    char name[M1_NAME + 1];
    if (n < PAL_FIXED || sl_read(e[0], bank_buf, &len, name) || !pal_name_eq(name, (const char *)e + 2))
        return -1;
    (void)pal_presets_into(bank_buf, &len, M1_PATCH_MAX, e + PAL_FIXED - 1u, n - (PAL_FIXED - 1u));
    pal_pattern_into(bank_buf, len, e[1]);
    pal_buf_len = len;
    pal_buf_slot = e[0];
    put(pal_buf_name, name)[0] = 0;
    return 0;
}

static uint32_t pal_request(uint32_t pos, uint32_t *aux)
{
    int32_t bar;
    uint32_t a = 0;
    if (aux)
        *aux = 0;
    if (pos == PAL_NONE || pos == pal_next) {    /* the same position again, or GO 0xFF: cancelled */
        if (pal_unwait()) {
            a = 2;
            pal_changed();
        }
        if (aux)
            *aux = a;
        return S_OK;
    }
    if (pos >= PAL_N)
        return S_RANGE;
    if (sb_on) {
        if (aux)
            *aux = 1;
        return S_CMD;
    }
    if (pal_ix[pos].state == PAL_EMPTY)
        return S_NONE;
    if (pal_ix[pos].state != PAL_OK || pal_prepare((uint32_t)pos)) {
        pal_bank_changed();
        return S_MISSING;
    }
    pal_next = (uint8_t)pos;
    bar = eng_run ? eng_next_bar(PAL_LEAD_SAMPLES) : -1;
    if (eng_run || pal_fade_st)
        pal_fade_arm(bar);                       /* (already armed: the earlier bar line stays) */
    if (aux)
        *aux = pal_fade_due() > (int32_t)PAL_FADE_NOW_N ? 1u : 0u;
    pal_changed();
    return S_OK;
}

/* the main loop, right after panel_status: the engine stopped at the bar (or at once): the prepared patch loads. The
 * audio has stopped; the load is the gap. Nothing is drawn here, and the main loop drains MIDI next, before its
 * redraw (notes sent at the switch sound at once) */
static void pal_switch_poll(void)
{
    uint32_t pos = pal_next, len = pal_buf_len, i;
    char name[PAL_NAME + 1];
    int rc;
    if (pos == PAL_NONE || (!pal_fade_stopped() && (eng_run || pal_fade_st)))
        return;
    if (pal_slot_name(pal_buf_slot, name, &i) || !pal_name_eq(name, pal_buf_name)) {   /* gone meanwhile */
        char m[27], num[4];
        (void)pal_unwait();
        (void)pal_check();
        fmt_int(num, (int32_t)pos + 1);
        put(put(put(m, MSG_PAL), num), MSG_PAL_MISSING)[0] = 0;
        ui_msg(m, NUDGE_MS);
        pal_changed();
        return;
    }
    pal_next = PAL_NONE;
    pal_last_rt = eng_run_ticks();               /* (the engine stopped at the bar: its tick, before the load) */
    pal_last_bar = eng_bar_ticks();
    pal_switches++;
    i = (uint32_t)pal_fade_stopped();            /* (else the engine was silent already: an overload's mute) */
    rc = m1_engine_load(bank_buf, len);
    if (i)
        pal_fade_resume();                       /* the new sound fades in over a half, the engine runs */
    else
        eng_resume();
    if (rc || m1_set_current(bank_buf, len)) {
        fallback_boot();
        pal_changed();
        return;
    }
    cur_preset = pal_buf_slot;
    cur_from_editor = 0;
    for (i = 0; i <= M1_NAME; i++)
        label_buf[i] = pal_buf_name[i];
    patch_label = label_buf;
    sel = 0;
    leds_avail();
    ui_full = 1;
    pal_cur = (uint8_t)pos;
    if (patches_up) {
        m1_slot_now(cur_preset, label_buf);      /* SLOT_NOW first, then PALETTE_NOW */
        m1_arms_now(mset_none());
    }
    pal_changed();
}

/* the redraw waits while the stop is near: the main loop must come round at once when the engine stops */
static int pal_draw_held(void)
{
    int32_t d = pal_fade_due();
    return d >= 0 && d < (int32_t)PAL_DRAW_HOLD;
}

/* "PATCH 31": the name of an editor's patch stored with no name sent */
static void pal_unnamed(char *name, uint32_t slot)
{
    char num[4];
    char *p = put(name, MSG_PAL_UNNAMED);
    fmt_int(num, (int32_t)slot + 1);
    if (slot < 9u)
        *p++ = '0';
    put(p, num)[0] = 0;
}

static void pal_save(uint32_t pos)
{
    uint8_t e[PAL_ENTRY_MAX], from[PAL_N];
    uint32_t i, slot = PAL_NONE, n;
    char m[27], num[4], *p;
    if (pos >= PAL_N)
        return;
    if (sb_on) {
        ui_msg(MSG_SANDBOX_PATCH_STAYS, NUDGE_MS);
        return;
    }
    if (!flash_ok || !m1_cur_len) {
        ui_msg("NO FLASH", NUDGE_MS);
        return;
    }
    (void)pal_unwait();                          /* (a write at the bar line would lengthen the gap) */
    if (cur_from_editor) {                       /* a patch in no slot (from the editor): the first empty slot */
        for (i = 0; i < bank_slots && slot_used(i); i++)
            ;
        if (i >= bank_slots) {
            ui_msg(MSG_PAL_BANK_FULL, NUDGE_MS);
            pal_changed();
            return;
        }
        slot = i;
        for (i = 0; i <= M1_NAME; i++)
            label_buf[i] = 0;
        if (pal_live_name[0])
            put(label_buf, pal_live_name)[0] = 0;
        else
            pal_unnamed(label_buf, slot);
        cur_preset = slot;
    }
    ui_msg("SAVING", 5000);
    if ((cur_from_editor || m1_edited) && m1_store(m1_cur, m1_cur_len)) {   /* C3: the slot only when edited */
        ui_msg("ERROR", NUDGE_MS);
        return;
    }
    cur_from_editor = 0;
    for (i = 0; i < PAL_FIXED; i++)
        e[i] = 0;
    e[0] = (uint8_t)cur_preset;
    e[1] = (uint8_t)eng_pattern();
    for (i = 0; i < PAL_NAME && label_buf[i]; i++)
        e[2u + i] = (uint8_t)label_buf[i];
    pages_ensure();
    n = PAL_FIXED - 1u + pal_capture(e + PAL_FIXED - 1u, PAL_ENTRY_MAX - (PAL_FIXED - 1u));
    for (i = 0; i < PAL_N; i++)
        from[i] = (uint8_t)i;
    if (pal_write(from, pos, e, n)) {
        ui_msg("ERROR", NUDGE_MS);
        return;
    }
    (void)pal_check();
    pal_cur = (uint8_t)pos;
    fmt_int(num, (int32_t)pos + 1);
    if (slot != PAL_NONE) {
        char sn[4];
        fmt_int(sn, (int32_t)slot + 1);
        p = put(put(m, MSG_PAL_SAVED_SLOT), sn);
        put(put(p, MSG_PAL_SAVED_AND), num)[0] = 0;
    } else {
        put(put(m, MSG_PAL_SAVED), num)[0] = 0;
    }
    ui_msg(m, NUDGE_MS);
    pal_changed();
}

/* boot, after patch_boot: the record and the index */
static void pal_boot(void)
{
    if (!flash_ok)
        return;
    pal_scan();
    (void)pal_check();
}

/* the link's PALETTE command (proto.c C_PALETTE): op, then its payload (docs/ARCHITECTURE.md "The palette") */
static void m1_palette(const uint8_t *d, uint32_t len)
{
    uint32_t op = len ? d[0] : 0xFFu, pos = len > 1u ? d[1] : 0u, st = S_OK, aux = 0, i;
    uint8_t from[PAL_N];
    pal_defer = 1;
    switch (op) {
    case 0:                                      /* GET */
        m1_pal_asked = 1;
        pal_now_due = 1;
        break;
    case 1: {                                    /* ENTRY_GET pos */
        uint8_t p[1u + PAL_ENTRY_MAX];
        if (len < 2u || pos >= PAL_N) {
            m1_ack(C_PALETTE, pos, S_RANGE, 0);
            break;
        }
        p[0] = (uint8_t)pos;
        m1_reply_long(R_PALETTE_ENTRY, p, 1u + pal_entry(pos, p + 1));
        break;
    }
    case 2: {                                    /* PUT pos, ENTRY (none: empty the position) */
        uint32_t n = len > 2u ? len - 2u : 0u, l;
        char name[PAL_NAME + 1];
        if (len < 2u || pos >= PAL_N || (n && !pal_entry_ok(d + 2, n)))
            st = S_RANGE;
        else if (n && (pal_slot_name(d[2], name, &l) || !pal_name_eq(name, (const char *)d + 4)))
            st = S_MISSING;                      /* (the slot does not hold that name now) */
        else if (!flash_ok)
            st = S_FLASH;
        else {
            for (i = 0; i < PAL_N; i++)
                from[i] = (uint8_t)i;
            st = pal_write(from, pos, d + 2, n) ? S_FLASH : S_OK;
            (void)pal_check();
            if (!n && pal_cur == pos)
                pal_cur = PAL_NONE;
            pal_changed();
        }
        m1_ack(C_PALETTE, pos, st, 0);
        break;
    }
    case 3: {                                    /* ORDER from[8]: new position i takes old from[i], 0xFF empty */
        uint8_t cur = PAL_NONE;
        if (len < 1u + PAL_N)
            st = S_RANGE;
        for (i = 0; st == S_OK && i < PAL_N; i++) {
            from[i] = d[1 + i];
            if (from[i] >= PAL_N && from[i] != PAL_NONE)
                st = S_RANGE;
            else if (pal_cur != PAL_NONE && from[i] == pal_cur && cur == PAL_NONE)
                cur = (uint8_t)i;
        }
        if (st == S_OK && !flash_ok)
            st = S_FLASH;
        if (st == S_OK) {
            st = pal_write(from, PAL_NONE, 0, 0) ? S_FLASH : S_OK;
            if (st == S_OK)
                pal_cur = cur;                   /* (the playing entry where it went) */
            (void)pal_check();
            pal_changed();
        }
        m1_ack(C_PALETTE, 0, st, 0);
        break;
    }
    case 4:                                      /* GO pos (0xFF cancels) */
        if (len < 2u) {
            m1_ack(C_PALETTE, 0, S_RANGE, 0);
            break;
        }
        st = pal_request(pos, &aux);
        m1_ack(C_PALETTE, pos, st, aux);
        pal_now_due = 1;
        break;
    case 5:                                      /* NAME name[20]: the editor's patch under Live */
        for (i = 0; i < PAL_NAME; i++)
            pal_live_name[i] = (char)(1u + i < len && d[1 + i] >= 32u && d[1 + i] < 127u && (!i || pal_live_name[i - 1u]) ? d[1 + i] : 0);
        pal_live_name[PAL_NAME] = 0;
        break;
    default:
        m1_ack(C_PALETTE, 0, S_RANGE, 0);
        break;
    }
    pal_defer = 0;
    if (pal_now_due)
        pal_now_send();
}
