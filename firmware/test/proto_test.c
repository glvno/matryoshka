/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Host test of proto.c: feeds the frames produced by web/scripts/golden.ts (a patch upload and a parameter change,
 * NAME.syx = concatenated F0..F7 messages) and checks that the engine then renders bit-exactly what it renders
 * after eng_load of the same patch plus eng_set_param.
 *   proto_test NAME.m1p NAME.syx MODULE PARAM VALUE_Q16 ATT_MODULE ATT_INPUT ATT_Q16 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/engine.c"

static int applied, stored;
static int slot_writes, slot_erases;
static uint32_t last_slot, last_len;
static char last_name[32];
static uint8_t last_data[3072];
static uint8_t replies[64][512];
static uint32_t reply_len[64], nreplies;
static int m1_apply(const uint8_t *p, uint32_t n)
{
    applied++;
    return eng_load(p, n);
}
static int m1_store(const uint8_t *p, uint32_t n)
{
    (void)p;
    (void)n;
    stored++;
    return 0;
}
static int m1_flash_ok(void) { return 1; }
static void m1_ui_changed(void) {}
static void m1_ui_rows(void) {}
static int transport_calls;
static void m1_transport(int run) { (void)run; transport_calls++; }
static uint32_t focus_calls, focus_dev, focus_page;
static void m1_focus(uint32_t dev, uint32_t pg) { focus_calls++; focus_dev = dev; focus_page = pg; }
static uint32_t live_calls, live_paused_arg;
static void m1_live(uint32_t paused) { live_paused_arg = paused; live_calls++; }
static int m1_slot_write(uint32_t slot, const char *name, const uint8_t *p, uint32_t len)
{
    slot_writes++;
    last_slot = slot;
    last_len = len;
    strncpy(last_name, name, sizeof last_name - 1);
    memcpy(last_data, p, len);
    return 0;
}
static int m1_slot_erase(uint32_t slot)
{
    slot_erases++;
    last_slot = slot;
    return 0;
}
static int m1_slot_info(uint32_t slot, char *name, uint32_t *len)
{
    if (slot != 5u)
        return 0;
    strcpy(name, last_name);
    *len = last_len;
    return 1;
}
static uint32_t m1_diag(uint32_t page, uint8_t *out)   /* two pages of 32, 7 */
{
    uint32_t i, n = page == 0u ? 32u : page == 1u ? 7u : 0u;
    for (i = 0; i < n; i++)
        out[i] = (uint8_t)(page * 32u + i);
    return n;
}
/* the presets (#195): a RAM store of up to 4 */
static struct { uint32_t st, n; char name[17]; int32_t v[88]; uint8_t used; } pst[4];
static uint32_t m1_presets(uint32_t k, uint32_t *structure, char *name, uint32_t *n)
{
    uint32_t i, c = 0;
    for (i = 0; i < 4u; i++)
        if (pst[i].used) {
            if (c == k && structure) {
                *structure = pst[i].st;
                strcpy(name, pst[i].name);
                *n = pst[i].n;
            }
            c++;
        }
    return c;
}
static int pst_find(uint32_t st, const char *name)
{
    int i;
    for (i = 0; i < 4; i++)
        if (pst[i].used && pst[i].st == st && !strncmp(pst[i].name, name, 16))
            return i;
    return -1;
}
static int m1_preset_get(uint32_t structure, const char *name, int32_t *vals, uint32_t *n)
{
    int i = pst_find(structure, name);
    if (i < 0)
        return -1;
    *n = pst[i].n;
    memcpy(vals, pst[i].v, 4u * pst[i].n);
    return 0;
}
static int m1_preset_put(uint32_t structure, const char *name, const int32_t *vals, uint32_t n)
{
    int i = pst_find(structure, name);
    if (i < 0)
        for (i = 0; i < 4 && pst[i].used; i++)
            ;
    if (i >= 4)
        return -2;
    pst[i].used = 1;
    pst[i].st = structure;
    pst[i].n = n;
    strncpy(pst[i].name, name, 16);
    pst[i].name[16] = 0;
    memcpy(pst[i].v, vals, 4u * n);
    return 0;
}
static int m1_preset_del(uint32_t structure, const char *name)
{
    int i = pst_find(structure, name);
    if (i < 0)
        return -1;
    pst[i].used = 0;
    return 0;
}
static void m1_send(const uint8_t *f, uint32_t n)
{
    memcpy(replies[nreplies], f, n);
    reply_len[nreplies++] = n;
}
static int midi_out_on = 1;                                   /* MENU > MIDI OUT (INFO's flag bit 2) */
static int m1_midi_out(void) { return midi_out_on; }
#include "../src/sandbox_msg.h"
static sb_page_t sb_got;                                      /* the last SANDBOX page */
static int sb_calls;
static void m1_sandbox(const sb_page_t *s) { sb_got = *s; sb_calls++; }
/* the device test mode (#291): the last key / turn, a screen of two texts, a peak */
static int test_key_id = -1, test_key_down, test_turn_enc = -1, test_turn_clicks;
static int m1_test_key(uint32_t id, int down)
{
    if (id >= 41u)
        return -1;
    test_key_id = (int)id;
    test_key_down = down;
    return 0;
}
static int m1_test_turn(uint32_t enc, int32_t clicks)
{
    if (enc >= 7u)
        return -1;
    test_turn_enc = (int)enc;
    test_turn_clicks = clicks;
    return 0;
}
static uint32_t m1_test_screen(uint32_t k, uint8_t *out)
{
    static const char *const T[2] = {"OCT 0", "BROWSER PLAYS"};
    uint32_t i;
    if (k == 0xFFu) {
        out[0] = 2;
        out[1] = 0;
        out[2] = 1;
        return 3;
    }
    if (k >= 2u)
        return 0;
    out[0] = (uint8_t)(10u + k);
    out[1] = (uint8_t)(20u * k);
    out[2] = 60;
    out[3] = 11;
    for (i = 0; T[k][i]; i++)
        out[5u + i] = (uint8_t)T[k][i];
    out[4] = (uint8_t)i;
    return 5u + i;
}
static uint32_t m1_test_peak(void) { return 1234u | 1u << 16 | 1u << 17; }
#include "../src/proto.c"

static uint8_t *slurp(const char *path, long *n)
{
    FILE *f = fopen(path, "rb");
    uint8_t *b;
    if (!f) {
        perror(path);
        exit(2);
    }
    fseek(f, 0, SEEK_END);
    *n = ftell(f);
    fseek(f, 0, SEEK_SET);
    b = malloc((size_t)*n + 1);
    if (fread(b, 1, (size_t)*n, f) != (size_t)*n)
        exit(2);
    fclose(f);
    return b;
}

