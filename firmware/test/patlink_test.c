/* SPDX-License-Identifier: GPL-3.0-only */
/* Host test of the pattern store's glue (#901, firmware/src/patlink.c), with the store itself (patstore.c) and the bank
 * (slotstore.c) over RAM flash, and proto.c (proto_test.c's stand-ins for the rest):
 *   - the payload of each case in pattern_cases.h (web/scripts/pattern-vectors.ts, written by export-defs) byte for byte
 *     as the editor writes it, the layout fingerprint, and the payload read back into a cleared pattern and written again;
 *   - a format 59 patch: the clean linked pattern left out of the binary, its content from the store at load, the link
 *     kept when the entry is gone, SAVE's write-back of an edited linked pattern (and the link dropped when its entry is
 *     gone), a patch without links rewritten byte for byte as it was;
 *   - the factory patches' linked patterns (#923, factory_tier.h KIT_GROUPS): every entry read back and well formed, the 808
 *     and 909 Kits with their demo sets loaded holding all their patterns and their song, with the store off too,
 *     rewritten byte for byte, and SAVE of an edited one keeping it inline without its link;
 *   - the demo sets (#1179, pl_demo_set from the factory region): each patch with one, a renamed copy and one with a
 *     parameter changed get the binary the editor gets (pattern_cases.h DEMO_CASES) and the engine the patterns that
 *     binary loads, the hash the editor checks; one with a module more or less, or without the region: NO DEMO SET and
 *     nothing changed; a patch without room for it: nothing changed;
 *   - SAVE with a power cut at every byte it programs (a user link's write-back, then the slot; a factory link's slot):
 *     after the next boot the slot plays the pattern as it was or as edited, never neither;
 *   - the SEQ page's save, save as new and load (a factory entry, another layout's locks left out);
 *   - INFO, PATS, PAT_GET, PAT_PUT (in chunks), PAT_DEL (S_USED with a slot that links the entry, force, read-only).
 * tools/patlink_test.sh builds and runs it. */
#define PROTO_TEST_PATLINK
#define PROTO_TEST_FACTORY
#define main proto_test_main
#include "proto_test.c"
#undef main
#include "../src/presets.h"
#include "pattern_cases.h"
#include "factory_host.h"                       /* (the factory region holding today's image: the factory patterns, #915) */

/* NOR flash in RAM from the bank's first sector to the store's end: erase sets 0xFF, a write only clears bits. A program
 * can be cut after cut_after bytes and an erase refused (a power cut, as in patstore_test.c) */
#define NOR0 0x97000u
static uint8_t nor[0xE0000u - NOR0], nor_saved[0xE0000u - NOR0];
static long cut_after = -1;                     /* bytes the next programs may write before the "power" goes, -1 no cut */
static int cut_hit;
static int nor_in(uint32_t off, uint32_t n) { return off >= NOR0 && off + n <= NOR0 + sizeof nor; }
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    const uint8_t *f = host_fr(off, n);
    if (f) {
        memcpy(dst, f, n);
        return 0;
    }
    if (!nor_in(off, n))
        return -1;
    memcpy(dst, nor + off - NOR0, n);
    return 0;
}
static int st_erase(uint32_t off)
{
    if (cut_after == 0) {
        cut_hit = 1;
        return -9;
    }
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
    for (i = 0; i < n; i++) {
        if (cut_after == 0) {
            cut_hit = 1;
            return -9;
        }
        if (cut_after > 0)
            cut_after--;
        nor[off - NOR0 + i] &= s[i];
    }
    return 0;
}
static void fm1_wdt_feed(void) {}
static uint8_t flash_ok = 1;
#include "../src/factory.c"
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
    if (eng_load(tmp, len) || m1_set_current(tmp, len))
        return -1;
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

/* what the editor and the FM-1 must agree on after a pattern command (#1177, #1178): binary b loaded alone (links not
 * resolved), every track's pattern 1, the patterns and songs record (the selected pattern and song in it), the P-locks
 * record, then the links and the pattern origins as the binary holds them */
