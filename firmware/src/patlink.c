/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The pattern store's glue (#901, option D): between the engine's patterns, the running patch (proto.c m1_cur) and the
 * stored patterns (patstore.c).
 *
 * A stored pattern's payload is one pattern number across the patch's Steps tracks (track k = the k-th Steps module in
 * module order), all LE, byte for byte what web/src/pattern-store.ts writes:
 *   u8 1 (version), u32 layout (0 without P-locks, else pl_layout), u8 T (1 + the last track that has the pattern, at
 *   least 1), per track k < T: u8 n (0xFF: the track has not got the pattern), with n != 0xFF u8 len (bits 0..6: 0 the
 *   track's, else 1..64; bit 7: short words), u8 rate (0xFF the track's, else a STEPS_RATES index) and n u16 short words
 *   (format 48's rule and layout, engine.c eng_notes_short) or u32 note words; then u8 L, per locked track (ascending k)
 *   u8 k, u8 c (1..64) and c locks of 7 bytes as eng_locks_list writes them.
 * Pattern index 0 (pattern 1) has no own length / rate: written as len 0 and rate 0xFF, ignored when loaded.
 *
 * The running patch links pattern indices 1..63 to stored ids in format 59's section after the P-locks: m1_cur holds the
 * only copy (pl_link reads it, pl_set_link rewrites it). pl_hash keeps each link's payload hash as the store gave it to
 * this patch. A linked pattern whose payload still hashes to that is
 * clean: proto.c leaves it out of the patterns and locks sections (m1_pat_clean), so the binary carries only the link and
 * the next load copies it from the store again. An edited one stays inline until SAVE (pl_commit, #1202), which puts
 * every pattern 2..64 into the store: a saved slot holds pattern 1, its songs and its links. An edited pattern that
 * another slot or another pattern of the patch links gets an entry of its own then (shared until edited); an entry no
 * slot and not the running patch links goes (pl_gc). When the binary cannot hold the inline ones, they go to entries
 * only the running patch links (m1_pat_spill, #1199). Two kinds of read-only factory entries follow the user's (ids
 * 1..PT_ID_MAX), in id order: the factory
 * patches' patterns (factory_tier.h KIT_GROUPS, compiled in with the firmware tier, #915: from PL_KIT, a patch's block
 * from its own first id in one or more groups of consecutive ids, #852; any number of tracks, in the payload layout
 * above, a group packed together by lz_unpack.h and unpacking into m1_up), which
 * a factory patch links like a user entry, and the factory demonstration patterns (factory.c fc_pattern, ids PL_FACTORY +
 * index: one track, no locks). Loading either on the SEQ page copies it and links nothing. A link to a read-only entry
 * needs no store; SAVE of an edited one stores it as a new user entry, which it then links.
 *
 * The payloads go through m1_up (proto.c's upload buffer: the store works in sl_buf, and the editor sends no patch upload
 * while it talks to the store). Needs, after proto.c and patstore.c: m1_cur, m1_cur_len, m1_edited, m1_up,
 * m1_patch_patterns, m1_patch_locks, m1_patch_links, m1_steps_write, m1_steps_cost, m1_pat_link_now,
 * m1_track_pattern_now, m1_locks_now, m1_patch_name, bank_slots, bank_mask, sl_head / sl_buf (slotstore.c), KIT_GROUPS
 * (factory_tier.h), fc_pattern / fc_npatterns (factory.c). */
#define PL_KIT (PT_ID_MAX + 1u)            /* the first factory patch pattern's id: 0xE000 */
#define PL_FACTORY 0xFF00u                 /* the first factory demonstration pattern's id */
#define PL_END (PL_FACTORY + 256u)         /* one above every 16-bit id */
#define PL_DEMO_TRACKS 16u                 /* a demo set's origins at most: a patch's Steps tracks (engine.c ENG_MAX_TRACKS) */

static uint32_t pl_hash[ENG_PATTERNS];     /* each link's payload hash as the store gave it to this patch */
static uint64_t pl_priv;                   /* bit p: pattern p links an entry m1_pat_spill made since the load or SAVE, which
                                           * only the running patch links */
static int pl_is_factory(uint32_t id);

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
    uint8_t s[1u + 3u * (ENG_PATTERNS - 1u)];
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

/* a track's entry: n, len (with the short words bit), rate, the words */
static void pl_words(pl_out_t *s, const uint32_t *w, uint32_t n, uint32_t len, uint32_t rate)
{
    uint32_t j, sh = (uint32_t)eng_notes_short(w, n);
    pl_b(s, n);
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
    uint32_t nt = (uint32_t)eng_steps_count(), t, k, T = 1, L = 0, m;
    int c, r;
    const uint32_t *w;
    uint8_t lk[7u * ENG_PAT_LOCKS];
    for (t = 0; t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        if (eng_pattern_has(m, p))
            T = t + 1u;
        L += eng_locks_list(m, p, 0, 0) > 0;
    }
    pl_b(s, 1);
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

/* factory pattern f as a payload: track 0 alone, its own length and rate, no locks */
static void pl_factory(const fc_pattern_t *f, pl_out_t *s)
{
    pl_b(s, 1);
    pl_w(s, 0, 4);
    pl_b(s, 1);
    pl_words(s, f->notes, f->n, f->len, f->rate);
    pl_b(s, 0);
}

/* the factory patch pattern group (factory_tier.h KIT_GROUPS) that holds id, N_KIT_GROUPS none */
static uint32_t pl_kit(uint32_t id)
{
    uint32_t g;
    for (g = 0; g < N_KIT_GROUPS && id - KIT_GROUPS[g].first >= KIT_GROUPS[g].n; g++)
        ;
    return g;
}

/* stored pattern id (a user entry or a factory one) into buf (cap bytes), its record in *in: 0, -1 none. A factory patch
 * pattern's group is unpacked into buf, each entry there its name (NUL ended), u16 payload length, payload; the entry's
 * payload then moves to buf's start */
static int pl_read(uint32_t id, uint8_t *buf, uint32_t cap, pt_info_t *in)
{
    pl_out_t s = { buf, cap, 0, PT_FNV0 };
    const uint8_t *src = 0;
    const char *name;
    fc_pattern_t f;
    uint32_t i, n = 0, k, g = pl_kit(id);
    if (id <= PT_ID_MAX)
        return pt_read(id, buf, cap, in) ? -1 : 0;
    if (g < N_KIT_GROUPS) {
        if (lz_unpack(KIT_GROUPS[g].lz, KIT_GROUPS[g].lz_len, buf, cap) != (int32_t)KIT_GROUPS[g].len)
            return -1;
        for (src = buf, k = id - KIT_GROUPS[g].first;; k--, src += i + 3u + n) {
            for (i = 0; src[i]; i++)
                ;
            n = (uint32_t)src[i + 1u] | (uint32_t)src[i + 2u] << 8;
            if (!k)
                break;
        }
        name = (const char *)src;
        src += i + 3u;
    } else if (id >= PL_FACTORY && !fc_pattern(id - PL_FACTORY, &f)) {
        name = f.name;
    } else {
        return -1;
    }
    for (i = 0; i < PT_NAME && name[i]; i++)          /* (the name first: the payload may move over it) */
        in->name[i] = name[i];
    in->name[i] = 0;
    if (src)
        for (i = 0; i < n; i++)
            pl_b(&s, src[i]);
    else
        pl_factory(&f, &s);
    in->id = (uint16_t)id;
    in->len = (uint16_t)s.n;
    in->hash = s.h;
    return s.n <= cap ? 0 : -1;
}

/* a payload's framing: its tracks' entries and locks in range, its bytes used exactly: 0 ok */
static int pl_check(const uint8_t *b, uint32_t len)
{
    uint32_t at = 6, T, k, n, c, last = 0;
    if (len < 7u || b[0] != 1u || !(T = b[5]))
        return -1;
    for (k = 0; k < T; k++) {
        if (at >= len)
            return -1;
        if ((n = b[at++]) == 0xFFu)
            continue;
        if (n > TRACK_NOTES_MAX || at + 2u > len || (b[at] & 0x7Fu) > TRACK_STEPS || (b[at + 1u] != 0xFFu && b[at + 1u] > 8u))
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

/* a payload loaded into pattern p of the running patch (pattern-store.ts applyPayload): each track gets the payload's
 * entry for it (notes, and for p >= 1 its length and rate); a track without one no longer has p (pattern 1: no notes).
 * p's locks are replaced, by the payload's only in the same layout. 0 done, 1 done with the locks left out (another
 * layout), -1 malformed, -2 no room for all of it */
static int pl_apply(uint32_t p, const uint8_t *b, uint32_t len)
{
    uint32_t w[TRACK_NOTES_MAX];
    uint32_t nt = (uint32_t)eng_steps_count(), T, at = 6, t, n, j, k, c, sh, m, got = 0;
    int rc = 0;
    if (pl_check(b, len))
        return -1;
    T = b[5];
    for (t = 0; t < T || t < nt; t++) {
        m = (uint32_t)eng_steps_module(t);
        n = t < T ? b[at++] : 0xFFu;
        if (n == 0xFFu) {
            if (t < nt && p)
                eng_pattern_drop(m, p);
            else if (t < nt)
                (void)eng_pattern_set_notes(m, 0, w, 0);
            continue;
        }
        sh = b[at] & 0x80u;
        for (j = 0; j < n; j++) {
            const uint8_t *x = b + at + 2u + j * (sh ? 2u : 4u);
            uint32_t v = sh ? (uint32_t)x[0] | (uint32_t)x[1] << 8 : pl_rd32(x);
            w[j] = sh ? NW(v & 15u, ((v >> 4) & 15u) + 1u, (v >> 8) & 127u, (v & 0x8000u) ? ACCENT_VEL : STEP_VEL, 0u) : v;
        }
        if (t < nt && !eng_pattern_set_notes(m, p, w, n))
            rc = -2;
        else if (t < nt && p)
            (void)eng_pattern_shape(m, p, b[at] & 0x7Fu, b[at + 1u]);
        got |= t < 32u ? 1u << t : 0u;
        at += 2u + n * (sh ? 2u : 4u);
    }
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

/* the patterns and locks into the binary after a link changed (the clean ones out, the others in) */
static void pl_rewrite(void)
{
    (void)m1_patch_locks();
    m1_patch_patterns();
    m1_edited = 1;
}

/* pattern p of the running patch has notes or a length of its own on some track (pattern 1: always) */
static int pl_has(uint32_t p)
{
    uint32_t t;
    for (t = 0; t < (uint32_t)eng_steps_count(); t++)
        if (eng_pattern_has((uint32_t)eng_steps_module(t), p))
            return 1;
    return 0;
}

/* proto.c m1_set_current: the links of the patch just loaded (m1_cur, the engine has it). A linked pattern no track has
 * comes from the store or the factory entries (none there, or no store for a user entry: it stays absent, the link
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

/* the running patch's links become ids (ids[p], pattern p 1..63; 0 none): the patterns and locks sections without the
 * clean ones first (a pattern whose bytes hash to pl_hash[p]), then the links section, only when the binary holds all
 * three. 1 done; 0 not (nothing changed) */
static int pl_relink(const uint16_t *ids)
{
    uint8_t s[1u + 3u * (ENG_PATTERNS - 1u)];
    uint32_t p, o = 0, at = eng_links_at(m1_cur, m1_cur_len), old;
    uint64_t omit = 0;
    int32_t d;
    if (!at)
        return 0;
    for (p = 1; p < ENG_PATTERNS; p++) {
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
    d = m1_steps_cost(ENG_SEC_PATTERNS, omit) + m1_steps_cost(ENG_SEC_LOCKS, omit) + (int32_t)(o ? 1u + 3u * o : 0u)
        - (int32_t)old;
    if ((o && m1_cur[1] < ENG_COUNTED) || (int32_t)m1_cur_len + d > (int32_t)M1_PATCH_MAX)
        return 0;
    (void)m1_steps_write(ENG_SEC_PATTERNS, omit);
    (void)m1_steps_write(ENG_SEC_LOCKS, omit);
    return m1_patch_links(s, o ? 1u + 3u * o : 0u);
}

/* the running patch's links by pattern into ids (0 none) */
static void pl_ids(uint16_t *ids)
{
    uint32_t n, k;
    const uint8_t *e = pl_links(&n);
    for (k = 0; k < ENG_PATTERNS; k++)
        ids[k] = 0;
    for (k = 0; k < n; k++, e += 3)
        if (e[0] && e[0] < ENG_PATTERNS)
            ids[e[0]] = (uint16_t)((uint32_t)e[1] | (uint32_t)e[2] << 8);
}

/* bit p: the user entry pattern p links (ids[p]) is linked by another pattern of this patch, or by a saved slot other than
 * self (each slot's bytes read into sl_buf) */
static uint64_t pl_shared(const uint16_t *ids, uint32_t self)
{
    sl_hdr_t h;
    uint64_t m = 0;
    uint32_t s, k, p, q, at, id;
    for (p = 1; p < ENG_PATTERNS; p++)
        for (q = 1; ids[p] && q < ENG_PATTERNS; q++)
            if (q != p && ids[q] == ids[p])
                m |= (uint64_t)1u << p;
    for (s = 0; s < bank_slots; s++) {
        if (s == self || sl_head(s, &h, 1) || !(sl_buf[7] & ENG_FLAG_LINKS) || !(at = eng_links_at(sl_buf, h.len)))
            continue;
        for (k = 0; k < sl_buf[at]; k++) {
            id = (uint32_t)sl_buf[at + 2u + 3u * k] | (uint32_t)sl_buf[at + 3u + 3u * k] << 8;
            for (p = 1; p < ENG_PATTERNS; p++)
                if (ids[p] == id)
                    m |= (uint64_t)1u << p;
        }
    }
    return m;
}

/* SAVE (main.c m1_store, before the running patch goes into slot self; main.c's boot for each slot that holds patterns
 * 2..64 in its binary, #1202): every pattern 2..64 the running patch has goes to the store and the patch links it, so the
 * slot keeps pattern 1, the songs and the links. A pattern whose link is clean keeps it. Any other takes an entry whose
 * bytes are the same (by hash and length: shared), else is written over the entry it links when no other slot and no
 * other pattern of this patch links that one, else into a new entry named after the patch (`patch`, pl_name): an edited
 * shared pattern splits off its own copy. A link to a pattern no track has goes. The store full (or a pattern larger than
 * an entry, or the ids used up): that pattern stays in the binary. 0 done, -2 some pattern stayed in the binary, -3 the
 * binary could not take the links (it is as it was) */
static int pl_commit(const char *patch, uint32_t self)
{
    uint16_t ids[ENG_PATTERNS], uids[ENG_PATTERNS];
    int32_t at[ENG_PATTERNS];
    uint32_t hash[ENG_PATTERNS], want[ENG_PATTERNS], len[ENG_PATTERNS], keep[ENG_PATTERNS], p, loc, id, full = 0;
    uint64_t need = 0, shared = 0, done = 0, known = 0;
    char name[PT_NAME + 1u];
    pt_hdr_t r;
    pl_out_t s;
    int rc;
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
            if (!ids[p] || (ids[p] <= PT_ID_MAX ? at[p] >= 0 : pl_is_factory(ids[p])))
                ids[p] = 0;
            continue;
        }
        s = (pl_out_t){ 0, 0, 0, PT_FNV0 };
        pl_encode(p, &s);
        if (ids[p] && (ids[p] > PT_ID_MAX ? s.h == pl_hash[p] : at[p] >= 0 && (s.h == pl_hash[p] || s.h == hash[p]))) {
            pl_hash[p] = s.h;                         /* (clean: the link stays) */
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
    for (loc = 0; need && !pt_iter(&loc, &r); loc += pt_size(r.len))   /* (an entry with the same bytes: one walk) */
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
        s = (pl_out_t){ m1_up, sizeof m1_up, 0, PT_FNV0 };
        pl_encode(p, &s);
        if (id) {
            pt_info_t in;
            rc = pt_stat(id, &in) ? -4 : pt_put(&id, in.name, m1_up, s.n);
        } else {
            rc = -4;
        }
        if (rc == -4) {
            id = 0;
            pl_name(name, patch, p);
            rc = pt_put(&id, name, m1_up, s.n);
        }
        if (rc) {
            full = 1;                                 /* (it stays in the binary, as an edited copy of its link if any) */
            continue;
        }
        ids[p] = (uint16_t)id;
        pl_hash[p] = s.h;
        done |= (uint64_t)1u << p;
    }
    if (!pl_relink(ids)) {                            /* (the entries it wrote go at the next tidy-up, pl_gc) */
        for (p = 1; p < ENG_PATTERNS; p++)
            pl_hash[p] = keep[p];
        return -3;
    }
    for (p = 1; p < ENG_PATTERNS; p++)
        if (done >> p & 1u)
            m1_pat_link_now(p, ids[p], pl_hash[p]);
    pl_priv = 0;
    return full ? -2 : 0;
}

/* proto.c m1_steps_sec (#1199): the binary cannot hold its patterns and P-locks. Each pattern 2..64 it holds goes to the
 * store, in an entry of its own that only the running patch links (pl_priv: written over at the next spill), named after
 * the patch, so the slot's links and the other patches' patterns stay as they are until SAVE (pl_commit takes these
 * entries as they are). Then the sections without them and the links (pl_relink). 1 some went, 0 none (no store, the store
 * full, or the binary still cannot hold the links) */
static int m1_pat_spill(void)
{
    uint16_t ids[ENG_PATTERNS];
    uint32_t keep[ENG_PATTERNS], p, id;
    uint64_t moved = 0;
    char name[PT_NAME + 1u];
    pl_out_t s;
    int rc;
    if (!pt_on)
        return 0;
    pl_ids(ids);
    for (p = 1; p < ENG_PATTERNS; p++) {
        keep[p] = pl_hash[p];
        if (!pl_has(p))
            continue;
        s = (pl_out_t){ m1_up, sizeof m1_up, 0, PT_FNV0 };
        pl_encode(p, &s);
        if ((ids[p] && s.h == pl_hash[p]) || s.n > PT_MAX)
            continue;
        id = (pl_priv >> p & 1u) && ids[p] <= PT_ID_MAX ? ids[p] : 0u;
        pl_name(name, m1_patch_name(), p);
        rc = pt_put(&id, name, m1_up, s.n);
        if (rc == -4) {
            id = 0;
            rc = pt_put(&id, name, m1_up, s.n);
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
        for (p = 1; p < ENG_PATTERNS; p++)
            pl_hash[p] = keep[p];
        return 0;
    }
    pl_priv |= moved;
    m1_edited = 1;
    for (p = 1; p < ENG_PATTERNS; p++)
        if (moved >> p & 1u)
            m1_pat_link_now(p, ids[p], pl_hash[p]);
    return 1;
}

/* a stored pattern is deleted once no patch links it (#1202): after a slot is written or erased, and at boot. Every user
 * entry a saved slot or the running patch links stays. The entries' ids go into m1_up (with a mark each after them), each
 * slot's bytes into sl_buf. A slot that holds a patch but cannot be read leaves every entry as it is */
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

/* pattern p into the store: over its link's live entry, else (and with as_new always) a new entry named `name`, which p
 * >= 1 is then linked to. got: the entry's name (PT_NAME + 1 bytes). 0 written over, 1 a new entry, -1 no store or a
 * flash error, -2 full (or too big) */
static int pl_save(uint32_t p, int as_new, const char *name, char *got)
{
    pl_out_t s = { m1_up, sizeof m1_up, 0, PT_FNV0 };
    pt_info_t in;
    uint32_t id, i;
    int rc, over;
    if (!pt_on)
        return -1;
    pl_encode(p, &s);
    over = !as_new && p && (id = pl_link(p)) != 0 && !pt_stat(id, &in);
    if (over)
        name = in.name;
    else
        id = 0;
    rc = s.n > s.cap ? -3 : pt_put(&id, name, m1_up, s.n);
    if (rc)
        return rc == -1 ? -1 : -2;
    for (i = 0; i < PT_NAME && name[i]; i++)
        got[i] = name[i];
    got[i] = 0;
    if (p) {
        pl_hash[p] = s.h;
        (void)pl_set_link(p, id);                     /* (a binary that cannot hold the link: the entry is a copy) */
        pl_rewrite();
    }
    m1_pat_link_now(p, pl_link(p), s.h);
    return over ? 0 : 1;
}

/* stored entry id loaded into pattern p: a user entry into p >= 1 links it, a factory one or p 0 is a copy (an older
 * link of p goes). got: its name. 0 done, 1 done with the locks left out (another layout), -1 none, -2 no room */
static int pl_load_entry(uint32_t p, uint32_t id, char *got)
{
    pt_info_t in;
    uint32_t t, i, m;
    int rc;
    if (pl_read(id, m1_up, sizeof m1_up, &in) || (rc = pl_apply(p, m1_up, in.len)) == -1)
        return -1;
    for (i = 0; i <= PT_NAME; i++)
        got[i] = in.name[i];
    if (p) {
        id = id <= PT_ID_MAX ? id : 0u;
        pl_hash[p] = id ? pl_hash_of(p) : 0u;
        (void)pl_set_link(p, id);
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
 * as a load applies it). 0 done, -2 no room (the patch's bytes or the engine's notes: q is left empty) */
static int pl_copy(uint32_t p, uint32_t q)
{
    pl_out_t s = { m1_up, sizeof m1_up, 0, PT_FNV0 };
    uint32_t t;
    int rc;
    pl_encode(p, &s);
    rc = s.n > s.cap ? -2 : pl_apply(q, m1_up, s.n);
    if (rc >= 0 && m1_patterns_fit())
        return 0;
    for (t = 0; t < (uint32_t)eng_steps_count(); t++)
        eng_pattern_drop((uint32_t)eng_steps_module(t), q);
    eng_locks_clear(q);
    (void)m1_patterns_fit();
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
 * no P-lock, no pattern origin, no song entry and none playing. The stored and factory patterns stay in the store */
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

/* ---- the demo sets (#1179): a factory patch's patterns, links, songs and pattern 1 origins as it shipped up to 1.24.1,
 * kept in the factory region (factory.c fc_demo, web/src/demo-sets.ts) and found by the running patch's layout. A set's
 * body: u8 items, each u8 pattern, u8 kind (0: u16 length and a stored pattern's payload; 1: u16 the factory entry it
 * links), u8 origins, each u8 track and u32 its pattern 1's origin, u8 songs, each u8 entries and per entry u8 pattern,
 * i8 shift */

/* the running patch's layout as its binary has it (web/src/pattern-store.ts layoutOf: FNV-1a over its module count and
 * each module's type, 0 made 1), which finds its demo set: every module of the binary, whether the engine runs it or
 * not. 0: a malformed binary */
static uint32_t pl_demo_layout(void)
{
    pl_out_t s = { 0, 0, 0, PT_FNV0 };
    uint32_t m, n = m1_cur_len >= 8u ? m1_cur[2] : 0u, at = eng_records_at(m1_cur, m1_cur_len);
    pl_b(&s, n);
    for (m = 0; m < n && at && eng_rec_ok(m1_cur, m1_cur_len, at); m++, at += eng_rec_size(m1_cur, at))
        pl_b(&s, m1_cur[at] & 0x7Fu);
    return m < n ? 0u : s.h ? s.h : 1u;
}
/* the running patch's demo set at region offset at (len bytes) walked: checked (apply 0), or loaded into the patch, which
 * clear all has just emptied (apply 1). 0 done (well formed), -1 malformed or (loading) not all of it went in */
static int pl_demo_walk(uint32_t at, uint32_t len, int apply)
{
    uint8_t b[5], lk[1u + 3u * (ENG_PATTERNS - 1u)], og[6u * PL_DEMO_TRACKS];
    uint32_t end = at + len, n, k, j, c, l, nl = 0, no = 0, nt = (uint32_t)eng_steps_count();
    if (fc_rd(1, at++, b, 1u))
        return -1;
    for (n = b[0], k = 0; k < n; k++) {             /* the patterns */
        if (at + 4u > end || fc_rd(1, at, b, 4u) || b[0] >= ENG_PATTERNS || b[1] > 1u || nl == ENG_PATTERNS - 1u)
            return -1;
        l = (uint32_t)b[2] | (uint32_t)b[3] << 8;
        at += 4u;
        if (b[1]) {                                  /* a link: its content comes from the factory entry (m1_pat_load) */
            lk[1u + 3u * nl] = b[0];
            lk[2u + 3u * nl] = b[2];
            lk[3u + 3u * nl++] = b[3];
            continue;
        }
        if (l > sizeof m1_up || at + l > end)
            return -1;
        if (apply && (fc_rd(1, at, m1_up, l) || pl_apply(b[0], m1_up, l) < 0))
            return -1;
        at += l;
    }
    lk[0] = (uint8_t)nl;
    if (at + 1u > end || fc_rd(1, at++, b, 1u) || b[0] > PL_DEMO_TRACKS)
        return -1;
    for (n = b[0], k = 0; k < n; k++, at += 5u) {   /* pattern 1's origins (D-882) */
        if (at + 5u > end || fc_rd(1, at, b, 5u))
            return -1;
        if (b[0] >= nt)
            continue;
        og[6u * no] = (uint8_t)eng_steps_module(b[0]);
        og[6u * no + 1u] = 0;
        for (j = 0; j < 4u; j++)
            og[6u * no + 2u + j] = b[1u + j];
        no++;
    }
    if (at + 1u > end || fc_rd(1, at++, b, 1u) || b[0] > ENG_SONGS)
        return -1;
    for (n = b[0], k = 0; k < n; k++) {             /* the songs */
        if (at + 1u > end || fc_rd(1, at++, b, 1u) || at + 2u * b[0] > end)
            return -1;
        for (c = b[0], j = 0; j < c; j++, at += 2u)
            if (fc_rd(1, at, b, 2u) || b[0] >= ENG_PATTERNS || (apply && eng_song_put(k, j, b[0], (int8_t)b[1])))
                return -1;
    }
    if (at != end)
        return -1;
    if (!apply)
        return 0;
    if (!m1_patch_links(lk, nl ? 1u + 3u * nl : 0u) || !m1_origins_put(og, no))
        return -1;
    m1_pat_load();                                   /* (the links' patterns from their entries, clean: as a patch load) */
    for (k = 0; k < nt; k++)
        m1_patch_notes((uint32_t)eng_steps_module(k));
    return m1_patterns_fit() ? 0 : -1;
}
/* the running patch's demo set loaded (seq_ui.c: SEQ held + SEL, then SEL): clear all (pl_clear_all), then the set's
 * patterns (a payload loaded as the store's are, or a link to a factory patch's pattern), its pattern 1 origins and its
 * songs; pattern 1 selected, no song playing. The patch as the factory patch shipped up to 1.24.1, but for its sound. All
 * or nothing: the room (the bytes the patch's notes, patterns and songs, P-locks, links and origins take now, against
 * the set's) and the set are checked before anything changes. *hash: the set's (PATTERN_OP). 0 done, -1 no demo set
 * (none of this layout, no region, a malformed one), -2 the patch has no room */
static int pl_demo_set(uint32_t *hash)
{
    uint32_t at, len, cost, notes = m1_sec_at(ENG_SEC_NOTES), links = m1_sec_at(ENG_SEC_DEVICES);
    uint32_t og = eng_origins_at(m1_cur, m1_cur_len), used;
    if (fc_demo(pl_demo_layout(), &at, &len, &cost, hash) || pl_demo_walk(at, len, 0))
        return -1;
    used = (notes && links >= notes ? links - notes : 0u) + (og ? eng_origins_end(m1_cur, m1_cur_len, og) - og : 0u);
    if (!notes || !links || m1_cur_len - used + cost > M1_PATCH_MAX)
        return -2;
    pl_clear_all();
    if (!pl_demo_walk(at, len, 1))
        return 0;
    pl_clear_all();                                  /* (never: the room was checked; not half a set) */
    return -2;
}

/* the entry is a factory one (factory_tier.h KIT_GROUPS, factory.c's patterns) */
static int pl_is_factory(uint32_t id) { return pl_kit(id) < N_KIT_GROUPS || id - PL_FACTORY < fc_npatterns(); }

/* the entry after stored id `from` in the store's order (by id: the user entries, then the factory patches' patterns,
 * then the demonstration patterns), 0 none */
static uint32_t pl_after(uint32_t from)
{
    pt_info_t in;
    if (from < PL_KIT && !pt_next(from, &in))
        return in.id;
    for (from = from < PL_KIT ? PL_KIT : from + 1u; from < PL_FACTORY + fc_npatterns(); from++)
        if (pl_is_factory(from))
            return from;
    return 0;
}
/* the entry before stored id `from` (at most PL_END) in the store's order, 0 none */
static uint32_t pl_before(uint32_t from)
{
    pt_info_t in;
    while (from > PL_KIT)
        if (pl_is_factory(--from))
            return from;
    return pt_prev(from, &in) ? 0u : in.id;
}

/* the entry after (dir > 0) or before stored id `from` in the store's order, round; from 0: the first or the last */
static uint32_t pl_step(uint32_t from, int dir)
{
    uint32_t id = dir > 0 ? pl_after(from) : pl_before(from ? from : PL_END);
    return id ? id : dir > 0 ? pl_after(0) : pl_before(PL_END);
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
    p[11] = (uint8_t)(p[11] | (pt_on ? 2u : 0u));      /* (byte 25 bit 1: SAVE puts every pattern 2..64 into the store, #1202) */
}

/* the entries (e 0: how many); else the one after cursor `after` (0: the first) as PAT's bytes from its id on, and the
 * next cursor (0: none after). The user entries come in the store's order (cursor PL_CUR_USER | the store offset past the
 * entry: one walk over the store lists them all), then the factory ones in id order (PL_CUR_KIT | the id) */
#define PL_CUR_USER 0x100000u
#define PL_CUR_KIT 0x200000u
static uint32_t m1_pat_list(uint32_t after, uint8_t *e)
{
    pt_info_t in;
    pt_hdr_t r;
    uint8_t b[6];
    uint32_t id, i, k, loc, next = 0;
    if (!e)
        return pt_count() + N_KIT_PATTERNS + fc_npatterns();
    if (!(after & PL_CUR_KIT) && pt_on) {
        pt_ensure();
        for (loc = after & 0xFFFFFu; !pt_iter(&loc, &r); loc += pt_size(r.len))
            if (r.magic == PT_MAGIC && !st_read(PT_BASE + loc + PT_HDR, b, sizeof b)) {
                pt_fill(&r, &in);
                next = PL_CUR_USER | (loc + pt_size(r.len));
                break;
            }
    }
    if (!next) {
        for (id = after & PL_CUR_KIT ? (after & 0xFFFFu) + 1u : PL_KIT; id < PL_FACTORY + fc_npatterns() && !pl_is_factory(id); id++)
            ;
        if (id >= PL_FACTORY + fc_npatterns() || pl_read(id, m1_up, sizeof m1_up, &in))
            return 0;
        for (k = 0; k < sizeof b; k++)
            b[k] = m1_up[k];
        next = PL_CUR_KIT | id;
    }
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
    e[13] = in.id > PT_ID_MAX ? 1u : 0u;
    for (i = 0; i < PT_NAME && in.name[i]; i++)
        e[14u + i] = (uint8_t)in.name[i];
    return next;
}

static const uint8_t *m1_pat_get(uint32_t id, uint32_t *len)
{
    pt_info_t in;
    if (pl_read(id, m1_up, sizeof m1_up, &in))
        return 0;
    *len = in.len;
    return m1_up;
}

static uint32_t m1_pat_put(uint32_t *id, const char *name, const uint8_t *p, uint32_t len)
{
    int rc;
    if (*id > PT_ID_MAX || pl_check(p, len))
        return S_RANGE;
    rc = pt_put(id, name, p, len);
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
