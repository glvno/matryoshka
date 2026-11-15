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
 * The running patch links pattern indices 1..63 to stored ids (format 59's section, after the P-locks): pl_id and the
 * payload's hash as the store gave it to this patch (pl_hash). A linked pattern whose payload still hashes to pl_hash is
 * clean: proto.c leaves it out of the patterns and locks sections (m1_pat_clean), so the binary carries only the link and
 * the next load copies it from the store again. An edited one stays inline, and SAVE writes it over its stored entry
 * (pl_writeback). Factory demonstration patterns (presets.h PRESET_PATTERNS) are read-only entries 0xFF00 + index after
 * the user's: one track, no locks; loading one copies it and links nothing.
 *
 * The payloads go through m1_up (proto.c's upload buffer: the store works in sl_buf, and the editor sends no patch upload
 * while it talks to the store). Needs, after proto.c and patstore.c: m1_cur, m1_cur_len, m1_edited, m1_up,
 * m1_patch_patterns, m1_patch_locks, m1_patch_links, m1_pat_link_now, m1_track_pattern_now, m1_locks_now, bank_slots,
 * sl_head / sl_buf (slotstore.c), PRESET_PATTERNS (presets.h). */
#define PL_FACTORY 0xFF00u                 /* the first factory entry's id */

static uint16_t pl_id[ENG_PATTERNS];       /* the running patch's links: pattern index -> stored id, 0 none */
static uint32_t pl_hash[ENG_PATTERNS];     /* each link's payload hash as the store gave it to this patch */

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
    uint8_t lk[7];
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
        m = (uint32_t)eng_steps_module(t);
        if ((c = eng_locks_list(m, p, 0, 0)) <= 0)
            continue;
        pl_b(s, t);
        pl_b(s, (uint32_t)c);
        for (k = 0; (int)k < c; k++) {
            (void)eng_lock_item(m, p, k, lk);
            pl_b(s, lk[0]);
            pl_b(s, lk[1]);
            pl_b(s, lk[2]);
            pl_w(s, pl_rd32(lk + 3), 4);
        }
    }
}
static uint32_t pl_hash_of(uint32_t p)
{
    pl_out_t s = { 0, 0, 0, PT_FNV0 };
    pl_encode(p, &s);
    return s.h;
}

/* factory entry i (presets.h PRESET_PATTERNS) as a payload: track 0 alone, its own length and rate, no locks */
static void pl_factory(uint32_t i, pl_out_t *s)
{
    const preset_pattern_t *f = &PRESET_PATTERNS[i];
    pl_b(s, 1);
    pl_w(s, 0, 4);
    pl_b(s, 1);
    pl_words(s, f->notes, f->n, f->len, f->rate);
    pl_b(s, 0);
}