static uint32_t content(const uint8_t *b, uint32_t len, uint8_t *out)
{
    static uint8_t tmp[M1_PATCH_MAX];
    const uint32_t *w;
    uint32_t n = 0, t, at, end;
    int c;
    memcpy(tmp, b, len);
    if (eng_load(tmp, len))
        return 0;
    eng_patterns_omit(0);
    for (t = 0; (int)t < eng_steps_count(); t++) {
        c = eng_pattern_notes((uint32_t)eng_steps_module(t), 0, &w);
        out[n++] = (uint8_t)c;
        memcpy(out + n, w, 4u * (uint32_t)c);
        n += 4u * (uint32_t)c;
    }
    c = eng_patterns_record(out + n, 8192u);
    n += c > 0 ? (uint32_t)c : 0u;
    out[n++] = 0xEE;
    c = eng_locks_record(out + n, 8192u);
    n += c > 0 ? (uint32_t)c : 0u;
    out[n++] = 0xEE;
    if ((tmp[7] & ENG_FLAG_LINKS) && (at = eng_links_at(tmp, len)) != 0u) {
        end = eng_links_end(tmp, len, at);
        memcpy(out + n, tmp + at, end - at);
        n += end - at;
    }
    out[n++] = 0xEE;
    if ((at = eng_origins_at(tmp, len)) != 0u) {
        end = eng_origins_end(tmp, len, at);
        memcpy(out + n, tmp + at, end - at);
        n += end - at;
    }
    return n;
}
/* each case's pattern copied (SEQ held + SAVE: pl_copy, the copy selected) and everything cleared (SEQ held + HOME:
 * pl_clear_all) on the running patch: what the FM-1's binary then holds is what the editor's copy of the patch holds
 * after the same command (pattern_cases.h PATTERN_OPS, web/src/pattern-ops.ts) */
