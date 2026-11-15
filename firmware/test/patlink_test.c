/* SPDX-License-Identifier: GPL-3.0-only */
/* Host test of the pattern store's glue (#901, firmware/src/patlink.c), with the store itself (patstore.c) and the bank
 * (slotstore.c) over RAM flash, and proto.c (proto_test.c's stand-ins for the rest):
 *   - the payload of each case in pattern_cases.h (web/scripts/pattern-vectors.ts, written by export-defs) byte for byte
 *     as the editor writes it, the layout fingerprint, and the payload read back into a cleared pattern and written again;
 *   - a format 59 patch: the clean linked pattern left out of the binary, its content from the store at load, the link
 *     kept when the entry is gone, SAVE's write-back of an edited linked pattern (and the link dropped when its entry is
 *     gone), a patch without links rewritten byte for byte as it was;
 *   - the SEQ page's save, save as new and load (a factory entry, another layout's locks left out);
 *   - INFO, PATS, PAT_GET, PAT_PUT (in chunks), PAT_DEL (S_USED with a slot that links the entry, force, read-only).
 * tools/patlink_test.sh builds and runs it. */
#define PROTO_TEST_PATLINK
#define main proto_test_main
#include "proto_test.c"
#undef main
#include "../src/presets.h"
#include "pattern_cases.h"

/* NOR flash in RAM from the bank's first sector to the store's end: erase sets 0xFF, a write only clears bits */
#define NOR0 0x97000u
static uint8_t nor[0xE0000u - NOR0];
static int nor_in(uint32_t off, uint32_t n) { return off >= NOR0 && off + n <= NOR0 + sizeof nor; }
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    if (!nor_in(off, n))
        return -1;
    memcpy(dst, nor + off - NOR0, n);
    return 0;
}
static int st_erase(uint32_t off)
{
    if (!nor_in(off & ~0xFFFu, 0x1000u))
        return -1;
    memset(nor + (off & ~0xFFFu) - NOR0, 0xFF, 0x1000u);
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    const uint8_t *s = src;
    uint32_t i;
    if (!nor_in(off, n))
        return -1;
    for (i = 0; i < n; i++)
        nor[off - NOR0 + i] &= s[i];
    return 0;
}
static void fm1_wdt_feed(void) {}
#include "../src/slotstore.c"
#include "../src/patstore.c"
#include "../src/patlink.c"

static int fails;
#define OK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); fails++; } } while (0)

static uint8_t pay[PT_MAX + 64u];
static uint32_t encode(uint32_t p, uint8_t *out)
{
    pl_out_t s = { out, PT_MAX + 64u, 0, PT_FNV0 };
    pl_encode(p, &s);
    return s.n;
}
/* the running patch as the FM-1 has it after a load: the engine, m1_cur, its links resolved */
static int load_patch(const uint8_t *b, uint32_t len)
{
    static uint8_t tmp[M1_PATCH_MAX];
    memcpy(tmp, b, len);
    if (eng_load(tmp, len))
        return -1;
    m1_set_current(tmp, len);
    return 0;
}
/* some track of the engine has pattern p */
static int has(uint32_t p)
{
    uint32_t t;
    for (t = 0; (int)t < eng_steps_count(); t++)
        if (eng_pattern_has((uint32_t)eng_steps_module(t), p))
            return 1;
    return 0;
}
/* the binary m1_cur holds pattern p inline (loaded alone, links not resolved); the running patch is loaded again after */
static int inline_has(uint32_t p)
{
    static uint8_t keep[M1_PATCH_MAX];
    uint32_t len = m1_cur_len;
    int h;
    memcpy(keep, m1_cur, len);
    if (eng_load(keep, len))
        return -1;
    h = has(p);
    (void)load_patch(keep, len);
    return h;
}
/* every track's pattern p gone (pattern 1: its notes), and p's locks */
static void clear(uint32_t p)
{
    uint32_t t, none = 0;
    for (t = 0; (int)t < eng_steps_count(); t++) {
        if (p)
            eng_pattern_drop((uint32_t)eng_steps_module(t), p);
        else
            (void)eng_pattern_set_notes((uint32_t)eng_steps_module(t), 0, &none, 0);
    }
    eng_locks_clear(p);
}
static uint32_t frame(uint32_t cmd, const uint8_t *p, uint32_t n)
{
    static uint8_t f[1024];
    f[0] = 0x7D;
    f[1] = 0x4D;
    f[2] = 0x31;
    f[3] = (uint8_t)cmd;
    nreplies = 0;
    return (uint32_t)m1_handle(f, 4u + m1_pack7(p, n, f + 4));
}
static uint32_t reply(uint32_t k, uint32_t cmd, uint8_t *out, uint32_t cap)
{
    if (k >= nreplies || replies[k][4] != cmd)
        return 0;
    return m1_unpack7(replies[k] + 5, reply_len[k] - 6u, out, cap);
}
static uint32_t rd16(const uint8_t *b) { return (uint32_t)b[0] | (uint32_t)b[1] << 8; }
static int link_told(uint32_t p, uint32_t id)
{
    uint8_t b[8];
    uint32_t k;
    for (k = 0; k < nreplies; k++)
        if (reply(k, R_PAT_LINK_NOW, b, sizeof b) == 7u && b[0] == p && rd16(b + 1) == id)
            return 1;
    return 0;
}

