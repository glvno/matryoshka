/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The pattern store (#901, option D): the user's stored patterns on the FM-1, which any patch whose tracks they fit can
 * load or link (proto.c, seq_ui.c). It takes the bank's last 4 sectors, 0xDC000 .. 0xDFFFF (slotstore.c sl_sector_addr(62
 * .. 65), inside Felucca's data region, which the update loader never erases); slotstore.c pt_claim hands them over at
 * boot (the bank then has 60 slots) and sets pt_on. While pt_on is 0 every call here refuses (-1, or 0).
 *
 * The store is a log over the 4 sectors. A formatted sector starts with a 16-byte header (the next free id when it was
 * formatted, then the magic PT_SMAGIC, programmed last); records follow, 4-byte aligned: a 36-byte header (magic, a
 * store-wide sequence number, id, length, FNV-1a hash of the payload, CRC-16 of name and payload, the next free id when it
 * was written, the name) and the payload. A record is written at its sector's free tail: the header fields first, then
 * the payload, both checked, and the magic last: the commit. A replaced record is killed (its magic programmed to 0) only
 * after its replacement is committed; a deletion is the same kill. A header whose length is not valid (a write cut in
 * its first bytes) makes the rest of its sector dead; a header with a valid length but no magic (a write cut later) is
 * skipped. Ids are never reused: the next id is above every id, record nextid and sector nextid on the flash.
 *
 * One sector is always kept clean (formatted, no records). When no free tail takes a record, the sector with the fewest
 * live bytes is compacted: its live records are copied into the clean sector (new sequence numbers), then it is erased
 * and formatted, and is the clean one. A cut leaves the old record or the new one; the scan (on the first use after
 * power-on, like the preset store's) finishes what a cut left before anything is written: sectors without a valid header
 * hold no records and are formatted; if no sector is clean (a cut compaction), the sector whose still needed records fit
 * in another sector's free tail has them copied there and is erased and formatted (a record is still needed when it is
 * the newest of its id and no record of the same contents sits in another sector: after a cut during the copies that
 * is the half-filled target, which is erased again); then of each id the newest record lives and older ones are
 * killed. Foreign bytes fail the magic, the CRC (such a record is killed) or the blank check of the free tail (the rest
 * of that sector is dead until it is compacted).
 *
 * The scan, pt_put and pt_read work in slotstore.c's sl_buf (pt_put's payload and pt_read's dst must be other buffers).
 * Needs st_read / st_erase / st_prog (storage_hw.c), m1_crc16 (proto.c), fm1_wdt_feed. Host tests: tools/patstore_test.sh. */
#define PT_BASE 0xDC000u
#define PT_NSEC 4u
#define PT_NAME 16u
#define PT_MAX 2048u                    /* payload bytes at most */
#define PT_ID_MAX 0xDFFFu               /* user ids 1..PT_ID_MAX; 0xE000.. are read-only factory entries (patlink.c) */
#define PT_FNV0 0x811C9DC5u
#define PT_MAGIC 0x31544150u            /* "PAT1": a committed record */
#define PT_SMAGIC 0x31535450u           /* "PTS1": a formatted sector */
#define PT_SEC 0x1000u
#define PT_SHDR 16u                     /* the sector header */
#define PT_HDR 36u                      /* the record header */
#define PT_TAB (PT_NSEC * (PT_SEC - PT_SHDR) / (PT_HDR + 4u))   /* records the 4 sectors hold at most: 408 */

typedef struct {
    uint32_t magic;          /* PT_MAGIC: committed; 0: killed; 0xFFFFFFFF: never committed */
    uint32_t seq;            /* store-wide write sequence */
    uint16_t id, len;        /* id 1..PT_ID_MAX; len = payload bytes 1..PT_MAX */
    uint32_t hash;           /* pt_fnv(PT_FNV0, payload, len) */
    uint16_t crc, nextid;    /* crc: m1_crc16 over name[16] then payload; nextid: the store's next free id when written */
    char name[PT_NAME];      /* zero padded, ASCII */
} pt_hdr_t;                  /* the payload follows, padded to 4 */
_Static_assert(sizeof(pt_hdr_t) == PT_HDR, "pattern header");

typedef struct {
    uint32_t magic;          /* PT_SMAGIC, programmed last */
    uint16_t nextid, rsv;    /* the store's next free id when formatted; rsv stays 0xFFFF */
    uint32_t rsv2[2];        /* 0xFFFFFFFF */
} pt_shdr_t;
_Static_assert(sizeof(pt_shdr_t) == PT_SHDR, "pattern sector header");
_Static_assert(4u * PT_TAB + PT_NAME + PT_MAX <= M1_PATCH_MAX, "the scan's table and one record fit in sl_buf");