static void ops(void)
{
    static uint8_t a[24576], b[24576];
    uint32_t c, na, nb;
    for (c = 0; c < N_PATTERN_CASES; c++) {
        uint32_t from = PATTERN_OPS[c].from, to = PATTERN_OPS[c].to;
        OK(!load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
        OK(to > 0u && to < ENG_PATTERNS && pl_free(to) && pl_has_notes(from));
        OK(pl_copy(from, to) == 0);
        eng_pattern_set(to);
        m1_patch_patterns();
        na = content(m1_cur, m1_cur_len, a);
        nb = content(PATTERN_OPS[c].copied, PATTERN_OPS[c].copied_len, b);
        if (!na || na != nb || memcmp(a, b, na))
            fprintf(stderr, "case %s: the copy of P%02u to P%02u differs from the editor's\n", PATTERN_CASES[c].name, (unsigned)from + 1u, (unsigned)to + 1u);
        OK(na && na == nb && !memcmp(a, b, na));
        OK(!load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
        OK(!pl_all_empty());
        pl_clear_all();
        OK(pl_all_empty());
        na = content(m1_cur, m1_cur_len, a);
        nb = content(PATTERN_OPS[c].cleared, PATTERN_OPS[c].cleared_len, b);
        if (!na || na != nb || memcmp(a, b, na))
            fprintf(stderr, "case %s: clear all differs from the editor's\n", PATTERN_CASES[c].name);
        OK(na && na == nb && !memcmp(a, b, na));
    }
    printf("patlink: %u patches copied and cleared on the FM-1 as the editor does it (#1177, #1178)\n", (unsigned)N_PATTERN_CASES);
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
    OK(m1_patch_locks() && pl_set_link(p, 0) && m1_cur_len == len && !memcmp(orig, m1_cur, len));
    wn = encode(p, want);
    OK(!pt_put(&id, "LOCKS P2", want, wn) && id);
    /* linked, clean: the binary keeps the link, not the pattern */
    OK(pl_set_link(p, id) && pl_link(p) == id);
    pl_hash[p] = pt_fnv(PT_FNV0, want, wn);
    pl_rewrite();
    OK(m1_cur[1] >= ENG_UPGRADED && (m1_cur[7] & ENG_FLAG_LINKS) && m1_valid(m1_cur, m1_cur_len));
    OK(m1_cur_len < len && inline_has(p) == 0);
    ln = m1_cur_len;
    memcpy(linked, m1_cur, ln);
    /* loaded: the store gives the pattern back, as it was */
    OK(!load_patch(linked, ln) && has(p) && pl_link(p) == id);
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
    OK(!load_patch(linked, ln) && !has(p) && pl_link(p) == id && (m1_cur[7] & ENG_FLAG_LINKS));
    m1_patch_patterns();
    OK(m1_patch_locks() && (m1_cur[7] & ENG_FLAG_LINKS) && pl_link(p) == id);
    /* edited with its entry gone: SAVE drops the link, the pattern stays inline */
    OK(eng_pattern_set_notes((uint32_t)eng_steps_module(0), p, notes_one(), 1u));
    m1_patch_track((uint32_t)eng_steps_module(0));
    nreplies = 0;
    pl_writeback();
    OK(!pl_link(p) && !(m1_cur[7] & ENG_FLAG_LINKS) && inline_has(p) == 1 && link_told(p, 0));
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
    OK(pl_save(p, 0, "LOCKS P2", got) == 1 && !strcmp(got, "LOCKS P2") && (id = pl_link(p)) != 0);
    OK(pl_save(p, 0, "OTHER", got) == 0 && pl_link(p) == id && !strcmp(got, "LOCKS P2"));
    OK(pl_save(p, 1, "COPY", got) == 1 && pl_link(p) != id && !strcmp(got, "COPY"));
    OK(pl_save(0, 0, "FIRST", got) == 1 && !pl_link(0));
    OK(pl_load_entry(p, PL_FACTORY, got) == 0 && !pl_link(p) && !strcmp(got, PRESET_PATTERNS[0].name));
    {
        const uint32_t *w;
        int n = eng_pattern_notes((uint32_t)eng_steps_module(0), p, &w);
        OK(n == (int)PRESET_PATTERNS[0].n && !memcmp(w, PRESET_PATTERNS[0].notes, 4u * (uint32_t)n));
        OK(eng_pattern_len((uint32_t)eng_steps_module(0), p) == PRESET_PATTERNS[0].len);
    }
    OK(pl_load_entry(p, id, got) == 0 && pl_link(p) == id && link_told(p, id));
    {
        pt_info_t first, last;
        uint32_t kit_last = KIT_GROUPS[0].first + KIT_GROUPS[0].n - 1u;
        OK(!pt_next(0, &first) && pl_step(0, 1) == first.id && pl_step(first.id, -1) == PL_FACTORY + N_PRESET_PATTERNS - 1u);
        OK(!pt_prev(PL_KIT, &last) && pl_step(PL_KIT, -1) == last.id && pl_step(last.id, 1) == PL_KIT);
        OK(pl_step(kit_last, 1) == KIT_GROUPS[1].first && pl_step(KIT_GROUPS[1].first, -1) == kit_last);
        OK(pl_step(KIT_GROUPS[N_KIT_GROUPS - 1].first + KIT_GROUPS[N_KIT_GROUPS - 1].n - 1u, 1) == PL_FACTORY);
        OK(pl_step(PL_FACTORY + N_PRESET_PATTERNS - 1u, 1) == first.id);
    }
    /* another layout: the notes load, the locks are left out */
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "FIRST ABSENT"); c++)
        ;
    if (c < N_PATTERN_CASES && !load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len)) {
        OK(pl_layout() != PATTERN_CASES[0].layout);
        OK(pl_load_entry(1, id, got) == 1 && eng_locks_count() == 0 && pl_link(1) == id);
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
    OK(n == 26u && (b[14] & 2u) && b[15] == 60u && rd16(b + 16) > 0u && rd16(b + 18) == pt_total_bytes());
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
    /* PATS: the user entries, then the factory patches' patterns, then the demonstration patterns */
    frame(C_PATS, 0, 0);
    cnt = pt_count() + N_KIT_PATTERNS + N_PRESET_PATTERNS;
    OK(nreplies == cnt);
    for (k = 0; k < nreplies; k++) {
        n = reply(k, R_PAT, e, sizeof e);
        OK(n == 34u && rd16(e) == k && rd16(e + 2) == cnt);
        if (n == 34u && rd16(e + 4) == id)
            OK(rd16(e + 6) == PATTERN_CASES[c].payload_len && e[17] == 0 && !memcmp(e + 18, "CHUNKED", 8));
        if (n == 34u && rd16(e + 4) == PL_KIT)
            OK(k == pt_count() && e[17] == 1u && e[16] == 1u && !memcmp(e + 18, "808 ", 4));
        if (k + 1u == nreplies)
            OK(rd16(e + 4) == PL_FACTORY + N_PRESET_PATTERNS - 1u && e[17] == 1u && e[16] == 1u);
    }
    /* GET of a factory patch's pattern: its payload */
    b[0] = (uint8_t)PL_KIT;
    b[1] = (uint8_t)(PL_KIT >> 8);
    b[2] = b[3] = 0;
    frame(C_PAT_GET, b, 4);
    {
        pt_info_t in;
        static uint8_t want[M1_PATCH_MAX];
        n = reply(0, R_PAT_DATA, b, sizeof b);
        OK(!pl_read(PL_KIT, want, sizeof want, &in) && n == 6u + in.len && rd16(b + 2) == in.len && !memcmp(b + 6, want, in.len));
    }
    /* a factory patch's pattern is read-only */
    memset(b, 0, sizeof b);
    b[0] = (uint8_t)PL_KIT;
    b[1] = (uint8_t)(PL_KIT >> 8);
    b[2] = (uint8_t)PATTERN_CASES[c].payload_len;
    memcpy(b + 22, PATTERN_CASES[c].payload, PATTERN_CASES[c].payload_len);
    frame(C_PAT_PUT, b, 22u + PATTERN_CASES[c].payload_len);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_RANGE);
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
    OK(pl_set_link(2, id));
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
    OK(inline_has(2) == 1 && pl_link(2) == id);     /* (the running patch keeps it inline; SAVE drops the link) */
    frame(C_PAT_DEL, b, 3);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_MISSING);
    printf("patlink: INFO, PATS, PAT_GET, PAT_PUT and PAT_DEL\n");
}

