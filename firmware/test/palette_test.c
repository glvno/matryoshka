/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The palette (#1196) on the host: its record (firmware/src/pal_store.h) over a RAM flash that behaves like NOR (an erase
 * sets a sector to 0xFF, a program only clears bits, a program can be cut after n bytes), and the device's palette.c
 * (switch, load, save, the link's PALETTE command) over stand-ins for the engine, the bank and the fade. The shared
 * test vectors of the link (docs/ARCHITECTURE.md "The palette") are asserted here and in web/src/protocol.test.ts.
 * tools/palette_test.sh. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "../src/engine.h"
#include "../src/messages.h"
#include "../loader/ldr_record.h"

static int fails;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)

/* the flash: the palette's sectors */
#define FLASH_LO 0xE5000u
#define FLASH_N 0x3000u
static uint8_t flash[FLASH_N];
static long cut_after = -1;
static int erases;
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    if (off < FLASH_LO || off + n > FLASH_LO + FLASH_N)
        return -8;
    memcpy(dst, flash + (off - FLASH_LO), n);
    return 0;
}
static int st_erase(uint32_t off)
{
    if (cut_after == 0)
        return -9;
    if (off < FLASH_LO || off + 0x1000u > FLASH_LO + FLASH_N || (off & 0xFFFu))
        return -8;
    memset(flash + (off - FLASH_LO), 0xFF, 0x1000u);
    erases++;
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    const uint8_t *s = src;
    uint32_t i;
    if (off < FLASH_LO || off + n > FLASH_LO + FLASH_N)
        return -8;
    for (i = 0; i < n; i++) {
        if (cut_after == 0)
            return -9;
        if (cut_after > 0)
            cut_after--;
        flash[off - FLASH_LO + i] &= s[i];
    }
    return 0;
}
static uint16_t m1_crc16(const uint8_t *d, uint32_t n)         /* proto.c's */
{
    uint32_t c = 0xFFFFu, i, k;
    for (i = 0; i < n; i++) {
        c ^= (uint32_t)d[i] << 8;
        for (k = 0; k < 8; k++)
            c = c & 0x8000u ? ((c << 1) ^ 0x1021u) & 0xFFFFu : (c << 1) & 0xFFFFu;
    }
    return (uint16_t)c;
}
#define M1_NAME 20u
#define M1_PATCH_MAX 3840u
/* proto.c's names */
#define M1_SLOTS 64u
enum { S_OK, S_RANGE, S_CRC, S_LOAD, S_FLASH, S_CMD, S_NONE, S_FULL, S_MISSING, S_USED };
enum { C_PALETTE = 0x1E, R_ACK = 0x40, R_SLOT_NOW = 0x43, R_PALETTE_NOW = 0x66, R_PALETTE_ENTRY = 0x67 };
#define NUDGE_MS 1500u
static uint8_t m1_pal_asked, m1_edited, sb_on, flash_ok = 1, patches_up = 1, ui_full, cur_from_editor;
static uint32_t m1_cur_len = 100, cur_preset, sel, bank_slots = 60;
static uint8_t m1_cur[M1_PATCH_MAX], bank_buf[M1_PATCH_MAX];
static char label_buf[M1_NAME + 1];
static const char *patch_label;
static char last_msg[64];

/* the link's frames, in order: cmd and payload */
static uint8_t tx[64][400];
static uint32_t tx_len[64], tx_cmd[64], ntx;
static void m1_reply_long(uint32_t cmd, const uint8_t *p, uint32_t n)
{
    if (ntx < 64u) {
        tx_cmd[ntx] = cmd;
        tx_len[ntx] = n;
        memcpy(tx[ntx], p, n);
    }
    ntx++;
}
static void m1_ack(uint32_t cmd, uint32_t seq, uint32_t status, uint32_t aux)
{
    uint8_t p[4] = { (uint8_t)cmd, (uint8_t)seq, (uint8_t)status, (uint8_t)aux };
    m1_reply_long(R_ACK, p, 4);
}
static void m1_slot_now(uint32_t slot, const char *name)
{
    uint8_t p[1u + M1_NAME] = { (uint8_t)slot };
    strncpy((char *)p + 1, name, M1_NAME);
    m1_reply_long(R_SLOT_NOW, p, sizeof p);
}
static void m1_arms_now(eng_mset_t s) { (void)s; }