static void run(int32_t *l, int32_t *r)
{
    eng_note_on(60, 65536, 1);
    eng_render(l, r, 128 * 40);
}

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); return 1; } } while (0)

/* proto_test --old OLD.m1p NEW.m1p ... (tools/old_format.sh): binaries of an older patch format (an earlier release's
 * encoder) against today's firmware. Each must pass m1_valid; m1_set_current must upgrade it (eng_upgrade) into a valid
 * binary of today's format that renders bit-identically to the older binary loaded as it is, and whose Drum map row names
 * read the same; NEW (today's encoding of the same patch, "-" none) shows whether the upgrade writes what the encoder
 * writes (a kit changed since the older release differs, so that is counted, not checked). */
static int old_format(int n, char **argv)
{
    static int32_t a_l[128 * 40], a_r[128 * 40], b_l[128 * 40], b_r[128 * 40];
    static uint8_t old[M1_PATCH_MAX];
    int k, same = 0, other = 0, kept = 0, current = 0;
    for (k = 0; k + 1 < n; k += 2) {
        long no, nn = 0;
        uint8_t *o = slurp(argv[k], &no), *nw = strcmp(argv[k + 1], "-") ? slurp(argv[k + 1], &nn) : 0;
        uint32_t m, r;
        if (no > (long)M1_PATCH_MAX || o[1] > ENG_PATCH_VERSION) {
            fprintf(stderr, "%s: not an older format that fits a slot\n", argv[k]);
            return 1;
        }
        if (o[1] == ENG_PATCH_VERSION) {                      /* (BASE wrote today's format already: it only has to load) */
            CHECK(m1_valid(o, (uint32_t)no) && eng_load(o, (uint32_t)no) == 0);
            current++;
            free(o);
            free(nw);
            continue;
        }
        memcpy(old, o, (size_t)no);
        if (!m1_valid(old, (uint32_t)no)) {
            fprintf(stderr, "FAIL %s: m1_valid refuses the older binary\n", argv[k]);
            return 1;
        }
        CHECK(eng_load(old, (uint32_t)no) == 0);
        E.tick_acc = E.ticks = 0;                             /* (the tempo clock runs on across loads: both from 0) */
        run(a_l, a_r);
        eng_all_notes_off();
        m1_set_current(old, (uint32_t)no);
        if (m1_cur[1] != ENG_PATCH_VERSION) {
            kept++;                                           /* (too big to upgrade: it stays in its format) */
            CHECK(m1_cur_len == (uint32_t)no && !memcmp(m1_cur, old, (size_t)no));
            continue;
        }
        CHECK(m1_valid(m1_cur, m1_cur_len));
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);
        E.tick_acc = E.ticks = 0;
        run(b_l, b_r);
        eng_all_notes_off();
        if (memcmp(a_l, b_l, sizeof a_l) || memcmp(a_r, b_r, sizeof a_r)) {
            fprintf(stderr, "FAIL %s: the upgraded binary renders differently\n", argv[k]);
            return 1;
        }
        for (m = 0; m < old[2]; m++)
            for (r = 0; r < 8u; r++) {
                char x[32], y[32];
                int hx = eng_drum_name(old, (uint32_t)no, m, r, x), hy = eng_drum_name(m1_cur, m1_cur_len, m, r, y);
                CHECK(hx == hy && (!hx || !strcmp(x, y)));
            }
        if (nw && nn == (long)m1_cur_len && !memcmp(nw, m1_cur, (size_t)nn))
            same++;
        else if (nw) {
            other++;
            printf("upgraded %s differs from today's encoding (%ld vs %u bytes)\n", argv[k], nn, (unsigned)m1_cur_len);
        }
        free(o);
        free(nw);
    }
    printf("older format ok: %d binaries load, upgrade and render bit-identically; %d upgraded as today's encoder writes them, %d differ, %d too big to upgrade, %d already in today's format\n",
           n / 2, same, other, kept, current);
    return 0;
}

/* a frame to m1_handle: cmd and its payload, 7-bit packed */
static int send_frame(uint32_t cmd, const uint8_t *pl, uint32_t n)
{
    static uint8_t fr[8u + (8u * 600u + 6u) / 7u];
    fr[0] = 0x7D;
    fr[1] = 0x4D;
    fr[2] = 0x31;
    fr[3] = (uint8_t)cmd;
    return m1_handle(fr, 4u + m1_pack7(pl, n, fr + 4));
}
/* the patterns and songs section of the running binary, 0 without one */
static uint32_t pat_section(void)
{
    uint32_t at = m1_notes_at();
    if (!at || !(m1_cur[7] & ENG_FLAG_PATTERNS))
        return 0;
    return (m1_cur[6] & 16u) ? eng_notes_end(m1_cur, m1_cur_len, at) : at;
}
/* the engine's patterns and songs are what the running binary holds: the section byte for byte (eng_patterns_record, the
 * encoder's patternRecord), the whole binary valid, and a reload gives the same section back */
static int pat_agree(void)
{
    static uint8_t rec[M1_PATCH_MAX], keep[M1_PATCH_MAX];
    uint32_t sec = pat_section(), end;
    int n = eng_patterns_record(rec, sizeof rec);
    if (n < 0 || !m1_valid(m1_cur, m1_cur_len))
        return 0;
    if (!n)
        return !sec && !(m1_cur[7] & ENG_FLAG_PATTERNS);
    end = sec ? eng_patterns_end(m1_cur, m1_cur_len, sec) : 0;
    if (!sec || end - sec != (uint32_t)n || memcmp(m1_cur + sec, rec, (size_t)n))
        return 0;
    memcpy(keep, rec, (size_t)n);
    if (eng_load(m1_cur, m1_cur_len) || eng_patterns_record(rec, sizeof rec) != n || memcmp(rec, keep, (size_t)n))
        return 0;
    return 1;
}
/* the patterns (format 48) on the FM-1: the steps-patterns and steps-song kits as the encoder writes them, the engine's
 * record of them, edits of any pattern (one the track had not got is made from its first), the editor's TRACK with a
 * pattern, PATTERN and SONG, an older binary that gains the section and loses it again */
