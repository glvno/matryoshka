/* SPDX-License-Identifier: GPL-3.0-only */
/* Host test of the pattern store's glue (#901, firmware/src/patlink.c), with the store itself (patstore.c) and the bank
 * (slotstore.c) over RAM flash, and proto.c (proto_test.c's stand-ins for the rest):
 *   - the payload of each case in pattern_cases.h (web/scripts/pattern-vectors.ts, written by export-defs) byte for byte
 *     as the editor writes it, the layout fingerprint, and the payload read back into a cleared pattern and written again;
 *   - a format 59 patch: the clean linked pattern left out of the binary, its content from the store at load, the link
 *     kept when the entry is gone, SAVE's write-back of an edited linked pattern (and the link dropped when its entry is
 *     gone), a patch without links rewritten byte for byte as it was;
 *   - the legacy factory patterns (factory_tier.h KIT_GROUPS, kept only to migrate slots that link them, #1202 G8): every
 *     entry read back and well formed, never listed, stepped to or loaded on its own; the 808 and 909 Kits as 1.25 saved
 *     them (pattern_cases.h PATTERNED_CASES, linking them) playing all their patterns and their song, with the store off
 *     too; boot's migration (main.c bank_patterns: patlink.c pl_slot_due, pl_commit) making them user entries with the
 *     same payloads, a second boot changing nothing, a power cut at every byte it programs migrating again with no
 *     duplicate; SAVE of a patch that links them storing them as user entries;
 *   - SAVE with a power cut at every byte it programs (a user link's write-back, then the slot; a legacy link's slot):
 *     after the next boot the slot plays the pattern as it was or as edited, never neither;
 *   - the SEQ page's kept copy and load (only user entries, another layout's locks left out);
 *   - INFO, PATS (the user entries, the kept flag), PAT_GET, PAT_PUT (in chunks), PAT_DEL (S_USED with a slot that links
 *     the entry, force, ids past PT_ID_MAX refused);
 *   - SLOT_GET (slot_get.h, #1202 P2): mode 0 the slot's bytes; mode 1 every pattern inline and no links (the patterns the
 *     slot plays), in chunks, the running patch borrowed muted and back exactly after the last chunk, at another command
 *     and after 2 s without a chunk; 0xFFFE too big inline (the running patch back), 0xFFFD unsaved edits, Live or a
 *     palette switch waiting, 0xFFFC the transport running, 0xFFFF an empty slot.
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

/* the running engine's patterns as the editor and the FM-1 must agree on them: every track's pattern 1 and length, the
 * patterns and songs record (the selected pattern and song in it), the P-locks record */
static uint32_t state(uint8_t *out)
{
    const uint32_t *w;
    uint32_t n = 0, t, m;
    int32_t v;
    int c;
    eng_patterns_omit(0);
    for (t = 0; (int)t < eng_steps_count(); t++) {
        m = (uint32_t)eng_steps_module(t);
        c = eng_pattern_notes(m, 0, &w);
        out[n++] = (uint8_t)c;
        memcpy(out + n, w, 4u * (uint32_t)c);
        n += 4u * (uint32_t)c;
        v = eng_get_param(m, STEPS_P_LEN);      /* (D-838: a double of pattern 1 doubles the track's length) */
        memcpy(out + n, &v, 4u);
        n += 4u;
    }
    c = eng_patterns_record(out + n, 8192u);
    n += c > 0 ? (uint32_t)c : 0u;
    out[n++] = 0xEE;
    c = eng_locks_record(out + n, 8192u);
    n += c > 0 ? (uint32_t)c : 0u;
    out[n++] = 0xEE;
    return n;
}
/* what the editor and the FM-1 must agree on after a pattern command (#1177, #1178, D-838): binary b loaded alone (links
 * not resolved), its state, then the links and the pattern origins as the binary holds them */
static uint32_t content(const uint8_t *b, uint32_t len, uint8_t *out)
{
    static uint8_t tmp[M1_PATCH_MAX];
    uint32_t n, at, end;
    memcpy(tmp, b, len);
    if (eng_load(tmp, len))
        return 0;
    n = state(out);
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
/* each case's pattern copied (SEQ held + SAVE: pl_copy, the copy selected), everything cleared (SEQ held + HOME:
 * pl_clear_all), and its pattern doubled (SEQ held + OCT+: pl_double) and halved (SEQ held + OCT-: pl_halve) on the
 * running patch: what the FM-1's binary then holds is what the editor's copy of the patch holds after the same command
 * (pattern_cases.h PATTERN_OPS, web/src/pattern-ops.ts); a double or halve the editor refuses the FM-1 refuses for the
 * same reason */
static void ops(void)
{
    static uint8_t a[24576], b[24576];
    uint32_t c, na, nb, most;
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
        OK(!load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
        OK(pl_double(from, &most) == PATTERN_OPS[c].doubled_rc);
        if (!PATTERN_OPS[c].doubled_rc) {
            na = content(m1_cur, m1_cur_len, a);
            nb = content(PATTERN_OPS[c].doubled, PATTERN_OPS[c].doubled_len, b);
            if (!na || na != nb || memcmp(a, b, na))
                fprintf(stderr, "case %s: the double of P%02u differs from the editor's\n", PATTERN_CASES[c].name, (unsigned)from + 1u);
            OK(na && na == nb && !memcmp(a, b, na));
        }
        OK(!load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
        OK(pl_halve(from, &most) == PATTERN_OPS[c].halved_rc);
        if (PATTERN_OPS[c].halved_rc)
            continue;
        na = content(m1_cur, m1_cur_len, a);
        nb = content(PATTERN_OPS[c].halved, PATTERN_OPS[c].halved_len, b);
        if (!na || na != nb || memcmp(a, b, na))
            fprintf(stderr, "case %s: the halve of P%02u differs from the editor's\n", PATTERN_CASES[c].name, (unsigned)from + 1u);
        OK(na && na == nb && !memcmp(a, b, na));
    }
    printf("patlink: %u patches copied, cleared, doubled and halved on the FM-1 as the editor does it (#1177, #1178, D-838, D-841)\n", (unsigned)N_PATTERN_CASES);
}

/* the case of that name */
static uint32_t case_of(const char *name)
{
    uint32_t c;
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, name); c++)
        ;
    return c;
}
/* a double or halve (op: pl_double, pl_halve) refused with rc: the binary byte for byte as it was, and the engine's
 * patterns too */
static int refused(int (*op)(uint32_t, uint32_t *), uint32_t p, int rc)
{
    static uint8_t bin[M1_PATCH_MAX], a[24576], b[24576];
    uint32_t len = m1_cur_len, na = state(a), nb, most = 0;
    memcpy(bin, m1_cur, len);
    if (op(p, &most) != rc)
        return 0;
    nb = state(b);
    return m1_cur_len == len && !memcmp(bin, m1_cur, len) && na == nb && !memcmp(a, b, na);
}
/* the binary filled with patterns of the first track from pattern `first` on until it holds no more: 100 long words each,
 * then single notes */
static void fill_bytes(uint32_t first)
{
    uint32_t w[TRACK_NOTES_MAX], j, q, k, m = (uint32_t)eng_steps_module(0);
    for (k = 100; k; k = k > 1u ? 1u : 0u)
        for (q = first; q < ENG_PATTERNS; q++) {
            if (eng_pattern_has(m, q))
                continue;
            for (j = 0; j < k; j++)
                w[j] = NW(j % 16u, 1u, 30u + j / 16u, 90u, 0u);
            if (!eng_pattern_set_notes(m, q, w, k) || !m1_patterns_fit()) {
                eng_pattern_drop(m, q);
                (void)m1_patterns_fit();
                break;
            }
        }
}
/* the double's limits (D-838): doubled again it repeats the doubled pattern, up to 64 steps; each refusal (64 steps, the
 * notes of a pattern, the P-locks of a pattern, the patch's bytes, for a pattern and for pattern 1) changes nothing. The
 * bytes' refusals with the store off: on, the patterns 2..64 the binary cannot hold go to the store (#1199) */