typedef struct { uint16_t id, len; uint32_t hash; char name[PT_NAME + 1]; } pt_info_t;

static uint8_t pt_on;                   /* the store is claimed (slotstore.c pt_claim) */
static uint8_t pt_scanned;              /* pt_scan ran (it runs on the first use) */
static uint16_t pt_tail[PT_NSEC];       /* where each sector's next record goes: PT_SHDR clean, PT_SEC no room (full, or
                                         * bytes past its records that are not 0xFF), 0 not formatted */
static uint32_t pt_seq;                 /* the next sequence number */
static uint32_t pt_nextid;              /* the next free id (above PT_ID_MAX: the ids are used up) */
static void pt_scan(void);

static uint32_t pt_fnv(uint32_t h, const void *p, uint32_t n)
{
    const uint8_t *b = p;
    while (n--)
        h = (h ^ *b++) * 0x01000193u;
    return h;
}

static uint32_t pt_size(uint32_t len) { return PT_HDR + ((len + 3u) & ~3u); }
static uint32_t pt_room(uint32_t sec) { return pt_tail[sec] ? PT_SEC - pt_tail[sec] : 0u; }

static void pt_ensure(void)
{
    if (!pt_scanned)
        pt_scan();
}

/* the n bytes at flash address a are those of p; 0 = same */
static int pt_cmp(uint32_t a, const uint8_t *p, uint32_t n)
{
    uint8_t b[32];
    uint32_t k, i;
    for (; n; n -= k, a += k, p += k) {
        k = n < sizeof b ? n : (uint32_t)sizeof b;
        if (st_read(a, b, k))
            return -1;
        for (i = 0; i < k; i++)
            if (b[i] != p[i])
                return -1;
    }
    return 0;
}

/* sector sec from byte off to its end is all 0xFF */
static int pt_blank(uint32_t sec, uint32_t off)
{
    uint8_t b[64];
    uint32_t k, i;
    for (; off < PT_SEC; off += k) {
        k = PT_SEC - off < sizeof b ? PT_SEC - off : (uint32_t)sizeof b;
        if (st_read(PT_BASE + sec * PT_SEC + off, b, k))
            return 0;
        for (i = 0; i < k; i++)
            if (b[i] != 0xFFu)
                return 0;
    }
    return 1;
}

/* sector sec has a valid sector header */
static int pt_sec_ok(uint32_t sec)
{
    pt_shdr_t s;
    return !st_read(PT_BASE + sec * PT_SEC, &s, sizeof s) && s.magic == PT_SMAGIC;
}

/* erase sector sec and write its header: the next free id, then the magic; 0 = ok */
static int pt_format(uint32_t sec)
{
    static const uint32_t m = PT_SMAGIC;
    uint32_t a = PT_BASE + sec * PT_SEC;
    uint16_t id = (uint16_t)pt_nextid;
    pt_tail[sec] = 0;
    fm1_wdt_feed();
    if (st_erase(a) || st_prog(a + 4u, (const uint8_t *)&id, 2u) || st_prog(a, (const uint8_t *)&m, 4u) || !pt_sec_ok(sec)
        || pt_cmp(a + 4u, (const uint8_t *)&id, 2u))
        return -1;
    pt_tail[sec] = PT_SHDR;
    return 0;
}

/* the record header at store offset *loc (sector x 4 KiB + offset) or the next one after it (*loc moves there): a header
 * whose length is valid. One that is not, or the sector's tail, ends that sector's records. 0 = found, -1 no more */
static int pt_iter(uint32_t *loc, pt_hdr_t *h)
{
    for (;;) {
        uint32_t sec = *loc / PT_SEC, off = *loc % PT_SEC;
        if (sec >= PT_NSEC)
            return -1;
        if (off < PT_SHDR)
            off = PT_SHDR;
        *loc = sec * PT_SEC + off;
        if (off + PT_HDR <= pt_tail[sec] && !st_read(PT_BASE + *loc, h, PT_HDR) && h->len >= 1u && h->len <= PT_MAX
            && off + pt_size(h->len) <= PT_SEC)
            return 0;
        *loc = (sec + 1u) * PT_SEC;
    }
}