/* the binary of demo case `name` with its demo set loaded (pattern_cases.h DEMO_CASES, as the editor loads it) into out:
 * its length, 0 none */
static uint32_t demo_bin(const char *name, uint8_t *out)
{
    uint32_t i;
    for (i = 0; i < N_DEMO_CASES; i++)
        if (!strcmp(DEMO_CASES[i].name, name) && DEMO_CASES[i].loaded) {
            memcpy(out, DEMO_CASES[i].loaded, DEMO_CASES[i].loaded_len);
            return DEMO_CASES[i].loaded_len;
        }
    return 0;
}
/* the running patch's links whose pattern plays and is its entry's payload, clean (bit p each in *clean) */
static uint32_t links_ok(uint64_t *clean)
{
    static uint8_t want[M1_PATCH_MAX];
    uint32_t n, k, p, id, len, ok = 0;
    const uint8_t *e = pl_links(&n);
    pt_info_t in;
    *clean = 0;
    for (k = 0; k < n; k++, e += 3) {
        p = e[0];
        id = (uint32_t)e[1] | (uint32_t)e[2] << 8;
        if (pl_read(id, want, sizeof want, &in))
            continue;
        len = encode(p, pay);
        if (has(p) && len == in.len && !memcmp(pay, want, len) && pl_hash[p] == in.hash) {
            ok++;
            *clean |= (uint64_t)1u << p;
        }
    }
    return ok;
}
/* pattern p of the first track with one more note */
static void edit(uint32_t p)
{
    const uint32_t *w;
    uint32_t notes[TRACK_NOTES_MAX], m = (uint32_t)eng_steps_module(0), k;
    int cnt = eng_pattern_notes(m, p, &w);
    for (k = 0; (int)k < cnt; k++)
        notes[k] = w[k];
    notes[cnt] = NW(15u, 1u, 61u, STEP_VEL, 0u);
    OK(eng_pattern_set_notes(m, p, notes, (uint32_t)cnt + 1u));
    m1_patch_track(m);
}