static void doubles(void)
{
    uint32_t all = case_of("DOUBLE ALL"), one = case_of("DOUBLE ONE"), most = 0, m, j, k, n, ok;
    uint32_t w[TRACK_NOTES_MAX];
    const uint32_t *x;
    OK(all < N_PATTERN_CASES && one < N_PATTERN_CASES);
    OK(!load_patch(PATTERN_CASES[all].patch, PATTERN_CASES[all].patch_len));
    m = (uint32_t)eng_steps_module(1);
    OK(pl_double(1, &most) == 0 && most == 32u && eng_pattern_len(m, 1) == 32);
    OK(pl_double(1, &most) == 0 && most == 64u && eng_pattern_len(m, 1) == 64);
    n = (uint32_t)eng_pattern_notes(m, 1, &x);   /* (steps 32..63 the same as 0..31: the doubled pattern repeated) */
    for (j = 0, ok = n > 0u; j < n; j++)
        if (NW_VEL(x[j]) && NW_AT(x[j]) < 32u && !eng_note_drone(x[j])) {
            for (k = 0; k < n && x[k] != x[j] + 32u; k++)
                ;
            ok &= k < n;
        }
    OK(ok);
    OK(eng_pattern_len((uint32_t)eng_steps_module(0), 1) == 48 && eng_pattern_len((uint32_t)eng_steps_module(2), 1) == 32);
    OK(refused(pl_double, 1, -1));
    OK(!load_patch(PATTERN_CASES[one].patch, PATTERN_CASES[one].patch_len));
    OK(pl_double(0, &most) == 0 && most == 64u);  /* (its second track's 32 steps to 64: the next double is refused) */
    OK(refused(pl_double, 0, -1));
    OK(!load_patch(PATTERN_CASES[all].patch, PATTERN_CASES[all].patch_len));
    m = (uint32_t)eng_steps_module(0);
    for (j = 0; j < 130u; j++)                   /* (130 notes on 12 steps: 260 doubled) */
        w[j] = NW(j % 12u, 1u, 40u + j / 12u, STEP_VEL, 0u);
    OK(eng_pattern_set_notes(m, 1, w, 130));
    OK(refused(pl_double, 1, -2));
    OK(!load_patch(PATTERN_CASES[one].patch, PATTERN_CASES[one].patch_len));
    m = (uint32_t)eng_steps_module(1);           /* (33 locks on 32 steps, two rows: 66 doubled) */
    for (j = 0; j < 32u; j++)
        OK(!eng_lock_set(m, 0, j, (uint32_t)eng_find(T_CONST), 0, 0, 65536, 1));
    OK(!eng_lock_set(m, 0, 0, (uint32_t)eng_find(T_OUTPUT), 0, 0, 0, 1));
    OK(refused(pl_double, 0, -3));
    pt_on = 0;
    OK(!load_patch(PATTERN_CASES[all].patch, PATTERN_CASES[all].patch_len));
    fill_bytes(5);
    OK(refused(pl_double, 1, -4));
    OK(!load_patch(PATTERN_CASES[one].patch, PATTERN_CASES[one].patch_len));
    fill_bytes(5);
    OK(refused(pl_double, 0, -4));
    pt_on = 1;
    printf("patlink: doubled twice to 64 steps, the doubled pattern repeated; each refusal leaves the binary as it was (D-838)\n");
}

/* the running patch's note words, every pattern of every track */
static uint32_t words_all(void)
{
    const uint32_t *x;
    uint32_t t, q, m, k = 0;
    for (t = 0; (int)t < eng_steps_count(); t++)
        for (m = (uint32_t)eng_steps_module(t), q = 0; q < ENG_PATTERNS; q++)
            if (!q || eng_pattern_has(m, q))
                k += (uint32_t)eng_pattern_notes(m, q, &x);
    return k;
}
/* the halve's rules (D-841): half the length, rounded down, the notes and P-locks as they were; a track without the
 * pattern gets its pattern 1's; pattern 1 halves the track's length and pins the patterns on it; down to 1 step, then
 * refused; each refusal (1 step, the patch's notes, its P-locks, its bytes) changes nothing */
static void halves(void)
{
    uint32_t odd = case_of("HALVE ODD"), one = case_of("DOUBLE ONE"), most = 0, m0, m1, m2, j, q, k, n0, n1;
    uint32_t w[TRACK_NOTES_MAX];
    const uint32_t *x;
    OK(odd < N_PATTERN_CASES && one < N_PATTERN_CASES);
    OK(!load_patch(PATTERN_CASES[odd].patch, PATTERN_CASES[odd].patch_len));
    m0 = (uint32_t)eng_steps_module(0);
    m1 = (uint32_t)eng_steps_module(1);
    m2 = (uint32_t)eng_steps_module(2);
    n0 = (uint32_t)eng_pattern_notes(m0, 1, &x);
    n1 = (uint32_t)eng_pattern_notes(m1, 0, &x);
    OK(!eng_pattern_has(m1, 1));
    OK(pl_halve(1, &most) == 0 && most == 8u);
    OK(eng_pattern_len(m0, 1) == 7 && eng_pattern_rate(m0, 1) == 3 && eng_pattern_notes(m0, 1, &x) == (int)n0);
    OK(eng_pattern_has(m1, 1) && eng_pattern_len(m1, 1) == 8 && eng_pattern_notes(m1, 1, &x) == (int)n1 && eng_locks_list(m1, 1, (uint8_t *)w, sizeof w) == 1);
    OK(eng_pattern_len(m2, 1) == 4);
    OK(pl_halve(1, &most) == 0 && most == 4u && eng_pattern_len(m0, 1) == 3 && eng_pattern_len(m2, 1) == 2);
    OK(pl_halve(1, &most) == 0 && most == 2u && eng_pattern_len(m0, 1) == 1);
    OK(refused(pl_halve, 1, -1));                /* (the first track at 1 step: nothing halves) */
    OK(eng_pattern_notes(m0, 1, &x) == (int)n0);
    OK(!load_patch(PATTERN_CASES[one].patch, PATTERN_CASES[one].patch_len));
    m0 = (uint32_t)eng_steps_module(0);
    OK(pl_halve(0, &most) == 0 && most == 16u);  /* (16 and 32 steps to 8 and 16; pattern 2 on the track's length keeps 16) */
    OK(eng_steps_len(m0) == 8 && eng_pattern_len(m0, 1) == 16 && eng_pattern_len(m0, 2) == 10);
    OK(!load_patch(PATTERN_CASES[odd].patch, PATTERN_CASES[odd].patch_len));
    m0 = (uint32_t)eng_steps_module(0);
    m1 = (uint32_t)eng_steps_module(1);
    for (j = 0; j < 60u; j++)                    /* (track 2's pattern 1 of 60 notes, copied into its pattern 2: the patch past 1536) */
        w[j] = NW(j % 16u, 1u, 30u + j / 16u, STEP_VEL, 0u);
    OK(eng_pattern_set_notes(m1, 0, w, 60));
    for (q = 2; q < ENG_PATTERNS && (k = words_all()) < ENG_MAX_NOTES - 10u; q++) {
        k = ENG_MAX_NOTES - 10u - k < TRACK_NOTES_MAX ? ENG_MAX_NOTES - 10u - k : TRACK_NOTES_MAX;
        for (j = 0; j < k; j++)
            w[j] = NW(j % 16u, 1u, 30u + j / 16u, STEP_VEL, 0u);
        OK(eng_pattern_set_notes(m0, q, w, k));
    }
    OK(words_all() == ENG_MAX_NOTES - 10u);
    OK(refused(pl_halve, 1, -2));
    OK(!load_patch(PATTERN_CASES[odd].patch, PATTERN_CASES[odd].patch_len));
    m0 = (uint32_t)eng_steps_module(0);
    m2 = (uint32_t)eng_steps_module(2);
    for (k = 0; k < 4u; k++)                     /* (the patch at 256 P-locks: track 2's one, copied, would pass it) */
        for (j = 0; j < 64u && eng_locks_count() < ENG_MAX_LOCKS; j++)
            (void)eng_lock_set(k < 2u ? m0 : m2, k & 1u, j, (uint32_t)eng_find(T_CONST), 0, 0, 65536, 1);
    OK(eng_locks_count() == ENG_MAX_LOCKS);
    OK(refused(pl_halve, 1, -3));
    pt_on = 0;
    OK(!load_patch(PATTERN_CASES[odd].patch, PATTERN_CASES[odd].patch_len));
    fill_bytes(5);
    OK(refused(pl_halve, 1, -4));                /* (track 2's new pattern 2 does not fit) */
    pt_on = 1;
    printf("patlink: halved down to 1 step, the notes kept; a track without the pattern gets its pattern 1; each refusal leaves the binary as it was (D-841)\n");
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
    OK(!pt_put(&id, "LOCKS P2", want, wn, 0) && id);
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
    pl_commit("LOCKS", 0);                           /* (no slot links the entry: written over in place) */
    n = encode(p, pay);
    OK(!pt_read(id, want, sizeof want, &in) && in.len == n && !memcmp(want, pay, n) && pl_hash[p] == in.hash);
    OK(link_told(p, id) && m1_pat_clean() == (uint64_t)1u << p && inline_has(p) == 0);
    /* its entry gone: the pattern absent at load, the link kept */
    OK(!pt_del(id));
    OK(!load_patch(linked, ln) && !has(p) && pl_link(p) == id && (m1_cur[7] & ENG_FLAG_LINKS));
    m1_patch_patterns();
    OK(m1_patch_locks() && (m1_cur[7] & ENG_FLAG_LINKS) && pl_link(p) == id);
    /* edited with its entry gone: SAVE stores it as a new entry and links that */
    OK(eng_pattern_set_notes((uint32_t)eng_steps_module(0), p, notes_one(), 1u));
    m1_patch_track((uint32_t)eng_steps_module(0));
    nreplies = 0;
    pl_commit("LOCKS", 0);
    OK(pl_link(p) && pl_link(p) != id && inline_has(p) == 0 && link_told(p, pl_link(p)) && m1_pat_clean() == (uint64_t)1u << p);
    printf("patlink: links left out, loaded from the store, written back at SAVE\n");
}

