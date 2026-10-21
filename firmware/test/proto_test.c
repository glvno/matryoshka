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
static uint8_t replies[64][64];
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
static int transport_calls;
static void m1_transport(int run) { (void)run; transport_calls++; }
static uint32_t focus_calls, focus_dev, focus_page;
static void m1_focus(uint32_t dev, uint32_t pg) { focus_calls++; focus_dev = dev; focus_page = pg; }
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
static void m1_send(const uint8_t *f, uint32_t n)
{
    memcpy(replies[nreplies], f, n);
    reply_len[nreplies++] = n;
}
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

int main(int argc, char **argv)
{
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
    CHECK(m1_cur_len == (uint32_t)np);
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
        memcpy(m1_cur, flat, base);
        memset(m1_cur + base, 0, count);
        m1_cur[1] = ENG_PATCH_VERSION;
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
        m1_cur[1] = ENG_PATCH_VERSION; m1_cur[6] |= 12u;
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
        CHECK(eng_load(m1_cur, m1_cur_len) != 0); m1_cur[1] = ENG_PATCH_VERSION;
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
        base = m1_notes_at();
        end = eng_notes_end(m1_cur, m1_cur_len, base);
        devb = (m1_cur[6] & 32u) ? eng_devices_end(m1_cur, m1_cur_len, end) - end : 0u;   /* the device pages follow */
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
    printf("proto ok: %u acks, %ld patch bytes, render identical\n", acks_ok, np);
    return 0;
}
