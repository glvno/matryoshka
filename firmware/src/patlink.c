/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The pattern store's glue (#901, option D): between the engine's patterns, the running patch (proto.c m1_cur) and the
 * stored patterns (patstore.c).
 *
 * A stored pattern's payload is one pattern number across the patch's Steps tracks (track k = the k-th Steps module in
 * module order), all LE, byte for byte what web/src/pattern-store.ts writes:
 *   u8 version (1; 2 when a track's n passes ENG_NOTES_1_26: firmware before 1.27 refuses it, pl_check), u32 layout (0
 *   without P-locks, else pl_layout), u8 T (1 + the last track that has the pattern, at least 1), per track k < T: n
 *   (0xFF: the track has not got the pattern; else ENG_COUNT_ESC's count, version 2 only past 128), with n != 0xFF u8 len
 *   (bits 0..6: 0 the track's, else 1..64; bit 7: short words), u8 rate (0xFF the track's, else a STEPS_RATES index) and n
 *   u16 short words (format 48's rule and layout, engine.c eng_notes_short) or u32 note words; then u8 L, per locked track
 *   (ascending k) u8 k, u8 c (1..64) and c locks of 7 bytes as eng_locks_list writes them.
 * Pattern index 0 (pattern 1) has no own length / rate: written as len 0 and rate 0xFF, ignored when loaded.
 *
 * The running patch links pattern indices 1..63 to stored ids in format 59's section after the P-locks, and since format
 * 67 (ENG_WIDE, #1292) pattern index 0 too: m1_cur holds the only copy (pl_link reads it, pl_set_link rewrites it).
 * pl_hash keeps each link's payload hash as the store gave it to this patch. A linked pattern whose payload still hashes
 * to that is clean: proto.c leaves it out of the patterns and locks sections (pattern 1: of the notes section and the
 * locks; m1_pat_clean), so the binary carries only the link and the next load copies it from the store again. An edited
 * one stays inline until SAVE (pl_commit, #1202), which puts every pattern 2..64 into the store: a saved slot holds
 * pattern 1, its songs and its links. An edited pattern that another slot or another pattern of the patch links gets an
 * entry of its own then (shared until edited); an entry no slot and not the running patch links goes (pl_gc). When the
 * binary cannot hold the inline ones, they go to entries only the running patch links (m1_pat_spill, #1199), and when it
 * cannot hold pattern 1 either, pattern 1 too (#1292); SAVE brings pattern 1 back inline when the binary can hold it. The
 * store holds user entries only (ids 1..PT_ID_MAX, kept copies
 * among them). The legacy factory patterns (the 808 Kit's and 909 Kit's patterns that were read-only store entries up to
 * 1.25: factory_tier.h KIT_GROUPS from PL_KIT, a kit's block in one or more groups of consecutive ids packed by
 * lz_unpack.h, each unpacking into m1_up) stay compiled in only so a patch that still links one plays it (pl_read): SAVE
 * stores such a pattern as a user entry and links that (pl_commit, which main.c's boot runs on every slot that links one,
 * #1202 G8). They are never listed, browsed or loaded on their own.
 *
 * The payloads go through m1_up (proto.c's upload buffer: the store works in sl_buf, and the editor sends no patch upload
 * while it talks to the store); an edit the binary may still refuse after m1_pat_spill ran keeps its undo at m1_up's
 * start, and the spill's payloads go after it (pl_mark). Needs, after proto.c and patstore.c: m1_cur, m1_cur_len,
 * m1_edited, m1_up, m1_patch_patterns, m1_patch_locks, m1_patch_links, m1_steps_write, m1_steps_cost, m1_pat_link_now,
 * m1_track_pattern_now, m1_locks_now, m1_patch_name, bank_slots, bank_mask, sl_head / sl_buf (slotstore.c), KIT_GROUPS
 * (factory_tier.h). */
#define PL_KIT (PT_ID_MAX + 1u)            /* the first legacy factory pattern's id: 0xE000 */

static uint32_t pl_hash[ENG_PATTERNS];     /* each link's payload hash as the store gave it to this patch */
static uint64_t pl_priv;                   /* bit p: pattern p links an entry m1_pat_spill made since the load or SAVE, which
                                           * only the running patch links */
/* an edit the binary can still refuse after m1_pat_spill sent patterns to the store to make room (pl_double, pl_halve,
 * pl_copy), from pl_mark to pl_unmark: what the spill changes, kept so that a refusal leaves the binary, the links and the
 * editor as they were */
typedef struct {
    uint16_t ids[ENG_PATTERNS];            /* the links before (pl_ids) */
    uint32_t hash[ENG_PATTERNS];           /* pl_hash before */
    uint64_t priv, moved;                  /* pl_priv before; the patterns the spill linked since (the editor not told yet) */
    uint32_t held;                         /* the bytes at m1_up's start the edit keeps (its undo): the spill works after them */
    uint8_t edited, fmt;                   /* m1_edited and the binary's format byte before */
} pl_mark_t;
static pl_mark_t *pl_marked;               /* the edit under way, 0 none */

/* the running patch's links (m1_cur's format 59 section): its entries (3 bytes each), their count in *n */
static const uint8_t *pl_links(uint32_t *n)
{
    uint32_t at = (m1_cur[7] & ENG_FLAG_LINKS) ? eng_links_at(m1_cur, m1_cur_len) : 0u;
    *n = at ? m1_cur[at] : 0u;
    return m1_cur + at + 1u;
}
/* pattern p's stored id, 0 not linked */
static uint32_t pl_link(uint32_t p)
{
    uint32_t n, k;
    const uint8_t *e = pl_links(&n);
    for (k = 0; k < n; k++, e += 3)
        if (e[0] == p)
            return (uint32_t)e[1] | (uint32_t)e[2] << 8;
    return 0;
}
/* pattern p linked to id (0: its link goes) in the binary (proto.c m1_patch_links): 1 done, 0 the binary cannot hold it */
static int pl_set_link(uint32_t p, uint32_t id)
{
    uint8_t s[1u + 3u * ENG_PATTERNS];
    uint32_t n, k, o = 0;
    const uint8_t *e = pl_links(&n);
    for (k = 0; k <= n; k++, e += 3) {
        if (id && (k == n || e[0] > p)) {            /* (in order, once) */
            s[1u + 3u * o] = (uint8_t)p;
            s[2u + 3u * o] = (uint8_t)id;
            s[3u + 3u * o++] = (uint8_t)(id >> 8);
            id = 0;
        }
        if (k < n && e[0] != p) {
            s[1u + 3u * o] = e[0];
            s[2u + 3u * o] = e[1];
            s[3u + 3u * o++] = e[2];
        }
    }
    s[0] = (uint8_t)o;
    return m1_patch_links(s, o ? 1u + 3u * o : 0u);
}

/* a payload as it is made: into o (cap bytes; o 0: only counted and hashed), n bytes so far, h their FNV-1a hash */
typedef struct { uint8_t *o; uint32_t cap, n, h; } pl_out_t;
static void pl_b(pl_out_t *s, uint32_t b)
{
    b &= 255u;
    if (s->o && s->n < s->cap)
        s->o[s->n] = (uint8_t)b;
    s->n++;
    s->h = (s->h ^ b) * 0x01000193u;
}
static void pl_w(pl_out_t *s, uint32_t v, uint32_t k)
{
    for (; k; k--, v >>= 8)
        pl_b(s, v);
}
static uint32_t pl_rd32(const uint8_t *b) { return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24; }

/* the running patch's layout fingerprint: FNV-1a over its module count and each module's type, 0 made 1 */
static uint32_t pl_layout(void)
{
    pl_out_t s = { 0, 0, 0, PT_FNV0 };
    uint32_t m, n = (uint32_t)eng_nmodules();
    pl_b(&s, n);
    for (m = 0; m < n; m++)
        pl_b(&s, (uint32_t)eng_type(m) & 0x7Fu);
    return s.h ? s.h : 1u;
}

/* a track's entry: n (ENG_COUNT_ESC), len (with the short words bit), rate, the words */
static void pl_words(pl_out_t *s, const uint32_t *w, uint32_t n, uint32_t len, uint32_t rate)
{
    uint32_t j, sh = (uint32_t)eng_notes_short(w, n);
    if (n >= ENG_COUNT_ESC)
        pl_b(s, ENG_COUNT_ESC);
    pl_b(s, n >= ENG_COUNT_ESC ? n - ENG_COUNT_ESC : n);
    pl_b(s, len | (sh ? 0x80u : 0u));
    pl_b(s, rate);
    for (j = 0; j < n; j++)
        if (sh)
            pl_w(s, NW_AT(w[j]) | (NW_LEN(w[j]) - 1u) << 4 | NW_NOTE(w[j]) << 8 | (NW_VEL(w[j]) == ACCENT_VEL ? 0x8000u : 0u), 2);
        else
            pl_w(s, w[j], 4);
}

/* pattern p of the running patch as a payload */
static void pl_encode(uint32_t p, pl_out_t *s)
{
    uint32_t nt = (uint32_t)eng_steps_count(), t, k, T = 1, L = 0, m, v = 1;
    int c, r;
    const uint32_t *w;
    uint8_t lk[7u * ENG_PAT_LOCKS];
    for (t = 0; t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        if (eng_pattern_has(m, p)) {
            T = t + 1u;
            v = eng_pattern_notes(m, p, &w) > (int)ENG_NOTES_1_26 ? 2u : v;   /* (version 2 only for a wide one, #1292) */
        }
        L += eng_locks_list(m, p, 0, 0) > 0;
    }
    pl_b(s, v);
    pl_w(s, L ? pl_layout() : 0u, 4);
    pl_b(s, T);
    for (t = 0; t < T; t++) {
        m = (uint32_t)eng_steps_module(t);
        if (t >= nt || !eng_pattern_has(m, p)) {
            pl_b(s, 0xFFu);
            continue;
        }
        c = eng_pattern_notes(m, p, &w);
        r = p ? eng_pattern_rate(m, p) : -1;
        pl_words(s, w, (uint32_t)c, p ? (uint32_t)eng_pattern_len(m, p) : 0u, r < 0 ? 0xFFu : (uint32_t)r);
    }
    pl_b(s, L);
    for (t = 0; t < nt; t++) {
        if ((c = eng_locks_list((uint32_t)eng_steps_module(t), p, lk, sizeof lk)) <= 0)
            continue;
        pl_b(s, t);
        pl_b(s, (uint32_t)c);
        for (k = 0; k < 7u * (uint32_t)c; k++)        /* (eng_locks_list's 7 bytes a lock are the payload's) */
            pl_b(s, lk[k]);
    }
}
static uint32_t pl_hash_of(uint32_t p)
{
    pl_out_t s = { 0, 0, 0, PT_FNV0 };
    pl_encode(p, &s);
    return s.h;
}

/* the legacy factory pattern group (factory_tier.h KIT_GROUPS) that holds id, N_KIT_GROUPS none */
static uint32_t pl_kit(uint32_t id)
{
    uint32_t g;
    for (g = 0; g < N_KIT_GROUPS && id - KIT_GROUPS[g].first >= KIT_GROUPS[g].n; g++)
        ;
    return g;
}
/* id is a legacy factory pattern this firmware holds */
static int pl_legacy(uint32_t id) { return id > PT_ID_MAX && pl_kit(id) < N_KIT_GROUPS; }
/* a slot's patch binary that boot moves into the store (main.c bank_patterns, #1202): it holds patterns 2..64 of its own
 * (format 48's patterns section names a track: a binary of 1.25 or before, or one an older editor wrote), or it links a
 * legacy factory pattern this firmware holds (a factory patch's link of 1.25 or before, G8) */
static int pl_slot_due(const uint8_t *b, uint32_t len)
{
    uint32_t at = len >= 8u && b[1] >= 48u && (b[7] & ENG_FLAG_PATTERNS) ? eng_section_at(b, len, ENG_SEC_PATTERNS) : 0u, k;
    if (at && at + 2u < len && b[at + 2u] != 0u)
        return 1;
    at = len >= 8u && (b[7] & ENG_FLAG_LINKS) ? eng_links_at(b, len) : 0u;
    for (k = 0; at && k < b[at]; k++)
        if (pl_legacy((uint32_t)b[at + 2u + 3u * k] | (uint32_t)b[at + 3u + 3u * k] << 8))
            return 1;
    return 0;
}

/* stored pattern id (a user entry, or a legacy factory pattern) into buf (cap bytes), its record in *in: 0, -1 none. A
 * legacy pattern's group is unpacked into buf, each entry there its name (NUL ended), u16 payload length, payload; the
 * entry's payload then moves to buf's start */
static int pl_read(uint32_t id, uint8_t *buf, uint32_t cap, pt_info_t *in)
{
    pl_out_t s = { buf, cap, 0, PT_FNV0 };
    const uint8_t *src;
    uint32_t i, n = 0, k, g = pl_kit(id);
    if (id <= PT_ID_MAX)
        return pt_read(id, buf, cap, in) ? -1 : 0;
    if (g >= N_KIT_GROUPS || lz_unpack(KIT_GROUPS[g].lz, KIT_GROUPS[g].lz_len, buf, cap) != (int32_t)KIT_GROUPS[g].len)
        return -1;
    for (src = buf, k = id - KIT_GROUPS[g].first;; k--, src += i + 3u + n) {
        for (i = 0; src[i]; i++)
            ;
        n = (uint32_t)src[i + 1u] | (uint32_t)src[i + 2u] << 8;
        if (!k)
            break;
    }
    for (k = 0; k < PT_NAME && src[k]; k++)           /* (the name first: the payload moves over it) */
        in->name[k] = (char)src[k];
    in->name[k] = 0;
    for (src += i + 3u, i = 0; i < n; i++)
        pl_b(&s, src[i]);
    in->id = (uint16_t)id;
    in->len = (uint16_t)s.n;
    in->hash = s.h;
    in->kept = 0;
    return s.n <= cap ? 0 : -1;
}

/* a payload's framing: its tracks' entries and locks in range, its bytes used exactly: 0 ok. Version 1 holds at most
 * ENG_NOTES_1_26 words a track, version 2 (#1292) TRACK_NOTES_MAX, its counts ENG_COUNT_ESC */
static int pl_check(const uint8_t *b, uint32_t len)
{
    uint32_t at = 6, T, k, n, c, last = 0, w;
    if (len < 7u || (b[0] != 1u && b[0] != 2u) || !(T = b[5]))
        return -1;
    for (k = 0; k < T; k++) {
        if (at >= len)
            return -1;
        if (b[at] == 0xFFu) {
            at++;
            continue;
        }
        if (at + 1u >= len)
            return -1;
        n = eng_count_at(b, at, &w);
        at += w;
        if (n > (b[0] == 2u ? TRACK_NOTES_MAX : ENG_NOTES_1_26) || at + 2u > len || (b[at] & 0x7Fu) > TRACK_STEPS || (b[at + 1u] != 0xFFu && b[at + 1u] > 8u))
            return -1;
        at += 2u + n * ((b[at] & 0x80u) ? 2u : 4u);
    }
    if (at >= len)
        return -1;
    n = b[at++];
    for (k = 0; k < n; k++) {
        if (at + 2u > len || (k && b[at] <= last) || !(c = b[at + 1u]) || c > ENG_PAT_LOCKS)
            return -1;
        last = b[at];
        at += 2u + 7u * c;
    }
    return at == len ? 0 : -1;
}

/* the extras (ENG_ROW_MORE) of the running patch's first page row on module m's parameter j, 0 none: what a lock on it
 * also sets, as the SEQ page's lock entry takes them (seq_ui.c seq_lock_turn, pages_ui.c row_more) */
static const uint8_t *pl_row_more(uint32_t m, uint32_t j)
{
    const uint8_t *b = m1_cur;
    uint32_t len = m1_cur_len, at = (b[6] & 32u) ? eng_section_at(b, len, ENG_SEC_DEVICES) : 0u, n, d, g, np, r, nr;
    if (!at || !eng_devices_end(b, len, at))
        return 0;
    n = b[at++];
    for (d = 0; d < n; d++) {
        if (b[at] != 1u) {                            /* (a plain module, named or not) */
            at += b[at] == ENG_DEV_NAMED ? 3u + b[at + 2u] : 2u;
            continue;
        }
        at += 2u + b[at + 1u];
        np = b[at++];
        for (g = 0; g < np; g++) {
            at += 1u + b[at];
            nr = b[at + 3u];
            at += 4u;
            for (r = 0; r < nr; r++) {
                uint32_t mod = b[at], par = b[at + 1u];
                at += 3u + b[at + 2u];                /* (the label) */
                if (!(par & ENG_ROW_MORE))
                    continue;
                if (par & 0x80u) {                    /* (a poly row's top) */
                    at++;
                    continue;
                }
                if (mod == m && (par & ~ENG_ROW_MORE) == j)
                    return b + at;
                at = eng_row_more_end(b, len, at);
            }
        }
    }
    return 0;
}

/* the tracks' entries of a checked payload into pattern p (pl_apply's first half): each track gets its entry's notes (and
 * for p >= 1 its length and rate); a track without one no longer has p (pattern 1: no notes). *at: from the first entry
 * to the locks' count; *got: the tracks that had an entry (bit t). 0 done, -2 no room for all the notes */
static int pl_apply_notes(uint32_t p, const uint8_t *b, uint32_t *at, uint32_t *got)
{
    uint32_t w[TRACK_NOTES_MAX];
    uint32_t nt = (uint32_t)eng_steps_count(), T = b[5], t, n, j, sh, m, c;
    int rc = 0;
    *got = 0;
    for (t = 0; t < T || t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        n = t < T && b[*at] != 0xFFu ? eng_count_at(b, *at, &c) : 0xFFu;
        *at += t < T ? (n == 0xFFu ? 1u : c) : 0u;
        if (n == 0xFFu) {
            if (t < nt && p)
                eng_pattern_drop(m, p);
            else if (t < nt)
                (void)eng_pattern_set_notes(m, 0, w, 0);
            continue;
        }
        sh = b[*at] & 0x80u;
        for (j = 0; j < n; j++) {
            const uint8_t *x = b + *at + 2u + j * (sh ? 2u : 4u);
            uint32_t v = sh ? (uint32_t)x[0] | (uint32_t)x[1] << 8 : pl_rd32(x);
            w[j] = sh ? NW(v & 15u, ((v >> 4) & 15u) + 1u, (v >> 8) & 127u, (v & 0x8000u) ? ACCENT_VEL : STEP_VEL, 0u) : v;
        }
        if (t < nt && !eng_pattern_set_notes(m, p, w, n))
            rc = -2;
        else if (t < nt && p)
            (void)eng_pattern_shape(m, p, b[*at] & 0x7Fu, b[*at + 1u]);
        *got |= t < 32u ? 1u << t : 0u;
        *at += 2u + n * (sh ? 2u : 4u);
    }
    return rc;
}

/* a payload loaded into pattern p of the running patch (pattern-store.ts applyPayload): each track gets the payload's
 * entry for it (pl_apply_notes). p's locks are replaced, by the payload's only in the same layout. 0 done, 1 done with
 * the locks left out (another layout), -1 malformed, -2 no room for all of it */
static int pl_apply(uint32_t p, const uint8_t *b, uint32_t len)
{
    uint32_t nt = (uint32_t)eng_steps_count(), at = 6, t, n, j, k, c, m, got;
    int rc;
    if (pl_check(b, len))
        return -1;
    rc = pl_apply_notes(p, b, &at, &got);
    eng_locks_clear(p);
    n = b[at++];
    if (n && pl_rd32(b + 1) != pl_layout())
        return rc ? rc : 1;
    for (k = 0; k < n; k++, at += 2u + 7u * c) {
        t = b[at];
        c = b[at + 1u];
        m = (uint32_t)eng_steps_module(t);
        for (j = 0; t < nt && (got >> t & 1u) && j < c; j++) {
            const uint8_t *x = b + at + 2u + 7u * j;
            if (eng_lock_set(m, p, x[0], x[1], x[2], pl_row_more(x[1], x[2]), (int32_t)pl_rd32(x + 3), 1) < 0)
                rc = -2;
        }
    }
    return rc;
}

/* ---- the running patch's links */

/* the notes, patterns and locks into the binary after a link changed (the clean ones out, the others in) */
static void pl_rewrite(void)
{
    (void)m1_patch_locks();
    m1_patch_patterns();
    (void)m1_steps_sec(ENG_SEC_NOTES);
    m1_edited = 1;
}

/* pattern p of the running patch has notes or a length of its own on some track; pattern 1 (#1292): notes or P-locks
 * on some track (an empty pattern 1 needs no stored entry) */
static int pl_has(uint32_t p)
{
    uint32_t t, m;
    const uint32_t *w;
    for (t = 0; t < (uint32_t)eng_steps_count(); t++) {
        m = (uint32_t)eng_steps_module(t);
        if (p ? eng_pattern_has(m, p) : eng_pattern_notes(m, 0, &w) > 0 || eng_locks_list(m, 0, 0, 0) > 0)
            return 1;
    }
    return 0;
}

/* proto.c m1_set_current: the links of the patch just loaded (m1_cur, the engine has it). A linked pattern no track has
 * comes from the store or the legacy factory patterns (none there, or no store for a user entry: it stays absent, the link
 * stays); one with inline content is an edited copy, dirty unless it equals the stored one. The user entries are found in
 * one walk over the store (pt_find_many) */
static void m1_pat_load(void)
{
    uint16_t ids[ENG_PATTERNS];
    int32_t at[ENG_PATTERNS];
    uint32_t hash[ENG_PATTERNS], n, k, p, id;
    const uint8_t *e = pl_links(&n);
    pt_info_t in;
    int rc;
    for (p = 0; p < ENG_PATTERNS; p++)
        pl_hash[p] = 0;
    pl_priv = 0;
    for (k = 0; k < n && k < ENG_PATTERNS; k++)
        ids[k] = (uint16_t)(((uint32_t)e[3u * k + 1u] | (uint32_t)e[3u * k + 2u] << 8) <= PT_ID_MAX
                            ? (uint32_t)e[3u * k + 1u] | (uint32_t)e[3u * k + 2u] << 8 : 0u);
    pt_find_many(ids, k, at, hash);
    for (k = 0; k < n && k < ENG_PATTERNS; k++, e += 3) {
        p = e[0];
        id = (uint32_t)e[1] | (uint32_t)e[2] << 8;
        if (pl_has(p)) {
            pl_hash[p] = id > PT_ID_MAX ? (pl_read(id, m1_up, sizeof m1_up, &in) ? 0u : in.hash) : at[k] < 0 ? 0u : hash[k];
            continue;
        }
        rc = id > PT_ID_MAX ? pl_read(id, m1_up, sizeof m1_up, &in) : at[k] < 0 ? -1
            : pt_read_at((uint32_t)at[k], m1_up, sizeof m1_up, &in);
        if (!rc)
            (void)pl_apply(p, m1_up, in.len);
        pl_hash[p] = pl_hash_of(p);                   /* (as this patch has it: clean until it is edited) */
    }
}

/* proto.c: the clean linked patterns (bit p) */
static uint64_t m1_pat_clean(void)
{
    uint64_t c = 0;
    uint32_t n, k;
    const uint8_t *e = pl_links(&n);
    for (k = 0; k < n; k++, e += 3)
        if (pl_hash_of(e[0]) == pl_hash[e[0]])
            c |= (uint64_t)1u << e[0];
    return c;
}
/* proto.c m1_track_back (#1292): an edit the binary had no room for while pattern 1 is a clean link (the binary leaves it
 * out): pattern 1 back from its stored entry (read into m1_up after a marked edit's bytes, pl_mark), which held every
 * track's pattern 1 as it was. 1 done, 0 pattern 1 is not linked or its entry cannot be read */
static int m1_pat_back(uint32_t mod)
{
    uint32_t id = pl_link(0), at = pl_marked ? pl_marked->held : 0u;
    pt_info_t in;
    (void)mod;
    if (!id || pl_read(id, m1_up + at, sizeof m1_up - at, &in) || pl_apply(0, m1_up + at, in.len) < 0)
        return 0;
    pl_hash[0] = pl_hash_of(0);
    return 1;
}

/* ---- every pattern 2..64 in the store (#1202): SAVE, the binary's room (#1199), the entries no patch links */

/* the name a pattern gets in the store: its patch's (in capitals, at most 12 characters) and its number, `909 KIT P03` */
static void pl_name(char *out, const char *patch, uint32_t p)
{
    uint32_t n = 0;
    for (; patch && *patch && n < PT_NAME - 4u; patch++)
        if (*patch >= 32 && *patch < 127 && (*patch != ' ' || n))
            out[n++] = *patch >= 'a' && *patch <= 'z' ? (char)(*patch - ('a' - 'A')) : *patch;
    while (n && out[n - 1u] == ' ')
        n--;
    if (n)
        out[n++] = ' ';
    out[n++] = 'P';
    out[n++] = (char)('0' + (p + 1u) / 10u);
    out[n++] = (char)('0' + (p + 1u) % 10u);
    out[n] = 0;
}

/* the running patch's links become ids (ids[p], pattern p 0..63; 0 none; a link of pattern 1 makes the binary ENG_WIDE,
 * #1292): the notes, patterns and locks sections without the clean ones first (a pattern whose bytes hash to
 * pl_hash[p]), then the links section, only when the binary holds all four (the ones that shrink written first). 1 done;
 * 0 not (nothing changed) */
static int pl_relink(const uint16_t *ids)
{
    uint8_t s[1u + 3u * ENG_PATTERNS];
    uint32_t p, o = 0, at, old, fmt = m1_cur[1], k, pass;
    uint64_t omit = 0;
    int32_t d = 0, c[4];
    if (ids[0] && eng_widen(m1_cur, &m1_cur_len, M1_PATCH_MAX))
        return 0;
    if (!(at = eng_links_at(m1_cur, m1_cur_len))) {
        eng_narrow(m1_cur, &m1_cur_len, fmt);
        return 0;
    }
    for (p = 0; p < ENG_PATTERNS; p++) {
        if (!ids[p])
            continue;
        s[1u + 3u * o] = (uint8_t)p;
        s[2u + 3u * o] = (uint8_t)ids[p];
        s[3u + 3u * o++] = (uint8_t)(ids[p] >> 8);
        if (pl_hash_of(p) == pl_hash[p])
            omit |= (uint64_t)1u << p;
    }
    s[0] = (uint8_t)o;
    old = (m1_cur[7] & ENG_FLAG_LINKS) ? eng_links_end(m1_cur, m1_cur_len, at) - at : 0u;
    c[0] = m1_steps_cost(ENG_SEC_NOTES, omit);
    c[1] = m1_steps_cost(ENG_SEC_PATTERNS, omit);
    c[2] = m1_steps_cost(ENG_SEC_LOCKS, omit);
    c[3] = (int32_t)(o ? 1u + 3u * o : 0u) - (int32_t)old;
    for (k = 0; k < 4u; k++)
        d += c[k];
    if ((o && m1_cur[1] < ENG_COUNTED) || (int32_t)m1_cur_len + d > (int32_t)M1_PATCH_MAX) {
        eng_narrow(m1_cur, &m1_cur_len, fmt);
        return 0;
    }
    for (pass = 0; pass < 2u; pass++)
        for (k = 0; k < 4u; k++)
            if ((c[k] > 0) == (pass == 1u)) {
                if (k < 3u)
                    (void)m1_steps_write(k == 0u ? ENG_SEC_NOTES : k == 1u ? ENG_SEC_PATTERNS : ENG_SEC_LOCKS, omit);
                else
                    (void)m1_patch_links(s, o ? 1u + 3u * o : 0u);
            }
    return 1;
}

/* the running patch's links by pattern into ids (0 none) */
static void pl_ids(uint16_t *ids)
{
    uint32_t n, k;
    const uint8_t *e = pl_links(&n);
    for (k = 0; k < ENG_PATTERNS; k++)
        ids[k] = 0;
    for (k = 0; k < n; k++, e += 3)
        if (e[0] < ENG_PATTERNS)
            ids[e[0]] = (uint16_t)((uint32_t)e[1] | (uint32_t)e[2] << 8);
}

/* bit p: the user entry pattern p links (ids[p]) is linked by another pattern of this patch, or by a saved slot other than
 * self (each slot's bytes read into sl_buf) */
static uint64_t pl_shared(const uint16_t *ids, uint32_t self)
{
    sl_hdr_t h;
    uint64_t m = 0;
    uint32_t s, k, p, q, at, id;
    for (p = 0; p < ENG_PATTERNS; p++)
        for (q = 0; ids[p] && q < ENG_PATTERNS; q++)
            if (q != p && ids[q] == ids[p])
                m |= (uint64_t)1u << p;
    for (s = 0; s < bank_slots; s++) {
        if (s == self || sl_head(s, &h, 1) || !(sl_buf[7] & ENG_FLAG_LINKS) || !(at = eng_links_at(sl_buf, h.len)))
            continue;
        for (k = 0; k < sl_buf[at]; k++) {
            id = (uint32_t)sl_buf[at + 2u + 3u * k] | (uint32_t)sl_buf[at + 3u + 3u * k] << 8;
            for (p = 0; p < ENG_PATTERNS; p++)
                if (ids[p] == id)
                    m |= (uint64_t)1u << p;
        }
    }
    return m;
}

/* pattern p into the store for SAVE: over user entry *id (0 none; one that is gone or a kept copy: a new one instead),
 * else into a new entry named after the patch (`patch`, pl_name); its payload hash in *h. 0 done (*id the entry), else
 * pt_put's error */
static int pl_put(uint32_t p, uint32_t *id, const char *patch, uint32_t *h)
{
    char name[PT_NAME + 1u];
    pl_out_t s = { m1_up, sizeof m1_up, 0, PT_FNV0 };
    pt_info_t in;
    int rc;
    pl_encode(p, &s);
    rc = *id && !pt_stat(*id, &in) ? pt_put(id, in.name, m1_up, s.n, 0) : -4;   /* (-4 too over a kept copy) */
    if (rc == -4) {
        *id = 0;
        pl_name(name, patch, p);
        rc = pt_put(id, name, m1_up, s.n, 0);
    }
    *h = s.h;
    return rc;
}
/* SAVE (main.c m1_store, before the running patch goes into slot self; main.c's boot for each slot that holds patterns
 * 2..64 in its binary or links a legacy factory pattern, #1202): every pattern 2..64 the running patch has goes to the
 * store and the patch links it, so the slot keeps pattern 1, the songs and the links. A pattern whose link to a user
 * entry is clean keeps it. Any other (a legacy factory pattern's too) takes an entry whose bytes are the same (by hash
 * and length: shared), else is written over the user entry it links when no other slot and no other pattern of this
 * patch links that one, else into a new entry named after the patch (`patch`, pl_name): an edited shared pattern splits
 * off its own copy. A link to a pattern no track has goes (one this FM-1 cannot resolve stays). The store full (or a
 * pattern larger than an entry, or the ids used up): that pattern stays in the binary. Pattern 1 linked (#1292, the
 * binary had no room for it) comes back inline when the binary can hold it now (an empty one always); else it keeps a
 * clean link, or goes to the store as a pattern 2..64 does. 0 done, -2 some pattern stayed in the binary, -3 the binary
 * could not take the links (it is as it was) */
static int pl_commit(const char *patch, uint32_t self)
{
    uint16_t ids[ENG_PATTERNS], uids[ENG_PATTERNS];
    int32_t at[ENG_PATTERNS];
    uint32_t hash[ENG_PATTERNS], want[ENG_PATTERNS], len[ENG_PATTERNS], keep[ENG_PATTERNS], p, loc, id, full = 0, h;
    uint64_t need = 0, shared = 0, done = 0, known = 0;
    pt_hdr_t r;
    pl_out_t s;
    int ok;
    if (!pt_on)
        return 0;
    pl_ids(ids);
    for (p = 0; p < ENG_PATTERNS; p++) {
        uids[p] = ids[p] <= PT_ID_MAX ? ids[p] : 0u;
        keep[p] = pl_hash[p];
    }
    pt_find_many(uids, ENG_PATTERNS, at, hash);
    for (p = 1; p < ENG_PATTERNS; p++) {
        if (!pl_has(p)) {                             /* (a link this FM-1 cannot resolve stays, as at load) */
            if (!ids[p] || (ids[p] <= PT_ID_MAX ? at[p] >= 0 : pl_legacy(ids[p])))
                ids[p] = 0;
            continue;
        }
        s = (pl_out_t){ 0, 0, 0, PT_FNV0 };
        pl_encode(p, &s);
        if (ids[p] && ids[p] <= PT_ID_MAX && at[p] >= 0 && (s.h == pl_hash[p] || s.h == hash[p])) {
            pl_hash[p] = s.h;                         /* (clean: the link stays; a legacy factory link never does) */
            continue;
        }
        if (s.n > PT_MAX) {
            full = 1;
            continue;
        }
        want[p] = s.h;
        len[p] = s.n;
        need |= (uint64_t)1u << p;
    }
    for (loc = 0; need && !pt_iter(&loc, &r); loc += pt_size(r.len))   /* (an entry with the same bytes: one walk; a kept
                                                                         * copy stays unlinked) */
        for (p = 1; r.magic == PT_MAGIC && p < ENG_PATTERNS; p++)
            if ((need >> p & 1u) && !(done >> p & 1u) && r.hash == want[p] && r.len == len[p]) {
                ids[p] = r.id;
                pl_hash[p] = want[p];
                done |= (uint64_t)1u << p;
            }
    for (p = 1; p < ENG_PATTERNS; p++) {
        uint32_t q;
        if (!(need >> p & 1u) || (done >> p & 1u))
            continue;
        for (q = 1; q < p && !((done >> q & 1u) && want[q] == want[p] && len[q] == len[p] && (need >> q & 1u)); q++)
            ;
        if (q < p) {                                  /* (alike a pattern this SAVE stored: the same entry) */
            ids[p] = ids[q];
            pl_hash[p] = want[p];
            done |= (uint64_t)1u << p;
            continue;
        }
        id = ids[p] <= PT_ID_MAX && at[p] >= 0 ? ids[p] : 0u;
        if (id && !known) {
            shared = pl_shared(ids, self);
            known = 1;
        }
        if (id && (shared >> p & 1u))
            id = 0;
        if (pl_put(p, &id, patch, &h)) {
            full = 1;                                 /* (it stays in the binary, as an edited copy of its link if any) */
            continue;
        }
        ids[p] = (uint16_t)id;
        pl_hash[p] = h;
        done |= (uint64_t)1u << p;
    }
    ok = 0;
    if ((id = ids[0]) != 0) {                         /* pattern 1 (#1292): inline again when the binary holds it */
        ids[0] = 0;
        if (!(ok = pl_relink(ids)) && pl_has(0)) {
            ids[0] = (uint16_t)id;
            s = (pl_out_t){ 0, 0, 0, PT_FNV0 };
            pl_encode(0, &s);
            if (id <= PT_ID_MAX && at[0] >= 0 && (s.h == pl_hash[0] || s.h == hash[0])) {
                pl_hash[0] = s.h;                     /* (clean: the link stays) */
            } else {
                id = id <= PT_ID_MAX && at[0] >= 0 && !((known ? shared : pl_shared(ids, self)) & 1u) ? id : 0u;
                if (s.n > PT_MAX || pl_put(0, &id, patch, &h)) {
                    full = 1;                         /* (inline, as an edited copy of its link) */
                } else {
                    ids[0] = (uint16_t)id;
                    pl_hash[0] = h;
                    done |= 1u;
                }
            }
        } else if (ok) {
            done |= 1u;                               /* (the editor hears that it is inline: no link) */
        }
    }
    if (!ok && !pl_relink(ids)) {                     /* (the entries it wrote go at the next tidy-up, pl_gc) */
        for (p = 0; p < ENG_PATTERNS; p++)
            pl_hash[p] = keep[p];
        return -3;
    }
    for (p = 0; p < ENG_PATTERNS; p++)
        if (done >> p & 1u)
            m1_pat_link_now(p, ids[p], ids[p] ? pl_hash[p] : 0u);
    pl_priv = 0;
    return full ? -2 : 0;
}

/* proto.c m1_steps_sec (#1199): the binary cannot hold its patterns and P-locks. Each pattern from..64 it holds (from 1:
 * 2..64; 0: pattern 1 too, which the binary must be able to be ENG_WIDE for, #1292) goes to the store, in an entry of its
 * own that only the running patch links (pl_priv: written over at the next spill), named after the patch, so the slot's
 * links and the other patches' patterns stay as they are until SAVE (pl_commit takes these entries as they are). Then the
 * sections without them and the links (pl_relink). Each payload is made in m1_up after the bytes a marked edit keeps
 * there (pl_mark; one that does not fit after them stays, as one past PT_MAX does), and the editor hears the new links at
 * once, or a marked edit's at its end (pl_unmark). 1 some went, 0 none (no store, the store full, or the binary still
 * cannot hold the links) */
static int m1_pat_spill(uint32_t from)
{
    uint16_t ids[ENG_PATTERNS];
    uint32_t keep[ENG_PATTERNS], p, id, at = pl_marked ? pl_marked->held : 0u;
    uint64_t moved = 0;
    char name[PT_NAME + 1u];
    pl_out_t s;
    int rc;
    if (!pt_on)
        return 0;
    pl_ids(ids);
    for (p = from; p < ENG_PATTERNS; p++) {
        keep[p] = pl_hash[p];
        if (!pl_has(p) || (!p && !m1_can_wide()))
            continue;
        s = (pl_out_t){ m1_up + at, sizeof m1_up - at, 0, PT_FNV0 };
        pl_encode(p, &s);
        if ((ids[p] && s.h == pl_hash[p]) || s.n > PT_MAX || s.n > s.cap)
            continue;
        id = (pl_priv >> p & 1u) && ids[p] <= PT_ID_MAX ? ids[p] : 0u;
        pl_name(name, m1_patch_name(), p);
        rc = pt_put(&id, name, m1_up + at, s.n, 0);
        if (rc == -4) {
            id = 0;
            rc = pt_put(&id, name, m1_up + at, s.n, 0);
        }
        if (rc)
            continue;
        ids[p] = (uint16_t)id;
        pl_hash[p] = s.h;
        moved |= (uint64_t)1u << p;
    }
    if (!moved)
        return 0;
    if (!pl_relink(ids)) {                            /* (the entries it wrote go at the next tidy-up, pl_gc) */
        for (p = from; p < ENG_PATTERNS; p++)
            pl_hash[p] = keep[p];
        return 0;
    }
    pl_priv |= moved;
    m1_edited = 1;
    if (pl_marked)
        pl_marked->moved |= moved;
    else
        for (p = from; p < ENG_PATTERNS; p++)
            if (moved >> p & 1u)
                m1_pat_link_now(p, ids[p], pl_hash[p]);
    return 1;
}

/* an edit the binary may refuse after m1_pat_spill ran (pl_double, pl_halve, pl_copy) begins: the links, their hashes,
 * pl_priv, m1_edited and the binary's format byte kept in k; held: the bytes at m1_up's start the edit needs until it ends
 * (its undo), which the spill leaves alone. Until pl_unmark the spill tells the editor nothing */
static void pl_mark(pl_mark_t *k, uint32_t held)
{
    uint32_t p;
    pl_ids(k->ids);
    for (p = 0; p < ENG_PATTERNS; p++)
        k->hash[p] = pl_hash[p];
    k->priv = pl_priv;
    k->moved = 0;
    k->held = held;
    k->edited = m1_edited;
    k->fmt = m1_cur[1];
    pl_marked = k;
}
/* the edit pl_mark began ends, done or refused (refused: once the engine and the binary's other sections are as they
 * were). Done, the editor hears the links the spill made. Refused, the links go back to what they were, with their hashes,
 * pl_priv, m1_edited and the format byte: the binary byte for byte as before (the entries the spill wrote stay in the
 * store until pl_gc), the editor told nothing. Should the binary not take the links back (it held them before), the
 * spill's stay and the editor hears them */
static void pl_unmark(pl_mark_t *k, int done)
{
    uint32_t p, h;
    pl_marked = 0;
    if (!done && k->moved) {
        for (p = 0; p < ENG_PATTERNS; p++) {        /* (swapped: pl_relink sees the hashes before, k keeps the spill's) */
            h = pl_hash[p];
            pl_hash[p] = k->hash[p];
            k->hash[p] = h;
        }
        if (pl_relink(k->ids)) {
            pl_priv = k->priv;
            if (m1_cur[1] >= ENG_WIDE && k->fmt < ENG_WIDE)   /* (made ENG_WIDE for the spill's links, #1292) */
                eng_narrow(m1_cur, &m1_cur_len, k->fmt);
            m1_cur[1] = k->fmt;                       /* (m1_patch_links may have raised it for the spill's links) */
            k->moved = 0;
        } else {
            for (p = 0; p < ENG_PATTERNS; p++)
                pl_hash[p] = k->hash[p];
        }
    }
    if (!done && !k->moved) {
        m1_edited = k->edited;
        if (m1_cur[1] >= ENG_WIDE && k->fmt < ENG_WIDE)   /* (a wide pattern the edit made widened it, #1292) */
            eng_narrow(m1_cur, &m1_cur_len, k->fmt);
    }
    for (p = 0; p < ENG_PATTERNS; p++)
        if (k->moved >> p & 1u)
            m1_pat_link_now(p, pl_link(p), pl_hash[p]);
}

/* a stored pattern is deleted once no patch links it (#1202): after a slot is written or erased, and at boot. Every user
 * entry a saved slot or the running patch links stays, and every kept copy (PT_KMAGIC: neither walk below counts it). The
 * entries' ids go into m1_up (with a mark each after them), each slot's bytes into sl_buf. A slot that holds a patch but
 * cannot be read leaves every entry as it is */
static void pl_gc(void)
{
    uint8_t *mk = m1_up + 2u * PT_TAB;
    uint32_t n = 0, loc, k, s, j, at, id, c;
    const uint8_t *e;
    sl_hdr_t h;
    pt_hdr_t r;
    if (!pt_on)
        return;
    pt_ensure();
    for (loc = 0; !pt_iter(&loc, &r); loc += pt_size(r.len))
        if (r.magic == PT_MAGIC && n < PT_TAB) {
            m1_up[2u * n] = (uint8_t)r.id;
            m1_up[2u * n++ + 1u] = (uint8_t)(r.id >> 8);
        }
    for (k = 0; k < (n + 7u) / 8u; k++)
        mk[k] = 0;
    for (s = 0; s <= bank_slots; s++) {              /* (s == bank_slots: the running patch) */
        if (s < bank_slots) {
            if (!(bank_mask >> s & 1u))
                continue;
            if (sl_head(s, &h, 1))
                return;
            e = (sl_buf[7] & ENG_FLAG_LINKS) && (at = eng_links_at(sl_buf, h.len)) ? sl_buf + at : 0;
        } else {
            e = m1_cur_len && (m1_cur[7] & ENG_FLAG_LINKS) && (at = eng_links_at(m1_cur, m1_cur_len)) ? m1_cur + at : 0;
        }
        for (c = e ? e[0] : 0u, j = 0; j < c; j++) {
            id = (uint32_t)e[2u + 3u * j] | (uint32_t)e[3u + 3u * j] << 8;
            for (k = 0; k < n; k++)
                if (((uint32_t)m1_up[2u * k] | (uint32_t)m1_up[2u * k + 1u] << 8) == id)
                    mk[k / 8u] |= (uint8_t)(1u << (k % 8u));
        }
        fm1_wdt_feed();
    }
    for (k = 0, loc = 0; k < n && !pt_iter(&loc, &r); loc += pt_size(r.len)) {
        if (r.magic != PT_MAGIC)
            continue;
        if (!(mk[k / 8u] >> (k % 8u) & 1u))
            (void)pt_kill(loc);
        k++;
    }
}

/* ---- the SEQ page (seq_ui.c) */

/* FX+SAVE (#1202 P1): pattern p into the store as a new kept copy (PT_KMAGIC: never freed, never written over by SAVE),
 * named as SAVE names its entries (pl_name), linked to nothing: p's link stays. got: its name (PT_NAME + 1 bytes).
 * 1 stored, -1 no store or a flash error, -2 full (or too big) */
static int pl_keep(uint32_t p, char *got)
{
    pl_out_t s = { m1_up, sizeof m1_up, 0, PT_FNV0 };
    uint32_t id = 0;
    int rc;
    if (!pt_on)
        return -1;
    pl_encode(p, &s);
    pl_name(got, m1_patch_name(), p);
    rc = s.n > s.cap ? -3 : pt_put(&id, got, m1_up, s.n, 1);
    return !rc ? 1 : rc == -1 ? -1 : -2;
}

/* stored entry id (a user entry: a legacy factory pattern is never loaded on its own) loaded into pattern p: p >= 1 links
 * it, p 0 is a copy (an older link of p goes). got: its name. 0 done, 1 done with the locks left out (another layout),
 * -1 none, -2 no room */
static int pl_load_entry(uint32_t p, uint32_t id, char *got)
{
    pt_info_t in;
    uint32_t t, i, m;
    int rc;
    if (id > PT_ID_MAX || pl_read(id, m1_up, sizeof m1_up, &in) || (rc = pl_apply(p, m1_up, in.len)) == -1)
        return -1;
    for (i = 0; i <= PT_NAME; i++)
        got[i] = in.name[i];
    if (p) {
        pl_hash[p] = pl_hash_of(p);
        (void)pl_set_link(p, id);
    } else if (pl_link(0)) {                          /* (a copy: pattern 1's own link goes, #1292) */
        pl_hash[0] = 0;
        (void)pl_set_link(0, 0);
    }
    pl_rewrite();
    for (t = 0; t < (uint32_t)eng_steps_count(); t++)   /* (the editor follows the tracks that have it) */
        if (eng_pattern_has(m = (uint32_t)eng_steps_module(t), p)) {
            m1_track_pattern_now(m, p);
            m1_locks_now(m, p);
        }
    m1_pat_link_now(p, pl_link(p), pl_hash[p]);
    return rc;
}

/* ---- the SEQ page's pattern commands (#1177, #1178): what the editor's copy and clear all do, on the running patch */

/* pattern p is empty: no track holds it and it has no link (a link whose stored entry this FM-1 lacks holds the number) */
static int pl_free(uint32_t p)
{
    uint32_t t;
    for (t = 0; t < (uint32_t)eng_steps_count(); t++)
        if (eng_pattern_has((uint32_t)eng_steps_module(t), p))
            return 0;
    return !pl_link(p);
}
/* pattern p has a note on some track */
static int pl_has_notes(uint32_t p)
{
    const uint32_t *w;
    uint32_t t, m;
    for (t = 0; t < (uint32_t)eng_steps_count(); t++) {
        m = (uint32_t)eng_steps_module(t);
        if ((!p || eng_pattern_has(m, p)) && eng_pattern_notes(m, p, &w) > 0)
            return 1;
    }
    return 0;
}
/* pattern p of every track copied into pattern q, which is empty (pl_free): notes, P-locks, its own length and rate; a
 * track without p gets no q. A plain pattern, linked to nothing, whatever p links (the payload the store would get, applied
 * as a load applies it). 0 done, -2 no room (the patch's bytes or the engine's notes: q is left empty, and the patterns
 * m1_pat_spill sent to the store meanwhile are linked as before, pl_unmark) */
static int pl_copy(uint32_t p, uint32_t q)
{
    pl_out_t s = { m1_up, sizeof m1_up, 0, PT_FNV0 };
    pl_mark_t mk;
    uint32_t t;
    int rc;
    pl_encode(p, &s);
    pl_mark(&mk, 0);                             /* (the payload is applied before the spill can run) */
    rc = s.n > s.cap ? -2 : pl_apply(q, m1_up, s.n);
    if (rc >= 0 && m1_patterns_fit()) {
        pl_unmark(&mk, 1);
        return 0;
    }
    for (t = 0; t < (uint32_t)eng_steps_count(); t++)
        eng_pattern_drop((uint32_t)eng_steps_module(t), q);
    eng_locks_clear(q);
    (void)m1_patterns_fit();
    pl_unmark(&mk, 0);
    return -2;
}
/* the patch has nothing clear all would clear: no notes in pattern 1, no other pattern, no link, no P-lock, no song */
static int pl_all_empty(void)
{
    uint32_t p, n;
    (void)pl_links(&n);
    if (n || eng_locks_count() || pl_has_notes(0))
        return 0;
    for (p = 1; p < ENG_PATTERNS; p++)
        if (!pl_free(p))
            return 0;
    for (p = 0; p < ENG_SONGS; p++)
        if (eng_song_len(p))
            return 0;
    return 1;
}
/* every pattern of every track and every song cleared (#1178): pattern 1 empty and selected, no other pattern, no link,
 * no P-lock, no pattern origin, no song entry and none playing. The stored patterns stay in the store */
static void pl_clear_all(void)
{
    static const uint32_t none[1];
    uint32_t t, p, m;
    for (t = 0; t < (uint32_t)eng_steps_count(); t++) {
        m = (uint32_t)eng_steps_module(t);
        (void)eng_pattern_set_notes(m, 0, none, 0);
        for (p = 1; p < ENG_PATTERNS; p++)
            eng_pattern_drop(m, p);
    }
    for (p = 0; p < ENG_PATTERNS; p++) {
        eng_locks_clear(p);
        pl_hash[p] = 0;
    }
    for (p = 0; p < ENG_SONGS; p++)
        while (eng_song_len(p))
            (void)eng_song_delete(p, 0);
    eng_song_set(0);
    eng_pattern_set(0);
    (void)m1_patch_links(0, 0);
    for (t = 0; t < (uint32_t)eng_steps_count(); t++)
        m1_patch_notes((uint32_t)eng_steps_module(t));
    (void)m1_patterns_fit();
    m1_origins_drop();
    m1_edited = 1;
}

/* ---- the SEQ page's double (D-838) and halve (D-841): web/src/pattern-ops.ts doublePattern, halvePattern on the running
 * patch */

/* the length of pattern p on module m's track: its own, else the track's (pattern 1 has none) */
static uint32_t pl_len(uint32_t m, uint32_t p)
{
    int l = p ? eng_pattern_len(m, p) : 0;
    return l > 0 ? (uint32_t)l : (uint32_t)clampi(round_q16(eng_get_param(m, STEPS_P_LEN)), 1, TRACK_STEPS);
}
/* a pattern's n words on len steps doubled (pattern-ops.ts doubled) into out (0: only counted), their count: steps
 * len..2len-1 become a copy of steps 0..len-1, the words from step 2len on stay. A note that ran past the end keeps the
 * length it sounded for (the first copy without its tie, the second with it); a drone stays one. A note's condition and
 * timing words go with it */
static uint32_t pl_doubled(const uint32_t *w, uint32_t n, uint32_t len, uint32_t *out)
{
    uint32_t i, g, k, o = 0, at, x, e, a, b;
    for (i = 0; i < n; i += g) {
        for (g = 1; i + g < n && !NW_VEL(w[i + g]); g++)
            ;
        at = NW_AT(w[i]);
        if (at >= 2u * len || (at < len && eng_note_drone(w[i]))) {
            for (k = 0; k < g; k++, o++)
                if (out)
                    out[o] = w[i + k];
            continue;
        }
        if (at >= len)
            continue;
        x = w[i];
        a = x;
        b = x + len;                             /* (the start is the low six bits of every word: 2len <= 64) */
        if (at + NW_LEN(x) > len) {
            e = (x & ENG_NOTE_WRAP) ? (NW_LEN(x) < len ? NW_LEN(x) : len) : len - at;
            a = (x & ~(ENG_NOTE_WRAP | 63u << 6)) | (e - 1u) << 6;
            b = ((x & ~(63u << 6)) | (e - 1u) << 6) + len;
        }
        if (out) {
            out[o] = a;
            out[o + g] = b;
            for (k = 1; k < g; k++) {
                out[o + k] = w[i + k];
                out[o + g + k] = w[i + k] + len;
            }
        }
        o += 2u * g;
    }
    return o;
}
/* a double's undoing from the payload b (n bytes) pl_double took before it: each track's notes, length and rate of p
 * (a track that had not got p loses it), and p's locks on the steps the double wrote (all of them on such a track) gone,
 * the payload's there back. len[t]: track t's length before, has[t]: it had p, was[t]: its length parameter before,
 * pin[t]: its patterns that took the track's length as their own (p 0) */
static void pl_undouble(uint32_t p, const uint8_t *b, const uint8_t *len, const uint8_t *has, const int32_t *was, const uint64_t *pin)
{
    uint8_t lk[7u * ENG_PAT_LOCKS];
    uint32_t nt = (uint32_t)eng_steps_count(), at = 6, got, t, m, q, j, c, k, nl, lo, hi;
    int r;
    (void)pl_apply_notes(p, b, &at, &got);
    nl = b[at++];
    for (t = 0; t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        if (!p) {
            eng_set_param(m, STEPS_P_LEN, was[t]);
            for (q = 1; q < ENG_PATTERNS; q++)
                if (pin[t] >> q & 1u) {
                    r = eng_pattern_rate(m, q);
                    (void)eng_pattern_shape(m, q, 0, r < 0 ? 0xFFu : (uint32_t)r);
                }
        }
        lo = has[t] ? len[t] : 0u;
        hi = has[t] ? 2u * len[t] : TRACK_STEPS;
        c = (uint32_t)eng_locks_list(m, p, lk, sizeof lk);
        for (j = 0; j < c; j++)
            if (lk[7u * j] >= lo && lk[7u * j] < hi)
                (void)eng_lock_set(m, p, lk[7u * j], lk[7u * j + 1u], lk[7u * j + 2u], 0, 0, 0);
        for (k = 0, q = at; k < nl; k++, q += 2u + 7u * b[q + 1u])   /* (a lock the double dropped comes back last) */
            for (j = 0; b[q] == t && j < b[q + 1u]; j++) {
                const uint8_t *x = b + q + 2u + 7u * j;
                if (x[0] >= lo && x[0] < hi)
                    (void)eng_lock_set(m, p, x[0], x[1], x[2], pl_row_more(x[1], x[2]), (int32_t)pl_rd32(x + 3), 1);
            }
    }
}
/* pattern p of every track doubled (pattern-ops.ts doublePattern, D-838) in the engine and the running binary: 0 done
 * (*longest: the longest new length), -1 a track would pass TRACK_STEPS, -2 a pattern TRACK_NOTES_MAX words or the patch
 * ENG_MAX_NOTES, -3 a pattern ENG_PAT_LOCKS locks or the patch ENG_MAX_LOCKS, -4 the binary has no room. Refused,
 * nothing changes: the undo is p's payload at m1_up's start, where m1_pat_spill leaves it, and the patterns the spill sent
 * to the store meanwhile are linked as before (pl_mark). Pattern 1 doubles the track's length, and the track's other
 * patterns on the track's length get it as their own; a track without p gets it first from its pattern 1 (D-542). Links
 * and origins stay: a linked pattern is no longer clean (pl_hash), as after an edit. The playhead goes on where it is */
static int pl_double(uint32_t p, uint32_t *longest)
{
    uint32_t w[TRACK_NOTES_MAX];
    uint8_t lk[7u * ENG_PAT_LOCKS], len[ENG_MAX_TRACKS], has[ENG_MAX_TRACKS];
    int32_t was[ENG_MAX_TRACKS];
    uint8_t rn[ENG_MAX_TRACKS];                  /* (each track's record's parameters before: m1_track_fit's undoing) */
    uint64_t pin[ENG_MAX_TRACKS];
    uint32_t nt = (uint32_t)eng_steps_count(), t, m, q, j, n, c, k, L, sp, words = 0, locks = (uint32_t)eng_locks_count(), most = 0;
    uint32_t bad = 0;                            /* (bit 1 notes, bit 2 locks) */
    const uint32_t *src;
    pl_out_t s = { m1_up, sizeof m1_up, 0, PT_FNV0 };
    pl_mark_t mk;
    int ok = 1, r;
    for (t = 0; t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        has[t] = (uint8_t)(!p || eng_pattern_has(m, p));
        len[t] = (uint8_t)pl_len(m, has[t] ? p : 0u);
        if (2u * len[t] > TRACK_STEPS)
            return -1;
        for (q = 0; q < ENG_PATTERNS; q++)
            if (!q || eng_pattern_has(m, q))
                words += (uint32_t)eng_pattern_notes(m, q, &src);
    }
    for (t = 0; t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        sp = has[t] ? p : 0u;
        n = (uint32_t)eng_pattern_notes(m, sp, &src);
        k = pl_doubled(src, n, len[t], 0);
        bad |= k > TRACK_NOTES_MAX ? 2u : 0u;
        words += k - (has[t] ? n : 0u);
        c = (uint32_t)eng_locks_list(m, sp, lk, sizeof lk);
        for (j = k = 0; j < c; j++)
            k += lk[7u * j] >= 2u * len[t] ? 1u : lk[7u * j] < len[t] ? 2u : 0u;
        bad |= k > ENG_PAT_LOCKS ? 4u : 0u;
        locks += k - (has[t] ? c : 0u);
    }
    if ((bad & 2u) || words > ENG_MAX_NOTES)
        return -2;
    if ((bad & 4u) || locks > ENG_MAX_LOCKS)
        return -3;
    pl_encode(p, &s);                            /* (what undoes it) */
    if (s.n > s.cap)
        return -4;
    pl_mark(&mk, s.n);
    for (t = 0; t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        L = len[t];
        sp = has[t] ? p : 0u;
        r = has[t] && p ? eng_pattern_rate(m, p) : -1;
        pin[t] = 0;
        was[t] = eng_get_param(m, STEPS_P_LEN);
        rn[t] = (uint8_t)m1_track_npar(m);
        c = (uint32_t)eng_locks_list(m, sp, lk, sizeof lk);
        n = (uint32_t)eng_pattern_notes(m, sp, &src);
        n = pl_doubled(src, n, L, w);
        ok &= eng_pattern_set_notes(m, p, w, n) != 0;
        if (p)
            (void)eng_pattern_shape(m, p, 2u * L, r < 0 ? 0xFFu : (uint32_t)r);
        else {
            for (q = 1; q < ENG_PATTERNS; q++)
                if (eng_pattern_has(m, q) && !eng_pattern_len(m, q)) {
                    r = eng_pattern_rate(m, q);
                    (void)eng_pattern_shape(m, q, L, r < 0 ? 0xFFu : (uint32_t)r);
                    pin[t] |= (uint64_t)1u << q;
                }
            eng_set_param(m, STEPS_P_LEN, (int32_t)(2u * L) << 16);
        }
        for (j = 0; j < c; j++) {                /* the locks: those on L..2L-1 go, those on 0..L-1 copied L steps on */
            const uint8_t *x = lk + 7u * j;
            if (has[t] && x[0] >= L && x[0] < 2u * L)
                (void)eng_lock_set(m, p, x[0], x[1], x[2], 0, 0, 0);
            else if (!has[t] && (x[0] < L || x[0] >= 2u * L))
                ok &= eng_lock_set(m, p, x[0], x[1], x[2], 0, (int32_t)pl_rd32(x + 3), 1) == 0;
        }
        for (j = 0; j < c; j++)
            if (lk[7u * j] < L)
                ok &= eng_lock_set(m, p, lk[7u * j] + L, lk[7u * j + 1u], lk[7u * j + 2u], 0, (int32_t)pl_rd32(lk + 7u * j + 3u), 1) == 0;
        most = 2u * L > most ? 2u * L : most;
    }
    ok = ok && m1_patterns_fit();
    for (t = 0; ok && !p && t < nt; t++)
        ok = m1_track_fit((uint32_t)eng_steps_module(t), -1);
    if (ok) {
        m1_edited = 1;
        pl_unmark(&mk, 1);
        *longest = most;
        return 0;
    }
    pl_undouble(p, m1_up, len, has, was, pin);
    (void)m1_patterns_fit();
    for (t = 0; !p && t < nt; t++)
        (void)m1_track_fit((uint32_t)eng_steps_module(t), (int)rn[t]);
    pl_unmark(&mk, 0);
    return -4;
}
/* pattern p of every track halved (pattern-ops.ts halvePattern, D-841) in the engine and the running binary: its length
 * halved, rounded down, its notes and P-locks as they were (as LAST STEP shortens it). 0 done (*longest: the longest new
 * length), -1 a track of 1 step, -2 the patch would pass ENG_MAX_NOTES, -3 ENG_MAX_LOCKS (a track without p gets it first
 * from its pattern 1, D-542), -4 the binary has no room. Refused, nothing changes (the patterns m1_pat_spill sent to the
 * store meanwhile linked as before, pl_unmark). Which length is pl_double's: pattern 1 halves the track's length, and the
 * track's other patterns on the track's length get it as their own. The playhead goes on as after LAST STEP */
static int pl_halve(uint32_t p, uint32_t *longest)
{
    uint32_t w[TRACK_NOTES_MAX];
    uint8_t lk[7u * ENG_PAT_LOCKS], len[ENG_MAX_TRACKS], has[ENG_MAX_TRACKS], own[ENG_MAX_TRACKS], rn[ENG_MAX_TRACKS];
    int32_t was[ENG_MAX_TRACKS];
    uint64_t pin[ENG_MAX_TRACKS];
    uint32_t nt = (uint32_t)eng_steps_count(), t, m, q, j, n, c, words = 0, locks = (uint32_t)eng_locks_count(), most = 0;
    const uint32_t *src;
    pl_mark_t mk;
    int ok = 1, r;
    for (t = 0; t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        has[t] = (uint8_t)(!p || eng_pattern_has(m, p));
        len[t] = (uint8_t)pl_len(m, has[t] ? p : 0u);
        if (len[t] < 2u)
            return -1;
        for (q = 0; q < ENG_PATTERNS; q++)
            if (!q || eng_pattern_has(m, q))
                words += (uint32_t)eng_pattern_notes(m, q, &src);
        if (!has[t]) {                           /* (the copy of its pattern 1 it gets) */
            words += (uint32_t)eng_pattern_notes(m, 0, &src);
            locks += (uint32_t)eng_locks_list(m, 0, lk, sizeof lk);
        }
    }
    if (words > ENG_MAX_NOTES)
        return -2;
    if (locks > ENG_MAX_LOCKS)
        return -3;
    pl_mark(&mk, 0);
    for (t = 0; t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        pin[t] = 0;
        was[t] = eng_get_param(m, STEPS_P_LEN);
        rn[t] = (uint8_t)m1_track_npar(m);
        own[t] = (uint8_t)(p && has[t] ? eng_pattern_len(m, p) : 0);
        if (!p) {
            for (q = 1; q < ENG_PATTERNS; q++)
                if (eng_pattern_has(m, q) && !eng_pattern_len(m, q)) {
                    r = eng_pattern_rate(m, q);
                    (void)eng_pattern_shape(m, q, len[t], r < 0 ? 0xFFu : (uint32_t)r);
                    pin[t] |= (uint64_t)1u << q;
                }
            eng_set_param(m, STEPS_P_LEN, (int32_t)(len[t] / 2u) << 16);
        } else {
            if (!has[t]) {
                n = (uint32_t)eng_pattern_notes(m, 0, &src);
                for (j = 0; j < n; j++)          /* (a copy: setting p moves the engine's slices) */
                    w[j] = src[j];
                ok &= eng_pattern_set_notes(m, p, w, n) != 0;
                c = (uint32_t)eng_locks_list(m, 0, lk, sizeof lk);
                for (j = 0; j < c; j++)
                    ok &= eng_lock_set(m, p, lk[7u * j], lk[7u * j + 1u], lk[7u * j + 2u], 0, (int32_t)pl_rd32(lk + 7u * j + 3u), 1) == 0;
            }
            r = has[t] ? eng_pattern_rate(m, p) : -1;
            (void)eng_pattern_shape(m, p, len[t] / 2u, r < 0 ? 0xFFu : (uint32_t)r);
        }
        most = len[t] / 2u > most ? len[t] / 2u : most;
    }
    ok = ok && m1_patterns_fit();
    for (t = 0; ok && !p && t < nt; t++)
        ok = m1_track_fit((uint32_t)eng_steps_module(t), -1);
    if (ok) {
        m1_edited = 1;
        pl_unmark(&mk, 1);
        *longest = most;
        return 0;
    }
    for (t = 0; t < nt; t++) {                   /* (undone) */
        m = (uint32_t)eng_steps_module(t);
        if (!p) {
            eng_set_param(m, STEPS_P_LEN, was[t]);
            for (q = 1; q < ENG_PATTERNS; q++)
                if (pin[t] >> q & 1u) {
                    r = eng_pattern_rate(m, q);
                    (void)eng_pattern_shape(m, q, 0, r < 0 ? 0xFFu : (uint32_t)r);
                }
        } else if (has[t]) {
            r = eng_pattern_rate(m, p);
            (void)eng_pattern_shape(m, p, own[t], r < 0 ? 0xFFu : (uint32_t)r);
        } else {
            c = (uint32_t)eng_locks_list(m, p, lk, sizeof lk);
            for (j = 0; j < c; j++)
                (void)eng_lock_set(m, p, lk[7u * j], lk[7u * j + 1u], lk[7u * j + 2u], 0, 0, 0);
            eng_pattern_drop(m, p);
        }
    }
    (void)m1_patterns_fit();
    for (t = 0; !p && t < nt; t++)
        (void)m1_track_fit((uint32_t)eng_steps_module(t), (int)rn[t]);
    pl_unmark(&mk, 0);
    return -4;
}

/* the entry after stored id `from` in the store's order (by id), 0 none */
static uint32_t pl_after(uint32_t from)
{
    pt_info_t in;
    return pt_next(from, &in) ? 0u : in.id;
}
/* the entry before stored id `from` (at most PL_KIT) in the store's order, 0 none */
static uint32_t pl_before(uint32_t from)
{
    pt_info_t in;
    return pt_prev(from, &in) ? 0u : in.id;
}

/* the entry after (dir > 0) or before stored id `from` in the store's order, round; from 0: the first or the last */
static uint32_t pl_step(uint32_t from, int dir)
{
    uint32_t id = dir > 0 ? pl_after(from) : pl_before(from ? from : PL_KIT);
    return id ? id : dir > 0 ? pl_after(0) : pl_before(PL_KIT);
}

/* ---- the editor link (proto.c) */

static void m1_pat_info(uint8_t *p)
{
    uint32_t f = pt_free_bytes(), t = pt_total_bytes();
    f = f > 0xFFFFu ? 0xFFFFu : f;
    t = t > 0xFFFFu ? 0xFFFFu : t;
    p[0] = (uint8_t)(p[0] | (pt_on ? 2u : 0u));
    p[1] = (uint8_t)bank_slots;
    p[2] = (uint8_t)f;
    p[3] = (uint8_t)(f >> 8);
    p[4] = (uint8_t)t;
    p[5] = (uint8_t)(t >> 8);
    p[11] = (uint8_t)(p[11] | (pt_on ? 2u : 0u));    /* (byte 25 bit 1: SAVE puts every pattern 2..64 into the store, #1202) */
}

/* the entries (e 0: how many); else the one after cursor `after` (0: the first) as PAT's bytes from its id on, and the
 * next cursor (0: none after): the user entries, kept copies among them, in the store's order (cursor PL_CUR_USER | the
 * store offset past the entry: one walk over the store lists them all). PAT's flags byte: bit 1 a kept copy */
#define PL_CUR_USER 0x100000u
static uint32_t m1_pat_list(uint32_t after, uint8_t *e)
{
    pt_info_t in;
    pt_hdr_t r;
    uint8_t b[6];
    uint32_t i, k, loc, next = 0;
    if (!e)
        return pt_count();
    if (!pt_on)
        return 0;
    pt_ensure();
    for (loc = after & 0xFFFFFu; !pt_iter(&loc, &r); loc += pt_size(r.len))
        if (PT_LIVE(r.magic) && !st_read(PT_BASE + loc + PT_HDR, b, sizeof b)) {
            pt_fill(&r, &in);
            next = PL_CUR_USER | (loc + pt_size(r.len));
            break;
        }
    if (!next)
        return 0;
    for (k = 0; k < 30u; k++)
        e[k] = 0;
    e[0] = (uint8_t)in.id;
    e[1] = (uint8_t)(in.id >> 8);
    e[2] = (uint8_t)in.len;
    e[3] = (uint8_t)(in.len >> 8);
    for (k = 0; k < 4u; k++) {
        e[4u + k] = (uint8_t)(in.hash >> (8u * k));
        e[8u + k] = b[1u + k];                        /* (the layout) */
    }
    e[12] = b[5];
    e[13] = in.kept ? 2u : 0u;
    for (i = 0; i < PT_NAME && in.name[i]; i++)
        e[14u + i] = (uint8_t)in.name[i];
    return next;
}

static const uint8_t *m1_pat_get(uint32_t id, uint32_t *len)
{
    pt_info_t in;
    if (id > PT_ID_MAX || pl_read(id, m1_up, sizeof m1_up, &in))
        return 0;
    *len = in.len;
    return m1_up;
}

/* len's bit 15 (proto.c PAT_PUT's PAT_KEPT): stored as a kept copy */
static uint32_t m1_pat_put(uint32_t *id, const char *name, const uint8_t *p, uint32_t len)
{
    uint32_t kept = len >> 15 & 1u;
    int rc;
    len &= 0x7FFFu;
    if (*id > PT_ID_MAX || pl_check(p, len))
        return S_RANGE;
    rc = pt_put(id, name, p, len, (int)kept);
    return rc == 0 ? S_OK : rc == -2 ? S_FULL : rc == -3 ? S_RANGE : rc == -4 ? S_MISSING : S_FLASH;
}

/* the bank's slots whose patches link stored id */
static uint32_t pl_used(uint32_t id)
{
    sl_hdr_t h;
    uint32_t s, k, at, n = 0;
    for (s = 0; s < bank_slots; s++) {
        if (sl_head(s, &h, 1) || !(sl_buf[7] & ENG_FLAG_LINKS) || !(at = eng_links_at(sl_buf, h.len)))
            continue;
        for (k = 0; k < sl_buf[at] && ((uint32_t)sl_buf[at + 2u + 3u * k] | (uint32_t)sl_buf[at + 3u + 3u * k] << 8) != id; k++)
            ;
        n += k < sl_buf[at];
    }
    return n;
}

static uint32_t m1_pat_del(uint32_t id, uint32_t force, uint32_t *count)
{
    pt_info_t in;
    uint32_t n, k, live = 0;
    const uint8_t *e;
    int rc;
    if (id > PT_ID_MAX)
        return S_RANGE;
    if (!id || pt_stat(id, &in))
        return S_MISSING;
    if (!force && (*count = pl_used(id)) != 0)
        return S_USED;
    if ((rc = pt_del(id)) != 0)
        return rc == -4 ? S_MISSING : S_FLASH;
    for (e = pl_links(&n), k = 0; k < n; k++, e += 3)  /* (the running patch's links to it: inline from now on, SAVE drops
                                                        * the link) */
        if (((uint32_t)e[1] | (uint32_t)e[2] << 8) == id) {
            pl_hash[e[0]] = 0;
            live = 1;
        }
    if (live)
        pl_rewrite();
    return S_OK;
}