static int patterns_test(const char *kit_path, const char *song_path)
{
    static int32_t l[128], r[128];
    static uint8_t rec[M1_PATCH_MAX];
    long nk, ns;
    uint8_t *kit = slurp(kit_path, &nk), *song = slurp(song_path, &ns), pl[3u + 4u * 4u];
    uint32_t t0, t1, sec, len0;
    const uint32_t *w;
    int n;
    CHECK(kit[1] == ENG_PATCH_VERSION && (kit[7] & ENG_FLAG_PATTERNS) && m1_valid(kit, (uint32_t)nk) && !m1_valid(kit, (uint32_t)nk - 1u));
    m1_set_current(kit, (uint32_t)nk);
    CHECK(eng_load(m1_cur, m1_cur_len) == 0);
    sec = pat_section();
    n = eng_patterns_record(rec, sizeof rec);                   /* the engine writes what the encoder wrote */
    CHECK(sec && n > 0 && sec + (uint32_t)n == eng_patterns_end(m1_cur, m1_cur_len, sec) && !memcmp(m1_cur + sec, rec, (size_t)n));
    CHECK(eng_patterns_record(0, 0) == n && eng_patterns_record(rec, (uint32_t)n - 1u) == -1);
    t0 = (uint32_t)eng_steps_module(0);
    t1 = (uint32_t)eng_steps_module(1);
    CHECK(eng_pattern_has(t0, 0) && eng_pattern_has(t0, 1) && eng_pattern_has(t0, 2) && !eng_pattern_has(t0, 3));
    CHECK(eng_pattern_has(t1, 1) && !eng_pattern_has(t1, 2) && eng_pattern_has(t1, 3) && eng_pattern_notes(t1, 3, &w) == 0);
    CHECK(eng_pattern_len(t0, 1) == 5 && eng_pattern_len(t0, 2) == 12 && eng_pattern_rate(t0, 2) == 5 && eng_pattern_rate(t0, 1) == -1);
    CHECK(eng_pattern_notes(t0, 2, &w) == 6 && (w[0] & 63u) == 0u && ((w[0] >> 19) & 127u) == ACCENT_VEL && ((w[5] >> 6) & 63u) == 3u);   /* short words read */
    CHECK(eng_pattern_notes(t0, 1, &w) == 4 && ((w[2] >> 26) & 31u) == 10u && ((w[3] >> 19) & 127u) == 77u);   /* long ones: a chance, a velocity */
    len0 = m1_cur_len;
    /* stopped: a chosen pattern plays from the next block; an edit goes into it */
    eng_pattern_set(1);
    CHECK(eng_pattern_playing(t0) == 0 && eng_pattern_queued(t0) == 1);
    eng_render(l, r, 128);
    CHECK(eng_pattern_playing(t0) == 1 && eng_pattern_queued(t0) == -1 && eng_steps_len(t0) == 5 && eng_steps_len(t1) == 6);
    CHECK(eng_steps_get(t0, 1) == 0x80 && eng_steps_get(t0, 2) == 1);   /* (pattern 2's: a tie, a note) */
    m1_patch_step(t0, 1, 3u);                                  /* step 2 on, accented */
    CHECK(eng_steps_get(t0, 1) == 3 && eng_pattern_notes(t0, 1, &w) == 5 && eng_pattern_notes(t0, 0, &w) == 7);
    CHECK(pat_agree() && m1_cur_len == len0 + 4u);              /* (long words: a word more) */
    eng_pattern_set(2);
    eng_render(l, r, 128);
    m1_patch_step(t0, 15, 1u);                                 /* a short pattern: two bytes more */
    CHECK(eng_pattern_notes(t0, 2, &w) == 7 && pat_agree() && m1_cur_len == len0 + 6u);
    m1_patch_step(t0, 15, 0u);
    CHECK(pat_agree() && m1_cur_len == len0 + 4u);
    m1_patch_stepval(t0, 3, 70, 90);                           /* a velocity a short word cannot hold: the pattern turns long */
    CHECK(pat_agree() && m1_cur_len == len0 + 4u + 2u * 6u);
    m1_patch_stepval(t0, 3, 70, 100);
    CHECK(pat_agree() && m1_cur_len == len0 + 4u);
    /* a pattern the track had not got: it plays its first; an edit makes it, from the first */
    eng_pattern_set(5);
    eng_render(l, r, 128);
    CHECK(eng_pattern_playing(t0) == 5 && !eng_pattern_has(t0, 5) && eng_steps_len(t0) == 8 && eng_steps_get(t0, 0) == 1);
    m1_patch_step(t0, 4, 0u);                                  /* (step 5 of the first pattern off) */
    CHECK(eng_pattern_has(t0, 5) && !eng_pattern_has(t0, 3) && !eng_pattern_has(t0, 4) && eng_pattern_notes(t0, 5, &w) == 6);
    CHECK(eng_pattern_notes(t0, 0, &w) == 7 && pat_agree());
    CHECK(m1_cur_len == len0 + 4u + 2u + 3u + 4u * 6u);      /* two missing patterns (a byte each), the new one (long words) */
    CHECK(eng_pattern_playing(t1) == 5 && !eng_pattern_has(t1, 5));   /* the other track: still its first */
    /* every note of a pattern gone: the pattern stays, empty (it plays nothing) */
    CHECK(eng_pattern_set_notes(t1, 1, 0, 0));
    m1_patch_track(t1);
    CHECK(eng_pattern_has(t1, 1) && eng_pattern_notes(t1, 1, &w) == 0 && pat_agree());
    /* the editor's TRACK with a pattern (format 48): pattern 3 of the first track, the one played untouched */
    pl[0] = (uint8_t)t0;
    pl[1] = 2;
    pl[2] = 0x40; pl[3] = 0xC0; pl[4] = 0xFB; pl[5] = 0x03;    /* note 60 at step 0, 2 steps, velocity 127 (noteWord) */
    pl[6] = 0x04; pl[7] = 0x30; pl[8] = 0x24; pl[9] = 0x03;    /* note 67 at step 4, 1 step, velocity 100 */
    pl[10] = 3;
    CHECK(send_frame(C_TRACK, pl, 11u) == 1);
    CHECK(eng_pattern_has(t0, 3) && eng_pattern_notes(t0, 3, &w) == 2 && w[0] == 0x03FBC040u && w[1] == 0x03243004u);
    CHECK(eng_pattern_playing(t0) == 5 && pat_agree());
    /* PATTERN: the selected pattern into the binary (a reload plays it); SONG: a song's entries */
    pl[0] = 3;
    pl[1] = 0;
    CHECK(send_frame(C_PATTERN, pl, 2u) == 1 && eng_pattern() == 3 && pat_agree());
    CHECK(m1_cur[pat_section()] == 3u && eng_load(m1_cur, m1_cur_len) == 0 && eng_pattern_playing(t0) == 3);
    pl[0] = 2;
    pl[1] = 3;
    pl[2] = 1; pl[3] = 5;
    pl[4] = 3; pl[5] = (uint8_t)-7;
    pl[6] = 0; pl[7] = 0;
    CHECK(send_frame(C_SONG, pl, 8u) == 1 && eng_song_len(2) == 3 && eng_song_get(2, 1) == (3 | 0xF9 << 8) && pat_agree());
    pl[0] = 3;
    pl[1] = 3;
    CHECK(send_frame(C_PATTERN, pl, 2u) == 1 && eng_song() == 3 && pat_agree());
    CHECK(eng_song_insert(2, 0) == 0 && eng_song_delete(2, 3) == 0 && eng_song_len(2) == 3 && eng_song_get(2, 1) == (1 | 5 << 8));
    m1_patch_patterns();
    CHECK(pat_agree());
    /* the song kit: what the encoder wrote, the engine writes */
    m1_set_current(song, (uint32_t)ns);
    CHECK(eng_load(m1_cur, m1_cur_len) == 0 && eng_song() == 1 && eng_song_len(0) == 4 && eng_song_len(1) == 2 && pat_agree());
    CHECK(eng_song_get(0, 2) == (2 | 0xF9 << 8));
    /* a patch without patterns (an older format, upgraded): choosing pattern 2 makes the section, pattern 1 drops it */
    {
        static uint8_t plain[M1_PATCH_MAX];
        uint32_t i, pn = 0;
        for (i = 0; i < M1_PATCH_MAX && i < (uint32_t)nk; i++)
            plain[i] = kit[i];
        memcpy(m1_cur, kit, (size_t)nk);                      /* the kit without its section, as format 47 */
        m1_cur_len = (uint32_t)nk;
        sec = pat_section();
        pn = eng_patterns_end(m1_cur, m1_cur_len, sec) - sec;
        memmove(plain + sec, kit + sec + pn, (size_t)nk - sec - pn);
        plain[1] = 47;
        plain[7] &= (uint8_t)~ENG_FLAG_PATTERNS;
        CHECK(m1_valid(plain, (uint32_t)nk - pn));
        m1_set_current(plain, (uint32_t)nk - pn);
        CHECK(m1_cur[1] == ENG_PATCH_VERSION && eng_load(m1_cur, m1_cur_len) == 0 && eng_patterns_record(0, 0) == 0);
        pl[0] = 1;
        pl[1] = 0;
        CHECK(send_frame(C_PATTERN, pl, 2u) == 1 && (m1_cur[7] & ENG_FLAG_PATTERNS) && m1_cur_len == (uint32_t)nk - pn + 4u && pat_agree());
        pl[0] = 0;
        CHECK(send_frame(C_PATTERN, pl, 2u) == 1 && !(m1_cur[7] & ENG_FLAG_PATTERNS) && m1_cur_len == (uint32_t)nk - pn && pat_agree());
        CHECK(!memcmp(m1_cur + 2, plain + 2, (size_t)nk - pn - 2u));   /* (byte for byte as it was, but for its format) */
        plain[1] = 47;                                          /* a format 47 binary with the section: refused */
        memcpy(plain, kit, (size_t)nk);
        plain[1] = 47;
        CHECK(!m1_valid(plain, (uint32_t)nk) && eng_load(plain, (uint32_t)nk) != 0);
    }
    /* malformed sections are refused */
    memcpy(m1_cur, kit, (size_t)nk);
    m1_cur_len = (uint32_t)nk;
    sec = pat_section();
    m1_cur[sec] = ENG_PATTERNS;                                /* a selected pattern past the last */
    CHECK(eng_load(m1_cur, m1_cur_len) != 0);
    m1_cur[sec] = 0;
    m1_cur[sec + 1u] = ENG_SONGS + 1u;                         /* a song past the last */
    CHECK(eng_load(m1_cur, m1_cur_len) != 0);
    m1_cur[sec + 1u] = 0;
    CHECK(eng_load(m1_cur, m1_cur_len) == 0);
    m1_cur[sec + 4u] = 0;                                      /* a track with no patterns listed */
    CHECK(eng_load(m1_cur, m1_cur_len) != 0);
    free(kit);
    free(song);
    printf("patterns ok\n");
    return 0;
}