/* the live record of id (the newest, should a cut have left two): its store offset and header, -1 none */
static int pt_find(uint32_t id, pt_hdr_t *out)
{
    pt_hdr_t h;
    uint32_t loc;
    int at = -1;
    for (loc = 0; !pt_iter(&loc, &h); loc += pt_size(h.len))
        if (h.magic == PT_MAGIC && h.id == id && (at < 0 || h.seq > out->seq)) {
            *out = h;
            at = (int)loc;
        }
    return at;
}

/* the name and payload of the record at loc into buf, checked against its CRC; 0 = ok */
static int pt_load(uint32_t loc, const pt_hdr_t *h, uint8_t *buf)
{
    return st_read(PT_BASE + loc + PT_HDR - PT_NAME, buf, PT_NAME + h->len) || m1_crc16(buf, PT_NAME + h->len) != h->crc
        ? -1 : 0;
}

static int pt_kill(uint32_t loc)
{
    static const uint32_t zero = 0;
    return st_prog(PT_BASE + loc, (const uint8_t *)&zero, 4u);
}

/* program the record h at sector sec's tail: the header fields, the payload (from p, or with p 0 from the flash at
 * address from: a copy, which gets the next sequence number and the next free id), each checked, then the magic; 0 = ok */
static int pt_emit(uint32_t sec, pt_hdr_t *h, const uint8_t *p, uint32_t from)
{
    uint32_t off = pt_tail[sec], a = PT_BASE + sec * PT_SEC + off, n, k, i;
    uint8_t b[32];
    int rc;
    if (!p) {
        h->seq = pt_seq++;
        h->nextid = (uint16_t)pt_nextid;
    }
    pt_tail[sec] = PT_SEC;                              /* (until it is through: what a failure leaves is not clean) */
    rc = st_prog(a + 4u, (const uint8_t *)h + 4u, PT_HDR - 4u) || pt_cmp(a + 4u, (const uint8_t *)h + 4u, PT_HDR - 4u);
    for (n = 0; !rc && n < h->len; n += k) {
        k = h->len - n < sizeof b ? h->len - n : (uint32_t)sizeof b;
        for (i = 0; p && i < k; i++)
            b[i] = p[n + i];
        rc = (!p && st_read(from + n, b, k)) || st_prog(a + PT_HDR + n, b, k) || pt_cmp(a + PT_HDR + n, b, k);
    }
    if (rc || st_prog(a, (const uint8_t *)&h->magic, 4u) || pt_cmp(a, (const uint8_t *)&h->magic, 4u))
        return -1;
    pt_tail[sec] = (uint16_t)(off + pt_size(h->len));
    return 0;
}

static void pt_fill(const pt_hdr_t *h, pt_info_t *out)
{
    uint32_t i;
    if (!out)
        return;
    out->id = h->id;
    out->len = h->len;
    out->hash = h->hash;
    for (i = 0; i < PT_NAME; i++)
        out->name[i] = h->name[i];
    out->name[PT_NAME] = 0;
}

/* the live record bytes in sector sec */
static uint32_t pt_live(uint32_t sec)
{
    pt_hdr_t h;
    uint32_t loc = sec * PT_SEC, n = 0;
    for (; !pt_iter(&loc, &h) && loc / PT_SEC == sec; loc += pt_size(h.len))
        n += h.magic == PT_MAGIC ? pt_size(h.len) : 0u;
    return n;
}

/* a clean sector other than skip, PT_NSEC none */
static uint32_t pt_clean(uint32_t skip)
{
    uint32_t sec;
    for (sec = 0; sec < PT_NSEC; sec++)
        if (sec != skip && pt_tail[sec] == PT_SHDR)
            return sec;
    return PT_NSEC;
}

/* the formatted sector other than skip that is not clean and has the fewest live record bytes (*live), PT_NSEC none */
static uint32_t pt_fewest(uint32_t skip, uint32_t *live)
{
    uint32_t sec, best = PT_NSEC, n;
    *live = PT_SEC;
    for (sec = 0; sec < PT_NSEC; sec++)
        if (sec != skip && pt_tail[sec] > PT_SHDR && (n = pt_live(sec)) < *live) {
            *live = n;
            best = sec;
        }
    return best;
}

/* the sector whose free tail takes r bytes most snugly; the last clean sector is kept. PT_NSEC none */
static uint32_t pt_pick(uint32_t r)
{
    uint32_t sec, best = PT_NSEC;
    for (sec = 0; sec < PT_NSEC; sec++)
        if (pt_room(sec) >= r && (pt_tail[sec] != PT_SHDR || pt_clean(sec) < PT_NSEC)
            && (best == PT_NSEC || pt_room(sec) < pt_room(best)))
            best = sec;
    return best;
}