/* the factory patches' linked patterns (#923): the entries, the 808 and 909 Kits as they load, rewrite and SAVE */
static void kits(void)
{
    static uint8_t bin[M1_PATCH_MAX];
    static const char *const names[] = { "808 Kit", "909 Kit" };
    pt_info_t in;
    uint64_t clean;
    uint32_t g, k, i, id, len = 0, n = 0, total = 0, p = 0;
    for (g = 0; g < N_KIT_GROUPS; g++)
        for (k = 0; k < KIT_GROUPS[g].n; k++, total++) {
            id = KIT_GROUPS[g].first + k;
            OK(!pl_read(id, m1_up, sizeof m1_up, &in) && in.id == id && in.name[0] && !pl_check(m1_up, in.len) &&
               in.hash == pt_fnv(PT_FNV0, m1_up, in.len));
        }
    /* (a kit may take several groups, #852: the id before the last group's first is a hole between the kits' blocks) */
    OK(total == N_KIT_PATTERNS && pl_read(KIT_GROUPS[N_KIT_GROUPS - 1].first - 1u, m1_up, sizeof m1_up, &in) == -1);
    for (i = 0; i < 2u; i++) {
        OK((len = demo_bin(names[i], bin)) != 0);
        if (!len || load_patch(bin, len)) {
            OK(!"the kit loads");
            continue;
        }
        (void)pl_links(&n);
        OK(n >= 11u && links_ok(&clean) == n && m1_pat_clean() == clean);
        OK(eng_song_len(0) >= 8);                       /* (its song, over the linked patterns) */
        for (k = 0; k < (uint32_t)eng_song_len(0); k++)
            OK(has((uint32_t)eng_song_get(0, k) & 0xFFu));
        m1_patch_patterns();                            /* (rewritten as it came: the clean links stay out) */
        OK(m1_patch_locks() && m1_cur_len == len && !memcmp(m1_cur, bin, len));
        pt_on = 0;                                      /* (a factory link needs no store) */
        OK(!load_patch(bin, len) && links_ok(&clean) == n);
        pt_on = 1;
        if (!i) {                                       /* (#1177) a copy of a linked factory pattern is a plain one, inline:
                                                         * P04 does not fit the 808 Kit's bytes, so nothing changes; P21
                                                         * (16 hits) does: to P25, linked to nothing */
            static uint8_t before[M1_PATCH_MAX];
            const uint32_t *w, *x;
            uint32_t m = (uint32_t)eng_steps_module(0), q = 24u, blen;
            int nw;
            OK(!load_patch(bin, len) && pl_free(q) && pl_link(3) != 0u && pl_link(20) != 0u);
            blen = m1_cur_len;
            memcpy(before, m1_cur, blen);
            OK(pl_copy(3, q) == -2 && pl_free(q) && m1_cur_len == blen && !memcmp(before, m1_cur, blen));
            OK(pl_copy(20, q) == 0 && !pl_link(q) && pl_link(20) != 0u);
            nw = eng_pattern_notes(m, 20, &w);
            OK(nw > 0 && nw == eng_pattern_notes(m, q, &x) && !memcmp(w, x, 4u * (uint32_t)nw) && inline_has(q) == 1);
        }
        printf("patlink: %s: %u linked patterns from the factory entries, its song over them\n", names[i], (unsigned)n);
    }
    /* SAVE of an edited one (the 909 Kit's last): a new stored entry under the factory entry's name, linked, so the binary
     * takes the size it had before the edit; the others stay linked to the factory's */
    p = pl_links(&n)[3u * (n - 1u)];
    id = pl_link(p);
    OK(!pl_read(id, m1_up, sizeof m1_up, &in));
    len = m1_cur_len;
    edit(p);
    nreplies = 0;
    pl_writeback();
    {
        pt_info_t got;
        uint32_t now = pl_link(p);
        OK(now >= 1u && now <= PT_ID_MAX && link_told(p, now) && !pt_stat(now, &got) && !strcmp(got.name, in.name));
        OK(links_ok(&clean) == n && m1_pat_clean() == clean && inline_has(p) == 0 && m1_cur_len == len);
    }
    printf("patlink: the factory entries read back; SAVE stores an edited factory pattern as a new entry\n");
}

