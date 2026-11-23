/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* SLOT_GET (#1202 P2, proto.c C_SLOT_GET): a slot's patch binary for the editor's backup.
 *
 * Mode 0: the binary as stored (read into sl_buf).
 * Mode 1: the binary with every pattern inside and no links, as 1.25 reads it. Offset 0 borrows the running patch:
 * refused while the transport runs (0xFFFC), and while the running patch has unsaved edits, the editor's Live holds it or
 * a palette switch waits (0xFFFD: nothing changes). Its binary is kept in bank_buf, the engine stops rendering and the
 * output is muted (snd_muted, the sandbox's), and the bar says BACKING UP SLOT 3. The slot loads as boot's bank_patterns
 * loads one (the engine and m1_cur, its links resolved: proto.c m1_set_current), then its patterns go inline and its links
 * go (patlink.c pl_relink with no ids; 0xFFFE when the binary cannot hold them, the running patch back). m1_cur holds the
 * result; later offsets of the same slot read it. m1_slot_back brings the running patch back exactly as it ran: its binary,
 * slot, name and the palette's state untouched (no palette function runs), m1_edited clear. It runs after the chunk that
 * reaches the end (proto.c), at any other command (proto.c), at a panel control (main.c's polls), at a slot load
 * (preset_load), and SLOT_BK_MS after the last chunk (slot_bk_poll, the main loop).
 *
 * Included by main.c after preset_load, live.c and palette.c; needs m1_engine_load, m1_set_current, m1_cur, m1_cur_len,
 * m1_edited, pl_relink, sl_head / sl_buf, slot_used, flash_ok, bank_slots, bank_buf, eng_transport_running, eng_run,
 * editor_live, pal_next, snd_muted, sb_on, ui_msg, msg_until, ui_full, leds_avail, fallback_boot, put, fmt_int, fm1_ms.
 * Host-tested by firmware/test/patlink_test.c (slot_get). */
#define SLOT_BK_MS 2000u
#define SLOT_NONE 0xFFFFu                       /* totals past the bytes: the slot empty, out of range or unreadable */
#define SLOT_TOO_BIG 0xFFFEu                    /* ... the patch with every pattern inside would pass M1_PATCH_MAX */
#define SLOT_BUSY 0xFFFDu                       /* ... unsaved edits, the editor's Live, a palette switch waiting */
#define SLOT_RUNNING 0xFFFCu                    /* ... the transport runs */
static uint8_t slot_bk;                         /* the slot borrowed + 1, 0 none */
static uint16_t slot_bk_ms, slot_bk_len;        /* fm1_ms's low 16 bits at its last chunk; the running binary's length */

static void m1_slot_back(void)
{
    uint32_t len = slot_bk_len;
    if (!slot_bk)
        return;
    slot_bk = 0;
    if (m1_engine_load(bank_buf, len) || m1_set_current(bank_buf, len))
        fallback_boot();                        /* (never: it ran before) */
    eng_run = 1;
    snd_muted = sb_on;
    leds_avail();
    msg_until = 0;
    ui_full = 1;
}

/* the main loop: a mode 1 SLOT_GET cut off (no chunk for SLOT_BK_MS): the running patch back */
static void slot_bk_poll(void)
{
    if (slot_bk && (uint16_t)((uint16_t)fm1_ms - slot_bk_ms) >= SLOT_BK_MS)
        m1_slot_back();
}

static const uint8_t *m1_slot_get(uint32_t slot, uint32_t mode, uint32_t off, uint32_t *len)
{
    uint16_t none[ENG_PATTERNS] = { 0 };
    char m[24];
    sl_hdr_t h;
    uint32_t i;
    if (mode && off && slot_bk == slot + 1u) {   /* a later chunk of the slot borrowed */
        slot_bk_ms = (uint16_t)fm1_ms;
        *len = m1_cur_len;
        return m1_cur;
    }
    m1_slot_back();
    *len = SLOT_NONE;
    if (!flash_ok || slot >= bank_slots || !slot_used(slot) || sl_head(slot, &h, 1))
        return 0;
    if (!mode) {
        *len = h.len;
        return sl_buf;
    }
    if (eng_transport_running()) {
        *len = SLOT_RUNNING;
        return 0;
    }
    if (m1_edited || editor_live() || pal_next != PAL_NONE || !m1_cur_len) {
        *len = SLOT_BUSY;
        return 0;
    }
    for (i = 0; i < m1_cur_len; i++)
        bank_buf[i] = m1_cur[i];
    slot_bk_len = (uint16_t)m1_cur_len;
    slot_bk = (uint8_t)(slot + 1u);
    slot_bk_ms = (uint16_t)fm1_ms;
    snd_muted = 1;
    fmt_int(put(m, MSG_BACKING_UP), (int32_t)slot + 1);
    ui_msg(m, SLOT_BK_MS);
    if (m1_engine_load(sl_buf, h.len) || m1_set_current(sl_buf, h.len)) {   /* (m1_set_current copies sl_buf first: the
                                                                            * store then works in it) */
        m1_slot_back();
        return 0;
    }
    if ((m1_cur[7] & ENG_FLAG_LINKS) && !pl_relink(none)) {
        m1_slot_back();
        *len = SLOT_TOO_BIG;
        return 0;
    }
    *len = m1_cur_len;
    return m1_cur;
}