/* room for a record of r bytes: the sector with the fewest live bytes has them copied into the clean sector, then it is
 * erased and formatted (the clean one now). Before that erase the next free id must be on the flash elsewhere: the
 * copies carry it, else the clean sector is formatted again first if its header is behind. 0 = ok, -2 no sector makes
 * the room, -1 flash */
static int pt_compact(uint32_t r)
{
    pt_hdr_t h;
    pt_shdr_t s;
    uint32_t t = pt_clean(PT_NSEC), live, v = pt_fewest(t, &live), loc, n = 0;
    if (t == PT_NSEC || v == PT_NSEC || PT_SEC - PT_SHDR - live < r)
        return -2;
    for (loc = v * PT_SEC; !pt_iter(&loc, &h) && loc / PT_SEC == v; loc += pt_size(h.len)) {
        if (h.magic != PT_MAGIC)
            continue;
        if (pt_emit(t, &h, 0, PT_BASE + loc + PT_HDR))
            return -1;
        n++;
    }
    if (!n && (st_read(PT_BASE + t * PT_SEC, &s, sizeof s) || s.nextid < pt_nextid) && pt_format(t))
        return -1;
    return pt_format(v);
}

/* the scan's table (in sl_buf): entry k's id and store offset */
static uint32_t pt_get16(const uint8_t *b) { return (uint32_t)b[0] | (uint32_t)b[1] << 8; }
static uint32_t pt_tab_id(uint32_t k) { return pt_get16(sl_buf + 4u * k); }
static uint32_t pt_tab_loc(uint32_t k) { return pt_get16(sl_buf + 4u * k + 2u); }

static int pt_head(uint32_t loc, pt_hdr_t *h) { return st_read(PT_BASE + loc, h, PT_HDR); }

/* table entry k (its header into *h) is still needed: no other record of its id is newer, and (with twins) none of the
 * same contents sits in another sector (pt_finish; pt_dedupe asks without twins). 0 also when its header cannot be read */
static int pt_needed(uint32_t k, uint32_t n, pt_hdr_t *h, int twins)
{
    pt_hdr_t o;
    uint32_t j, i, same;
    if (pt_head(pt_tab_loc(k), h))
        return 0;
    for (j = 0; j < n; j++) {
        if (j == k || pt_tab_id(j) != pt_tab_id(k) || pt_head(pt_tab_loc(j), &o))
            continue;
        same = twins && o.len == h->len && o.hash == h->hash && o.crc == h->crc
            && pt_tab_loc(j) / PT_SEC != pt_tab_loc(k) / PT_SEC;
        for (i = 0; same && i < PT_NAME; i++)
            same = o.name[i] == h->name[i];
        if (o.seq > h->seq || same)
            return 0;
    }
    return 1;
}

/* no sector is clean (a cut compaction): of the sectors whose still needed records fit in another sector's free tail,
 * the one with the fewest has them copied there, then it is erased and formatted. 0 = done (scan again), -1 none fits */
static int pt_finish(uint32_t n)
{
    pt_hdr_t h;
    uint32_t sec, d, k, need, best = PT_NSEC, dest = PT_NSEC, fewest = PT_SEC;
    for (sec = 0; sec < PT_NSEC; sec++) {
        if (!pt_tail[sec])
            continue;
        for (need = 0, k = 0; k < n; k++)
            if (pt_tab_loc(k) / PT_SEC == sec && pt_needed(k, n, &h, 1))
                need += pt_size(h.len);
        for (d = 0; d < PT_NSEC; d++)
            if (d != sec && pt_tail[d] && pt_room(d) >= need && need < fewest) {
                fewest = need;
                best = sec;
                dest = d;
            }
    }
    if (best == PT_NSEC)
        return -1;
    for (k = 0; k < n; k++)
        if (pt_tab_loc(k) / PT_SEC == best && pt_needed(k, n, &h, 1)
            && pt_emit(dest, &h, 0, PT_BASE + pt_tab_loc(k) + PT_HDR))
            return -1;
    return pt_format(best);
}

/* of each id the newest record lives: older ones (a cut before a replaced record was killed) are killed */
static void pt_dedupe(uint32_t n)
{
    pt_hdr_t h;
    uint32_t k;
    for (k = 0; k < n; k++)
        if (!pt_head(pt_tab_loc(k), &h) && !pt_needed(k, n, &h, 0))
            (void)pt_kill(pt_tab_loc(k));
}