static void vectors(void)
{
    uint32_t c, n;
    for (c = 0; c < N_PATTERN_CASES; c++) {
        uint32_t p = PATTERN_CASES[c].pattern;
        if (load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len)) {
            OK(!"the case loads");
            continue;
        }
        n = encode(p, pay);
        if (n != PATTERN_CASES[c].payload_len || memcmp(pay, PATTERN_CASES[c].payload, n))
            fprintf(stderr, "case %s: the payload differs from the editor's\n", PATTERN_CASES[c].name);
        OK(n == PATTERN_CASES[c].payload_len && !memcmp(pay, PATTERN_CASES[c].payload, n));
        OK(pl_layout() == PATTERN_CASES[c].layout);
        clear(p);
        OK(pl_apply(p, PATTERN_CASES[c].payload, PATTERN_CASES[c].payload_len) == 0);
        n = encode(p, pay);
        OK(n == PATTERN_CASES[c].payload_len && !memcmp(pay, PATTERN_CASES[c].payload, n));
    }
    printf("patlink: %u payload vectors as the editor writes them, and back\n", (unsigned)N_PATTERN_CASES);
}

/* one note, for an edit */
static const uint32_t *notes_one(void)
{
    static uint32_t w[1];
    w[0] = NW(3u, 2u, 50u, STEP_VEL, 0u);
    return w;
}

/* the case with locks on pattern 2 (index 1): linked, left out, loaded back from the store, written back at SAVE */
static void links(void)
{
    static uint8_t orig[M1_PATCH_MAX], linked[M1_PATCH_MAX], want[PT_MAX + 64u];
    uint32_t c, p, id = 0, n, wn, len, ln;
    pt_info_t in;
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "LOCKS P2"); c++)
        ;
    OK(c < N_PATTERN_CASES);
    if (c == N_PATTERN_CASES)
        return;
    p = PATTERN_CASES[c].pattern;
    OK(p >= 1u && !load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
    len = m1_cur_len;
    memcpy(orig, m1_cur, len);
    m1_patch_patterns();                             /* (a patch without links: written as it was) */
    OK(m1_patch_locks() && m1_patch_links() && m1_cur_len == len && !memcmp(orig, m1_cur, len));
    wn = encode(p, want);
    OK(!pt_put(&id, "LOCKS P2", want, wn) && id);
    /* linked, clean: the binary keeps the link, not the pattern */
    pl_id[p] = (uint16_t)id;
    pl_hash[p] = pt_fnv(PT_FNV0, want, wn);
    pl_rewrite();
    OK(m1_cur[1] == ENG_PATCH_VERSION && (m1_cur[7] & ENG_FLAG_LINKS) && m1_valid(m1_cur, m1_cur_len));
    OK(m1_cur_len < len && inline_has(p) == 0);
    ln = m1_cur_len;
    memcpy(linked, m1_cur, ln);
    /* loaded: the store gives the pattern back, as it was */
    OK(!load_patch(linked, ln) && has(p) && pl_id[p] == id);
    n = encode(p, pay);
    OK(n == wn && !memcmp(pay, want, n));
    OK(m1_pat_clean() == (uint64_t)1u << p);
    /* edited: inline, notes and locks, until SAVE writes it over its entry */
    {
        const uint32_t *w;
        uint32_t notes[TRACK_NOTES_MAX], m = (uint32_t)eng_steps_module(0), k;
        int cnt = eng_pattern_notes(m, p, &w);
        for (k = 0; (int)k < cnt; k++)
            notes[k] = w[k];
        notes[cnt] = NW(9u, 1u, 60u, STEP_VEL, 0u);
        OK(eng_pattern_set_notes(m, p, notes, (uint32_t)cnt + 1u));
        m1_patch_track(m);
    }
    OK(m1_pat_clean() == 0 && inline_has(p) == 1);
    nreplies = 0;
    pl_writeback();
    n = encode(p, pay);
    OK(!pt_read(id, want, sizeof want, &in) && in.len == n && !memcmp(want, pay, n) && pl_hash[p] == in.hash);
    OK(link_told(p, id) && m1_pat_clean() == (uint64_t)1u << p && inline_has(p) == 0);
    /* its entry gone: the pattern absent at load, the link kept */
    OK(!pt_del(id));
    OK(!load_patch(linked, ln) && !has(p) && pl_id[p] == id && (m1_cur[7] & ENG_FLAG_LINKS));
    m1_patch_patterns();
    OK(m1_patch_links() && (m1_cur[7] & ENG_FLAG_LINKS));
    /* edited with its entry gone: SAVE drops the link, the pattern stays inline */
    OK(eng_pattern_set_notes((uint32_t)eng_steps_module(0), p, notes_one(), 1u));
    m1_patch_track((uint32_t)eng_steps_module(0));
    nreplies = 0;
    pl_writeback();
    OK(!pl_id[p] && !(m1_cur[7] & ENG_FLAG_LINKS) && inline_has(p) == 1 && link_told(p, 0));
    printf("patlink: links left out, loaded from the store, written back at SAVE\n");
}

