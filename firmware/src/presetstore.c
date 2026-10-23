/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The preset store (#194, docs/ledger/vocabulary.md "Preset"): the user's presets on the FM-1, in the 7 flash sectors 0x99000 .. 0x9FFFF
 * that nothing else uses (inside Felucca's data region, which the update loader never erases; the bank's 66 sectors and
 * its settings record are elsewhere: slotstore.c). A preset is the card row values of one structure (structure.ts
 * fingerprint) under a name; the device extras of the patch (format 34) say which values go where.
 *
 * Each sector holds PS_PER_SEC fixed slots of PS_SLOT bytes: a 32-byte header (magic, sequence number, structure, the value
 * count, CRC-16 of the values, the name) and up to PS_MAXV Q16 values. Writing takes a slot that is all 0xFF, programs the
 * values, then the header, then its magic (the commit: a header cut short has none). A replaced or deleted record is
 * killed by programming its magic to 0 (NOR flash only clears bits, so no erase is needed; not yet checked on the FM-1's
 * flash). When no clean slot is left, the sector with the most dead slots is compacted:
 * its live records are copied (new sequence numbers) into clean slots elsewhere, then it is erased; PS_KEEP slots stay
 * free for that, so at most PS_SLOTS - PS_KEEP presets are live. A cut at any point leaves the old record or the new one;
 * the next scan keeps the newest of a (structure, name) and kills the rest. Foreign bytes (another firmware's data) fail
 * the magic or the CRC and are treated as dead. Needs st_read / st_erase / st_prog (storage_hw.c), m1_crc16 (proto.c),
 * fm1_wdt_feed. */
#define PS_BASE 0x99000u
#define PS_NSEC 7u
#define PS_SLOT 384u
#define PS_PER_SEC 10u
#define PS_SLOTS (PS_NSEC * PS_PER_SEC)
#define PS_KEEP PS_PER_SEC              /* clean slots compaction needs: one sector's worth */
#define PS_MAX (PS_SLOTS - PS_KEEP)     /* live presets at most */
#define PS_MAXV 88u                     /* values a preset holds at most ((PS_SLOT - 32) / 4) */
#define PS_NAME 16u
#define PS_MAGIC 0x31535250u            /* "PRS1" */

typedef struct {
    uint32_t magic, seq, structure;
    uint16_t nvals, crc;
    char name[PS_NAME];
} ps_hdr_t;
_Static_assert(sizeof(ps_hdr_t) == 32u, "preset header");
_Static_assert(32u + 4u * PS_MAXV <= PS_SLOT && PS_SLOT * PS_PER_SEC <= 0x1000u, "preset slots");

enum { PS_CLEAN, PS_LIVE, PS_DEAD, PS_BLANK };      /* PS_BLANK: its header is all 0xFF (clean unless a cut write left values: checked before use) */
static uint8_t ps_state[PS_SLOTS];
static uint32_t ps_seq = 1;
static int32_t ps_vbuf[PS_MAXV];
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

/* slot i's header if it holds a valid record (its values into ps_vbuf with check != 0); 0 = valid */
static int ps_check(uint32_t i, ps_hdr_t *h, int check)
{
    if (st_read(ps_addr(i), h, sizeof *h) || h->magic != PS_MAGIC || h->nvals > PS_MAXV)
        return -1;
    if (check && (st_read(ps_addr(i) + 32u, ps_vbuf, 4u * h->nvals) || m1_crc16((const uint8_t *)ps_vbuf, 4u * h->nvals) != h->crc))
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

static void ps_kill(uint32_t i)
{
    static const uint32_t zero = 0;
    (void)st_prog(ps_addr(i), &zero, 4u);
    ps_state[i] = PS_DEAD;
}

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

/* the live slot of (structure, name), -1 none */
static void ps_ensure(void)
{
    if (!ps_scanned)
        ps_scan();
}

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

/* find the records (on the first use after power-on, not at boot: the loading screen stays as quick as before): the newest
 * of each (structure, name) lives, older copies are killed */
static void ps_scan(void)
{
    ps_hdr_t h, o;
    uint32_t i, j;
    ps_scanned = 1;
    ps_seq = 1;
    for (i = 0; i < PS_SLOTS; i++) {
        if ((i % PS_PER_SEC) == 0u)
            fm1_wdt_feed();
        if (!ps_check(i, &h, 1)) {
            ps_state[i] = PS_LIVE;
            if (h.seq >= ps_seq)
                ps_seq = h.seq + 1u;
        } else {
            const uint32_t *w = (const uint32_t *)&h;
            uint32_t k, ff = 1;
            if (st_read(ps_addr(i), &h, sizeof h))
                ff = 0;
            for (k = 0; ff && k < sizeof h / 4u; k++)
                ff = w[k] == 0xFFFFFFFFu;
            ps_state[i] = ff ? PS_BLANK : PS_DEAD;      /* (the whole slot is read only when it is about to be written: boot stays quick) */
        }
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

static int ps_clean_slot(uint32_t avoid_sec)
{
    uint32_t i;
    for (i = 0; i < PS_SLOTS; i++) {
        if (i / PS_PER_SEC == avoid_sec)
            continue;
        if (ps_state[i] == PS_BLANK)                    /* a blank header: the rest must be blank too */
            ps_state[i] = ps_clean(i) ? PS_CLEAN : PS_DEAD;
        if (ps_state[i] == PS_CLEAN)
            return (int)i;
    }
    return -1;
}

/* program a record into the clean slot s: the values, then the header; checked */
static int ps_prog(uint32_t s, uint32_t structure, const char *name, const int32_t *vals, uint32_t n)
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
    ps_state[s] = PS_DEAD;                              /* (whatever happens now, it is no longer clean) */
    if (n && st_prog(ps_addr(s) + 32u, vals, 4u * n))
        return -1;
    if (st_prog(ps_addr(s) + 4u, (const uint8_t *)&h + 4u, sizeof h - 4u)   /* the header, and its magic last: the commit */
        || st_prog(ps_addr(s), &h.magic, 4u) || ps_check(s, &c, 1) || c.seq != h.seq)
        return -1;
    ps_state[s] = PS_LIVE;
    return 0;
}

/* make clean slots: the sector with the most dead slots has its live records moved out, then it is erased */
static int ps_compact(void)
{
    uint32_t sec, best = PS_NSEC, most = 0, k;
    for (sec = 0; sec < PS_NSEC; sec++) {
        uint32_t dead = 0;
        for (k = 0; k < PS_PER_SEC; k++)
            dead += ps_state[sec * PS_PER_SEC + k] == PS_DEAD;
        if (dead > most) {
            most = dead;
            best = sec;
        }
    }
    if (best == PS_NSEC)
        return -1;
    for (k = 0; k < PS_PER_SEC; k++) {
        uint32_t i = best * PS_PER_SEC + k;
        ps_hdr_t h;
        int s;
        if (ps_state[i] != PS_LIVE)
            continue;
        if (ps_check(i, &h, 1) || (s = ps_clean_slot(best)) < 0 || ps_prog((uint32_t)s, h.structure, h.name, ps_vbuf, h.nvals))
            return -1;
        ps_state[i] = PS_DEAD;                          /* (its copy is live: the erase below takes it) */
    }
    fm1_wdt_feed();
    if (st_erase(PS_BASE + best * 0x1000u))
        return -1;
    for (k = 0; k < PS_PER_SEC; k++)
        ps_state[best * PS_PER_SEC + k] = PS_CLEAN;
    return 0;
}

static uint32_t ps_count(uint32_t state)
{
    uint32_t i, n = 0;
    for (i = 0; i < PS_SLOTS; i++)
        n += ps_state[i] == state || (state == PS_CLEAN && ps_state[i] == PS_BLANK);
    return n;
}

/* store a preset (a record of the same structure and name is replaced); 0 = ok, -1 flash, -2 full, -3 too many values.
 * Before it, PS_KEEP clean slots are kept (compacting while there are dead ones), so a compaction always has room. */
static int ps_put(uint32_t structure, const char *name, const int32_t *vals, uint32_t n)
{
    int old = ps_find(structure, name), s;   /* (ps_find scans first) */
    if (n > PS_MAXV)
        return -3;
    if (old < 0 && ps_count(PS_LIVE) >= PS_MAX)
        return -2;
    while (ps_count(PS_CLEAN) <= PS_KEEP && ps_count(PS_DEAD)) {
        if (ps_compact())
            return -1;
        old = ps_find(structure, name);                 /* (compaction moves records) */
    }
    if ((s = ps_clean_slot(PS_NSEC)) < 0)
        return -2;
    if (ps_prog((uint32_t)s, structure, name, vals, n))
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