/* stored pattern id (a user entry or a factory one) into buf (cap bytes), its record in *in: 0, -1 none */
static int pl_read(uint32_t id, uint8_t *buf, uint32_t cap, pt_info_t *in)
{
    pl_out_t s = { buf, cap, 0, PT_FNV0 };
    uint32_t i, k = id - PL_FACTORY;
    if (id < PL_FACTORY)
        return pt_read(id, buf, cap, in) ? -1 : 0;
    if (k >= N_PRESET_PATTERNS)
        return -1;
    pl_factory(k, &s);
    in->id = (uint16_t)id;
    in->len = (uint16_t)s.n;
    in->hash = s.h;
    for (i = 0; i < PT_NAME && PRESET_PATTERNS[k].name[i]; i++)
        in->name[i] = PRESET_PATTERNS[k].name[i];
    in->name[i] = 0;
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
    uint32_t len = m1_cur_len, at = eng_links_at(b, len), n, d, g, np, r, nr;
    if (!at || ((b[7] & ENG_FLAG_LINKS) && !(at = eng_links_end(b, len, at))) || !(b[6] & 32u) || !eng_devices_end(b, len, at))
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

/* the links into the binary, then the patterns and locks (the clean ones out, the others in) */
static void pl_rewrite(void)
{
    (void)m1_patch_links();
    (void)m1_patch_locks();
    m1_patch_patterns();
    m1_edited = 1;
}

/* proto.c m1_set_current: the links of the patch just loaded (m1_cur, the engine has it). A linked pattern no track has
 * comes from the store (none there, or no store: it stays absent, the link stays); one with inline content is an edited
 * copy, dirty unless it equals the stored one */
static void m1_pat_load(void)
{
    uint32_t at = eng_links_at(m1_cur, m1_cur_len), n, k, p, id, t, nt = (uint32_t)eng_steps_count();
    pt_info_t in;
    for (p = 0; p < ENG_PATTERNS; p++) {
        pl_id[p] = 0;
        pl_hash[p] = 0;
    }
    if (!at || !(m1_cur[7] & ENG_FLAG_LINKS))
        return;
    for (n = m1_cur[at], k = 0; k < n; k++) {
        p = m1_cur[at + 1u + 3u * k];
        id = (uint32_t)m1_cur[at + 2u + 3u * k] | (uint32_t)m1_cur[at + 3u + 3u * k] << 8;
        pl_id[p] = (uint16_t)id;
        for (t = 0; t < nt && !eng_pattern_has((uint32_t)eng_steps_module(t), p); t++)
            ;
        if (t < nt) {
            pl_hash[p] = pt_stat(id, &in) ? 0u : in.hash;
            continue;
        }
        if (!pt_read(id, m1_up, sizeof m1_up, &in))
            (void)pl_apply(p, m1_up, in.len);
        pl_hash[p] = pl_hash_of(p);                   /* (as this patch has it: clean until it is edited) */
    }
}

/* proto.c: the clean linked patterns (bit p) */
static uint64_t m1_pat_clean(void)
{
    uint64_t c = 0;
    uint32_t p;
    for (p = 1; p < ENG_PATTERNS; p++)
        if (pl_id[p] && pl_hash_of(p) == pl_hash[p])
            c |= (uint64_t)1u << p;
    return c;
}

/* proto.c m1_patch_links: the links section into out, its length (0 none) */
static uint32_t m1_pat_links(uint8_t *out)
{
    uint32_t p, n = 0;
    for (p = 1; p < ENG_PATTERNS; p++)
        if (pl_id[p]) {
            out[1u + 3u * n] = (uint8_t)p;
            out[2u + 3u * n] = (uint8_t)pl_id[p];
            out[3u + 3u * n] = (uint8_t)(pl_id[p] >> 8);
            n++;
        }
    out[0] = (uint8_t)n;
    return n ? 1u + 3u * n : 0u;
}

/* SAVE (main.c m1_store, before the slot is written): each edited linked pattern over its stored entry. One whose entry is
 * gone loses its link and stays inline; one the store cannot take (full, flash) stays inline and linked */
static void pl_writeback(void)
{
    pl_out_t s;
    pt_info_t in;
    uint32_t p, id, changed = 0;
    int rc;
    if (!pt_on)
        return;
    for (p = 1; p < ENG_PATTERNS; p++) {
        if (!pl_id[p])
            continue;
        s.o = m1_up;
        s.cap = sizeof m1_up;
        s.n = 0;
        s.h = PT_FNV0;
        pl_encode(p, &s);
        if (s.h == pl_hash[p] || s.n > s.cap)
            continue;
        id = pl_id[p];
        rc = pt_stat(id, &in) ? -4 : pt_put(&id, in.name, m1_up, s.n);
        if (rc == -4) {
            pl_id[p] = 0;
            pl_hash[p] = 0;
        } else if (!rc) {
            pl_hash[p] = s.h;
        } else {
            continue;
        }
        changed = 1;
        m1_pat_link_now(p, pl_id[p], pl_hash[p]);
    }
    if (changed)
        pl_rewrite();
}

/* ---- the SEQ page (seq_ui.c) */

/* pattern p into the store: over its link's live entry, else (and with as_new always) a new entry named `name`, which p
 * >= 1 is then linked to. got: the entry's name (PT_NAME + 1 bytes). 0 written over, 1 a new entry, -1 no store or a
 * flash error, -2 full (or too big) */
static int pl_save(uint32_t p, int as_new, const char *name, char *got)
{
    pl_out_t s = { m1_up, sizeof m1_up, 0, PT_FNV0 };
    pt_info_t in;
    uint32_t id = 0, i;
    int rc, over;
    if (!pt_on)
        return -1;
    pl_encode(p, &s);
    over = !as_new && p && pl_id[p] && !pt_stat(pl_id[p], &in);
    if (over) {
        id = pl_id[p];
        name = in.name;
    }
    rc = s.n > s.cap ? -3 : pt_put(&id, name, m1_up, s.n);
    if (rc)
        return rc == -1 ? -1 : -2;
    for (i = 0; i < PT_NAME && name[i]; i++)
        got[i] = name[i];
    got[i] = 0;
    if (p) {
        pl_id[p] = (uint16_t)id;
        pl_hash[p] = s.h;
        if (!m1_patch_links())                        /* (the binary cannot hold the link: the entry is a copy) */
            pl_id[p] = 0;
        pl_rewrite();
    }
    m1_pat_link_now(p, pl_id[p], s.h);
    return over ? 0 : 1;
}

/* stored entry id loaded into pattern p: a user entry into p >= 1 links it, a factory one or p 0 is a copy (an older
 * link of p goes). got: its name. 0 done, 1 done with the locks left out (another layout), -1 none, -2 no room */
static int pl_load_entry(uint32_t p, uint32_t id, char *got)
{
    pt_info_t in;
    uint32_t t, i;
    int rc;
    if (pl_read(id, m1_up, sizeof m1_up, &in) || (rc = pl_apply(p, m1_up, in.len)) == -1)
        return -1;
    for (i = 0; i <= PT_NAME; i++)
        got[i] = in.name[i];
    if (p) {
        pl_id[p] = (uint16_t)(id < PL_FACTORY ? id : 0u);
        pl_hash[p] = pl_id[p] ? pl_hash_of(p) : 0u;
        if (pl_id[p] && !m1_patch_links())
            pl_id[p] = 0;
    }
    pl_rewrite();
    for (t = 0; t < (uint32_t)eng_steps_count(); t++)   /* (the editor follows the tracks that have it) */
        if (eng_pattern_has((uint32_t)eng_steps_module(t), p)) {
            m1_track_pattern_now((uint32_t)eng_steps_module(t), p);
            m1_locks_now((uint32_t)eng_steps_module(t), p);
        }
    m1_pat_link_now(p, pl_id[p], pl_hash[p]);
    return rc;
}

/* the entry after (dir > 0) or before stored id `from` in the store's order (the user entries by id, then the factory
 * ones), round; from 0: the first or the last */
static uint32_t pl_step(uint32_t from, int dir)
{
    pt_info_t in;
    uint32_t last = PL_FACTORY + N_PRESET_PATTERNS - 1u;
    if (dir > 0) {
        if (from >= PL_FACTORY && from < last)
            return from + 1u;
        return pt_next(from < PL_FACTORY ? from : 0u, &in) ? PL_FACTORY : in.id;
    }
    if (from > PL_FACTORY && from <= last)
        return from - 1u;
    return from && from <= PL_FACTORY && !pt_prev(from, &in) ? in.id : last;
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
}

/* the entries (e 0: how many); else the one after `after` (user ids, then factory) as PAT's bytes from its id on */
static uint32_t m1_pat_list(uint32_t after, uint8_t *e)
{
    pt_info_t in;
    uint32_t id, i, k;
    if (!e)
        return pt_count() + N_PRESET_PATTERNS;
    if (after < PL_FACTORY && !pt_next(after, &in))
        id = in.id;
    else if ((id = after < PL_FACTORY ? PL_FACTORY : after + 1u) >= PL_FACTORY + N_PRESET_PATTERNS)
        return 0;
    if (pl_read(id, m1_up, sizeof m1_up, &in))
        return 0;
    for (k = 0; k < 30u; k++)
        e[k] = 0;
    e[0] = (uint8_t)id;
    e[1] = (uint8_t)(id >> 8);
    e[2] = (uint8_t)in.len;
    e[3] = (uint8_t)(in.len >> 8);
    for (k = 0; k < 4u; k++) {
        e[4u + k] = (uint8_t)(in.hash >> (8u * k));
        e[8u + k] = m1_up[1u + k];                    /* (the layout) */
    }
    e[12] = m1_up[5];
    e[13] = id >= PL_FACTORY ? 1u : 0u;
    for (i = 0; i < PT_NAME && in.name[i]; i++)
        e[14u + i] = (uint8_t)in.name[i];
    return id;
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
    uint32_t p, live = 0;
    int rc;
    if (id > PT_ID_MAX)
        return S_RANGE;
    if (!id || pt_stat(id, &in))
        return S_MISSING;
    if (!force && (*count = pl_used(id)) != 0)
        return S_USED;
    if ((rc = pt_del(id)) != 0)
        return rc == -4 ? S_MISSING : S_FLASH;
    for (p = 1; p < ENG_PATTERNS; p++)                 /* (the running patch's links to it: inline from now on, SAVE drops
                                                        * the link) */
        if (pl_id[p] == id) {
            pl_hash[p] = 0;
            live = 1;
        }
    if (live)
        pl_rewrite();
    return S_OK;
}