static void pt_see_id(uint32_t v)
{
    if (v <= PT_ID_MAX + 1u && v > pt_nextid)
        pt_nextid = v;
}

/* find the records and finish what a cut left (the file's header): on the first use after power-on, not at boot */
static void pt_scan(void)
{
    pt_shdr_t s;
    pt_hdr_t h;
    uint32_t end[PT_NSEC], sec, loc, n, pass;
    pt_scanned = 1;
    for (pass = 0;; pass++) {
        pt_seq = pt_nextid = 1;
        n = 0;
        for (sec = 0; sec < PT_NSEC; sec++) {
            int ok = !st_read(PT_BASE + sec * PT_SEC, &s, sizeof s) && s.magic == PT_SMAGIC;
            pt_tail[sec] = ok ? (uint16_t)PT_SEC : 0u;      /* (pt_iter walks a formatted sector to its end) */
            end[sec] = PT_SHDR;
            if (ok)
                pt_see_id(s.nextid);
        }
        for (loc = 0; !pt_iter(&loc, &h); loc += pt_size(h.len)) {
            end[loc / PT_SEC] = loc % PT_SEC + pt_size(h.len);
            if (h.id <= PT_ID_MAX)
                pt_see_id(h.id + 1u);
            pt_see_id(h.nextid);
            if (h.magic != 0xFFFFFFFFu && h.seq >= pt_seq) /* (a record never committed may have its number half written) */
                pt_seq = h.seq + 1u;
            if (h.magic != PT_MAGIC)
                continue;
            if (h.id < 1u || h.id > PT_ID_MAX || n >= PT_TAB || pt_load(loc, &h, sl_buf + 4u * PT_TAB)) {
                (void)pt_kill(loc);                         /* (foreign bytes) */
                continue;
            }
            sl_buf[4u * n] = (uint8_t)h.id;
            sl_buf[4u * n + 1u] = (uint8_t)(h.id >> 8);
            sl_buf[4u * n + 2u] = (uint8_t)loc;
            sl_buf[4u * n + 3u] = (uint8_t)(loc >> 8);
            n++;
        }
        for (sec = 0; sec < PT_NSEC; sec++) {
            fm1_wdt_feed();
            if (!pt_tail[sec])
                (void)pt_format(sec);                       /* (it holds no records: a cut erase or format) */
            else
                pt_tail[sec] = (uint16_t)(pt_blank(sec, end[sec]) ? end[sec] : PT_SEC);
        }
        if (pt_clean(PT_NSEC) < PT_NSEC || pass == 2u || pt_finish(n))
            break;                                          /* (pt_finish moved records: walk again for a fresh table) */
    }
    pt_dedupe(n);
}

/* the live record of id; 0 = live */
static int pt_stat(uint32_t id, pt_info_t *out)
{
    pt_hdr_t h;
    if (!pt_on)
        return -1;
    pt_ensure();
    if (pt_find(id, &h) < 0)
        return -1;
    pt_fill(&h, out);
    return 0;
}

/* the payload of id into dst (cap bytes); 0 ok, -1 none (or a CRC that fails), -3 longer than cap (out is filled) */
static int pt_read(uint32_t id, uint8_t *dst, uint32_t cap, pt_info_t *out)
{
    pt_hdr_t h;
    uint32_t i;
    int at;
    if (!pt_on)
        return -1;
    pt_ensure();
    at = pt_find(id, &h);
    if (at < 0)
        return -1;
    pt_fill(&h, out);
    if (h.len > cap)
        return -3;
    if (pt_load((uint32_t)at, &h, sl_buf))
        return -1;
    for (i = 0; i < h.len; i++)
        dst[i] = sl_buf[PT_NAME + i];
    return 0;
}

/* store a pattern: *id 0 a new one (its id assigned into *id), else over that live id (the old record is killed once
 * the new one is committed). 0 ok, -1 flash, -2 full, -3 range (len 0 / > PT_MAX / ids used up), -4 missing */