/* the SEQ page: FX+SAVE keeps a copy (#1202 P1), a factory entry and another layout's locks */
static void seq_page(void)
{
    char got[PT_NAME + 1u], want[PT_NAME + 1u];
    uint32_t c, id = 0, p = 1, link, before;
    pt_info_t in = { 0 };
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "LOCKS P2"); c++)
        ;
    if (c == N_PATTERN_CASES || load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len))
        return;
    /* FX+SAVE: a new kept entry named as SAVE names them, linked to nothing; p's link stays */
    link = pl_link(p);
    before = pt_count();
    pl_name(want, m1_patch_name(), p);
    OK(pl_keep(p, got) == 1 && !strcmp(got, want) && pt_count() == before + 1u && pl_link(p) == link);
    while (!id && !pt_next(in.id, &in))
        id = in.kept ? in.id : 0u;
    OK(id && !pt_stat(id, &in) && in.kept && !strcmp(in.name, want));
    OK(pl_keep(0, got) == 1 && pt_count() == before + 2u && !pl_link(0));
    /* the cleanup of unlinked entries leaves a kept copy */
    pl_gc();
    OK(!pt_stat(id, &in) && in.kept);
    /* linked and edited, SAVE does not write over it: a new entry, the kept copy as it was */
    OK(pl_load_entry(p, id, got) == 0 && pl_link(p) == id && !pt_stat(id, &in));
    {
        uint32_t hash = in.hash;
        OK(eng_pattern_set_notes((uint32_t)eng_steps_module(0), p, notes_one(), 1u));
        m1_patch_track((uint32_t)eng_steps_module(0));
        pl_commit("LOCKS", 0);
        OK(pl_link(p) && pl_link(p) != id && !pt_stat(id, &in) && in.kept && in.hash == hash);
        OK(!pt_stat(pl_link(p), &in) && !in.kept);
    }
    pl_gc();
    OK(!pt_stat(id, &in) && in.kept);
    link = pl_link(p);
    OK(pl_load_entry(p, PL_KIT, got) == -1 && pl_link(p) == link);   /* (a legacy factory pattern never loads on its own) */
    OK(pl_load_entry(p, id, got) == 0 && pl_link(p) == id && link_told(p, id));
    {
        pt_info_t first, last;
        OK(!pt_next(0, &first) && !pt_prev(PL_KIT, &last));
        OK(pl_step(0, 1) == first.id && pl_step(first.id, -1) == last.id && pl_step(last.id, 1) == first.id);
        OK(pl_step(0, -1) == last.id && pl_step(PL_KIT, 1) == first.id);   /* (a legacy link: the store's first) */
    }
    /* another layout: the notes load, the locks are left out */
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "FIRST ABSENT"); c++)
        ;
    if (c < N_PATTERN_CASES && !load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len)) {
        OK(pl_layout() != PATTERN_CASES[0].layout);
        OK(pl_load_entry(1, id, got) == 1 && eng_locks_count() == 0 && pl_link(1) == id);
    }
    printf("patlink: the SEQ page's kept copy (never freed, never written over) and load\n");
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
    OK(n == 26u && (b[14] & 2u) && b[15] == 48u && rd16(b + 16) > 0u && rd16(b + 18) == pt_total_bytes() && (b[25] & 7u) == 7u && (b[20] & 1u));
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
    /* PUT with total's bit 15 (PAT_KEPT, #1202 P1): a kept copy; a plain PUT over it is refused, a kept one is not */
    {
        uint32_t kid;
        pt_info_t in;
        memset(b, 0, sizeof b);
        b[2] = (uint8_t)PATTERN_CASES[c].payload_len;
        b[3] = 0x80;
        memcpy(b + 6, "KEPT", 4);
        memcpy(b + 22, PATTERN_CASES[c].payload, PATTERN_CASES[c].payload_len);
        frame(C_PAT_PUT, b, 22u + PATTERN_CASES[c].payload_len);
        OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_OK && (kid = rd16(e)) >= 1u && !pt_stat(kid, &in) && in.kept);
        b[0] = (uint8_t)kid;
        b[1] = (uint8_t)(kid >> 8);
        b[3] = 0;
        frame(C_PAT_PUT, b, 22u + PATTERN_CASES[c].payload_len);
        OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_MISSING);
        b[3] = 0x80;
        frame(C_PAT_PUT, b, 22u + PATTERN_CASES[c].payload_len);
        OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_OK && rd16(e) == kid && !pt_stat(kid, &in) && in.kept);
        OK(!pt_del(kid));
    }
    /* PATS: the user entries alone, a kept copy flagged (flags bit 1), none read-only */
    {
        char kname[PT_NAME + 1u];
        uint32_t kid = 0, seen = 0;
        pt_info_t in;
        OK(pl_keep(0, kname) == 1);
        while (!kid && !pt_next(seen, &in))
            kid = in.kept ? in.id : (seen = in.id, 0u);
        frame(C_PATS, 0, 0);
        cnt = pt_count();
        OK(nreplies == cnt && kid);
        for (k = 0, seen = 0; k < nreplies; k++) {
            n = reply(k, R_PAT, e, sizeof e);
            OK(n == 34u && rd16(e) == k && rd16(e + 2) == cnt && rd16(e + 4) >= 1u && rd16(e + 4) <= PT_ID_MAX && !(e[17] & 1u));
            if (n == 34u && rd16(e + 4) == id) {
                OK(rd16(e + 6) == PATTERN_CASES[c].payload_len && e[17] == 0 && !memcmp(e + 18, "CHUNKED", 8));
                seen |= 1u;
            }
            if (n == 34u && rd16(e + 4) == kid)
                seen |= 2u;
            if (n == 34u && !pt_stat(rd16(e + 4), &in))     /* (each flagged as the store keeps it, named so) */
                OK(e[17] == (in.kept ? 2u : 0u) && !memcmp(e + 18, in.name, strlen(in.name)));
        }
        OK(seen == 3u && !pt_del(kid));
    }
    /* a legacy factory pattern is not served, nor written */
    b[0] = (uint8_t)PL_KIT;
    b[1] = (uint8_t)(PL_KIT >> 8);
    b[2] = b[3] = 0;
    frame(C_PAT_GET, b, 4);
    OK(reply(0, R_PAT_DATA, b, sizeof b) == 6u && rd16(b + 2) == 0xFFFFu);
    memset(b, 0, sizeof b);
    b[0] = (uint8_t)PL_KIT;
    b[1] = (uint8_t)(PL_KIT >> 8);
    b[2] = (uint8_t)PATTERN_CASES[c].payload_len;
    memcpy(b + 22, PATTERN_CASES[c].payload, PATTERN_CASES[c].payload_len);
    frame(C_PAT_PUT, b, 22u + PATTERN_CASES[c].payload_len);
    OK(reply(0, R_PAT_STORED, e, sizeof e) == 4u && e[2] == S_RANGE);
    /* ids past PT_ID_MAX */
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

