/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The bank: M1_SLOTS (64) patch slots and one record of panel settings (id SL_SETTINGS), log-structured over 66 flash
 * sectors of 4 KiB: 0x97000 and 0x98000 (the old patch store) and 0xA0000 .. 0xDFFFF, all in Felucca's data region,
 * which the update loader never erases. A sector holds one record: a 48-byte header (magic, id, sequence number, length,
 * CRC-16, name; written last, so it is the commit) and the data from offset 256.
 * Writing a record (#74) takes a free sector, erases it, programs the data and then the header, checks it, and only then
 * erases the sector of the record it replaces: a cut at any point leaves the old record or the new one (both valid: the
 * higher sequence number wins at the next scan, the other is erased). At most 65 records live in 66 sectors, so one is
 * always free. Records of the 32-slot bank before (magic "M1SL", slot = id) are read as they are.
 * Needs st_read / st_erase / st_prog (storage_hw.c) and m1_crc16 (proto.c). */
#define SL_NSEC 66u
#define SL_MAGIC 0x3253314Du            /* "M1S2" */
#define SL_MAGIC_V1 0x4C53314Du         /* "M1SL": the 32-slot bank (slot n at 0xA0000 + n x 4 KiB) */
#define SL_PAYLOAD 256u
#define SL_SETTINGS M1_SLOTS            /* the record id of the panel settings (main.c) */
#define SL_NONE 0xFFu

typedef struct {
    uint32_t magic, id, seq, len, crc;
    char name[M1_NAME];
    uint32_t rsv[2];
} sl_hdr_t;
_Static_assert(sizeof(sl_hdr_t) == 48u, "slot header");

typedef struct {                         /* the 32-slot bank's header */
    uint32_t magic, slot, len, crc;
    char name[M1_NAME];
    uint32_t rsv[3];
} sl_hdr_v1_t;

static uint8_t sl_buf[M1_PATCH_MAX] ENG_POOL;
static uint8_t sl_sec[SL_SETTINGS + 1];          /* the sector of each record, SL_NONE: none */
static uint8_t sl_live[SL_NSEC];                 /* the sector holds a live record */
static uint32_t sl_seq;                          /* the next sequence number */
static uint32_t sl_next;                         /* where the search for a free sector starts (spreads the wear) */
static uint64_t bank_mask;                       /* bit n: slot n holds a patch */

static uint32_t sl_sector_addr(uint32_t i) { return i < 2u ? 0x97000u + i * 0x1000u : 0xA0000u + (i - 2u) * 0x1000u; }

/* the header of sector i as a record of this store (a 32-slot bank record converted), with check != 0 also its data's
 * CRC (the data go to sl_buf); 0 = a valid record */
static int sl_check(uint32_t i, sl_hdr_t *h, int check)
{
    uint32_t a = sl_sector_addr(i), k;
    if (st_read(a, h, sizeof *h))
        return -1;
    if (h->magic == SL_MAGIC_V1 && i >= 2u && i - 2u < 32u) {
        sl_hdr_v1_t o;
        if (st_read(a, &o, sizeof o) || o.slot != i - 2u)
            return -1;
        h->id = o.slot;
        h->seq = 0;
        h->len = o.len;
        h->crc = o.crc;
        for (k = 0; k < M1_NAME; k++)
            h->name[k] = o.name[k];
    } else if (h->magic != SL_MAGIC || h->id > SL_SETTINGS) {
        return -1;
    }
    if (h->len < 1u || h->len > M1_PATCH_MAX)
        return -1;
    if (check && (st_read(a + SL_PAYLOAD, sl_buf, h->len) || m1_crc16(sl_buf, h->len) != h->crc))
        return -1;
    return 0;
}

/* find the records: the newest valid one of each id; older copies (a write cut after its commit) are erased */
static void sl_scan(void)
{
    sl_hdr_t h, o;
    uint32_t i;
    bank_mask = 0;
    sl_seq = 1;
    for (i = 0; i <= SL_SETTINGS; i++)
        sl_sec[i] = SL_NONE;
    for (i = 0; i < SL_NSEC; i++) {
        fm1_wdt_feed();
        sl_live[i] = 0;
        if (sl_check(i, &h, 1))
            continue;
        if (h.seq >= sl_seq)
            sl_seq = h.seq + 1u;
        if (sl_sec[h.id] != SL_NONE) {
            uint32_t j = sl_sec[h.id];
            (void)sl_check(j, &o, 0);
            if (o.seq >= h.seq) {
                (void)st_erase(sl_sector_addr(i));
                continue;
            }
            (void)st_erase(sl_sector_addr(j));
            sl_live[j] = 0;
        }
        sl_sec[h.id] = (uint8_t)i;
        sl_live[i] = 1;
        if (h.id < M1_SLOTS)
            bank_mask |= (uint64_t)1 << h.id;
    }
}

/* the header of slot (or the settings record) if it is valid; with check != 0 also its data's CRC (data in sl_buf) */
static int sl_head(uint32_t id, sl_hdr_t *h, int check)
{
    if (id > SL_SETTINGS || sl_sec[id] == SL_NONE)
        return -1;
    return sl_check(sl_sec[id], h, check);
}

/* a record into dst (name: M1_NAME + 1 bytes, may be 0); 0 = ok */
static int sl_read(uint32_t id, uint8_t *dst, uint32_t *len, char *name)
{
    sl_hdr_t h;
    uint32_t i;
    if (sl_head(id, &h, 1))
        return -1;
    for (i = 0; i < h.len; i++)
        dst[i] = sl_buf[i];
    *len = h.len;
    if (name) {
        for (i = 0; i < M1_NAME; i++)
            name[i] = h.name[i];
        name[M1_NAME] = 0;
    }
    return 0;
}

static int sl_write(uint32_t id, const char *name, const uint8_t *p, uint32_t len)
{
    sl_hdr_t h, c;
    uint32_t i, s = SL_NONE, old;
    int rc;
    if (id > SL_SETTINGS || len < 1u || len > M1_PATCH_MAX)
        return -1;
    for (i = 0; i < SL_NSEC && s == SL_NONE; i++) {        /* a sector without a live record */
        uint32_t k = (sl_next + i) % SL_NSEC;
        if (!sl_live[k])
            s = k;
    }
    if (s == SL_NONE)
        return -1;
    sl_next = (s + 1u) % SL_NSEC;
    h.magic = SL_MAGIC;
    h.id = id;
    h.seq = sl_seq++;
    h.len = len;
    h.crc = m1_crc16(p, len);
    for (i = 0; i < M1_NAME; i++)
        h.name[i] = name ? name[i] : 0;
    h.rsv[0] = h.rsv[1] = 0;
    rc = st_erase(sl_sector_addr(s));
    if (!rc)
        rc = st_prog(sl_sector_addr(s) + SL_PAYLOAD, p, len);
    if (!rc)
        rc = st_prog(sl_sector_addr(s), (const uint8_t *)&h, sizeof h);   /* the commit record, last */
    if (!rc && (sl_check(s, &c, 1) || c.seq != h.seq))
        rc = -1;
    if (rc)
        return rc;                               /* the old record (if any) is untouched */
    old = sl_sec[id];
    sl_sec[id] = (uint8_t)s;
    sl_live[s] = 1;
    if (old != SL_NONE) {                         /* only now: the replaced record goes */
        (void)st_erase(sl_sector_addr(old));
        sl_live[old] = 0;
    }
    if (id < M1_SLOTS)
        bank_mask |= (uint64_t)1 << id;
    return 0;
}

static int sl_erase(uint32_t id)
{
    int rc = 0;
    if (id > SL_SETTINGS)
        return -1;
    if (sl_sec[id] != SL_NONE) {
        rc = st_erase(sl_sector_addr(sl_sec[id]));
        if (!rc) {
            sl_live[sl_sec[id]] = 0;
            sl_sec[id] = SL_NONE;
        }
    }
    if (!rc && id < M1_SLOTS)
        bank_mask &= ~((uint64_t)1 << id);
    return rc;
}

/* every sector of the store erased (FACTORY RESET): about three seconds */
static void sl_clear_all(void)
{
    uint32_t i;
    for (i = 0; i < SL_NSEC; i++) {
        fm1_wdt_feed();
        (void)st_erase(sl_sector_addr(i));
        sl_live[i] = 0;
    }
    for (i = 0; i <= SL_SETTINGS; i++)
        sl_sec[i] = SL_NONE;
    bank_mask = 0;
}
