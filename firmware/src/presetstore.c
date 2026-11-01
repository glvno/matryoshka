/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The preset store (#194, docs/ledger/vocabulary.md "Preset"): the user's presets on the FM-1, in the 7 flash sectors 0x99000 .. 0x9FFFF
 * that nothing else uses (inside Felucca's data region, which the update loader never erases; the bank's 66 sectors and
 * its settings record are elsewhere: slotstore.c). A preset is the card row values of one structure (structure.ts
 * fingerprint) under a name; the device extras of the patch (format 34) say which values go where.
 *
 * Each sector holds PS_PER_SEC fixed slots of PS_SLOT bytes: a 32-byte header (magic, sequence number, structure, the value
 * count, CRC-16 of the values, the name) and up to PS_SLOTV Q16 values. A record of more values (up to PS_MAXV: Cassia 1's
 * 118 rows, #485, D-285) takes two slots of one sector: its first slot holds the header (the count and CRC of all its
 * values) and the first PS_SLOTV values, the second the rest under a header of its own (magic PS_TAILM, the record's
 * sequence number, structure and name, its own count and CRC). Writing takes clean slots (all 0xFF; the sector with the
 * fewest that still fits, so clean slots stay together for pairs) and programs the second slot first (values, header,
 * magic: checked), then the first slot's values, header, and its magic last: the commit of both. A header cut short has no
 * magic; a second slot whose first slot never got its magic is an orphan, killed at the next scan. A replaced or deleted
 * record is killed by programming its magic to 0, its second slot's too (NOR flash only clears bits, so no erase is
 * needed; not yet checked on the FM-1's flash). When fewer than PS_KEEP clean slots would be left, the sector with the
 * most dead slots is compacted: its live records are copied whole, both slots of a pair together (new sequence numbers),
 * into clean slots elsewhere, then it is erased; PS_KEEP slots stay free for that, so at most PS_MAX slots are live (a
 * two-slot preset counts two). A cut at any point leaves the old record or the new one; the next scan keeps the newest of
 * a (structure, name) and kills the rest. Foreign bytes (another firmware's data) fail the magic or the CRC and are
 * treated as dead. Records of one slot are written as before the pairs (a store from older firmware reads as it is); older
 * firmware sees a two-slot record as dead. Needs st_read / st_erase / st_prog (storage_hw.c), m1_crc16 (proto.c),
 * fm1_wdt_feed. Host tests: tools/preset_test.sh. */
#ifndef ENG_POOL
#define ENG_POOL                        /* (modular.c: the pool section; the host tests: plain RAM) */
#endif
#define PS_BASE 0x99000u
#define PS_NSEC 7u
#define PS_SLOT 384u
#define PS_PER_SEC 10u
#define PS_SLOTS (PS_NSEC * PS_PER_SEC)
#define PS_KEEP PS_PER_SEC              /* clean slots compaction needs: one sector's worth */
#define PS_MAX (PS_SLOTS - PS_KEEP)     /* live slots at most (a two-slot preset counts two) */
#define PS_SLOTV 88u                    /* values one slot holds ((PS_SLOT - 32) / 4) */
#define PS_MAXV (2u * PS_SLOTV)         /* values a preset holds at most: two slots (#485) */
#define PS_NAME 16u
#define PS_MAGIC 0x31535250u            /* "PRS1": a record's (first) slot */
#define PS_TAILM 0x32535250u            /* "PRS2": the second slot of a record of more than PS_SLOTV values */
#define PS_NONE 0xFFu                   /* ps_link: no second slot */

typedef struct {
    uint32_t magic, seq, structure;
    uint16_t nvals, crc;
    char name[PS_NAME];
} ps_hdr_t;
_Static_assert(sizeof(ps_hdr_t) == 32u, "preset header");
_Static_assert(32u + 4u * PS_SLOTV <= PS_SLOT && PS_SLOT * PS_PER_SEC <= 0x1000u, "preset slots");

enum { PS_CLEAN, PS_LIVE, PS_DEAD, PS_BLANK, PS_TAIL };  /* PS_BLANK: its header is all 0xFF (clean unless a cut write left
                                                         * values: checked before use); PS_TAIL: a live record's second slot */
static uint8_t ps_state[PS_SLOTS];
static uint8_t ps_link[PS_SLOTS];               /* a live record's second slot, PS_NONE none */
static uint32_t ps_seq = 1;
static int32_t ps_vbuf[PS_MAXV] ENG_POOL;      /* (in the pool: RAM proper is short, #485) */
static uint8_t ps_scanned;                      /* ps_scan ran (it runs on the first use) */
static void ps_scan(void);

static uint32_t ps_addr(uint32_t i) { return PS_BASE + (i / PS_PER_SEC) * 0x1000u + (i % PS_PER_SEC) * PS_SLOT; }

static int ps_name_eq(const char *a, const char *b)        /* in any case (ps_name_cmp) */
{
    uint32_t i;
    for (i = 0; i < PS_NAME; i++) {
        if ((a[i] >= 'a' && a[i] <= 'z' ? a[i] - 32 : a[i]) != (b[i] >= 'a' && b[i] <= 'z' ? b[i] - 32 : b[i]))
            return 0;
        if (!a[i])
            return 1;
    }
    return 1;
}

/* slot t is the second slot of the record whose first slot's header is h: its own header matches */
static int ps_tail_of(uint32_t t, const ps_hdr_t *h)
{
    ps_hdr_t th;
    return t < PS_SLOTS && !st_read(ps_addr(t), &th, sizeof th) && th.magic == PS_TAILM && th.seq == h->seq
        && th.structure == h->structure && h->nvals > PS_SLOTV && th.nvals == h->nvals - PS_SLOTV;
}

/* slot i's header if it holds a valid record (its values into ps_vbuf with check != 0, from both slots of a pair: the CRC
 * covers them all); 0 = valid. A record of two slots needs its second (ps_link, set by ps_scan / ps_prog). */
static int ps_check(uint32_t i, ps_hdr_t *h, int check)
{
    uint32_t n1;
    if (st_read(ps_addr(i), h, sizeof *h) || h->magic != PS_MAGIC || h->nvals > PS_MAXV)
        return -1;
    if (h->nvals > PS_SLOTV && (ps_link[i] >= PS_SLOTS || (check && !ps_tail_of(ps_link[i], h))))
        return -1;
    if (!check)
        return 0;
    n1 = h->nvals > PS_SLOTV ? PS_SLOTV : h->nvals;
    if (st_read(ps_addr(i) + 32u, ps_vbuf, 4u * n1)
        || (h->nvals > n1 && st_read(ps_addr(ps_link[i]) + 32u, ps_vbuf + n1, 4u * (h->nvals - n1)))
        || m1_crc16((const uint8_t *)ps_vbuf, 4u * h->nvals) != h->crc)
        return -1;
    return 0;
}

/* slot i is all 0xFF (nothing was ever programmed into it since the erase) */
static int ps_clean(uint32_t i)
{
    uint32_t w[PS_SLOT / 4u], k;
    if (st_read(ps_addr(i), w, sizeof w))
        return 0;
    for (k = 0; k < PS_SLOT / 4u; k++)
        if (w[k] != 0xFFFFFFFFu)
            return 0;
    return 1;
}

static void ps_kill_slot(uint32_t i)
{
    static const uint32_t zero = 0;
    (void)st_prog(ps_addr(i), &zero, 4u);
    ps_state[i] = PS_DEAD;
}

/* kill the record in slot i: its magic, then its second slot's (a cut between them leaves an orphan the next scan kills) */
static void ps_kill(uint32_t i)
{
    uint32_t t = ps_link[i];
    ps_kill_slot(i);
    ps_link[i] = PS_NONE;
    if (t < PS_SLOTS)
        ps_kill_slot(t);
}

/* the slots the record in slot i takes */
static uint32_t ps_size(uint32_t i) { return ps_link[i] < PS_SLOTS ? 2u : 1u; }

static int ps_name_cmp(const char *a, const char *b)       /* in any case: the panel writes capitals, the editor need not */
{
    uint32_t i;
    for (i = 0; i < PS_NAME; i++) {
        int x = a[i] >= 'a' && a[i] <= 'z' ? a[i] - 32 : a[i], y = b[i] >= 'a' && b[i] <= 'z' ? b[i] - 32 : b[i];
        if (x != y)
            return x - y;
        if (!a[i])
            return 0;
    }
    return 0;
}

static void ps_ensure(void)
{
    if (!ps_scanned)
        ps_scan();
}

/* the live slot of (structure, name), -1 none */
static int ps_find(uint32_t structure, const char *name)
{
    ps_ensure();
    ps_hdr_t h;
    uint32_t i;
    for (i = 0; i < PS_SLOTS; i++)
        if (ps_state[i] == PS_LIVE && !ps_check(i, &h, 0) && h.structure == structure && ps_name_eq(h.name, name))
            return (int)i;
    return -1;
}

/* find the records (on the first use after power-on, not at boot: the loading screen stays as quick as before): a record
 * of two slots lives with its second slot (same sequence number); second slots no record claims are killed; the newest of
 * each (structure, name) lives, older copies are killed */
static void ps_scan(void)
{
    static uint32_t tseq[PS_SLOTS] ENG_POOL;        /* a candidate second slot's sequence number */
    ps_hdr_t h, o;
    uint32_t i, j;
    ps_scanned = 1;
    ps_seq = 1;
    for (i = 0; i < PS_SLOTS; i++) {
        const uint32_t *w = (const uint32_t *)&h;
        uint32_t k, ff = 1;
        if ((i % PS_PER_SEC) == 0u)
            fm1_wdt_feed();
        ps_link[i] = PS_NONE;
        if (st_read(ps_addr(i), &h, sizeof h))
            h.magic = 0, ff = 0;
        for (k = 0; ff && k < sizeof h / 4u; k++)
            ff = w[k] == 0xFFFFFFFFu;
        if (h.magic == PS_MAGIC)
            ps_state[i] = PS_LIVE;                  /* (a candidate: checked below, once second slots are known) */
        else if (h.magic == PS_TAILM) {
            ps_state[i] = PS_TAIL;
            tseq[i] = h.seq;
            if (h.seq >= ps_seq)                    /* (an orphan's number is never taken again) */
                ps_seq = h.seq + 1u;
        } else
            ps_state[i] = ff ? PS_BLANK : PS_DEAD;  /* (the whole slot is read only when it is about to be written: boot stays quick) */
    }
    for (i = 0; i < PS_SLOTS; i++) {
        if (ps_state[i] != PS_LIVE)
            continue;
        if (!st_read(ps_addr(i), &h, sizeof h) && h.nvals > PS_SLOTV && h.nvals <= PS_MAXV)
            for (j = 0; j < PS_SLOTS; j++)
                if (ps_state[j] == PS_TAIL && tseq[j] == h.seq && ps_tail_of(j, &h)) {
                    ps_link[i] = (uint8_t)j;
                    break;
                }
        if (ps_check(i, &h, 1)) {
            ps_state[i] = PS_DEAD;
            ps_link[i] = PS_NONE;
        } else if (h.seq >= ps_seq)
            ps_seq = h.seq + 1u;
    }
    for (j = 0; j < PS_SLOTS; j++) {                    /* second slots no live record claims (a write cut before its commit) */
        uint32_t claimed = 0;
        if (ps_state[j] != PS_TAIL)
            continue;
        for (i = 0; i < PS_SLOTS && !claimed; i++)
            claimed = ps_state[i] == PS_LIVE && ps_link[i] == j;
        if (!claimed)
            ps_kill_slot(j);
    }
    for (i = 0; i < PS_SLOTS; i++) {                    /* duplicates (a write cut before the old one was killed) */
        if (ps_state[i] != PS_LIVE || ps_check(i, &h, 0))
            continue;
        for (j = i + 1u; j < PS_SLOTS; j++)
            if (ps_state[j] == PS_LIVE && !ps_check(j, &o, 0) && o.structure == h.structure && ps_name_eq(o.name, h.name)) {
                if (o.seq > h.seq) {
                    ps_kill(i);
                    break;
                }
                ps_kill(j);
            }
    }
}

/* `need` (1 or 2) clean slots of one sector, not sector avoid_sec, into out: from the sector with the fewest clean slots
 * that has enough (so the clean slots stay together and a pair finds two); 0 = found */
static int ps_alloc(uint32_t need, uint32_t avoid_sec, uint32_t *out)
{
    for (;;) {
        uint32_t sec, best = PS_NSEC, fewest = PS_PER_SEC + 1u, k, got = 0;
        for (sec = 0; sec < PS_NSEC; sec++) {
            uint32_t c = 0;
            if (sec == avoid_sec)
                continue;
            for (k = 0; k < PS_PER_SEC; k++)
                c += ps_state[sec * PS_PER_SEC + k] == PS_CLEAN || ps_state[sec * PS_PER_SEC + k] == PS_BLANK;
            if (c >= need && c < fewest) {
                fewest = c;
                best = sec;
            }
        }
        if (best == PS_NSEC)
            return -1;
        for (k = 0; k < PS_PER_SEC && got < need; k++) {
            uint32_t i = best * PS_PER_SEC + k;
            if (ps_state[i] == PS_BLANK)                /* a blank header: the rest must be blank too */
                ps_state[i] = ps_clean(i) ? PS_CLEAN : PS_DEAD;
            if (ps_state[i] == PS_CLEAN)
                out[got++] = i;
        }
        if (got == need)
            return 0;
        /* (a blank header over programmed values: that slot is dead now; look again) */
    }
}

/* the bytes at flash address a are those of p (n bytes); 0 = same */
static int ps_same(uint32_t a, const void *p, uint32_t n)
{
    uint8_t b[64];
    const uint8_t *q = p;
    while (n) {
        uint32_t k = n < sizeof b ? n : (uint32_t)sizeof b, i;
        if (st_read(a, b, k))
            return -1;
        for (i = 0; i < k; i++)
            if (b[i] != q[i])
                return -1;
        a += k;
        q += k;
        n -= k;
    }
    return 0;
}

/* program one slot: the values, the header, and its magic last; checked */
static int ps_prog_slot(uint32_t s, const ps_hdr_t *h, const int32_t *vals, uint32_t n)
{
    ps_state[s] = PS_DEAD;                              /* (whatever happens now, it is no longer clean) */
    if (n && st_prog(ps_addr(s) + 32u, vals, 4u * n))
        return -1;
    if (st_prog(ps_addr(s) + 4u, (const uint8_t *)h + 4u, sizeof *h - 4u) || st_prog(ps_addr(s), &h->magic, 4u))
        return -1;
    return ps_same(ps_addr(s), h, sizeof *h) || ps_same(ps_addr(s) + 32u, vals, 4u * n) ? -1 : 0;
}

/* program a record into the clean slot s (and t, a clean slot of the same sector, for more than PS_SLOTV values): the
 * second slot first, then the first slot, whose magic commits both; checked. vals may be ps_vbuf. */
static int ps_prog(uint32_t s, uint32_t t, uint32_t structure, const char *name, const int32_t *vals, uint32_t n)
{
    ps_hdr_t h, c;
    uint32_t i;
    h.magic = PS_MAGIC;
    h.seq = ps_seq++;
    h.structure = structure;
    h.nvals = (uint16_t)n;
    h.crc = m1_crc16((const uint8_t *)vals, 4u * n);
    for (i = 0; i < PS_NAME; i++)
        h.name[i] = 0;
    for (i = 0; i < PS_NAME && name[i]; i++)
        h.name[i] = name[i];
    ps_link[s] = PS_NONE;
    if (n > PS_SLOTV) {
        ps_hdr_t th = h;
        th.magic = PS_TAILM;
        th.nvals = (uint16_t)(n - PS_SLOTV);
        th.crc = m1_crc16((const uint8_t *)(vals + PS_SLOTV), 4u * (n - PS_SLOTV));
        if (ps_prog_slot(t, &th, vals + PS_SLOTV, n - PS_SLOTV))
            return -1;
        ps_link[s] = (uint8_t)t;
    }
    if (ps_prog_slot(s, &h, vals, n > PS_SLOTV ? PS_SLOTV : n) || ps_check(s, &c, 1) || c.seq != h.seq) {
        ps_link[s] = PS_NONE;
        return -1;
    }
    ps_state[s] = PS_LIVE;
    if (n > PS_SLOTV)
        ps_state[t] = PS_TAIL;
    return 0;
}

/* the live records with a slot in sector sec */
static int ps_in(uint32_t i, uint32_t sec)
{
    return ps_state[i] == PS_LIVE && (i / PS_PER_SEC == sec || (ps_link[i] < PS_SLOTS && ps_link[i] / PS_PER_SEC == sec));
}

/* sector sec's live records fit into the clean slots of the other sectors, placed as ps_alloc will place them (the
 * sector with the fewest clean slots that has enough; a pair's two in one sector): compacting it cannot stop half way
 * for want of room. Called with no PS_BLANK slots left (ps_put). */
static int ps_fits(uint32_t sec)
{
    uint32_t c[PS_NSEC], i, k;
    for (k = 0; k < PS_NSEC; k++) {
        c[k] = 0;
        for (i = 0; k != sec && i < PS_PER_SEC; i++)
            c[k] += ps_state[k * PS_PER_SEC + i] == PS_CLEAN;
    }
    for (i = 0; i < PS_SLOTS; i++) {
        uint32_t need, best = PS_NSEC;
        if (!ps_in(i, sec))
            continue;
        need = ps_size(i);
        for (k = 0; k < PS_NSEC; k++)
            if (c[k] >= need && (best == PS_NSEC || c[k] < c[best]))
                best = k;
        if (best == PS_NSEC)
            return 0;
        c[best] -= need;
    }
    return 1;
}

/* make clean slots: of the sectors whose live records fit elsewhere, the one with the most dead slots has them moved out
 * (a pair's two slots together), then it is erased; -2 none fits (the store is full), -1 flash */
static int ps_compact(void)
{
    uint32_t sec, best = PS_NSEC, most = 0, k, i;
    for (sec = 0; sec < PS_NSEC; sec++) {
        uint32_t dead = 0;
        for (k = 0; k < PS_PER_SEC; k++)
            dead += ps_state[sec * PS_PER_SEC + k] == PS_DEAD;
        if (dead > most && ps_fits(sec)) {
            most = dead;
            best = sec;
        }
    }
    if (best == PS_NSEC)
        return -2;
    for (i = 0; i < PS_SLOTS; i++) {
        ps_hdr_t h;
        uint32_t s[2], t;
        if (!ps_in(i, best))
            continue;
        if (ps_check(i, &h, 1) || ps_alloc(ps_size(i), best, s) || ps_prog(s[0], s[1], h.structure, h.name, ps_vbuf, h.nvals))
            return -1;
        t = ps_link[i];
        if (i / PS_PER_SEC != best || (t < PS_SLOTS && t / PS_PER_SEC != best))
            ps_kill(i);                                 /* (a slot outside the sector: killed; the two slots of a pair
                                                         * always share one, so only a store written otherwise has this) */
        else {
            ps_state[i] = PS_DEAD;                      /* (its copy is live: the erase below takes it) */
            ps_link[i] = PS_NONE;
            if (t < PS_SLOTS)
                ps_state[t] = PS_DEAD;
        }
    }
    fm1_wdt_feed();
    if (st_erase(PS_BASE + best * 0x1000u))
        return -1;
    for (k = 0; k < PS_PER_SEC; k++) {
        ps_state[best * PS_PER_SEC + k] = PS_CLEAN;
        ps_link[best * PS_PER_SEC + k] = PS_NONE;
    }
    return 0;
}

static uint32_t ps_count(uint32_t state)
{
    uint32_t i, n = 0;
    for (i = 0; i < PS_SLOTS; i++)
        n += ps_state[i] == state || (state == PS_CLEAN && ps_state[i] == PS_BLANK) || (state == PS_LIVE && ps_state[i] == PS_TAIL);
    return n;
}

/* store a preset (a record of the same structure and name is replaced); 0 = ok, -1 flash, -2 full, -3 too many values.
 * Before it, PS_KEEP clean slots beyond the record's are kept (compacting while there are dead ones), so a compaction
 * always has room. ps_count(PS_LIVE) counts slots: a preset of more than PS_SLOTV values takes two. */
static int ps_put(uint32_t structure, const char *name, const int32_t *vals, uint32_t n)
{
    int old = ps_find(structure, name);  /* (ps_find scans first) */
    uint32_t need = n > PS_SLOTV ? 2u : 1u, s[2], i;
    if (n > PS_MAXV)
        return -3;
    if (ps_count(PS_LIVE) + need > PS_MAX + (old < 0 ? 0u : ps_size((uint32_t)old)))
        return -2;
    for (i = 0; i < PS_SLOTS; i++)                      /* blank headers over values (a cut write) are not clean: known
                                                         * before the clean slots are counted (each slot read once a boot) */
        if (ps_state[i] == PS_BLANK)
            ps_state[i] = ps_clean(i) ? PS_CLEAN : PS_DEAD;
    while (ps_count(PS_CLEAN) < PS_KEEP + need && ps_count(PS_DEAD)) {
        int rc = ps_compact();
        if (rc == -2)
            break;                                      /* (none fits: what clean slots there are take it, if enough) */
        if (rc)
            return -1;
        old = ps_find(structure, name);                 /* (compaction moves records) */
    }
    if (ps_alloc(need, PS_NSEC, s))
        return -2;
    if (ps_prog(s[0], s[1], structure, name, vals, n))
        return -1;
    if (old >= 0)
        ps_kill((uint32_t)old);                         /* only now: the replaced record goes */
    return 0;
}

/* delete a preset; 0 = ok, -1 none */
static int ps_del(uint32_t structure, const char *name)
{
    int i = ps_find(structure, name);
    if (i < 0)
        return -1;
    ps_kill((uint32_t)i);
    return 0;
}

/* the live presets of a structure (structure 0: every one), in name order: how many; with out != 0 their slots, at most max */
static uint32_t ps_list(uint32_t structure, uint8_t *out, uint32_t max)
{
    uint32_t i, n = 0, k;
    ps_hdr_t h, o;
    ps_ensure();
    for (i = 0; i < PS_SLOTS; i++) {
        if (ps_state[i] != PS_LIVE || ps_check(i, &h, 0) || (structure && h.structure != structure))
            continue;
        if (out && n < max) {                           /* insertion by name */
            for (k = n; k > 0 && !ps_check(out[k - 1u], &o, 0) && ps_name_cmp(o.name, h.name) > 0; k--)
                out[k] = out[k - 1u];
            out[k] = (uint8_t)i;
        }
        n++;
    }
    return n;
}

/* slot i's record: its structure, name (PS_NAME + 1 bytes) and values (ps_vbuf); 0 = ok */
static int ps_read(uint32_t i, uint32_t *structure, char *name, uint32_t *n)
{
    ps_hdr_t h;
    uint32_t k;
    ps_ensure();
    if (i >= PS_SLOTS || ps_state[i] != PS_LIVE || ps_check(i, &h, 1))
        return -1;
    *structure = h.structure;
    *n = h.nvals;
    for (k = 0; k < PS_NAME; k++)
        name[k] = h.name[k];
    name[PS_NAME] = 0;
    return 0;
}