/* every pattern's payload of the running patch, one after another, into out: their bytes */
static uint32_t all_payloads(uint8_t *out, uint32_t cap)
{
    uint32_t p, n = 0;
    for (p = 0; p < ENG_PATTERNS; p++) {
        pl_out_t s = { out + n, cap - n, 0, PT_FNV0 };
        pl_encode(p, &s);
        n += s.n < cap - n ? s.n : cap - n;
    }
    return n;
}
/* the demo sets (#1179): loaded on the FM-1 from the factory region as the editor loads them */
static void demo_sets(void)
{
    static uint8_t keep[M1_PATCH_MAX], got[ENG_PATTERNS * 400u], want[ENG_PATTERNS * 400u];
    uint32_t i, len, hash, ng, nw, at = 0, dlen, cost, h;
    int rc;
    for (i = 0; i < N_DEMO_CASES; i++) {
        if (load_patch(DEMO_CASES[i].patch, DEMO_CASES[i].patch_len)) {
            OK(!"the demo case loads");
            continue;
        }
        len = m1_cur_len;
        memcpy(keep, m1_cur, len);
        hash = 0;
        rc = pl_demo_set(&hash);
        if (!DEMO_CASES[i].loaded) {                    /* (a module more or less: no set, nothing changed) */
            OK(rc == -1 && m1_cur_len == len && !memcmp(m1_cur, keep, len));
            printf("patlink: %s: NO DEMO SET\n", DEMO_CASES[i].name);
            continue;
        }
        OK(rc == 0 && hash == DEMO_CASES[i].hash && !eng_pattern() && !eng_song());
        if (m1_cur_len != DEMO_CASES[i].loaded_len || memcmp(m1_cur, DEMO_CASES[i].loaded, m1_cur_len))
            fprintf(stderr, "  %s: the FM-1's binary (%u bytes) is not the editor's (%u)\n", DEMO_CASES[i].name, (unsigned)m1_cur_len, (unsigned)DEMO_CASES[i].loaded_len);
        OK(m1_cur_len == DEMO_CASES[i].loaded_len && !memcmp(m1_cur, DEMO_CASES[i].loaded, m1_cur_len));
        ng = all_payloads(got, sizeof got);             /* (the engine plays what the binary loads) */
        OK(!load_patch(DEMO_CASES[i].loaded, DEMO_CASES[i].loaded_len));
        nw = all_payloads(want, sizeof want);
        OK(ng == nw && !memcmp(got, want, ng));
        OK(pl_demo_set(&h) == 0 && m1_cur_len == DEMO_CASES[i].loaded_len && !memcmp(m1_cur, DEMO_CASES[i].loaded, m1_cur_len));   /* (again: the same) */
        printf("patlink: %s: its demo set loaded, %u bytes as the editor's\n", DEMO_CASES[i].name, (unsigned)m1_cur_len);
    }
    /* no room: the set's bytes made larger than any patch holds, nothing changes */
    OK(!load_patch(DEMO_CASES[0].patch, DEMO_CASES[0].patch_len) && !fc_demo(pl_demo_layout(), &at, &dlen, &cost, &h));
    {
        uint8_t *c = host_fr(FC_BASE + at - FC_DEMO_REC + 24u, 2u), was[2];
        len = m1_cur_len;
        memcpy(keep, m1_cur, len);
        memcpy(was, c, 2u);
        c[0] = c[1] = 0xFFu;
        OK(pl_demo_set(&h) == -2 && m1_cur_len == len && !memcmp(m1_cur, keep, len));
        memcpy(c, was, 2u);
    }
    /* no factory region: NO DEMO SET */
    host_fr_blank();
    fc_scan();
    OK(pl_demo_set(&h) == -1 && m1_cur_len == len && !memcmp(m1_cur, keep, len));
    host_fr_load();
    fc_scan();
    printf("patlink: no room, no factory region: nothing changes\n");
}

