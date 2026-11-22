/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The bank: the patch slots and one record of panel settings (id SL_SETTINGS, 64), log-structured over 66 flash sectors
 * of 4 KiB: 0x97000 and 0x98000 (the old patch store) and 0xA0000 .. 0xDFFFF, all in Felucca's data region, which the
 * update loader never erases. A sector holds one record: a 48-byte header (magic, id, sequence number, length, CRC-16,
 * name; written last, its magic last of all: the commit) and the data from offset 256.
 * Writing a record (#74) takes a free sector, erases it, programs the data and then the header, checks it, and only then
 * erases the sector of the record it replaces: a cut at any point leaves the old record or the new one (both valid: the
 * higher sequence number wins at the next scan, the other is erased). Records of the 32-slot bank before (magic "M1SL",
 * slot = id) are read as they are.
 * The pattern store (patstore.c, #901, #1202) takes the bank's last sectors, and the bank keeps its first ones: in the
 * layout of 1.26 (SL_L48) 48 slots in sectors 0..49 and the store in the last 16 (50..65, 0xD0000 .. 0xDFFFF); in the
 * layout of 1.16 .. 1.25 (SL_L60) 60 slots in sectors 0..61 and the store in the last 4 (62..65, 0xDC000 .. 0xDFFFF). At
 * boot pt_claim takes the 48-slot layout when the bank holds 48 patches or fewer, else the 60-slot one when it holds 60
 * or fewer: the patches of the ids at and above the layout's slots move into the first empty slots below, and the
 * records in the store's sectors move into the bank's. A write takes only the bank's sectors (at most one record more
 * than the slots and the settings record: one is always free). The scan still reads all 66 (records an older firmware
 * wrote there move at the next claim). A bank of more than 60 patches keeps the 64 slots and the 66 sectors (65 records
 * at most), and the store stays off until slots are freed. The ids stay 0..63 (M1_SLOTS) for the records of before.
 * Needs st_read / st_erase / st_prog (storage_hw.c), m1_crc16 (proto.c), and patstore.c after it. */
#define SL_NSEC 66u
typedef struct { uint8_t slots, nsec, pt_nsec; } sl_layout_t;   /* the slots, the bank's sectors (from 0), the store's
                                                                  * sectors (the last of the 66) */
static const sl_layout_t SL_L48 = { 48u, 50u, 16u };            /* 1.26 (#1202): about 60 KB of patterns */
static const sl_layout_t SL_L60 = { 60u, 62u, 4u };             /* 1.16 .. 1.25 (#901): 16 KB of patterns */
#define SL_MAGIC 0x3253314Du            /* "M1S2" */
#define SL_MAGIC_V1 0x4C53314Du         /* "M1SL": the 32-slot bank (slot n at 0xA0000 + n x 4 KiB) */
#define SL_PAYLOAD 256u
#define SL_SETTINGS 64u                 /* the record id of the panel settings (main.c); never the slot count */
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
static uint32_t bank_slots;                      /* the slots there are: 48 (60 in the layout of 1.25) when the pattern
                                                  * store is on, else 64 (proto.c defines it, 64 until pt_claim, ahead of its
                                                  * slot checks) */
static uint32_t sl_nbank = SL_NSEC;              /* the sectors a write may take: the bank's (pt_claim) */
static uint8_t pt_on;                            /* patstore.c's: the pattern store is claimed (pt_claim) */
static uint32_t pt_nsec;                         /* patstore.c's: its sectors, the last pt_nsec of the 66 (pt_claim) */
static int pt_sec_ok(uint32_t sec);              /* patstore.c: store sector sec has a valid header */
static int pt_format(uint32_t sec);              /* patstore.c: erase and format store sector sec */

static uint32_t sl_nalloc(void) { return sl_nbank; }
/* the layout l from now on (its slots, the sectors a write may take, the store's sectors; the store stays off until the
 * claim sets pt_on), 0 the 64 slots without a store */
static void sl_layout(const sl_layout_t *l)
{
    bank_slots = l ? l->slots : M1_SLOTS;
    sl_nbank = l ? l->nsec : SL_NSEC;
    pt_nsec = l ? l->pt_nsec : 0u;
}

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
#if FELUCCA_DEVICE_IDENTITY
    if (h->id == SL_SETTINGS && !di_record_valid((const uint8_t *)h->name)) return -1;
#endif
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

/* the settings record's extension (main.c settings_ext, #1107): its own bytes at this offset of the data, past the
 * record's 16, in the same sector. sl_write_ext programs them with the data, before the header (the commit), so they
 * stand or fall with the record. A firmware before it reads only the record's len bytes and writes no extension: its
 * own settings record has none (the erased flash reads 0xFF) */
#define SL_EXT_AT 3776u
#define SL_EXT_MAX 64u
static int sl_write_ext(uint32_t id, const char *name, const uint8_t *p, uint32_t len, const uint8_t *ext, uint32_t extn)
{
    sl_hdr_t h, c;
    uint32_t i, s = SL_NONE, old, n = sl_nalloc();
    int rc;
    if (id > SL_SETTINGS || len < 1u || len > M1_PATCH_MAX || extn > SL_EXT_MAX || (extn && len > SL_EXT_AT))
        return -1;
    for (i = 0; i < n && s == SL_NONE; i++) {               /* a sector without a live record */
        uint32_t k = (sl_next + i) % n;
        if (!sl_live[k])
            s = k;
    }
    if (s == SL_NONE)
        return -1;
    sl_next = (s + 1u) % n;
    h.magic = SL_MAGIC;
    h.id = id;
    h.seq = sl_seq++;
    h.len = len;
    h.crc = m1_crc16(p, len);
    for (i = 0; i < M1_NAME; i++)
        h.name[i] = name ? name[i] : 0;
    h.rsv[0] = h.rsv[1] = 0;
#if FELUCCA_DEVICE_IDENTITY
    if (id == SL_SETTINGS) di_pack((uint8_t *)h.name);
#endif
    rc = st_erase(sl_sector_addr(s));
    if (!rc)
        rc = st_prog(sl_sector_addr(s) + SL_PAYLOAD, p, len);
    if (!rc && extn)
        rc = st_prog(sl_sector_addr(s) + SL_PAYLOAD + SL_EXT_AT, ext, extn);
    if (!rc)                                     /* the commit record, last: its fields, then the magic (a cut in the
                                                  * fields leaves no magic, not a valid record with half a name) */
        rc = st_prog(sl_sector_addr(s) + 4u, (const uint8_t *)&h + 4u, sizeof h - 4u);
    if (!rc)
        rc = st_prog(sl_sector_addr(s), (const uint8_t *)&h, 4u);
    if (!rc && (sl_check(s, &c, 1) || c.seq != h.seq))
        rc = -1;
    if (rc)
        return rc;                               /* the old record (if any) is untouched */
#ifdef DEVICE_IDENTITY_COMMIT
    if (id == SL_SETTINGS) DEVICE_IDENTITY_COMMIT();
#endif
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

static int sl_write(uint32_t id, const char *name, const uint8_t *p, uint32_t len)
{
    return sl_write_ext(id, name, p, len, 0, 0u);
}

/* n bytes of record id's extension (sl_write_ext) into out, as the flash holds them (0xFF where none was written); 0 = ok */
static int sl_ext(uint32_t id, uint8_t *out, uint32_t n)
{
    sl_hdr_t h;
    if (n > SL_EXT_MAX || sl_head(id, &h, 0))
        return -1;
    return st_read(sl_sector_addr(sl_sec[id]) + SL_PAYLOAD + SL_EXT_AT, out, n) ? -1 : 0;
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

/* the bank's sectors erased (FACTORY RESET): about three seconds. The bank is empty then, so the pattern store takes the
 * sectors of the 48-slot layout (main.c's pt_clear_all formats them next); while the store was off or smaller they held
 * bank records and are erased here too */
static void sl_clear_all(void)
{
    uint32_t i, n = sl_nalloc();
    for (i = 0; i < n; i++) {
        fm1_wdt_feed();
        (void)st_erase(sl_sector_addr(i));
        sl_live[i] = 0;
    }
    for (i = 0; i <= SL_SETTINGS; i++)
        sl_sec[i] = SL_NONE;
    bank_mask = 0;
    sl_layout(&SL_L48);
    pt_on = 1;
}

/* record `from` written again as id `to` (into a free sector of the bank's), then the old one erased */
static int sl_move(uint32_t from, uint32_t to)
{
    uint32_t len;
    char name[M1_NAME + 1];
    if (sl_read(from, sl_buf, &len, name) || sl_write(to, name, sl_buf, len))
        return -1;
    return from == to ? 0 : sl_erase(from);
}

/* the slot below `below` that holds the same patch as h (length, CRC and name: a cut moved it but left the old id), else
 * the first empty one; `below` none */
static uint32_t sl_twin(const sl_hdr_t *h, uint32_t below)
{
    sl_hdr_t o;
    uint32_t s, k;
    for (s = 0; s < below; s++) {
        if (sl_head(s, &o, 0) || o.len != h->len || o.crc != h->crc)
            continue;
        for (k = 0; k < M1_NAME && o.name[k] == h->name[k]; k++)
            ;
        if (k == M1_NAME)
            return s;
    }
    for (s = 0; s < below && (bank_mask >> s & 1u); s++)
        ;
    return s;
}

/* the patches the bank holds, with layout l's slots (one at or above them with a twin below counts once) */
static uint32_t sl_count(uint32_t slots)
{
    sl_hdr_t h;
    uint32_t id, s, n = 0;
    for (id = 0; id < M1_SLOTS; id++)
        if ((bank_mask >> id & 1u) && (id < slots || sl_head(id, &h, 0) || (s = sl_twin(&h, slots)) == slots
                                       || !(bank_mask >> s & 1u)))
            n++;
    return n;
}

/* boot, after sl_scan and before the factory patches are placed (main.c): the layout the bank's patches fit, 48 slots or
 * else 60 (the header comment). The patches of the ids at and above its slots move into the first empty slots below (a
 * twin there: a cut after the copy; only the old id is erased), the records in the sectors past the bank's move into
 * the bank's, and each store sector that holds no bank record and no valid store header is formatted (a store of 1.25
 * keeps its 4 sectors and their records: they are the last 4 of the larger store). Every step is an sl_write and an
 * erase, so a cut leaves what this finishes at the next boot. More than 60 patches: nothing moves, the store stays off
 * (bank_slots 64) */
static void pt_claim(void)
{
    const sl_layout_t *l = sl_count(SL_L48.slots) <= SL_L48.slots ? &SL_L48 : sl_count(SL_L60.slots) <= SL_L60.slots ? &SL_L60 : 0;
    sl_hdr_t h;
    uint32_t id, s;
    pt_on = 0;
    sl_layout(l);                                        /* (from here sl_write takes the bank's sectors only) */
    if (!l)
        return;
    for (id = l->slots; id < M1_SLOTS; id++) {
        if (sl_head(id, &h, 0))
            continue;
        s = sl_twin(&h, l->slots);
        if (s == l->slots || ((bank_mask >> s & 1u) ? sl_erase(id) : sl_move(id, s)))
            goto off;
    }
    for (id = 0; id <= SL_SETTINGS; id++)
        if (sl_sec[id] != SL_NONE && sl_sec[id] >= l->nsec && sl_move(id, id))
            goto off;
    for (s = SL_NSEC - l->pt_nsec; s < SL_NSEC; s++)
        if (!sl_live[s] && !pt_sec_ok(s - (SL_NSEC - l->pt_nsec)) && pt_format(s - (SL_NSEC - l->pt_nsec)))
            goto off;
    pt_on = 1;
    return;
off:
    sl_layout(0);
}