/* the SEQ page: save, save as new, a factory entry and another layout's locks */
static void seq_page(void)
{
    char got[PT_NAME + 1u];
    uint32_t c, id = 0, p = 1;
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "LOCKS P2"); c++)
        ;
    if (c == N_PATTERN_CASES || load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len))
        return;
    OK(pl_save(p, 0, "LOCKS P2", got) == 1 && !strcmp(got, "LOCKS P2") && (id = pl_id[p]) != 0);
    OK(pl_save(p, 0, "OTHER", got) == 0 && pl_id[p] == id && !strcmp(got, "LOCKS P2"));
    OK(pl_save(p, 1, "COPY", got) == 1 && pl_id[p] != id && !strcmp(got, "COPY"));
    OK(pl_save(0, 0, "FIRST", got) == 1 && !pl_id[0]);
    OK(pl_load_entry(p, PL_FACTORY, got) == 0 && !pl_id[p] && !strcmp(got, PRESET_PATTERNS[0].name));
    {
        const uint32_t *w;
        int n = eng_pattern_notes((uint32_t)eng_steps_module(0), p, &w);
        OK(n == (int)PRESET_PATTERNS[0].n && !memcmp(w, PRESET_PATTERNS[0].notes, 4u * (uint32_t)n));
        OK(eng_pattern_len((uint32_t)eng_steps_module(0), p) == PRESET_PATTERNS[0].len);
    }
    OK(pl_load_entry(p, id, got) == 0 && pl_id[p] == id && link_told(p, id));
    {
        pt_info_t first, last;
        OK(!pt_next(0, &first) && pl_step(0, 1) == first.id && pl_step(first.id, -1) == PL_FACTORY + N_PRESET_PATTERNS - 1u);
        OK(!pt_prev(PL_FACTORY, &last) && pl_step(PL_FACTORY, -1) == last.id && pl_step(last.id, 1) == PL_FACTORY);
        OK(pl_step(PL_FACTORY + N_PRESET_PATTERNS - 1u, 1) == first.id);
    }
    /* another layout: the notes load, the locks are left out */
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "FIRST ABSENT"); c++)
        ;
    if (c < N_PATTERN_CASES && !load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len)) {
        OK(pl_layout() != PATTERN_CASES[0].layout);
        OK(pl_load_entry(1, id, got) == 1 && eng_locks_count() == 0 && pl_id[1] == id);
    }
    printf("patlink: the SEQ page's save, save as new and load\n");
}