int main(int argc, char **argv)
{
    if (argc >= 2 && !strcmp(argv[1], "--old"))
        return old_format(argc - 2, argv + 2);
    long np, ns, i, at = 0;
    uint8_t *patch, *syx;
    static int32_t a_l[128 * 40], a_r[128 * 40], b_l[128 * 40], b_r[128 * 40];
    uint32_t mod, par, acks_ok = 0, amod, ain;
    int32_t val, aval;
    if (argc < 9)
        return 2;
    patch = slurp(argv[1], &np);
    syx = slurp(argv[2], &ns);
    mod = (uint32_t)atoi(argv[3]);
    par = (uint32_t)atoi(argv[4]);
    val = atoi(argv[5]);
    amod = (uint32_t)atoi(argv[6]);
    ain = (uint32_t)atoi(argv[7]);
    aval = atoi(argv[8]);
    /* A minimal poly group exercises protocol framing independently of module parameter counts. */
    {
        uint8_t bin[8u + ENG_GROUP_REC + ENG_PANEL_BYTES] = {0};
        bin[0] = 0xA1u; bin[1] = 37u; bin[3] = 1u;
        bin[8] = 3u; bin[9] = 3u; bin[11] = 0x82u;
        CHECK(m1_valid(bin, sizeof bin));
        bin[1] = 36u; CHECK(!m1_valid(bin, sizeof bin));
        bin[9] = 0u; CHECK(!m1_valid(bin, sizeof bin));
        bin[11] = 2u; CHECK(m1_valid(bin, sizeof bin));
        bin[1] = 37u; bin[9] = 4u; CHECK(!m1_valid(bin, sizeof bin));
        bin[9] = 3u; bin[11] = 0x83u; CHECK(!m1_valid(bin, sizeof bin));
        bin[11] = 2u; bin[8] = 0x23u; CHECK(!m1_valid(bin, sizeof bin));
        bin[1] = 38u; CHECK(m1_valid(bin, sizeof bin));
        bin[8] = 0x93u; CHECK(!m1_valid(bin, sizeof bin));
        bin[8] = 0x20u; CHECK(!m1_valid(bin, sizeof bin));
        bin[8] = 0x89u; CHECK(!m1_valid(bin, sizeof bin));
        bin[8] = 3u; bin[10] = 0xC2u; CHECK(!m1_valid(bin, sizeof bin));
        bin[1] = 39u; CHECK(m1_valid(bin, sizeof bin));
        bin[10] = 0x42u; CHECK(!m1_valid(bin, sizeof bin));
        bin[10] = 0xC3u; CHECK(!m1_valid(bin, sizeof bin));
    }
    /* reference: direct load + parameter */
    CHECK(eng_load(patch, (uint32_t)np) == 0);
    eng_set_param(mod, par, val);
    eng_set_att(amod, ain, aval);
    run(a_l, a_r);
    eng_all_notes_off();
    /* protocol: the frames, then the same render */
    CHECK(eng_load(patch, 8) != 0 || 1);                      /* anything: the upload must replace it */
    while (at < ns) {
        long start = at + 1, end = start;
        CHECK(syx[at] == 0xF0);
        while (syx[end] != 0xF7)
            end++;
        CHECK(m1_handle(syx + start, (uint32_t)(end - start)) == 1);
        at = end + 1;
    }
    for (i = 0; i < (long)nreplies; i++) {
        uint8_t p[8];
        uint32_t n = m1_unpack7(replies[i] + 5, reply_len[i] - 6u, p, sizeof p);
        CHECK(replies[i][4] == R_ACK && n >= 4u);
        CHECK(p[2] == S_OK);
        acks_ok++;
    }
    CHECK(applied == 1);
    CHECK(m1_cur_len == (uint32_t)np || (patch[1] < ENG_PATCH_VERSION && m1_cur[1] == ENG_PATCH_VERSION));   /* (an older format's: upgraded) */
    run(b_l, b_r);
    CHECK(memcmp(a_l, b_l, sizeof a_l) == 0 && memcmp(a_r, b_r, sizeof a_r) == 0);
    /* the stored copy carries the live parameter */
    {
        uint32_t at2 = m1_record(mod) + 1u + 4u * par, at3 = m1_record(amod) + 1u + 4u * DEFS[m1_cur[m1_record(amod)]].npar + 4u * ain;
        CHECK((int32_t)((uint32_t)m1_cur[at2] | (uint32_t)m1_cur[at2 + 1] << 8 | (uint32_t)m1_cur[at2 + 2] << 16 | (uint32_t)m1_cur[at2 + 3] << 24) == val);
        CHECK((int32_t)((uint32_t)m1_cur[at3] | (uint32_t)m1_cur[at3 + 1] << 8 | (uint32_t)m1_cur[at3 + 2] << 16 | (uint32_t)m1_cur[at3 + 3] << 24) == aval);
    }
    /* a corrupted commit is refused and the old patch keeps running */
    nreplies = 0;
    {
        uint8_t bad[8] = {0x7D, 0x4D, 0x31, C_COMMIT, 0, 0, 0, 0};
        CHECK(m1_handle(bad, sizeof bad) == 1);
        CHECK(nreplies == 1);
    }
    /* DIAG: a page of 32 bytes fits a reply (m1_reply's frame), the last is short, past the end only the page byte */
    {
        uint32_t pg;
        for (pg = 0; pg < 3u; pg++) {
            uint8_t q[6] = {0x7D, 0x4D, 0x31, C_DIAG, (uint8_t)pg, 0}, p[40];   /* (the page byte packed: two septets) */
            uint32_t n;
            nreplies = 0;
            CHECK(m1_handle(q, sizeof q) == 1);
            CHECK(nreplies == 1 && replies[0][4] == R_DIAG);
            n = m1_unpack7(replies[0] + 5, reply_len[0] - 6u, p, sizeof p);
            CHECK(n == (pg == 0u ? 33u : pg == 1u ? 8u : 1u) && p[0] == pg && (n < 2u || p[1] == pg * 32u));
        }
    }
    /* LIVE (no payload): the hook, and no reply (it comes every 2 s) */
    {
        uint8_t q[4] = {0x7D, 0x4D, 0x31, C_LIVE};
        nreplies = 0;
        CHECK(m1_handle(q, sizeof q) == 1);
        CHECK(live_calls == 1 && live_paused_arg == 0u && nreplies == 0);
    }
    /* LIVE paused (#200): its byte reaches the hook (the editor's patch is over the budget), and still no reply */
    {
        uint8_t q[16] = {0x7D, 0x4D, 0x31, C_LIVE}, one = 1;
        uint32_t n = 4u + m1_pack7(&one, 1u, q + 4);
        nreplies = 0;
        CHECK(m1_handle(q, n) == 1);
        CHECK(live_calls == 2 && live_paused_arg == 1u && nreplies == 0);
    }
    /* HELLO: INFO with feature bit 8 (sandbox mode, INFO byte 6) and MENU > MIDI OUT in flag bit 2 */
    {
        uint8_t q[4] = {0x7D, 0x4D, 0x31, C_HELLO}, p[16];
        uint32_t n;
        nreplies = 0;
        CHECK(m1_handle(q, sizeof q) == 1 && nreplies == 1 && replies[0][4] == R_INFO);
        n = m1_unpack7(replies[0] + 5, reply_len[0] - 6u, p, sizeof p);
        CHECK(n == 9u && p[7] == ENG_PATCH_COMPAT_VERSION && p[8] == ENG_PATCH_VERSION);
        CHECK(p[5] == M1_FEATURES && p[6] == M1_FEATURES2 && (p[3] & M1_INFO_MIDI_OUT));
        midi_out_on = 0;
        nreplies = 0;
        CHECK(m1_handle(q, sizeof q) == 1 && nreplies == 1);
        n = m1_unpack7(replies[0] + 5, reply_len[0] - 6u, p, sizeof p);
        CHECK(n == 9u && p[7] == ENG_PATCH_COMPAT_VERSION && p[8] == ENG_PATCH_VERSION);
        CHECK(!(p[3] & M1_INFO_MIDI_OUT));
        midi_out_on = 1;
    }
    /* SANDBOX: the frame web/src/protocol.ts made (golden.ts), parsed field by field; one byte short: not taken, no reply */
    if (argc > 11) {
        long nsb;
        uint8_t *sb = slurp(argv[11], &nsb);
        CHECK(nsb > 6 && sb[0] == 0xF0 && sb[nsb - 1] == 0xF7);
        nreplies = 0;
        CHECK(m1_handle(sb + 1, (uint32_t)nsb - 2u) == 1 && nreplies == 0 && sb_calls == 1);
        CHECK(sb_got.rows == 7u && sb_got.index == 2u && sb_got.count == 5u);
        CHECK(!strcmp(sb_got.patch, "SOL 29N XL") && !strcmp(sb_got.dev, "Sol filter") && !strcmp(sb_got.page, "FILTER 1/2"));
        CHECK(!strcmp(sb_got.label[0], "Cutoff") && !strcmp(sb_got.value[0], "2.40") && !strcmp(sb_got.unit[0], "kHz")
              && sb_got.pos[0] == 150u && sb_got.steps[0] == 0u);
        CHECK(!strcmp(sb_got.label[1], "Res") && !strcmp(sb_got.value[1], "-12") && !strcmp(sb_got.unit[1], "dB") && sb_got.pos[1] == 255u);
        CHECK(!strcmp(sb_got.label[2], "Wave") && !strcmp(sb_got.value[2], "SAW") && !sb_got.unit[2][0] && sb_got.pos[2] == 0u
              && sb_got.steps[2] == 4u);
        CHECK(!sb_got.label[3][0] && !sb_got.value[3][0]);
        {
            uint8_t d[SB_BYTES], fr[8u + (8u * SB_BYTES + 6u) / 7u];
            uint32_t w;
            memset(d, 0, sizeof d);
            fr[0] = 0x7D; fr[1] = 0x4D; fr[2] = 0x31; fr[3] = C_SANDBOX;
            w = 4u + m1_pack7(d, SB_BYTES - 1u, fr + 4);
            CHECK(m1_handle(fr, w) == 1 && sb_calls == 1 && nreplies == 0);
        }
        printf("sandbox ok\n");
    }
    if (argc > 9) {                                              /* the preset bank commands */
        long ns2;
        uint8_t *sx = slurp(argv[9], &ns2);
        long q = 0;
        uint32_t nack_ok = 0, nack_bad = 0, got_info = 0;
        nreplies = 0;
        while (q < ns2) {
            long start = q + 1, end = start;
            while (sx[end] != 0xF7)
                end++;
            CHECK(m1_handle(sx + start, (uint32_t)(end - start)) == 1);
            q = end + 1;
        }
        for (i = 0; i < (long)nreplies; i++) {
            uint8_t p[40];
            uint32_t n = m1_unpack7(replies[i] + 5, reply_len[i] - 6u, p, sizeof p);
            if (replies[i][4] == R_SLOT) {
                CHECK(n >= 24u && p[0] == 5 && p[1] == 1 && (uint32_t)(p[2] | p[3] << 8) == (uint32_t)np && strcmp((char *)p + 4, "303 ACID") == 0);
                got_info = 1;
            } else if (p[2] == S_OK) {
                nack_ok++;
            } else {
                nack_bad++;
            }
        }
        CHECK(got_info);
        CHECK(slot_writes == 1 && slot_erases == 1);          /* the bad CRC was refused */
        CHECK(nack_bad == 1);
        CHECK(nack_ok >= 4u);
        CHECK(memcmp(last_data, patch, (size_t)np) == 0 && strcmp(last_name, "303 ACID") == 0);
        printf("slot commands ok: %u acks, %u refused\n", nack_ok, nack_bad);
    }
    /* Legacy fixed-link masks (flag bit 2, written by format 17 editors) survive framing, load and live macro-range edits. */
    {
        static uint8_t flat[M1_PATCH_MAX];               /* the fixture without its device pages: the raw sections go at its end */
        uint32_t base, count = patch[2];
        CHECK(!(patch[6] & 6u)); /* this fixture has no ranges or fixed-link masks */
        memcpy(m1_cur, patch, (size_t)np);
        m1_cur_len = (uint32_t)np;
        base = m1_devices_at() ? m1_devices_at() : (uint32_t)np;
        memcpy(flat, patch, base);
        flat[6] &= (uint8_t)~32u;
        flat[7] &= (uint8_t)~ENG_FLAG_EXTRAS;              /* (the device extras go with the pages) */
        memcpy(m1_cur, flat, base);
        memset(m1_cur + base, 0, count);
        /* (the fixture's own format: a patch that uses nothing newer is written in an older one, patchbin.ts WRITE_FLOOR) */
        m1_cur[6] |= 4u;
        m1_cur[base + mod] = 1u << FILTER_I_CV;
        m1_cur_len = base + count;
        CHECK(m1_valid(m1_cur, m1_cur_len));
        CHECK(!m1_valid(m1_cur, m1_cur_len - 1));
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);
        CHECK(!(E.node[mod].conn & (1u << FILTER_I_CV)));
        CHECK(inst_pool[E.node[mod].inst0].in[FILTER_I_CV] == zero_buf);
        CHECK(E.ncab == (uint32_t)(flat[4] | flat[5] << 8));
        m1_patch_range(mod, 0, par, 1, 20, 220);
        CHECK(m1_range_section() == base + count);
        CHECK(m1_valid(m1_cur, m1_cur_len));
        CHECK(m1_cur[base + mod] == (1u << FILTER_I_CV));
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);
        m1_patch_range(mod, 0, par, 0, 0, 0);
        CHECK(m1_cur_len == base + count && m1_valid(m1_cur, m1_cur_len));
        m1_cur[base + mod] = 0x80; /* not a fixed input */
        CHECK(eng_load(m1_cur, m1_cur_len) != 0);
        CHECK(eng_load(flat, base) == 0);
        /* Additional input routes (flag bit 3) retain the raw CV buffer for extra destinations when the fixed link is off. */
        memcpy(m1_cur, flat, base);
        memset(m1_cur + base, 0, count);
        m1_cur[6] |= 12u;
        m1_cur[base + mod] = 1u << FILTER_I_CV;
        m1_cur_len = base + count + 5u;
        m1_cur[base + count] = 1;
        m1_cur[base + count + 1] = (uint8_t)mod;
        m1_cur[base + count + 2] = FILTER_I_CV;
        m1_cur[base + count + 3] = (1u << FILTER_P_RES) | (1u << FILTER_P_CVAMT);
        m1_cur[base + count + 4] = 0;
        CHECK(m1_valid(m1_cur, m1_cur_len));
        CHECK(!m1_valid(m1_cur, m1_cur_len - 1));
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);
        CHECK(E.node[mod].input_map[FILTER_I_CV] == ((1u << FILTER_P_RES) | (1u << FILTER_P_CVAMT)));
        CHECK(!(E.node[mod].conn & (1u << FILTER_I_CV)));
        m1_patch_range(mod, 0, par, 1, 20, 220);
        CHECK(m1_range_section() == base + count + 5u);
        CHECK(m1_valid(m1_cur, m1_cur_len) && eng_load(m1_cur, m1_cur_len) == 0);
        m1_patch_range(mod, 0, par, 0, 0, 0);
        CHECK(m1_cur_len == base + count + 5u);
        m1_cur[1] = ENG_PATCH_COMPAT_VERSION - 1; CHECK(!m1_valid(m1_cur, m1_cur_len));   /* records of an older format */
        CHECK(eng_load(m1_cur, m1_cur_len) != 0); m1_cur[1] = patch[1];
        m1_cur[base + count + 2] = FILTER_I_P1;
        CHECK(eng_load(m1_cur, m1_cur_len) != 0);
        m1_cur[base + count + 2] = FILTER_I_CV;
        m1_cur[base + count + 4] = 0x80;
        CHECK(eng_load(m1_cur, m1_cur_len) != 0);
        CHECK(eng_load(flat, base) == 0);
        printf("fixed input routing and legacy patch framing ok\n");
    }
    if (argc > 10) {                                             /* the tracks' notes (#133): the steps-kit patch */
        long nk;
        uint8_t *kit = slurp(argv[10], &nk);
        int t0, t1, n0, n1;
        uint32_t base, end, devb;
        const uint32_t *w;
        CHECK((kit[6] & 16u) && !(kit[6] & 2u));                 /* notes, no ranges */
        memcpy(m1_cur, kit, (size_t)nk);
        m1_cur_len = (uint32_t)nk;
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);
        CHECK(eng_steps_count() >= 2);
        t0 = eng_steps_module(0);
        t1 = eng_steps_module(1);
        n0 = eng_steps_notes((uint32_t)t0, &w);
        n1 = eng_steps_notes((uint32_t)t1, &w);
        CHECK(n0 > 0 && n1 > 0);
        {                                                        /* R_TRACK (m1_track_now): module, n, n words LE, 7-bit packed */
            uint8_t d[3u + 4u * TRACK_NOTES_MAX];
            uint32_t r0 = nreplies, len, i;
            n0 = eng_steps_notes((uint32_t)t0, &w);
            CHECK(n0 <= 100);                                    /* (a reply buffer holds 512 B) */
            m1_track_now((uint32_t)t0);
            CHECK(nreplies == r0 + 1u && reply_len[r0] > 6u);
            CHECK(replies[r0][0] == 0xF0 && replies[r0][1] == 0x7D && replies[r0][2] == 0x4D && replies[r0][3] == 0x31
                  && replies[r0][4] == R_TRACK && replies[r0][reply_len[r0] - 1u] == 0xF7);
            len = m1_unpack7(replies[r0] + 5, reply_len[r0] - 6u, d, sizeof d);
            CHECK(len == 3u + 4u * (uint32_t)n0 && d[0] == (uint8_t)t0 && d[1] == (uint8_t)n0 && d[len - 1u] == 0u);   /* (pattern 1) */
            for (i = 0; i < (uint32_t)n0; i++)
                CHECK((d[2 + 4 * i] | d[3 + 4 * i] << 8 | d[4 + 4 * i] << 16 | (uint32_t)d[5 + 4 * i] << 24) == w[i]);
            CHECK(reply_len[r0] == 6u + m1_pack7(d, len, replies[63])           /* byte for byte what m1_pack7 gives */
                  && !memcmp(replies[r0] + 5, replies[63], reply_len[r0] - 6u));
            nreplies = r0;
        }
        base = m1_notes_at();
        end = eng_notes_end(m1_cur, m1_cur_len, base);
        devb = (m1_cur[6] & 32u) ? eng_devices_end(m1_cur, m1_cur_len, end) - end : 0u;   /* the device pages follow */
        if (m1_cur[7] & ENG_FLAG_EXTRAS)                          /* then the device extras (format 34) */
            devb = eng_extras_end(m1_cur, m1_cur_len, end + devb) - end;
        CHECK(end && end + devb == m1_cur_len && m1_cur[base] >= 2u);
        CHECK(eng_steps_get((uint32_t)t0, 5) == 0 && eng_steps_value((uint32_t)t0, 5) == (STEP_NOTE | STEP_VEL << 8));
        m1_patch_step((uint32_t)t0, 5, 1u);                      /* a note more: the entry grows by one word */
        CHECK(eng_steps_get((uint32_t)t0, 5) == 1 && m1_cur_len == (uint32_t)nk + 4u);
        m1_patch_stepval((uint32_t)t0, 5, 67, 30);
        CHECK(m1_valid(m1_cur, m1_cur_len) && !m1_valid(m1_cur, m1_cur_len - 1));
        m1_patch_range((uint32_t)t1, 0, STEPS_P_SWING, 1, 10, 200);   /* ranges come after the notes */
        CHECK(m1_range_section() == eng_notes_end(m1_cur, m1_cur_len, base) + devb);
        m1_patch_step((uint32_t)t0, 6, 0x80u);                   /* a tie: the note on step 5 goes on through step 6 */
        CHECK(eng_steps_get((uint32_t)t0, 6) == 0x80 && m1_cur_len == (uint32_t)nk + 4u + 6u);
        m1_patch_step((uint32_t)t0, 6, 0u);                      /* untied */
        CHECK(eng_steps_get((uint32_t)t0, 6) == 0);
        n1 = m1_cur[base];
        CHECK(eng_steps_set_notes((uint32_t)t1, 0, 0));          /* every note of a track gone: its entry goes */
        m1_patch_track((uint32_t)t1);
        CHECK(m1_cur[base] == (uint8_t)(n1 - 1) && m1_valid(m1_cur, m1_cur_len) && m1_range_section() == eng_notes_end(m1_cur, m1_cur_len, base) + devb);
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);               /* SAVE keeps them: a reload plays the same notes */
        CHECK(eng_steps_value((uint32_t)t0, 5) == (67 | 30 << 8));
        CHECK(eng_steps_notes((uint32_t)t1, &w) == 0 && eng_steps_notes((uint32_t)t0, &w) == n0 + 1);
        CHECK(E.nranges == 0 || E.ranges[0].mod == (uint8_t)t1);
        {                                                        /* every track emptied: the section goes */
            int t;
            for (t = 0; t < eng_steps_count(); t++) {
                CHECK(eng_steps_set_notes((uint32_t)eng_steps_module((uint32_t)t), 0, 0));
                m1_patch_track((uint32_t)eng_steps_module((uint32_t)t));
            }
            CHECK(!(m1_cur[6] & 16u) && m1_valid(m1_cur, m1_cur_len));
            m1_patch_step((uint32_t)t1, 0, 3u);                  /* and comes back with one track's entry */
            CHECK((m1_cur[6] & 16u) && m1_cur[base] == 1u && m1_cur[base + 1u] == (uint8_t)t1 && m1_valid(m1_cur, m1_cur_len));
            CHECK(eng_load(m1_cur, m1_cur_len) == 0 && eng_steps_get((uint32_t)t1, 0) == 3);
        }
        m1_cur[base + 1u] = 0;                                   /* an entry that names a module that is not a Steps module */
        if (eng_steps_module(0) != 0)
            CHECK(eng_load(m1_cur, m1_cur_len) != 0);
        m1_cur[1] = 30;                                          /* format 30 had step values there */
        CHECK(!m1_valid(m1_cur, m1_cur_len));
        printf("track notes ok\n");
    }
    if (argc > 13 && patterns_test(argv[12], argv[13]))         /* format 48: the patterns and songs */
        return 1;
    {   /* the presets (#195): PUT, PRESETS, GET, DEL, the full store, PRESET_STORED */
        uint8_t pl[4 + 16 + 1 + 4 * 88], fr[8 + (8 * sizeof pl + 6) / 7], got[sizeof pl];
        uint32_t w, k, n0;
        int32_t vals[3] = {65536, -2, 123456};
        memset(pl, 0, sizeof pl);
        pl[0] = 0x78; pl[1] = 0x56; pl[2] = 0x34; pl[3] = 0x12;   /* structure 0x12345678 */
        memcpy(pl + 4, "GLASS", 5);
        pl[20] = 3;
        for (k = 0; k < 3u; k++) {
            uint32_t x = (uint32_t)vals[k];
            pl[21 + 4 * k] = (uint8_t)x; pl[22 + 4 * k] = (uint8_t)(x >> 8); pl[23 + 4 * k] = (uint8_t)(x >> 16); pl[24 + 4 * k] = (uint8_t)(x >> 24);
        }
        fr[0] = 0x7D; fr[1] = 0x4D; fr[2] = 0x31; fr[3] = C_PRESET_PUT;
        w = 4 + m1_pack7(pl, 21 + 12, fr + 4);
        n0 = nreplies;
        CHECK(m1_handle(fr, w) == 1 && nreplies == n0 + 1 && replies[n0][4] == R_ACK);
        CHECK(m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 3 && got[0] == C_PRESET_PUT && got[2] == S_OK);
        fr[3] = C_PRESETS;
        n0 = nreplies;
        CHECK(m1_handle(fr, 4) == 1 && nreplies == n0 + 1 && replies[n0][4] == R_PRESET);
        CHECK(m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 23 && got[1] == 1 && !memcmp(got + 6, "GLASS", 5) && got[22] == 3);
        fr[3] = C_PRESET_GET;
        w = 4 + m1_pack7(pl, 20, fr + 4);
        n0 = nreplies;
        CHECK(m1_handle(fr, w) == 1 && replies[n0][4] == R_PRESET_DATA);
        CHECK(m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 33 && got[20] == 3 && !memcmp(got + 21, pl + 21, 12));
        fr[3] = C_PRESET_DEL;
        n0 = nreplies;
        CHECK(m1_handle(fr, w) == 1 && m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 3 && got[2] == S_OK);
        n0 = nreplies;
        CHECK(m1_handle(fr, w) == 1 && m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 3 && got[2] == S_MISSING);
        fr[3] = C_PRESET_GET;
        n0 = nreplies;
        CHECK(m1_handle(fr, w) == 1 && m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 21 && got[20] == 0xFF);
        n0 = nreplies;
        m1_preset_stored(0x12345678u, "DUSK");
        CHECK(nreplies == n0 + 1 && replies[n0][4] == R_PRESET_STORED);
        printf("presets ok\n");
    }
    {   /* the device test mode (#291): TEST_KEY / TEST_TURN answer ACK, SCREEN a head and one frame per text, PEAK */
        uint8_t fr[64], pl[4], got[64];
        uint32_t w, n0;
        nreplies = 0;
        fr[0] = 0x7D; fr[1] = 0x4D; fr[2] = 0x31; fr[3] = C_TEST_KEY;
        pl[0] = 10; pl[1] = 1;
        w = 4 + m1_pack7(pl, 2, fr + 4);
        CHECK(m1_handle(fr, w) == 1 && test_key_id == 10 && test_key_down == 1 && nreplies == 1 && replies[0][4] == R_ACK);
        CHECK(m1_unpack7(replies[0] + 5, reply_len[0] - 6, got, sizeof got) >= 3 && got[0] == C_TEST_KEY && got[1] == 10 && got[2] == S_OK);
        pl[0] = 41;
        w = 4 + m1_pack7(pl, 2, fr + 4);
        CHECK(m1_handle(fr, w) == 1 && m1_unpack7(replies[1] + 5, reply_len[1] - 6, got, sizeof got) >= 3 && got[2] == S_RANGE);
        fr[3] = C_TEST_TURN;
        pl[0] = 6; pl[1] = 0xFE;                             /* PRESET, -2 */
        w = 4 + m1_pack7(pl, 2, fr + 4);
        CHECK(m1_handle(fr, w) == 1 && test_turn_enc == 6 && test_turn_clicks == -2);
        CHECK(m1_unpack7(replies[2] + 5, reply_len[2] - 6, got, sizeof got) >= 3 && got[0] == C_TEST_TURN && got[2] == S_OK);
        fr[3] = C_TEST_SCREEN;
        n0 = nreplies;
        CHECK(m1_handle(fr, 4) == 1 && nreplies == n0 + 3 && replies[n0][4] == R_SCREEN && replies[n0 + 2][4] == R_SCREEN);
        CHECK(m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 4 && got[0] == 0xFF && got[1] == 2 && got[3] == 1);
        CHECK(m1_unpack7(replies[n0 + 2] + 5, reply_len[n0 + 2] - 6, got, sizeof got) >= 19 && got[0] == 1 && got[1] == 11 && got[2] == 20
              && got[5] == 13 && !memcmp(got + 6, "BROWSER PLAYS", 13));
        fr[3] = C_TEST_PEAK;
        n0 = nreplies;
        CHECK(m1_handle(fr, 4) == 1 && nreplies == n0 + 1 && replies[n0][4] == R_PEAK);
        CHECK(m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 3 && got[0] == (1234 & 255) && got[1] == (1234 >> 8) && got[2] == 3);
        fr[3] = C_HELLO;
        n0 = nreplies;
        CHECK(m1_handle(fr, 4) == 1 && m1_unpack7(replies[n0] + 5, reply_len[n0] - 6, got, sizeof got) >= 7 && (got[6] & 2u));
        printf("test mode ok\n");
    }
    printf("proto ok: %u acks, %ld patch bytes, render identical\n", acks_ok, np);
    return 0;
}