/* the bank: slot n's name and length, or none */
static char bank_name[64][M1_NAME + 1];
static uint32_t bank_len[64];
static int slot_used(uint32_t s) { return s < bank_slots && bank_name[s][0]; }
typedef struct { uint32_t magic, id, seq, len, crc; char name[M1_NAME]; uint32_t rsv[2]; } sl_hdr_t;
static int sl_head(uint32_t id, sl_hdr_t *h, int check)
{
    (void)check;
    if (id >= 64u || !bank_name[id][0])
        return -1;
    memset(h, 0, sizeof *h);
    memcpy(h->name, bank_name[id], M1_NAME);
    h->len = bank_len[id];
    return 0;
}
static int sl_reads;
static int sl_read(uint32_t id, uint8_t *dst, uint32_t *len, char *name)
{
    if (id >= 64u || !bank_name[id][0])
        return -1;
    sl_reads++;
    memset(dst, 0, bank_len[id]);
    dst[0] = (uint8_t)id;                          /* (the slot in byte 0: the load can be told apart) */
    dst[1] = 48;
    dst[7] = ENG_FLAG_PATTERNS;
    dst[40] = 5;                                   /* (the patterns section at 40: pattern 6, song 2) */
    dst[41] = 2;
    *len = bank_len[id];
    memcpy(name, bank_name[id], M1_NAME);
    name[M1_NAME] = 0;
    return 0;
}
uint32_t eng_section_at(const uint8_t *p, uint32_t len, uint32_t sec)
{
    (void)p;
    return sec == ENG_SEC_PATTERNS && len > 42u ? 40u : 0u;
}
static void put_slot(uint32_t s, const char *name, uint32_t len)
{
    memset(bank_name[s], 0, sizeof bank_name[s]);
    strncpy(bank_name[s], name, M1_NAME);
    bank_len[s] = len;
}

/* the presets (pages_ui.c) */
static uint32_t presets_into_calls, capture_n = 1;
static uint8_t capture_bytes[64] = { 0 };
static uint32_t pal_presets_into(uint8_t *buf, uint32_t *len, uint32_t cap, const uint8_t *devs, uint32_t n)
{
    (void)buf; (void)len; (void)cap; (void)devs; (void)n;
    presets_into_calls++;
    return 0;
}
static uint32_t pal_capture(uint8_t *out, uint32_t cap)
{
    (void)cap;
    memcpy(out, capture_bytes, capture_n);
    return capture_n;
}
static void pages_ensure(void) {}

/* the engine and the fade (pal_fade.h) */
static volatile uint8_t eng_run = 1, pal_fade_st;
#define PAL_FADE_NOW_N 220u
static int32_t next_bar = -1, armed_at = -99, fade_due = -1;
static int fade_stopped, fade_cancels, fade_resumes, loads;
static int32_t pat_now = 3;
int32_t eng_next_bar(uint32_t lead) { (void)lead; return next_bar; }
int eng_pattern(void) { return pat_now; }
static int32_t run_ticks = -1;
int32_t eng_run_ticks(void) { return run_ticks; }
uint32_t eng_bar_ticks(void) { return 96; }
static void pal_fade_arm(int32_t bar)
{
    armed_at = bar;
    pal_fade_st = 1;
    fade_due = bar < 0 ? (int32_t)PAL_FADE_NOW_N : 20000;
}
static void pal_fade_cancel(void) { fade_cancels++; pal_fade_st = 0; fade_due = -1; fade_stopped = 0; }
static int pal_fade_stopped(void) { return fade_stopped; }
static void pal_fade_resume(void) { fade_resumes++; fade_stopped = 0; pal_fade_st = 0; fade_due = -1; eng_run = 1; }
static int32_t pal_fade_due(void) { return fade_due; }
static uint8_t loaded_slot;
static int m1_engine_load(const uint8_t *p, uint32_t len) { (void)len; loads++; eng_run = 0; loaded_slot = p[0]; return 0; }
static uint8_t cur_pattern_sel, cur_song;
static int m1_set_current(const uint8_t *p, uint32_t len) { (void)len; cur_pattern_sel = p[40]; cur_song = p[41]; return 0; }
static void fallback_boot(void) {}
static void leds_avail(void) {}
static void eng_resume(void) { eng_run = 1; }
static void ui_msg(const char *s, uint32_t ms) { (void)ms; snprintf(last_msg, sizeof last_msg, "%s", s); }
static int ui_changes;
static void pal_ui_changed(void) { ui_changes++; }
static int stores;
static int m1_store(const uint8_t *p, uint32_t n)
{
    (void)p; (void)n;
    stores++;
    put_slot(cur_preset, label_buf, m1_cur_len);
    m1_edited = 0;
    return 0;
}
static char *put(char *d, const char *s) { while (*s) *d++ = *s++; return d; }
static void fmt_int(char *b, int32_t v) { sprintf(b, "%d", (int)v); }