static int pt_put(uint32_t *id, const char *name, const uint8_t *p, uint32_t len)
{
    pt_hdr_t h, o;
    uint32_t i, end, sec, r = pt_size(len);
    int old = -1, rc;
    if (!pt_on)
        return -1;
    pt_ensure();
    if (len < 1u || len > PT_MAX || (!*id && pt_nextid > PT_ID_MAX))
        return -3;
    if (*id && pt_find(*id, &o) < 0)
        return -4;
    sec = pt_pick(r);
    if (sec == PT_NSEC) {
        rc = pt_compact(r);
        if (rc)
            return rc;
        sec = pt_pick(r);
        if (sec == PT_NSEC)
            return -2;
    }
    if (*id)
        old = pt_find(*id, &o);                         /* (compaction moves records) */
    h.magic = PT_MAGIC;
    h.seq = pt_seq++;
    h.id = (uint16_t)(*id ? *id : pt_nextid++);         /* (a new id is taken even if the write fails: never reused) */
    h.len = (uint16_t)len;
    h.hash = pt_fnv(PT_FNV0, p, len);
    h.nextid = (uint16_t)pt_nextid;
    for (i = 0, end = !name; i < PT_NAME; i++) {      /* (the name zero padded, and with the payload into sl_buf for the CRC) */
        end = end || !name[i];
        sl_buf[i] = (uint8_t)(h.name[i] = end ? 0 : name[i]);
    }
    for (i = 0; i < len; i++)
        sl_buf[PT_NAME + i] = p[i];
    h.crc = m1_crc16(sl_buf, PT_NAME + len);
    if (pt_emit(sec, &h, p, 0))
        return -1;
    if (old >= 0)
        (void)pt_kill((uint32_t)old);                   /* only now: the replaced record goes */
    *id = h.id;
    return 0;
}

/* delete id; 0 ok, -4 missing, -1 flash */
static int pt_del(uint32_t id)
{
    pt_hdr_t h;
    int at;
    if (!pt_on)
        return -1;
    pt_ensure();
    at = pt_find(id, &h);
    if (at < 0)
        return -4;
    return pt_kill((uint32_t)at) ? -1 : 0;
}

/* the live records */
static uint32_t pt_count(void)
{
    pt_hdr_t h;
    uint32_t loc, n = 0;
    if (!pt_on)
        return 0;
    pt_ensure();
    for (loc = 0; !pt_iter(&loc, &h); loc += pt_size(h.len))
        n += h.magic == PT_MAGIC;
    return n;
}

/* the live record with the smallest id above from (up) or the largest below it; 0 = found */
static int pt_near(uint32_t from, int up, pt_info_t *out)
{
    pt_hdr_t h, b;
    uint32_t loc;
    int found = 0;
    if (!pt_on)
        return -1;
    pt_ensure();
    for (loc = 0; !pt_iter(&loc, &h); loc += pt_size(h.len))
        if (h.magic == PT_MAGIC && (up ? h.id > from : h.id < from) && (!found || (up ? h.id < b.id : h.id > b.id))) {
            b = h;
            found = 1;
        }
    if (!found)
        return -1;
    pt_fill(&b, out);
    return 0;
}

static int pt_next(uint32_t after, pt_info_t *out) { return pt_near(after, 1, out); }
static int pt_prev(uint32_t before, pt_info_t *out) { return pt_near(before, 0, out); }

/* the largest payload a new pattern can have now (pt_put compacts for it) */
static uint32_t pt_free_bytes(void)
{
    uint32_t c, live, room = 0, sec;
    if (!pt_on)
        return 0;
    pt_ensure();
    c = pt_clean(PT_NSEC);
    if (c == PT_NSEC) {                                 /* (no clean sector, the scan could not make one: the free tails) */
        for (sec = 0; sec < PT_NSEC; sec++)
            if (pt_room(sec) > room)
                room = pt_room(sec);
    } else {
        room = pt_clean(c) < PT_NSEC ? PT_SEC - PT_SHDR : 0u;   /* (a second clean sector) */
        if (pt_fewest(c, &live) < PT_NSEC && PT_SEC - PT_SHDR - live > room)
            room = PT_SEC - PT_SHDR - live;
    }
    return room < PT_HDR + 4u ? 0u : room - PT_HDR > PT_MAX ? PT_MAX : room - PT_HDR;
}

/* the bytes the records take at most (headers included): every sector but the clean one */
static uint32_t pt_total_bytes(void) { return pt_on ? (PT_NSEC - 1u) * (PT_SEC - PT_SHDR) : 0u; }

/* FACTORY RESET (main.c, after slotstore.c sl_clear_all): all 4 sectors erased and formatted, the ids from 1 again */
static void pt_clear_all(void)
{
    uint32_t sec;
    if (!pt_on)
        return;
    pt_seq = pt_nextid = 1;
    pt_scanned = 1;
    for (sec = 0; sec < PT_NSEC; sec++)
        (void)pt_format(sec);
}