/* PATTERNED_CASES' patch `name` (pattern_cases.h: a factory patch with the patterns 1.25 gave it, the kits linking the
 * legacy factory patterns) into out: its length, 0 none */
static uint32_t patterned_bin(const char *name, uint8_t *out)
{
    uint32_t i;
    for (i = 0; i < N_PATTERNED_CASES; i++)
        if (!strcmp(PATTERNED_CASES[i].name, name)) {
            memcpy(out, PATTERNED_CASES[i].patch, PATTERNED_CASES[i].patch_len);
            return PATTERNED_CASES[i].patch_len;
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
/* a power-on: the RAM state as after a reset, then the boot's sl_scan and pt_claim (patstore_test.c's) */
static void boot(void)
{
    cut_after = -1;
    nreplies = 0;
    sl_next = 0;
    sl_layout(0);
    pt_on = 0;
    pt_scanned = 0;
    pt_seq = pt_nextid = 0;
    memset(pt_tail, 0, sizeof pt_tail);
    sl_scan();
    pt_claim();
    if (pt_on)
        pt_scan();
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
        pl_commit("CUT", 5);
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
    OK(!pt_put(&id, "LOCKS P2", pay, wn, 0) && pl_set_link(p, id));
    pl_hash[p] = pt_fnv(PT_FNV0, pay, wn);
    pl_rewrite();
    OK(!sl_write(5, "LINKED", m1_cur, m1_cur_len));
    cut_save("a user link", p);
    /* a legacy factory link: SAVE stores the patterns as user entries, then writes the slot */
    memset(nor, 0xFF, sizeof nor);
    boot();
    OK((len = patterned_bin("808 Kit", bin)) != 0 && !sl_write(5, "808 KIT", bin, len));
    cut_save("a legacy factory link", 2u);
}

/* pattern p of the first track: these n notes, each at its own step */
static void notes_at(uint32_t p, uint32_t n, uint32_t note)
{
    uint32_t w[16], k;
    for (k = 0; k < n && k < 16u; k++)
        w[k] = NW(k, 1u, note + k, STEP_VEL, 0u);
    OK(eng_pattern_set_notes((uint32_t)eng_steps_module(0), p, w, n));
    m1_patch_track((uint32_t)eng_steps_module(0));
}
/* pattern 1 of track module m one note longer at a time, each into the binary as the SEQ page puts it, until the bar says
 * PATCH FULL (1) or it holds TRACK_NOTES_MAX notes (0); *cnt: the notes before the last edit */
static int grow_one(uint32_t m, uint32_t *cnt)
{
    static uint32_t nw[TRACK_NOTES_MAX + 1u];
    const uint32_t *w;
    uint32_t k, j, full = (uint32_t)patch_full_calls;
    for (k = 0; (uint32_t)patch_full_calls == full; k++) {
        *cnt = (uint32_t)eng_pattern_notes(m, 0, &w);
        if (*cnt >= TRACK_NOTES_MAX)
            return 0;
        for (j = 0; j < *cnt; j++)
            nw[j] = w[j];
        nw[*cnt] = NW(k % 16u, 1u, 20u + k % 100u, STEP_VEL, 0u);
        OK(eng_pattern_set_notes(m, 0, nw, *cnt + 1u));
        nreplies = 0;
        m1_patch_track(m);
    }
    return (uint32_t)patch_full_calls == full + 1u;
}
/* #1202: every pattern 2..64 goes to the store at SAVE and the slot keeps pattern 1, the songs and the links; a pattern
 * shared by two patches (or two patterns of one) until one is edited, which then gets its own entry; an entry no slot
 * and not the running patch links goes; the inline patterns of 1.25 move to the store, those alike shared; the binary's
 * room (#1199): an edit of pattern 1 it cannot hold is refused, the patterns 2..64 it holds go to the store */
static void store(void)
{
    static uint8_t a5[PT_MAX + 64u], b5[PT_MAX + 64u], w2[PT_MAX + 64u], bin[M1_PATCH_MAX];
    uint32_t c, m, p, id3, id5, idc = 0, n5, n2, len, cnt = 0, k, full;
    const uint32_t *w;
    pt_info_t in;
    char name[PT_NAME + 1u];
    memset(nor, 0xFF, sizeof nor);
    boot();
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "SHORT WORDS"); c++)
        ;
    OK(c < N_PATTERN_CASES && !load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
    notes_at(2, 3, 40u);                            /* P03 and P04 alike, P05 its own */
    notes_at(3, 3, 40u);
    notes_at(4, 5, 50u);
    OK(inline_has(2) == 1 && inline_has(4) == 1);
    nreplies = 0;
    OK(pl_commit("Store Test", 0) == 0);
    id3 = pl_link(2);
    id5 = pl_link(4);
    OK(id3 && pl_link(3) == id3 && id5 && id5 != id3 && pl_link(1) && link_told(4, id5));
    for (p = 1; p <= 4u; p++)
        OK(has(p) && inline_has(p) == 0);
    OK(!pt_stat(id5, &in) && !strcmp(in.name, "STORE TEST P05"));
    n5 = encode(4, a5);
    OK(!sl_write(0, "A", m1_cur, m1_cur_len) && !sl_write(1, "B", m1_cur, m1_cur_len));   /* (B: a copy of A) */
    OK(!load_slot(0) && encode(4, b5) == n5 && !memcmp(a5, b5, n5) && pl_link(4) == id5);
    /* the copy edited: its own entry at SAVE, the original keeps its pattern */
    OK(!load_slot(1));
    edit(4);
    OK(pl_commit("B", 1) == 0 && (idc = pl_link(4)) != id5 && idc);
    OK(!sl_write(1, "B", m1_cur, m1_cur_len));
    OK(!load_slot(0) && encode(4, b5) == n5 && !memcmp(a5, b5, n5) && pl_link(4) == id5);
    /* edited again: only B links its entry now, which is written over */
    OK(!load_slot(1));
    notes_at(4, 2, 70u);
    OK(pl_commit("B", 1) == 0 && pl_link(4) == idc);
    OK(!sl_write(1, "B", m1_cur, m1_cur_len));
    /* two patterns of one patch alike: one edited splits off */
    OK(!load_slot(0));
    notes_at(2, 4, 40u);
    OK(pl_commit("A", 0) == 0 && pl_link(2) != id3 && pl_link(3) == id3);
    OK(!sl_write(0, "A", m1_cur, m1_cur_len));
    /* an entry no slot links goes; the running patch's stay */
    OK(!load_slot(1));
    OK(!sl_erase(1));
    pl_gc();
    OK(!pt_stat(idc, &in) && !pt_stat(id5, &in));
    OK(!load_slot(0));
    pl_gc();
    OK(pt_stat(idc, &in) == -1 && !pt_stat(id5, &in) && !pt_stat(id3, &in));
    printf("patlink: SAVE stores patterns 2..64, shared until edited, an edited copy splits, freed once unlinked\n");

    /* 1.25's inline patterns into the store (main.c bank_patterns: as SAVE), two alike sharing one entry */
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "LOCKS P2"); c++)
        ;
    p = PATTERN_CASES[c].pattern;
    OK(!sl_write(2, "OLD", PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
    OK(!sl_write(3, "OLD TOO", PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
    OK(!load_slot(2) && inline_has(p) == 1 && !pl_link(p));
    n2 = encode(p, w2);
    OK(pl_commit("OLD", 2) == 0 && pl_link(p) && m1_edited && m1_valid(m1_cur, m1_cur_len));
    OK(m1_cur_len < PATTERN_CASES[c].patch_len && !sl_write(2, "OLD", m1_cur, m1_cur_len));
    id3 = pl_link(p);
    OK(!load_slot(2) && has(p) && inline_has(p) == 0 && encode(p, b5) == n2 && !memcmp(b5, w2, n2) && pl_link(p) == id3);
    OK(!load_slot(3) && pl_commit("OLD TOO", 3) == 0 && pl_link(p) == id3 && !sl_write(3, "OLD TOO", m1_cur, m1_cur_len));
    printf("patlink: 1.25's inline patterns move to the store, two alike share one entry\n");

    /* #1199, #1292: pattern 1 past the binary's room goes to the store as 2..64 do; with the store off it is refused (the
     * engine keeps what the binary has, the bar says so) */
    OK((len = patterned_bin("808 Kit", bin)) != 0 && !load_patch(bin, len));
    m = (uint32_t)eng_steps_module(0);
    OK(!grow_one(m, &cnt) && cnt == TRACK_NOTES_MAX && pl_link(0) && m1_valid(m1_cur, m1_cur_len));
    pt_on = 0;
    OK(!load_patch(bin, len));
    OK(grow_one(m, &cnt) && eng_pattern_notes(m, 0, &w) == (int)cnt && !pl_link(0) && m1_valid(m1_cur, m1_cur_len));
    pt_on = 1;
    /* a pattern 2..64 past it (P04, as in kits) goes to the store (an entry only this patch links), and SAVE keeps that
     * entry */
    OK(!load_patch(bin, len) && pl_copy(3, 24) == 0 && (idc = pl_link(24)) && (pl_priv >> 24 & 1u));
    OK(pl_commit("808 Kit", 0) == 0 && pl_link(24) == idc && !pl_priv);
    pl_name(name, "a very long patch name", 63);
    OK(!strcmp(name, "A VERY LONG P64"));
    printf("patlink: a full patch stores pattern 1 as the others, refuses its edit with the store off (#1199, #1292)\n");
}

/* the 909 Kit loaded: 0. shipped: as the factory set has it (presets.h: its FX drawer, format 67, D-1055), else as 1.25
 * saved it (pattern_cases.h PATTERNED_CASES: no drawer, format 64) with pattern 1 alone, its links to the legacy factory
 * patterns dropped */
static int kit_909(int shipped)
{
    static uint8_t b[M1_PATCH_MAX];
    uint32_t i, p;
    int32_t n = -1;
    if (!shipped) {
        if (!(n = (int32_t)patterned_bin("909 Kit", b)) || load_patch(b, (uint32_t)n))
            return -1;
        for (p = 1; p < ENG_PATTERNS; p++) {
            clear(p);
            (void)pl_set_link(p, 0);
        }
        m1_patch_patterns();
        return m1_patch_locks() ? 0 : -1;
    }
    for (i = 0; i < N_PRESETS && strcmp(PRESET_LIST[i].name, "909 KIT"); i++)
        ;
    if (i < N_PRESETS)
        n = lz_unpack(PRESET_LIST[i].lz, PRESET_LIST[i].lz_len, b, sizeof b);
    return n > 0 ? load_patch(b, (uint32_t)n) : -1;
}
/* pattern p of the first track: n notes on 16 steps, then c P-locks over 10 rows (another module's parameter 1 each, a
 * step's rows first), each into the binary as the SEQ page puts it */
static void kit_pattern(uint32_t p, uint32_t n, uint32_t c)
{
    static const uint32_t note[] = { 36u, 42u, 38u, 42u };
    uint32_t w[16], row[10], rows = 0, j, mod, m = (uint32_t)eng_steps_module(0);
    for (mod = 0; mod < (uint32_t)eng_nmodules() && rows < 10u; mod++)
        if (mod != m && eng_type(mod) != T_PART && eng_type(mod) != T_STEPS && DEFS[eng_type(mod)].npar > 1)
            row[rows++] = mod;
    for (j = 0; j < n; j++)
        w[j] = NW(j * 16u / n, 1u, note[j % 4u], STEP_VEL, 0u);
    OK(rows == 10u && eng_pattern_set_notes(m, p, w, n));
    if (p)
        m1_patch_patterns();
    else
        m1_patch_track(m);
    for (j = 0; rows && j < c; j++) {
        OK(!eng_lock_set(m, p, j / rows, row[j % rows], 1u, 0, 1000 * (int32_t)j, 1));
        OK(m1_patch_locks());
    }
}
/* the PAT_LINK_NOW replies since nreplies was reset */
static uint32_t links_told(void)
{
    uint8_t b[8];
    uint32_t k, n = 0;
    for (k = 0; k < nreplies; k++)
        n += reply(k, R_PAT_LINK_NOW, b, sizeof b) != 0u;
    return n;
}
/* the store filled with junk entries (each its own bytes); lo: then junk freed until it takes an entry of lo bytes, but
 * not that one and another of hi bytes too. store_unfill: the junk gone */
static uint8_t junk[PT_MAX];
static uint32_t junk_id[PT_TAB], junks, junk_k;
static int store_takes(uint32_t n)
{
    uint32_t id = 0;
    junk_k++;
    junk[0] = (uint8_t)junk_k;
    junk[1] = (uint8_t)(junk_k >> 8);
    if (pt_put(&id, "PROBE", junk, n, 0))
        return 0;
    (void)pt_del(id);
    return 1;
}
static void store_fill(uint32_t lo, uint32_t hi)
{
    uint32_t sz, id;
    memset(junk, 0x11, sizeof junk);
    for (sz = PT_MAX; sz >= 8u; sz /= 2u)
        for (;;) {
            id = 0;
            junk_k++;
            junk[0] = (uint8_t)junk_k;
            junk[1] = (uint8_t)(junk_k >> 8);
            if (junks == PT_TAB || pt_put(&id, "JUNK", junk, sz, 0))
                break;
            junk_id[junks++] = id;
        }
    while (lo && junks && !store_takes(lo))
        (void)pt_del(junk_id[--junks]);
    OK(!lo || (store_takes(lo) && !store_takes(lo + PT_HDR + hi)));
}
static void store_unfill(void)
{
    while (junks)
        (void)pt_del(junk_id[--junks]);
}
/* a double the binary refuses after the patterns it holds went to the store to make room (#1199, #1292, D-838): the
 * binary byte for byte, the engine, the links and m1_edited as they were, and the editor told nothing. The store on but
 * with room for P02's entry only (the spill links P02, pattern 1's spill finds no room: the double's undo kept apart
 * from the payloads the spill writes, the spill's links undone), full (the spill takes nothing) and off; a double the
 * store makes room for done, its link told. On the 909 Kit as 1.25 saved it (116 bytes free): 8 notes and 8 P-locks fit,
 * doubled they do not */
static void double_spill(void)
{
    uint64_t clean;
    uint32_t most, n, id, lo, hi;
    memset(nor, 0xFF, sizeof nor);
    boot();
    OK(!kit_909(0));
    kit_pattern(0, 8, 8);
    kit_pattern(1, 5, 0);
    OK(inline_has(1) == 1 && !pl_link(1));
    lo = encode(1, pay);
    hi = encode(0, pay);
    store_fill(lo, hi);
    n = pt_count();
    m1_edited = 0;
    nreplies = 0;
    OK(refused(pl_double, 0, -4));
    OK(pt_count() == n + 1u && !pl_link(0) && !pl_link(1) && !pl_priv && !m1_edited && !links_told());   /* (its entry stays until pl_gc) */
    store_unfill();
    OK(!kit_909(0));
    kit_pattern(1, 8, 8);
    nreplies = 0;
    OK(pl_double(1, &most) == 0 && most == 32u && (id = pl_link(1)) != 0u && link_told(1, id) && (pl_priv >> 1 & 1u));
    OK(links_ok(&clean) == 1u && clean == 2u);      /* (the stored entry is the doubled P02) */
    store_fill(0, 0);
    OK(!kit_909(0));
    kit_pattern(1, 8, 8);
    m1_edited = 0;
    nreplies = 0;
    OK(refused(pl_double, 1, -4));
    OK(!pl_link(1) && !m1_edited && !links_told());
    store_unfill();
    pt_on = 0;
    OK(!kit_909(0));
    kit_pattern(0, 8, 8);
    kit_pattern(1, 5, 0);
    m1_edited = 0;
    nreplies = 0;
    OK(refused(pl_double, 0, -4));
    OK(!m1_edited && !links_told());
    OK(!kit_909(0));
    kit_pattern(1, 8, 8);
    OK(refused(pl_double, 1, -4));
    pt_on = 1;
    printf("patlink: a double refused after the store made room leaves the binary, the links and the editor as they were (D-838)\n");
}

static uint32_t slot_all(uint32_t s, uint32_t mode, uint8_t *out, uint32_t *total);
/* binary b loaded as the FM-1 loads it (its links resolved) and played from the start: a hash of 0.7 s of its output */
static uint32_t render_of(const uint8_t *b, uint32_t len)
{
    static int32_t l[64], r[64];
    uint32_t h = PT_FNV0, k;
    eng_transport(0);
    if (load_patch(b, len))
        return 0;
    eng_transport(1);
    for (k = 0; k < 500u; k++) {
        eng_render(l, r, 64);
        h = pt_fnv(h, l, sizeof l);
        h = pt_fnv(h, r, sizeof r);
    }
    eng_transport(0);
    return h;
}
/* #1292, the owner's case: the shipped 909 Kit (its FX drawer leaves pattern 1 about 51 bytes) with pattern 1 of 8 notes
 * and 32 P-locks (already in the store: the patch cannot hold the locks) doubled, pattern 1 in the store, linked (format
 * 67); SAVE keeps the link, the slot loaded again and SLOT_GET mode 0 give the same patterns and the same output, mode 1
 * (every pattern inside) is too big; once pattern 1 fits again (one note, no locks) SAVE puts it back inline */
static void pattern1_spill(void)
{
    static uint8_t a[24576], b[24576], st[M1_PATCH_MAX], got[M1_PATCH_MAX], was[ENG_PATTERNS * 400u], now[ENG_PATTERNS * 400u];
    uint32_t most = 0, id, na, nb, nw, len, total, r1;
    memset(nor, 0xFF, sizeof nor);
    boot();
    OK(!kit_909(1));
    kit_pattern(0, 8, 32);
    nreplies = 0;
    OK(pl_double(0, &most) == 0 && most == 32u && (id = pl_link(0)) != 0u && link_told(0, id) && m1_valid(m1_cur, m1_cur_len));
    na = state(a);
    nw = all_payloads(was, sizeof was);
    OK(pl_commit("909 KIT", 7) == 0 && (id = pl_link(0)) != 0u && !sl_write(7, "909 KIT", m1_cur, m1_cur_len));
    OK(!load_slot(7) && pl_link(0) == id);
    nb = state(b);
    OK(na == nb && !memcmp(a, b, na));
    OK(all_payloads(now, sizeof now) == nw && !memcmp(now, was, nw));
    OK(sl_read(7, st, &len, 0) == 0 && (r1 = render_of(st, len)) != 0u);
    OK(slot_all(7, 0, got, &total) == len && !memcmp(got, st, len));
    OK(render_of(got, len) == r1 && all_payloads(now, sizeof now) == nw && !memcmp(now, was, nw));
    m1_edited = 0;
    OK(slot_all(7, 1, got, &total) == 0 && total == 0xFFFEu);
    /* pattern 1 down to one note without locks: it fits, SAVE writes it inline and drops the link */
    OK(!load_slot(7));
    clear(0);
    OK(eng_pattern_set_notes((uint32_t)eng_steps_module(0), 0, notes_one(), 1u));
    m1_patch_track((uint32_t)eng_steps_module(0));
    OK(m1_patch_locks());
    OK(pl_commit("909 KIT", 7) == 0 && !pl_link(0) && !sl_write(7, "909 KIT", m1_cur, m1_cur_len));
    na = state(a);
    OK(content(m1_cur, m1_cur_len, b) != 0u && !memcmp(a, b, na));
    OK(!load_slot(7) && !pl_link(0));
    nb = state(b);
    OK(na == nb && !memcmp(a, b, na));
    printf("patlink: the 909 Kit's pattern 1 (8 notes, 32 locks) doubled into the store, saved, loaded, SLOT_GET, inline again once it fits (#1292)\n");
}

/* boot's migration (main.c bank_patterns): each slot pl_slot_due names loaded, its patterns stored (pl_commit) and the
 * slot written again when that changed it; then pl_gc. The slots written */
static uint32_t migrate(void)
{
    static uint8_t b[M1_PATCH_MAX];
    char name[M1_NAME + 1u];
    uint32_t s, len, n = 0;
    for (s = 0; s < bank_slots; s++) {
        if (!(bank_mask >> s & 1u) || sl_read(s, b, &len, name) || !pl_slot_due(b, len) || load_patch(b, len))
            continue;
        (void)pl_commit(name, s);
        if (m1_edited && !sl_write(s, name, m1_cur, m1_cur_len))
            n++;
    }
    pl_gc();
    return n;
}
/* the running patch links only user entries (not kept copies) named `prefix` Pnn, each clean */
static int user_links(const char *prefix)
{
    uint32_t n, k, id;
    const uint8_t *e = pl_links(&n);
    uint64_t clean = m1_pat_clean();
    pt_info_t in;
    if (!n)
        return 0;
    for (k = 0; k < n; k++, e += 3) {
        id = (uint32_t)e[1] | (uint32_t)e[2] << 8;
        if (id < 1u || id > PT_ID_MAX || pt_stat(id, &in) || in.kept || strncmp(in.name, prefix, strlen(prefix)) || !(clean >> e[0] & 1u))
            return 0;
    }
    return 1;
}

/* the legacy factory patterns (#1202 G8): kept only so a slot 1.25 saved with links to them plays them, until boot makes
 * them user entries */
static void legacy(void)
{
    static uint8_t bin[M1_PATCH_MAX], was[ENG_PATTERNS * 400u], now[ENG_PATTERNS * 400u];
    static const char *const names[] = { "808 Kit", "909 Kit" }, *const prefix[] = { "808 KIT P", "909 KIT P" };
    pt_info_t in;
    uint64_t clean;
    uint32_t g, k, i, id, len = 0, n = 0, total = 0, nw, nn, cnt, cut;
    memset(nor, 0xFF, sizeof nor);
    boot();
    for (g = 0; g < N_KIT_GROUPS; g++)
        for (k = 0; k < KIT_GROUPS[g].n; k++, total++) {
            id = KIT_GROUPS[g].first + k;
            OK(pl_legacy(id) && !pl_read(id, m1_up, sizeof m1_up, &in) && in.id == id && in.name[0] && !pl_check(m1_up, in.len)
               && in.hash == pt_fnv(PT_FNV0, m1_up, in.len));
        }
    /* (a kit may take several groups, #852: the id before the last group's first is a hole between the kits' blocks) */
    OK(total == N_KIT_PATTERNS && pl_read(KIT_GROUPS[N_KIT_GROUPS - 1].first - 1u, m1_up, sizeof m1_up, &in) == -1);
    OK(!pl_legacy(PT_ID_MAX) && pl_step(0, 1) == 0u && m1_pat_list(0, 0) == 0u);   /* (none listed: the store is empty) */
    for (i = 0; i < 2u; i++) {
        OK((len = patterned_bin(names[i], bin)) != 0);
        if (!len || load_patch(bin, len)) {
            OK(!"the kit loads");
            continue;
        }
        (void)pl_links(&n);
        OK(n >= 11u && links_ok(&clean) == n && m1_pat_clean() == clean && pl_slot_due(bin, len));
        OK(eng_song_len(0) >= 8);                       /* (its song, over the linked patterns) */
        for (k = 0; k < (uint32_t)eng_song_len(0); k++)
            OK(has((uint32_t)eng_song_get(0, k) & 0xFFu));
        m1_patch_patterns();                            /* (rewritten as it came: the clean links stay out) */
        OK(m1_patch_locks() && m1_cur_len == len && !memcmp(m1_cur, bin, len));
        pt_on = 0;                                      /* (a legacy link needs no store) */
        OK(!load_patch(bin, len) && links_ok(&clean) == n);
        pt_on = 1;
        if (!i) {                                       /* (#1177) a copy of a pattern linked to a legacy one is a plain one: P04
                                                         * does not fit the 808 Kit's bytes, so without a store nothing
                                                         * changes, and with one the patterns the binary holds go there,
                                                         * linked (#1199); P21 (16 hits) then fits inline, to P26 */
            static uint8_t before[M1_PATCH_MAX];
            const uint32_t *w, *x;
            uint32_t m = (uint32_t)eng_steps_module(0), q = 24u, blen;
            int c;
            OK(!load_patch(bin, len) && pl_free(q) && pl_link(3) != 0u && pl_link(20) != 0u);
            blen = m1_cur_len;
            memcpy(before, m1_cur, blen);
            pt_on = 0;
            OK(pl_copy(3, q) == -2 && pl_free(q) && m1_cur_len == blen && !memcmp(before, m1_cur, blen));
            pt_on = 1;
            nreplies = 0;
            OK(pl_copy(3, q) == 0 && pl_link(q) >= 1u && pl_link(q) <= PT_ID_MAX && (pl_priv >> q & 1u) && inline_has(q) == 0);
            OK(link_told(q, pl_link(q)) && m1_valid(m1_cur, m1_cur_len));
            OK(pl_copy(20, q + 1u) == 0 && !pl_link(q + 1u) && pl_link(20) != 0u);
            c = eng_pattern_notes(m, 20, &w);
            OK(c > 0 && c == eng_pattern_notes(m, q + 1u, &x) && !memcmp(w, x, 4u * (uint32_t)c) && inline_has(q + 1u) == 1);
        }
        printf("patlink: %s as 1.25 saved it: %u links to the legacy factory patterns, played, its song over them\n", names[i],
               (unsigned)n);
    }
    /* boot's migration: both kits' slots, their patterns user entries with the same payloads, linked; again: nothing */
    memset(nor, 0xFF, sizeof nor);
    boot();
    for (i = 0; i < 2u; i++)
        OK((len = patterned_bin(names[i], bin)) != 0 && !sl_write(5u + i, i ? "909 Kit" : "808 Kit", bin, len));
    pl_gc();
    OK(pt_count() == 0u && migrate() == 2u);
    cnt = pt_count();
    for (i = 0; i < 2u; i++) {
        OK((len = patterned_bin(names[i], bin)) != 0 && !load_patch(bin, len));
        nw = all_payloads(was, sizeof was);
        OK(!load_slot(5u + i) && user_links(prefix[i]));
        nn = all_payloads(now, sizeof now);
        OK(nn == nw && !memcmp(was, now, nn) && eng_song_len(0) >= 8);
    }
    OK(cnt >= 11u && migrate() == 0u && pt_count() == cnt);
    boot();
    OK(migrate() == 0u && pt_count() == cnt);
    printf("patlink: boot makes the legacy factory patterns user entries (%u), the payloads as they were; again: nothing\n",
           (unsigned)cnt);
    /* SAVE of a patch that links them (not edited) stores them too: the same entries, by their bytes */
    OK((len = patterned_bin("909 Kit", bin)) != 0 && !load_patch(bin, len));
    OK(pl_commit("909 Kit", 7) == 0 && user_links("909 KIT P") && pt_count() == cnt);
    /* an edited one gets an entry of its own */
    edit(2);
    OK(pl_commit("909 Kit", 7) == 0 && user_links("909 KIT P") && pt_count() == cnt + 1u);
    printf("patlink: SAVE never keeps a legacy link: the patterns go to user entries\n");
    /* a power cut at every byte the migration programs: the next boot migrates again, no entry twice */
    memset(nor, 0xFF, sizeof nor);
    boot();
    OK((len = patterned_bin("808 Kit", bin)) != 0 && !sl_write(5, "808 Kit", bin, len));
    memcpy(nor_saved, nor, sizeof nor);
    OK(!load_patch(bin, len));
    nw = all_payloads(was, sizeof was);
    OK(migrate() == 1u);
    cnt = pt_count();
    for (cut = 0;; cut += cut < 64u ? 1u : 13u) {
        memcpy(nor, nor_saved, sizeof nor);
        boot();
        cut_hit = 0;
        cut_after = (long)cut;
        (void)migrate();
        boot();
        (void)migrate();
        nn = 0;
        if (load_slot(5) || !user_links("808 KIT P") || (nn = all_payloads(now, sizeof now)) != nw || memcmp(was, now, nn) || pt_count() != cnt) {
            fprintf(stderr, "legacy migration cut after %u bytes: %u entries (want %u)\n", (unsigned)cut, (unsigned)pt_count(), (unsigned)cnt);
            OK(!"the slot migrated once, its patterns as they were");
            break;
        }
        if (!cut_hit)
            break;
    }
    printf("patlink: the migration cut at %u points: migrated again at the next boot, no entry twice\n", (unsigned)cut);
}

/* SLOT_GET (slot_get.h) with main.c's surroundings stood in */
static uint8_t bank_buf[M1_PATCH_MAX];
static uint8_t eng_run = 1, snd_muted, sb_on, ui_full, sg_live;
static uint32_t msg_until, sg_fallbacks;
static char sg_msg[40];
#define PAL_NONE 0xFFu
static uint8_t pal_next = PAL_NONE;
static int slot_used(uint32_t s) { return s < bank_slots && (bank_mask >> s & 1u); }
static int m1_engine_load(const uint8_t *p, uint32_t len)
{
    static uint8_t t[M1_PATCH_MAX];
    memcpy(t, p, len);
    eng_run = 0;
    return eng_load(t, len);
}
static int editor_live(void) { return sg_live; }
static void ui_msg(const char *s, uint32_t ms) { (void)ms; snprintf(sg_msg, sizeof sg_msg, "%s", s); }
static void leds_avail(void) {}
static void fallback_boot(void) { sg_fallbacks++; }
static char *put(char *d, const char *s) { while (*s) *d++ = *s++; *d = 0; return d; }
static void fmt_int(char *b, int32_t v) { sprintf(b, "%d", (int)v); }
#include "../src/messages.h"
#include "../src/slot_get.h"
/* SLOT_GET of slot s, mode, offset off: the bytes into out (at off), the total in *total; the bytes it carried */
static uint32_t slot_chunk(uint32_t s, uint32_t mode, uint32_t off, uint8_t *out, uint32_t *total)
{
    uint8_t b[4], r[300];
    uint32_t n;
    b[0] = (uint8_t)s;
    b[1] = (uint8_t)off;
    b[2] = (uint8_t)(off >> 8);
    b[3] = (uint8_t)mode;
    frame(C_SLOT_GET, b, 4);
    n = reply(0, R_SLOT_DATA, r, sizeof r);
    if (n < 5u || r[0] != s || rd16(r + 3) != off) {
        *total = 0;
        return 0;
    }
    *total = rd16(r + 1);
    memcpy(out + off, r + 5, n - 5u);
    return n - 5u;
}
/* the whole binary: its length, 0 refused (*total the status) */
static uint32_t slot_all(uint32_t s, uint32_t mode, uint8_t *out, uint32_t *total)
{
    uint32_t off = 0, n;
    do {
        n = slot_chunk(s, mode, off, out, total);
        off += n;
    } while (n && off < *total);
    return *total < 0xFFFCu && off == *total ? off : 0u;
}
static void slot_get(void)
{
    static uint8_t run[M1_PATCH_MAX], got[M1_PATCH_MAX], st[M1_PATCH_MAX], was[ENG_PATTERNS * 400u], now[ENG_PATTERNS * 400u];
    uint32_t c, len, rlen, total, n, p, k, nw, nn, words[64];
    memset(nor, 0xFF, sizeof nor);
    boot();
    /* slot 4: patterns 2..5 in the store, linked; slot 0 runs another patch */
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "LOCKS P2"); c++)
        ;
    OK(c < N_PATTERN_CASES && !load_patch(PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len));
    notes_at(2, 3, 40u);
    notes_at(3, 5, 50u);
    notes_at(4, 2, 60u);
    OK(pl_commit("SG", 4) == 0 && pl_link(2) && !sl_write(4, "SG", m1_cur, m1_cur_len));
    OK(!load_slot(4));
    nw = all_payloads(was, sizeof was);
    for (c = 0; c < N_PATTERN_CASES && strcmp(PATTERN_CASES[c].name, "SHORT WORDS"); c++)
        ;
    OK(c < N_PATTERN_CASES && !sl_write(0, "RUN", PATTERN_CASES[c].patch, PATTERN_CASES[c].patch_len) && !load_slot(0));
    rlen = m1_cur_len;
    memcpy(run, m1_cur, rlen);
    nn = all_payloads(now, sizeof now);
    /* mode 0: the slot's bytes as stored */
    OK(sl_read(4, st, &len, 0) == 0 && slot_all(4, 0, got, &total) == len && !memcmp(got, st, len) && !slot_bk);
    /* mode 1: borrowed muted, the bar says so; every pattern inline, no links, the patterns the slot plays */
    n = slot_chunk(4, 1, 0, got, &total);
    OK(n && slot_bk == 5u && snd_muted && !eng_run && !strcmp(sg_msg, "BACKING UP SLOT 5"));
    for (len = n; n && len < total; len += n)
        n = slot_chunk(4, 1, len, got, &total);
    OK(len == total && !(got[7] & ENG_FLAG_LINKS) && got[1] <= ENG_PATCH_VERSION && m1_valid(got, len));
    OK(!slot_bk && eng_run && !snd_muted && !m1_edited && m1_cur_len == rlen && !memcmp(m1_cur, run, rlen) && !sg_fallbacks);
    k = all_payloads(st, sizeof st);
    OK(k == nn && !memcmp(st, now, k));             /* (the engine plays the running patch again) */
    pt_on = 0;                                      /* (the inline binary alone: no store to resolve from) */
    OK(!load_patch(got, len));
    k = all_payloads(st, sizeof st);
    pt_on = 1;
    OK(k == nw && !memcmp(st, was, k));
    OK(!load_slot(0));
    printf("patlink: SLOT_GET mode 1: %u bytes with every pattern inside, no links; the running patch back after the last chunk\n",
           (unsigned)len);
    /* cut off: another command brings the running patch back; so do 2 s without a chunk */
    OK(slot_chunk(4, 1, 0, got, &total) && slot_bk == 5u);
    frame(C_HELLO, 0, 0);
    OK(!slot_bk && m1_cur_len == rlen && !memcmp(m1_cur, run, rlen) && !snd_muted && eng_run);
    OK(slot_chunk(4, 1, 0, got, &total) && slot_bk == 5u);
    fm1_ms += 1000u;
    slot_bk_poll();
    OK(slot_bk == 5u);
    n = slot_chunk(4, 1, 256, got, &total);
    OK(n == total - 256u && total < 512u && !slot_bk);   /* (the last chunk: back) */
    OK(slot_chunk(4, 1, 0, got, &total) && slot_bk == 5u);
    fm1_ms += 1000u;
    slot_bk_poll();
    OK(slot_bk == 5u);
    fm1_ms += 1100u;
    slot_bk_poll();
    OK(!slot_bk && m1_cur_len == rlen && !memcmp(m1_cur, run, rlen) && !m1_edited);
    OK(slot_chunk(4, 1, 0, got, &total) && slot_chunk(9, 0, 0, got, &total) == 0 && total == 0xFFFFu && !slot_bk
       && !memcmp(m1_cur, run, rlen));             /* (another slot asked: back, and an empty slot: 0xFFFF) */
    /* refused, nothing changes: the transport runs, unsaved edits, Live, a palette switch waiting, an empty slot */
    eng_transport(1);
    OK(slot_all(4, 1, got, &total) == 0 && total == 0xFFFCu && !slot_bk);
    eng_transport(0);
    m1_edited = 1;
    OK(slot_all(4, 1, got, &total) == 0 && total == 0xFFFDu && !slot_bk);
    m1_edited = 0;
    sg_live = 1;
    OK(slot_all(4, 1, got, &total) == 0 && total == 0xFFFDu && !slot_bk);
    sg_live = 0;
    pal_next = 2;
    OK(slot_all(4, 1, got, &total) == 0 && total == 0xFFFDu && !slot_bk);
    pal_next = PAL_NONE;
    OK(slot_all(9, 1, got, &total) == 0 && total == 0xFFFFu && slot_all(60, 0, got, &total) == 0 && total == 0xFFFFu);
    OK(m1_cur_len == rlen && !memcmp(m1_cur, run, rlen));
    /* too big with every pattern inside: 0xFFFE, the running patch back */
    OK(!load_slot(4));
    for (p = 1; p < ENG_PATTERNS; p++) {
        for (k = 0; k < 64u; k++)
            words[k] = NW(k % 16u, 1u, 30u + k, 77u, 0u);
        if (!eng_pattern_set_notes((uint32_t)eng_steps_module(0), p, words, 64u))
            break;
    }
    OK(p > 20u && pl_commit("BIG", 6) == 0 && m1_valid(m1_cur, m1_cur_len) && !sl_write(6, "BIG", m1_cur, m1_cur_len));
    OK(!load_slot(0));
    OK(slot_all(6, 1, got, &total) == 0 && total == 0xFFFEu && !slot_bk && m1_cur_len == rlen && !memcmp(m1_cur, run, rlen)
       && !m1_edited && !snd_muted && eng_run);
    OK(slot_all(6, 0, got, &total) != 0);           /* (mode 0 serves it as stored) */
    printf("patlink: SLOT_GET mode 1 cut off (another command, 2 s), refused (0xFFFC, 0xFFFD, 0xFFFF) and too big (0xFFFE)\n");
}

int main(void)
{
    memset(nor, 0xFF, sizeof nor);
    sl_scan();
    pt_claim();
    if (pt_on)
        pt_scan();
    if (!pt_on || bank_slots != 48u) {
        fprintf(stderr, "FAIL: the empty bank's claim did not turn the store on\n");
        return 1;
    }
    vectors();
    ops();
    doubles();
    halves();
    links();
    seq_page();
    link_frames();
    legacy();
    slot_get();
    cuts();
    store();
    double_spill();
    pattern1_spill();
    if (fails) {
        fprintf(stderr, "patlink: %d checks failed\n", fails);
        return 1;
    }
    printf("patlink ok\n");
    return 0;
}