#include "../src/palette.h"
#include "../src/palette.c"

/* the shared vectors */
static const uint8_t V1[38] = { 0x00, 0x02, 0x4D, 0x4F, 0x4E, 0x4F, 0x4C, 0x49, 0x54, 0x48, 0x20, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                0, 0x01, 0x00, 0x78, 0x56, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0x05, 0x57, 0x41, 0x52, 0x4D, 0x31 };
static const uint8_t V2[23] = { 0x10, 0x00, 0x38, 0x30, 0x38, 0x20, 0x4B, 0x49, 0x54 };

static void link(const uint8_t *d, uint32_t n) { ntx = 0; m1_palette(d, n); }
static void put_entry(uint32_t pos, const uint8_t *e, uint32_t n)
{
    uint8_t f[2 + PAL_ENTRY_MAX] = { 2, (uint8_t)pos };
    memcpy(f + 2, e, n);
    link(f, 2 + n);
}
static int acked(uint32_t k, uint32_t seq, uint32_t st, uint32_t aux)
{
    return k < ntx && tx_cmd[k] == R_ACK && tx[k][0] == C_PALETTE && tx[k][1] == seq && tx[k][2] == st && tx[k][3] == aux;
}
static const uint8_t *now_pos(uint32_t k, uint32_t pos) { return tx[k] + 6 + 27 * pos; }
static int nudged(const char *s) { return !strcmp(last_msg, s) && strlen(s) <= 26u; }