/* a power-on: the RAM state as after a reset, then the boot's sl_scan and pt_claim (patstore_test.c's) */
static void boot(void)
{
    cut_after = -1;
    nreplies = 0;
    sl_next = 0;
    bank_slots = M1_SLOTS;
    pt_on = 0;
    pt_scanned = 0;
    pt_seq = pt_nextid = 0;
    memset(pt_tail, 0, sizeof pt_tail);
    sl_scan();
    pt_claim();
}
/* slot s loaded as the FM-1 loads it */
static int load_slot(uint32_t s)
{
    static uint8_t b[M1_PATCH_MAX];
    uint32_t len;
    return sl_read(s, b, &len, 0) || load_patch(b, len);
}
/* SAVE of slot 5's patch with pattern p edited (the write-back, then the slot), cut at every byte it programs: after the
 * next boot the slot loads, and p plays as it was or as edited */
static void cut_save(const char *what, uint32_t p)
{
    static uint8_t was[PT_MAX + 64u], now[PT_MAX + 64u];
    uint32_t wn, nn, n, cut, old = 0, edited = 0;
    int o, e;
    memcpy(nor_saved, nor, sizeof nor);
    boot();
    if (load_slot(5) || !has(p)) {
        OK(!"the slot loads with its pattern");
        return;
    }
    wn = encode(p, was);
    for (cut = 0;; cut++) {
        memcpy(nor, nor_saved, sizeof nor);
        boot();
        if (load_slot(5)) {
            OK(!"the slot loads before the cut");
            break;
        }
        edit(p);
        nn = encode(p, now);
        cut_hit = 0;
        cut_after = (long)cut;
        pl_writeback();
        (void)sl_write(5, "CUT", m1_cur, m1_cur_len);
        boot();
        if (load_slot(5) || !has(p)) {
            fprintf(stderr, "%s: cut after %u bytes: the slot or its pattern is gone\n", what, (unsigned)cut);
            OK(!"the slot plays its pattern after the cut");
            break;
        }
        n = encode(p, pay);
        o = n == wn && !memcmp(pay, was, n);
        e = n == nn && !memcmp(pay, now, n);
        OK(o || e);
        old += (uint32_t)o;
        edited += (uint32_t)e;
        if (!cut_hit)
            break;
    }
    OK(old && edited);
    printf("patlink: %s: SAVE cut at each of its %u bytes: the pattern as it was (%u) or as edited (%u)\n", what,
           (unsigned)cut, (unsigned)old, (unsigned)edited);
}
static void cuts(void)
{
    static uint8_t bin[M1_PATCH_MAX];
    uint32_t c, p, id = 0, wn, len;
    /* a user link: SAVE writes the edited pattern over its stored entry, then the slot */
    memset(nor, 0xFF, sizeof nor);
    boot();
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "LOCKS P2"); c++)
        ;
    if (c == N_PATTERN_CASES || load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len))
        return;
    p = PATTERN_CASES[c].pattern;
    wn = encode(p, pay);
    OK(!pt_put(&id, "LOCKS P2", pay, wn) && pl_set_link(p, id));
    pl_hash[p] = pt_fnv(PT_FNV0, pay, wn);
    pl_rewrite();
    OK(!sl_write(5, "LINKED", m1_cur, m1_cur_len));
    cut_save("a user link", p);
    /* a factory link: SAVE keeps the edited pattern inline and writes the slot */
    memset(nor, 0xFF, sizeof nor);
    boot();
    OK((len = demo_bin("808 Kit", bin)) != 0 && !sl_write(5, "808 KIT", bin, len));
    cut_save("a factory link", 2u);
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
    ops();
    links();
    seq_page();
    link_frames();
    kits();
    demo_sets();
    cuts();
    if (fails) {
        fprintf(stderr, "patlink: %d checks failed\n", fails);
        return 1;
    }
    printf("patlink ok\n");
    return 0;
}