static void link_frames(void)
{
    uint8_t b[300], e[40];
    uint32_t c, n, id = 0, k, cnt;
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "LONG WORDS"); c++)
        ;
    if (c == N_PATTERN_CASES || load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len))
        return;
    frame(C_HELLO, 0, 0);
    n = reply(0, R_INFO, b, sizeof b);
    OK(n == 20u && (b[14] & 2u) && b[15] == 60u && rd16(b + 16) > 0u && rd16(b + 18) == pt_total_bytes());
    /* PUT in two chunks */
    memset(b, 0, sizeof b);
    b[2] = (uint8_t)PATTERN_CASES[c].payload_len;
    memcpy(b + 6, "CHUNKED", 7);
    memcpy(b + 22, PATTERN_CASES[c].payload, 10);
    frame(C_PAT_PUT, b, 22u + 10u);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && rd16(e) == 0xFFFFu && e[2] == S_OK);
    b[4] = 10;
    memcpy(b + 22, PATTERN_CASES[c].payload + 10, PATTERN_CASES[c].payload_len - 10u);
    frame(C_PAT_PUT, b, 22u + PATTERN_CASES[c].payload_len - 10u);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_OK && (id = rd16(e)) >= 1u && id <= PT_ID_MAX);
    /* GET */
    b[0] = (uint8_t)id;
    b[1] = (uint8_t)(id >> 8);
    b[2] = b[3] = 0;
    frame(C_PAT_GET, b, 4);
    n = reply(0, R_PAT_DATA, b, sizeof b);
    OK(n == 6u + PATTERN_CASES[c].payload_len && rd16(b) == id && rd16(b + 2) == PATTERN_CASES[c].payload_len && !memcmp(b + 6, PATTERN_CASES[c].payload, n - 6u));
    b[0] = 0x34;
    b[1] = 0x12;
    frame(C_PAT_GET, b, 4);
    OK(reply(0, R_PAT_DATA, b, sizeof b) == 6u && rd16(b + 2) == 0xFFFFu);
    /* PATS: the user entries, then the factory ones */
    frame(C_PATS, 0, 0);
    cnt = pt_count() + N_PRESET_PATTERNS;
    OK(nreplies == cnt);
    for (k = 0; k < nreplies; k++) {
        n = reply(k, R_PAT, e, sizeof e);
        OK(n == 34u && rd16(e) == k && rd16(e + 2) == cnt);
        if (n == 34u && rd16(e + 4) == id)
            OK(rd16(e + 6) == PATTERN_CASES[c].payload_len && e[17] == 0 && !memcmp(e + 18, "CHUNKED", 8));
        if (k + 1u == nreplies)
            OK(rd16(e + 4) == PL_FACTORY + N_PRESET_PATTERNS - 1u && e[17] == 1u && e[16] == 1u);
    }
    /* read-only entries */
    memset(b, 0, sizeof b);
    b[0] = 0x00;
    b[1] = 0xFF;
    b[2] = (uint8_t)PATTERN_CASES[c].payload_len;
    memcpy(b + 22, PATTERN_CASES[c].payload, PATTERN_CASES[c].payload_len);
    frame(C_PAT_PUT, b, 22u + PATTERN_CASES[c].payload_len);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_RANGE);
    b[2] = 0;
    frame(C_PAT_DEL, b, 3);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_RANGE);
    /* DEL: used by a slot, then forced */
    pl_id[2] = (uint16_t)id;
    pl_hash[2] = pl_hash_of(2);
    pl_rewrite();
    OK(!sl_write(3, "LINKER", m1_cur, m1_cur_len));
    b[0] = (uint8_t)id;
    b[1] = (uint8_t)(id >> 8);
    b[2] = 0;
    frame(C_PAT_DEL, b, 3);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_USED && e[3] == 1u && !pt_stat(id, &(pt_info_t){0}));
    b[2] = 1;
    frame(C_PAT_DEL, b, 3);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_OK && pt_stat(id, &(pt_info_t){0}));
    OK(inline_has(2) == 1 && pl_id[2] == id);       /* (the running patch keeps it inline; SAVE drops the link) */
    frame(C_PAT_DEL, b, 3);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_MISSING);
    printf("patlink: INFO, PATS, PAT_GET, PAT_PUT and PAT_DEL\n");
}

int main(void)
{
    memset(nor, 0xFF, sizeof nor);
    sl_scan();
    pt_claim();
    if (!pt_on || bank_slots != 60u) {
        fprintf(stderr, "FAIL: the empty bank's claim did not turn the store on\n");
        return 1;
    }
    vectors();
    links();
    seq_page();
    link_frames();
    if (fails) {
        fprintf(stderr, "patlink: %d checks failed\n", fails);
        return 1;
    }
    printf("patlink ok\n");
    return 0;
}