int main(void)
{
    uint8_t e[PAL_ENTRY_MAX], from[PAL_N];
    uint32_t i, n;
    memset(flash, 0xFF, sizeof flash);

    /* the CRC and the vectors */
    {
        uint32_t c = 0xFFFFu;
        for (i = 0; i < 9; i++)
            c = pal_crc_step(c, (uint8_t)"123456789"[i]);
        CHECK(c == 0x29B1u && m1_crc16((const uint8_t *)"123456789", 9) == 0x29B1u);
        CHECK(m1_crc16(V1, sizeof V1) == 0x9B74u && m1_crc16(V2, sizeof V2) == 0x3659u);
        CHECK(pal_entry_ok(V1, sizeof V1) && pal_entry_ok(V2, sizeof V2));
        CHECK(!pal_entry_ok(V1, sizeof V1 - 1u) && !pal_entry_ok(V2, 22));
        memcpy(e, V1, sizeof V1);
        e[24] = e[25] = e[26] = e[27] = 0;          /* (a structure 0: a plain module has no presets) */
        CHECK(!pal_entry_ok(e, sizeof V1));
        memcpy(e, V1, sizeof V1);
        e[22] = PAL_DEVS + 1u;
        CHECK(!pal_entry_ok(e, sizeof V1));
    }

    /* an erased palette is empty; nothing goes out unasked before a GET */
    put_slot(0, "MONOLITH D", 2758);
    put_slot(16, "808 KIT", 3659);
    pal_scan();
    CHECK(pal_side == PAL_NONE && pal_check() == 0u && pal_ix[0].state == PAL_EMPTY);
    put_entry(2, V1, sizeof V1);
    CHECK(ntx == 1u && acked(0, 2, S_OK, 0));
    CHECK(pal_ix[2].state == PAL_OK && pal_ix[2].hash == 0x9B74u && pal_ix[2].len == 2758u && pal_side == 0u && pal_seq == 1u);
    {                                               /* D-942: the entry's first device preset's name, for the FM-1's names */
        char pn[PAL_PNAME + 1];
        CHECK(pal_preset(2, pn) == 5u && !strcmp(pn, "WARM1") && pal_preset(0, pn) == 0u && !pn[0]);
    }

    /* GET: PALETTE_NOW, 222 bytes */
    {
        uint8_t g = 0;
        link(&g, 1);
        CHECK(ntx == 1u && tx_cmd[0] == R_PALETTE_NOW && tx_len[0] == 222u && m1_pal_asked);
        CHECK(tx[0][0] == 1u && tx[0][1] == PAL_NONE && tx[0][2] == PAL_NONE && tx[0][3] == 0u && tx[0][4] == 1u && tx[0][5] == 0u);
        CHECK(now_pos(0, 2)[0] == PAL_OK && now_pos(0, 2)[1] == 0u && now_pos(0, 2)[2] == 2u && now_pos(0, 2)[3] == 0x74u &&
              now_pos(0, 2)[4] == 0x9Bu && now_pos(0, 2)[5] == (2758u & 255u) && now_pos(0, 2)[6] == 2758u >> 8 &&
              !memcmp(now_pos(0, 2) + 7, "MONOLITH D", 10) && now_pos(0, 0)[0] == PAL_EMPTY && now_pos(0, 0)[3] == 0u);
    }
    /* PUT answers ACK, then PALETTE_NOW; a slot that does not hold the name: MISSING; malformed: RANGE */
    put_entry(5, V2, sizeof V2);
    CHECK(ntx == 2u && acked(0, 5, S_OK, 0) && tx_cmd[1] == R_PALETTE_NOW && now_pos(1, 5)[0] == PAL_OK &&
          now_pos(1, 5)[3] == 0x59u && now_pos(1, 5)[4] == 0x36u && tx[1][4] == 2u);
    {
        char pn[PAL_PNAME + 1] = "X";
        CHECK(pal_preset(5, pn) == 0u && !pn[0]);   /* (an entry with no device preset: the patch's name alone) */
    }
    memcpy(e, V2, sizeof V2);
    e[0] = 1;                                       /* (slot 2 is empty) */
    put_entry(6, e, sizeof V2);
    CHECK(ntx == 1u && acked(0, 6, S_MISSING, 0) && pal_seq == 2u);
    e[0] = 0;                                       /* (slot 1 holds MONOLITH D) */
    put_entry(6, e, sizeof V2);
    CHECK(acked(0, 6, S_MISSING, 0));
    put_entry(6, V2, 20);
    CHECK(ntx == 1u && acked(0, 6, S_RANGE, 0));
    put_entry(8, V2, sizeof V2);
    CHECK(acked(0, 8, S_RANGE, 0));
    /* ENTRY_GET: the bytes back; an empty position: pos alone */
    {
        uint8_t g[2] = { 1, 2 };
        link(g, 2);
        CHECK(ntx == 1u && tx_cmd[0] == R_PALETTE_ENTRY && tx_len[0] == 39u && tx[0][0] == 2u && !memcmp(tx[0] + 1, V1, sizeof V1));
        g[1] = 0;
        link(g, 2);
        CHECK(tx_len[0] == 1u && tx[0][0] == 0u);
        g[1] = 9;
        link(g, 2);
        CHECK(acked(0, 9, S_RANGE, 0));
    }

    /* A / B: each write to the other sector, seq + 1; a cut write leaves the old record */
    CHECK(pal_side == 1u && pal_seq == 2u);
    for (i = 0; i < PAL_N; i++)
        from[i] = (uint8_t)i;
    cut_after = 126;                                /* (the body goes (124 bytes with the erased header room), the magic never) */
    CHECK(pal_write(from, 0, V2, sizeof V2) != 0);
    cut_after = -1;
    pal_scan();
    CHECK(pal_side == 1u && pal_seq == 2u && pal_entry(2, e) == sizeof V1 && pal_entry(0, e) == 0u);
    /* seq wraps: 0xFFFF on one side, then 0 on the other: 0 is the newer */
    pal_seq = 0xFFFEu;
    CHECK(pal_write(from, PAL_NONE, 0, 0) == 0 && pal_side == 0u && pal_seq == 0xFFFFu);
    CHECK(pal_write(from, PAL_NONE, 0, 0) == 0 && pal_side == 1u && pal_seq == 0u);
    pal_scan();
    CHECK(pal_side == 1u && pal_seq == 0u && pal_entry(5, e) == sizeof V2);
    CHECK(pal_write(from, PAL_NONE, 0, 0) == 0 && pal_side == 0u && pal_seq == 1u);
    /* a newer version reads as empty */
    {
        uint8_t save[16];
        memcpy(save, flash, 16);
        flash[4] = 2;
        CHECK(pal_head(0, &i, &n) != 0);
        memcpy(flash, save, 16);
        CHECK(pal_head(0, &i, &n) == 0);
        flash[16 + 3] ^= 1;                         /* (a body bit: the CRC refuses) */
        CHECK(pal_head(0, &i, &n) != 0);
        flash[16 + 3] ^= 1;
    }

    /* ORDER: reorder and remove in one write; the playing entry follows */
    pal_cur = 5;
    {
        uint8_t o[9] = { 3, 5, 2, PAL_NONE, PAL_NONE, PAL_NONE, PAL_NONE, PAL_NONE, PAL_NONE };
        link(o, 9);
        CHECK(acked(0, 0, S_OK, 0) && tx_cmd[1] == R_PALETTE_NOW && pal_ix[0].hash == 0x3659u && pal_ix[1].hash == 0x9B74u &&
              pal_ix[2].state == PAL_EMPTY && pal_ix[5].state == PAL_EMPTY && pal_cur == 0u && tx[1][1] == 0u);
        o[1] = 9;
        link(o, 9);
        CHECK(acked(0, 0, S_RANGE, 0) && pal_ix[0].hash == 0x3659u);
    }

    /* MISSING: the slot emptied, another name, the same name replaced */
    put_slot(16, "", 0);
    CHECK(pal_check() == 1u && pal_ix[0].state == PAL_MISSING && pal_ix[0].len == 0u);
    put_slot(16, "909 KIT", 3000);
    CHECK(pal_check() == 0u && pal_ix[0].state == PAL_MISSING);
    put_slot(16, "808 KIT", 3700);
    CHECK(pal_check() == 1u && pal_ix[0].state == PAL_OK && pal_ix[0].len == 3700u);

    /* GO: an empty position, MISSING, sandbox mode; stopped: at once; playing: at the bar; the same again cancels */
    {
        uint8_t g[2] = { 4, 4 };
        link(g, 2);
        CHECK(acked(0, 4, S_NONE, 0) && tx_cmd[1] == R_PALETTE_NOW && pal_next == PAL_NONE);
        put_slot(16, "", 0);
        (void)pal_check();
        g[1] = 0;
        link(g, 2);
        CHECK(acked(0, 0, S_MISSING, 0) && pal_next == PAL_NONE);
        put_slot(16, "808 KIT", 3700);
        (void)pal_check();
        sb_on = 1;
        link(g, 2);
        CHECK(acked(0, 0, S_CMD, 1) && pal_next == PAL_NONE);
        sb_on = 0;
        next_bar = -1;                              /* (stopped) */
        link(g, 2);
        CHECK(acked(0, 0, S_OK, 0) && tx_cmd[1] == R_PALETTE_NOW && tx[1][2] == 0u && armed_at == -1 && pal_next == 0u);
        CHECK(bank_buf[0] == 16u && bank_buf[40] == 0u && bank_buf[41] == 0u);   /* (the entry's pattern 0, no song) */
        pal_switch_poll();
        CHECK(loads == 0);                          /* (the fade has not stopped the engine yet) */
        fade_stopped = 1;
        eng_run = 0;
        pal_cur = PAL_NONE;
        ntx = 0;
        pal_switch_poll();
        CHECK(loads == 1 && loaded_slot == 16u && fade_resumes == 1 && cur_preset == 16u && pal_cur == 0u && pal_next == PAL_NONE);
        {
            uint8_t dg[12];
            CHECK(pal_diag(dg) == 12u && dg[0] == 0xFFu && dg[4] == 96u && dg[8] == 1u);   /* (stopped: -1) */
        }
        CHECK(!strcmp(label_buf, "808 KIT") && patch_label == label_buf && cur_pattern_sel == 0u && cur_song == 0u);
        CHECK(ntx == 2u && tx_cmd[0] == R_SLOT_NOW && tx[0][0] == 16u && tx_cmd[1] == R_PALETTE_NOW && tx[1][1] == 0u);
        next_bar = 384;                             /* (playing: the bar line at run tick 384) */
        g[1] = 1;
        link(g, 2);
        CHECK(acked(0, 1, S_OK, 1) && armed_at == 384 && pal_next == 1u && tx[1][2] == 1u && tx[1][1] == 0u);
        link(g, 2);                                 /* (the same position: cancelled, the old sound back up) */
        CHECK(acked(0, 1, S_OK, 2) && pal_next == PAL_NONE && fade_cancels == 1 && tx[1][2] == PAL_NONE);
        link(g, 2);
        g[1] = 0xFF;
        link(g, 2);
        CHECK(acked(0, 0xFF, S_OK, 2) && pal_next == PAL_NONE);
        g[1] = 0;
        link(g, 2);
        g[1] = 1;                                   /* (a re-target: the new one prepared, the bar line kept) */
        link(g, 2);
        CHECK(pal_next == 1u && bank_buf[0] == 0u && bank_buf[40] == 2u);
        put_slot(0, "OTHER", 100);                  /* (the slot replaced before the bar: no load, MISSING said) */
        fade_stopped = 1;
        pal_switch_poll();
        CHECK(loads == 1 && pal_next == PAL_NONE && nudged(MSG_PAL "2" MSG_PAL_MISSING) && pal_ix[1].state == PAL_MISSING);
        put_slot(0, "MONOLITH D", 2758);
        (void)pal_check();
        /* another patch change cancels and leaves no entry playing */
        link(g, 2);
        pal_cancel();
        CHECK(pal_next == PAL_NONE && pal_cur == PAL_NONE);
    }

    /* the redraw waits while the stop is near */
    fade_due = 3000;
    CHECK(!pal_draw_held());
    fade_due = 2000;
    CHECK(pal_draw_held());
    fade_due = -1;

    /* save: an unedited patch from a slot writes only the palette; an edited one its slot first (C3) */
    cur_preset = 0;
    put(label_buf, "MONOLITH D")[0] = 0;
    m1_edited = 0;
    capture_n = 1;
    pal_save(3);
    CHECK(stores == 0 && pal_ix[3].state == PAL_OK && pal_ix[3].slot == 0u && pal_ix[3].pattern == 3u && pal_cur == 3u);
    CHECK(nudged(MSG_PAL_SAVED "4") && pal_entry(3, e) == PAL_FIXED && e[22] == 0u);
    m1_edited = 1;
    capture_n = 1 + 10 + 5;                         /* (one device with a preset: as V1's) */
    memcpy(capture_bytes, V1 + 22, capture_n);
    pal_save(4);
    CHECK(stores == 1 && pal_entry(4, e) == sizeof V1 && !memcmp(e + 2, V1 + 2, sizeof V1 - 2u) && e[1] == 3u);
    /* a patch from the editor: the first empty slot, named by PALETTE NAME, else PATCH nn */
    {
        uint8_t nm[21] = { 5, 'M', 'Y', ' ', 'P', 'A', 'D' };
        link(nm, sizeof nm);
        CHECK(ntx == 0u && !strcmp(pal_live_name, "MY PAD"));
        cur_from_editor = 1;
        m1_edited = 1;
        pal_save(6);
        CHECK(stores == 2 && cur_preset == 1u && !strcmp(bank_name[1], "MY PAD") && pal_ix[6].slot == 1u &&
              pal_ix[6].state == PAL_OK && !cur_from_editor && nudged(MSG_PAL_SAVED_SLOT "2" MSG_PAL_SAVED_AND "7"));
        pal_live_name[0] = 0;
        cur_from_editor = 1;
        pal_save(7);
        CHECK(cur_preset == 2u && !strcmp(bank_name[2], "PATCH 03") && nudged(MSG_PAL_SAVED_SLOT "3" MSG_PAL_SAVED_AND "8"));
        for (i = 0; i < 60; i++)
            if (!bank_name[i][0])
                put_slot(i, "FILL", 10);
        cur_from_editor = 1;
        n = pal_seq;
        pal_save(0);
        CHECK(nudged(MSG_PAL_BANK_FULL) && pal_seq == n && stores == 3);
        cur_from_editor = 0;
        sb_on = 1;
        pal_save(0);
        CHECK(nudged(MSG_SANDBOX_PATCH_STAYS) && pal_seq == n);
        sb_on = 0;
        CHECK(strlen(MSG_PAL "8" MSG_PAL_EMPTY) <= 26u && strlen(MSG_PAL_SAVED_SLOT "60" MSG_PAL_SAVED_AND "8") <= 26u);
    }

    /* the largest record ends before 0xF00, whose 80 bytes stay erased: never an update record */
    {
        uint8_t big[PAL_ENTRY_MAX], r[LDR_REC_LEN];
        memset(big, 0, sizeof big);
        big[0] = 0;
        memcpy(big + 2, "MONOLITH D", 10);
        big[22] = PAL_DEVS;
        for (i = 0; i < PAL_DEVS; i++) {
            uint8_t *d = big + PAL_FIXED + i * PAL_DEV_MAX;
            d[0] = (uint8_t)i;
            d[1] = d[5] = 0x11;
            d[9] = PAL_PNAME;
            memset(d + 10, 'A' + (int)i, PAL_PNAME);
        }
        CHECK(pal_entry_ok(big, PAL_ENTRY_MAX) && PAL_ENTRY_MAX == 335u);
        for (i = 0; i < PAL_N; i++)
            from[i] = (uint8_t)i;
        for (i = 0; i < PAL_N; i++)
            CHECK(pal_write(from, i, big, sizeof big) == 0);
        pal_scan();
        CHECK(pal_head(pal_side, &i, &n) == 0 && PAL_HDR + n == 2712u && PAL_HDR + n <= PAL_END);
        for (i = 0; i < 2; i++) {
            memcpy(r, flash + i * 0x1000u + 0xF00u, LDR_REC_LEN);
            CHECK(!ldr_is_record(r) && r[0] == 0xFFu && r[79] == 0xFFu);
        }
        CHECK(pal_entry(7, e) == PAL_ENTRY_MAX && !memcmp(e, big, sizeof big));
    }

    /* FACTORY RESET: both sectors erased, the palette empty */
    pal_cur = 2;
    pal_clear_all();
    CHECK(pal_side == PAL_NONE && pal_cur == PAL_NONE && pal_ix[7].state == PAL_EMPTY && flash[0] == 0xFFu && flash[0x1000] == 0xFFu);
    pal_scan();
    CHECK(pal_side == PAL_NONE);

    if (fails) {
        printf("palette: %d failed\n", fails);
        return 1;
    }
    printf("palette ok: record A/B (seq wrap, cut write, newer version, CRC), the 335-byte entry and 2712-byte record clear "
           "of the loader's 0xF00, the link vectors (0x9B74, 0x3659, 0x29B1), PUT/ENTRY_GET/ORDER/GO/NAME, MISSING, the "
           "switch's load, save (C3, a free slot, BANK FULL), FACTORY RESET\n");
    return 0;
}
