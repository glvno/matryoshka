/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The factory content in two tiers (#915, D-179 amended 2026-11-15, docs/ledger/patch-format.md D-1020, link commands
 * D-490).
 *
 * The firmware tier is compiled in (factory_tier.h FC_TIER, web/src/factory-tiers.ts FIRMWARE_TIER) and always plays: the
 * factory patches unlikely to change, and the user preset migrations (presetmig.c). The factory region holds the rest: the
 * other factory patches, every factory engine preset, the factory drum patterns, and a copy of any firmware-tier patch
 * fixed since that firmware shipped. It lives in the 18 flash sectors 0xEA000 .. 0xFBFFF (the stock package fills them
 * with its USR file, our update loader never writes them); the editor writes it over the link (FACT_BEGIN, FACT_WRITE,
 * FACT_SUM, FACT_READ, FACT_COMMIT, FACT_INFO), so presets and region patches change without a firmware release.
 *
 * What the firmware reads is the two merged (fc_merge): the tier's patches in their order, each replaced by the region's
 * record of the same name when that one's revision is higher, then the region's other patches; the region's patterns
 * found before the tier's; the presets only from the region. A factory preset is found by its engine structure (the
 * running patch's), so a preset whose structure no installed patch has is never offered and never plays wrong. Without a
 * valid region the tier alone plays (the FM-1 says FACTORY SOUNDS MISSING:, main.c).
 *
 * An image, all little endian (web/scripts/factory-region.ts writes both):
 *   header, 64 bytes at the image's start: u32 magic "MFC1" (programmed last in the region: the commit), u8 layout
 *   (FC_LAYOUT), u8 the newest patch format a record uses (the firmware must play it: the oldest firmware the content
 *   needs), u16 the content's version (an ordinal over the released factory sets: the editor compares it, a patch record's
 *   revision defaults to it), u32 the factory set (24 bits, as the settings record keeps it), u32 the body's length, u32
 *   its CRC-32, u16 counts of patches, presets, patterns, released sets, dictionary values and migrations, u32 the offsets
 *   (from the image's start) of the patch directory, the presets, the dictionary, the patterns, the released sets and the
 *   migrations, u8 the bits of a dictionary index, u8 kind (FC_KIND_REGION, FC_KIND_TIER), u16 the count of released
 *   copies, u16 the demo sets' length (layout 2; layout 1: spare), u16 CRC-16 (m1_crc16) of bytes 4..61;
 *   patches: 36 bytes each: name[20], u32 offset of the packed bytes (lz_unpack.h), u16 packed length, u16 length,
 *     u16 CRC-16 of the packed bytes, u16 the slot FACTORY RESET puts it in, u16 revision, u16 spare;
 *   presets: u32 structure each (one column, for the scans), then 16 bytes each: u16 offset of its values (dictionary
 *     indexes, low bits first, 2 spare bytes after), u16 their bytes, u16 the preset whose values it changes (0xFFFF
 *     none: complete), u16 offset of its changed rows (one byte each), u16 offset of its name (NUL ended), u8 values,
 *     u8 changed rows, u16 CRC-16 of the values' and rows' bytes, u16 spare; offsets from the presets' start;
 *   dictionary: i32 each;
 *   patterns: 24 bytes each: u32 identity, u32 structure, u16 offset of its note words (u32 each), u8 notes, u8 len,
 *     u8 rate, u8 swing, u8 dir, u8 spare, i32 gate, u16 offset of its name, u16 CRC-16 of the note words; offsets from
 *     the patterns' start;
 *   released sets: 12 bytes each: u32 set, u64 which of this image's patches it had (bit n: patch n);
 *   released copies, right after the released sets (a firmware before them reads the count as spare bytes, and neither):
 *     12 bytes each: u32 FNV-1a and u32 CRC-32 of the bytes, u16 their length, u8 this image's patch, u8 spare. Each is
 *     a copy of that patch's name a release wrote whose bytes differ from today's (web/scripts/released-factory.json):
 *     a slot that still holds one gets today's patch (bank_upgrade.h, D-887);
 *   migrations: u16 counts of the list, tables, lines, ops, table values and line values, then the list (16 bytes each:
 *     u32 from, u32 to, u16 ops, u16 table, u16 line, u8 earlier rows, u8 today's), the tables (8 each: u8 a, b, na, nb,
 *     i8 la, lb, u16 v), the lines (6 each: u8 x, key, n, i8 lo, u16 v), the line values (i32), the table values (i8)
 *     and the ops (u8): presetmig.c reads them;
 *   demo sets (layout 2 and 3, the body's last bytes, header bytes 60..61 their length; web/src/demo-sets.ts, #1179): u8 count,
 *     then each: u32 the layout of the factory patch it comes from (patlink.c pl_layout), name[20], u16 the bytes its
 *     notes, patterns and songs, P-locks and links sections and its pattern origins take in a patch, u32 its FNV-1a hash,
 *     u16 the body's length, the body (patlink.c pl_demo_set reads it). The tier never has any.
 * This firmware reads layouts FC_LAYOUT_MIN..FC_LAYOUT (a layout-1 image: no demo sets). Layout 3 has layout 2's bytes; its
 * content is for firmware whose kit cards hold their DRUMS track (#1202 K2, D-1062: the kits' presets, preset patterns and
 * demo sets are made for those cards). 1.25 reads layouts 1 and 2 and 1.24.x layout 1 alone; the editor keeps an image of
 * each for them (web/public/firmware/factory/, D-1020).
 * The update loader erases a sector of this region whose last 256 bytes look like an update record
 * (firmware/loader/ldr_record.h); the image's writer keeps every sector clear of that, and FACT_WRITE refuses such a page.
 *
 * Writing (power-cut safe, the order of the preset store's commit): FACT_BEGIN erases sector 0 (the header goes: the
 * tier alone plays from then on), FACT_WRITE programs pages (offset 0 of sectors 1..17 erases the sector first; sector 0
 * keeps bytes 0..63 for the header), FACT_COMMIT checks the header and the body's CRC-32 against the flash, programs the
 * header without its magic, then the magic. A cut before the magic leaves no content (the tier alone); the editor runs
 * the install again and skips the sectors whose FACT_SUM already matches. Needs st_read / st_erase / st_prog
 * (storage_hw.c), m1_crc16, M1_NAME (proto.c), lz_unpack.h, ldr_record.h, factory_tier.h. Host tests:
 * tools/factory_test.sh. */
#include "lz_unpack.h"
#include "../loader/ldr_record.h"
#include "factory_tier.h"

#define FC_BASE 0xEA000u                /* the region: 18 sectors, below Felucca's globals (0xFC000) */
#define FC_SECTORS 18u
#define FC_SIZE (FC_SECTORS * 0x1000u)
#define FC_MAGIC 0x3143464Du            /* "MFC1" */
#define FC_LAYOUT 3u
#define FC_LAYOUT_MIN 1u                /* the oldest layout this firmware reads (1: no demo sets) */
#define FC_DEMO_REC 32u                 /* a demo set's record before its body */
#define FC_HDR 64u
#define FC_REC 36u                      /* a patch record */
#define FC_KIND_REGION 0u               /* header byte 57: an image for the region */
#define FC_KIND_TIER 1u                 /* ... the firmware tier (FC_TIER) */
#define FC_PATCHES 64u                  /* patches at most, in each image and merged (the bank's masks are 64 bits) */
#define FC_NOTES 32u                    /* a pattern's note words at most */
#define FC_PNAME 16u                    /* a preset's or pattern's name */
#define FC_STRUCT_PRESETS 32u           /* factory presets of one structure at most (pages_ui.c pr_list; factory-region.ts refuses more) */
#define FC_TIER_SET 0xFFFFFFu           /* the factory set of a bank written from the firmware tier alone */
#define FC_IN_REGION 0x80u              /* fc_pmap: the record is the region's */
#define FC_NOIDX 0xFFu
enum { FC_NONE, FC_OK, FC_NEWER, FC_DAMAGED };   /* the region's state (FACT_INFO) */

typedef struct {
    uint32_t magic;
    uint8_t layout, format;
    uint16_t version;
    uint32_t set, len, crc;
    uint16_t npatch, npreset, npattern, nreleased, ndict, nmig;
    uint32_t patch, preset, dict, pattern, released, mig;
    uint8_t bits;                       /* a dictionary index's bits (1..16) */
    uint8_t kind;                       /* FC_KIND_REGION, FC_KIND_TIER */
    uint16_t ncopy;                     /* released copies (in the struct's padding: no larger than before) */
    uint16_t demo;                      /* the demo sets' bytes (layout 2), at the body's end */
} fc_hdr_t;

typedef struct {                        /* a factory pattern (fc_pattern) */
    uint32_t identity, structure;
    char name[FC_PNAME + 1u];
    uint32_t notes[FC_NOTES];
    uint16_t n;
    uint8_t len, rate, swing, dir;
    int32_t gate;
} fc_pattern_t;

/* FC_MEM: where the headers and the merged list live (modular.c: NOINIT, the RAM region has no room to spare); fc_scan
 * sets them before anything reads them, so they need no zeroing */
#ifndef FC_MEM
#define FC_MEM
#endif
static fc_hdr_t ft FC_MEM;              /* the firmware tier's header (FC_TIER) */
static fc_hdr_t fr FC_MEM;              /* the region's, while fc_region */
static uint8_t fc_region;               /* 1: the region's content is valid and read */
static uint8_t fc_state;                /* the region's state (FC_NONE ..) */
static uint8_t fc_writing;              /* FACT_BEGIN ran since boot (no commit yet) */
static uint8_t fc_sync_due;             /* a commit put new content in: main.c brings the bank to it */
static uint8_t fc_np;                   /* the merged patches: the tier's record t is merged patch t */
static uint8_t fc_pmap[FC_PATCHES] FC_MEM;   /* merged patch i: its record (FC_IN_REGION: the region's) */
static uint8_t fc_ridx[FC_PATCHES] FC_MEM;   /* the region's record r: its merged index (FC_NOIDX: none, the list is full) */

static uint32_t fc_u16(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8; }
static uint32_t fc_u32(const uint8_t *p) { return fc_u16(p) | fc_u16(p + 2) << 16; }

/* bytes of the region (st_read) or of the tier (compiled in): 0 ok */
static int fc_rd(int region, uint32_t off, void *dst, uint32_t n)
{
    uint8_t *d = dst;
    uint32_t i;
    if (region)
        return off <= FC_SIZE && n <= FC_SIZE - off ? st_read(FC_BASE + off, dst, n) : -1;
    if (off > sizeof FC_TIER || n > sizeof FC_TIER - off)
        return -1;
    for (i = 0; i < n; i++)
        d[i] = FC_TIER[off + i];
    return 0;
}

static uint32_t fc_crc16(uint32_t c, const uint8_t *p, uint32_t n)   /* CRC-16/CCITT-FALSE from c (m1_crc16: from 0xFFFF) */
{
    uint32_t k;
    while (n--) {
        c ^= (uint32_t)*p++ << 8;
        for (k = 0; k < 8u; k++)
            c = c & 0x8000u ? ((c << 1) ^ 0x1021u) & 0xFFFFu : (c << 1) & 0xFFFFu;
    }
    return c;
}

static uint32_t fc_crc32(uint32_t c, const uint8_t *p, uint32_t n)   /* CRC-32 (IEEE), c from ~0, inverted at the end */
{
    uint32_t k;
    while (n--) {
        c ^= *p++;
        for (k = 0; k < 8u; k++)
            c = c & 1u ? (c >> 1) ^ 0xEDB88320u : c >> 1;
    }
    return c;
}

/* a header's 64 bytes into h: 0 when it is ours and whole (its own CRC; counts and sections inside the body) */
static int fc_parse(const uint8_t *b, fc_hdr_t *h)
{
    h->magic = fc_u32(b);
    h->layout = b[4];
    h->format = b[5];
    h->version = (uint16_t)fc_u16(b + 6);
    h->set = fc_u32(b + 8) & 0xFFFFFFu;
    h->len = fc_u32(b + 12);
    h->crc = fc_u32(b + 16);
    h->npatch = (uint16_t)fc_u16(b + 20);
    h->npreset = (uint16_t)fc_u16(b + 22);
    h->npattern = (uint16_t)fc_u16(b + 24);
    h->nreleased = (uint16_t)fc_u16(b + 26);
    h->ndict = (uint16_t)fc_u16(b + 28);
    h->nmig = (uint16_t)fc_u16(b + 30);
    h->patch = fc_u32(b + 32);
    h->preset = fc_u32(b + 36);
    h->dict = fc_u32(b + 40);
    h->pattern = fc_u32(b + 44);
    h->released = fc_u32(b + 48);
    h->mig = fc_u32(b + 52);
    h->bits = b[56];
    h->kind = b[57];
    h->ncopy = (uint16_t)fc_u16(b + 58);
    h->demo = h->layout >= 2u ? (uint16_t)fc_u16(b + 60) : 0u;
    if (h->magic != FC_MAGIC || fc_u16(b + 62) != m1_crc16(b + 4, 58u) || h->len > FC_SIZE - FC_HDR)
        return -1;
    if (h->npatch > FC_PATCHES || !h->bits || h->bits > 16u || h->demo > h->len)
        return -1;
    return 0;
}

/* the region's content checked: its header, an image for the region, the layout and format this firmware reads, the
 * body's CRC-32 */
static uint32_t fc_check(fc_hdr_t *h)
{
    uint8_t b[256];
    uint32_t off, c = 0xFFFFFFFFu;
    if (st_read(FC_BASE, b, FC_HDR) || fc_parse(b, h) || h->kind != FC_KIND_REGION)
        return FC_NONE;
    if (h->layout < FC_LAYOUT_MIN || h->layout > FC_LAYOUT || h->format > ENG_PATCH_VERSION)
        return FC_NEWER;
    for (off = 0; off < h->len; off += sizeof b) {
        uint32_t n = h->len - off < sizeof b ? h->len - off : sizeof b;
        if (st_read(FC_BASE + FC_HDR + off, b, n))
            return FC_DAMAGED;
        c = fc_crc32(c, b, n);
    }
    return ~c == h->crc ? FC_OK : FC_DAMAGED;
}

/* the merged patch list (see the top): the tier's in order, a region record of the same name in its place when that
 * one's revision is higher, then the region's others */
static void fc_merge(void)
{
    uint8_t a[FC_REC], b[FC_REC];
    uint32_t t, r, k;
    for (t = 0; t < ft.npatch; t++)
        fc_pmap[t] = (uint8_t)t;
    fc_np = (uint8_t)ft.npatch;
    for (r = 0; fc_region && r < fr.npatch; r++) {
        fc_ridx[r] = FC_NOIDX;
        if (fc_rd(1, fr.patch + FC_REC * r, a, FC_REC))
            continue;
        for (t = 0; t < ft.npatch; t++) {
            if (fc_rd(0, ft.patch + FC_REC * t, b, FC_REC))
                continue;
            for (k = 0; k < M1_NAME && a[k] == b[k]; k++)
                ;
            if (k == M1_NAME)
                break;
        }
        if (t < ft.npatch) {                            /* a firmware-tier patch's copy: the newer revision plays */
            fc_ridx[r] = (uint8_t)t;
            if (fc_u16(a + 32) > fc_u16(b + 32))
                fc_pmap[t] = (uint8_t)(FC_IN_REGION | r);
        } else if (fc_np < FC_PATCHES) {
            fc_pmap[fc_np] = (uint8_t)(FC_IN_REGION | r);
            fc_ridx[r] = fc_np++;
        }
    }
}

/* boot, and after a commit: the tier, and the region's content when valid */
static uint8_t fc_scanned;
static uint8_t fc_scans;                /* scans since boot (mod 256): the region's content may have changed (seq_ui.c's demo set) */
static void fc_scan(void)
{
    fc_hdr_t h;
    fc_scanned = 1;
    fc_scans++;
    if (fc_parse(FC_TIER, &ft))                         /* (export-defs writes a whole one: never) */
        ft.npatch = ft.npreset = ft.npattern = ft.nreleased = ft.nmig = ft.ncopy = ft.demo = 0;
    fc_state = flash_ok ? (uint8_t)fc_check(&h) : (uint8_t)FC_NONE;
    fc_region = fc_state == FC_OK;
    if (fc_region)
        fr = h;
    fc_merge();
}
/* scanned (the first use scans, so a host test needs no boot) */
static void fc_ready(void)
{
    if (!fc_scanned)
        fc_scan();
}

/* the factory set a bank brought to today's content keeps: the region's, else FC_TIER_SET (a region added later brings
 * the rest) */
static uint32_t fc_set(void)
{
    fc_ready();
    return fc_region ? fr.set : FC_TIER_SET;
}

/* ---- patches */

static uint32_t fc_npatches(void) { fc_ready(); return fc_np; }

/* merged patch i's record into e: 0 ok */
static int fc_rec(uint32_t i, uint8_t *e)
{
    uint32_t m;
    if (i >= fc_npatches())
        return -1;
    m = fc_pmap[i];
    return m & FC_IN_REGION ? fc_rd(1, fr.patch + FC_REC * (m & 0x7Fu), e, FC_REC) : fc_rd(0, ft.patch + FC_REC * m, e, FC_REC);
}

/* 1 when merged patch i is read from the region */
static int fc_patch_region(uint32_t i) { return i < fc_npatches() && (fc_pmap[i] & FC_IN_REGION); }

/* patch i's name (M1_NAME bytes, NUL padded), length and slot: 0 ok */
static int fc_patch_info(uint32_t i, char *name, uint32_t *len, uint32_t *slot)
{
    uint8_t e[FC_REC];
    uint32_t k;
    if (fc_rec(i, e))
        return -1;
    for (k = 0; k < M1_NAME; k++)
        name[k] = (char)(e[k] >= 32u && e[k] < 127u ? e[k] : 0);
    if (len)
        *len = fc_u16(e + 26);
    if (slot)
        *slot = fc_u16(e + 30);
    return 0;
}

/* patch i unpacked into buf (cap bytes): its length, -1 unreadable. The packed bytes are read into buf's end and unpacked
 * in place (the image's writer checks that the output never reaches input not yet read, for cap M1_PATCH_MAX) */
static int32_t fc_patch(uint32_t i, uint8_t *buf, uint32_t cap)
{
    uint8_t e[FC_REC];
    uint32_t lz, len;
    if (fc_rec(i, e))
        return -1;
    lz = fc_u16(e + 24);
    len = fc_u16(e + 26);
    if (!lz || lz > cap || len > cap || fc_rd(fc_patch_region(i), fc_u32(e + 20), buf + cap - lz, lz) ||
        m1_crc16(buf + cap - lz, lz) != fc_u16(e + 28))
        return -1;
    return lz_unpack(buf + cap - lz, lz, buf, cap) == (int32_t)len ? (int32_t)len : -1;
}

/* the released set `set`: which of the merged patches it had (*has; an image that does not know the set counts as
 * having every patch some released set of it had, a build between releases); *any: those any released set had. 1 when
 * an image knows the set */
static int fc_released(uint32_t set, uint64_t *has, uint64_t *any)
{
    uint8_t e[12];
    uint32_t k, n, img;
    int found = 0;
    fc_ready();
    *has = *any = 0;
    for (img = 0; img < 2u; img++) {
        const fc_hdr_t *h = img ? &fr : &ft;
        uint64_t mine = 0, all = 0;
        int got = 0;
        if (img && !fc_region)
            break;
        for (k = 0; k < h->nreleased; k++) {
            uint64_t bits, m = 0;
            if (fc_rd((int)img, h->released + 12u * k, e, sizeof e))
                break;
            bits = (uint64_t)fc_u32(e + 4) | (uint64_t)fc_u32(e + 8) << 32;
            for (n = 0; n < h->npatch; n++) {               /* (this image's patch n: its merged index) */
                uint32_t at = img ? fc_ridx[n] : n;
                if ((bits >> n & 1u) && at != FC_NOIDX)
                    m |= (uint64_t)1 << at;
            }
            all |= m;
            if (fc_u32(e) == set) {
                mine = m;
                got = 1;
            }
        }
        *any |= all;
        *has |= got ? mine : all;
        found |= got;
    }
    return found;
}

/* ---- released copies (D-887 amended 2026-11-19, bank_upgrade.h): the tier's, then the region's */

static uint32_t fc_fnv32(uint32_t h, const uint8_t *p, uint32_t n)   /* FNV-1a from h (0x811C9DC5 to start) */
{
    while (n--)
        h = (h ^ *p++) * 0x01000193u;
    return h;
}

static uint32_t fc_ncopies(void) { fc_ready(); return ft.ncopy + (fc_region ? fr.ncopy : 0u); }

/* released copy k: its length, FNV-1a and CRC-32 into *len, *fnv, *crc; the merged patch it is a copy of, -1 none (an
 * image's patch the merged list has no room for, a section past the body) */
static int fc_copy(uint32_t k, uint32_t *len, uint32_t *fnv, uint32_t *crc)
{
    uint8_t e[12];
    uint32_t region, at;
    const fc_hdr_t *h;
    if (k >= fc_ncopies())                              /* (scans first) */
        return -1;
    region = k >= ft.ncopy;
    h = region ? &fr : &ft;
    k -= region ? ft.ncopy : 0u;
    at = h->released + 12u * (h->nreleased + k);
    if (at + 12u > FC_HDR + h->len || fc_rd((int)region, at, e, sizeof e) || e[10] >= h->npatch)
        return -1;
    *fnv = fc_u32(e);
    *crc = fc_u32(e + 4);
    *len = fc_u16(e + 8);
    at = region ? fc_ridx[e[10]] : e[10];
    return at == FC_NOIDX ? -1 : (int)at;
}

/* ---- the factory engines' presets (the region's alone) */

static uint32_t fc_npresets(void) { fc_ready(); return fc_region ? fr.npreset : 0u; }

/* the first preset from `from` on of the structure, -1 none (the structures are read 64 at a time) */
static int fc_preset_find(uint32_t structure, uint32_t from)
{
    uint8_t b[256];
    uint32_t k, i, n;
    for (k = from; k < fc_npresets(); k += n) {
        n = fr.npreset - k < 64u ? fr.npreset - k : 64u;
        if (fc_rd(1, fr.preset + 4u * k, b, 4u * n))
            return -1;
        for (i = 0; i < n; i++)
            if (fc_u32(b + 4u * i) == structure)
                return (int)(k + i);
    }
    return -1;
}

static int fc_preset_entry(uint32_t k, uint8_t *e)
{
    return k < fc_npresets() ? fc_rd(1, fr.preset + 4u * fr.npreset + 16u * k, e, 16u) : -1;
}

/* preset k's structure (0 none) */
static uint32_t fc_preset_structure(uint32_t k)
{
    uint8_t b[4];
    return k < fc_npresets() && !fc_rd(1, fr.preset + 4u * k, b, 4u) ? fc_u32(b) : 0u;
}

/* preset k's name (FC_PNAME + 1 bytes, NUL ended) and its values' count: the count, -1 none */
static int fc_preset_name(uint32_t k, char *name)
{
    uint8_t e[16];
    uint32_t i;
    if (fc_preset_entry(k, e) || fc_rd(1, fr.preset + fc_u16(e + 8), name, FC_PNAME))
        return -1;
    for (i = 0; i < FC_PNAME && name[i]; i++)
        ;
    for (; i <= FC_PNAME; i++)
        name[i] = 0;
    return e[10];
}

/* dictionary index i of the packed values p (fr.bits each, low bits first: export-defs packs them so, with 2 spare bytes) */
static uint32_t fc_index(const uint8_t *p, uint32_t i)
{
    uint32_t bit = i * fr.bits, at = bit >> 3;
    return ((p[at] | (uint32_t)p[at + 1u] << 8 | (uint32_t)p[at + 2u] << 16) >> (bit & 7u)) & ((1u << fr.bits) - 1u);
}

/* preset k's Q16 values into scratch (cap values): scratch, 0 unreadable. A preset that changes another's values reads
 * that one first, then its changed rows; the dictionary is read 64 values at a time */
static const int32_t *fc_preset_values(uint32_t k, int32_t *scratch, uint32_t cap)
{
    uint8_t e[16], v[256], r[256];
    uint32_t n, c, i, w, done[256u / 32u];
    if (fc_preset_entry(k, e) || (n = e[10]) > cap || n > 256u || (c = e[11]) > n || fc_u16(e + 2) > sizeof v)
        return 0;
    if (fc_rd(1, fr.preset + fc_u16(e), v, fc_u16(e + 2)) || (c && fc_rd(1, fr.preset + fc_u16(e + 6), r, c)))
        return 0;
    if (fc_crc16(fc_crc16(0xFFFFu, v, fc_u16(e + 2)), r, c) != fc_u16(e + 12))   /* (over the values, then the rows) */
        return 0;
    if (fc_u16(e + 4) != 0xFFFFu) {                     /* the base's values, then the changed rows */
        uint8_t be[16], bv[256];
        if (fc_preset_entry(fc_u16(e + 4), be) || be[10] != n || fc_u16(be + 2) > sizeof bv ||
            fc_rd(1, fr.preset + fc_u16(be), bv, fc_u16(be + 2)))
            return 0;
        for (i = 0; i < n; i++)
            scratch[i] = (int32_t)fc_index(bv, i);
        for (i = 0; i < c; i++) {
            if (r[i] >= n)
                return 0;
            scratch[r[i]] = (int32_t)fc_index(v, i);
        }
    } else
        for (i = 0; i < n; i++)
            scratch[i] = (int32_t)fc_index(v, i);
    for (i = 0; i < n; i++)
        if ((uint32_t)scratch[i] >= fr.ndict)
            return 0;
    for (i = 0; i < sizeof done / sizeof *done; i++)
        done[i] = 0;
    for (w = 0; w < fr.ndict; w += 64u) {               /* indexes to values, a window of the dictionary at a time */
        uint32_t m = fr.ndict - w < 64u ? fr.ndict - w : 64u;
        if (fc_rd(1, fr.dict + 4u * w, v, 4u * m))
            return 0;
        for (i = 0; i < n; i++)
            if (!(done[i >> 5] >> (i & 31u) & 1u) && (uint32_t)scratch[i] - w < m) {
                scratch[i] = (int32_t)fc_u32(v + 4u * ((uint32_t)scratch[i] - w));
                done[i >> 5] |= 1u << (i & 31u);
            }
    }
    return scratch;
}

/* ---- the factory drum patterns: the region's, then the tier's (a lookup by identity or name finds the region's
 * first) */

static uint32_t fc_npatterns(void) { fc_ready(); return (fc_region ? fr.npattern : 0u) + ft.npattern; }

/* pattern i into p: 0 ok */
static int fc_pattern(uint32_t i, fc_pattern_t *p)
{
    uint8_t e[24];
    uint32_t k, nr;
    int region;
    const fc_hdr_t *h;
    if (i >= fc_npatterns())                            /* (scans first: fc_region is set from here on) */
        return -1;
    nr = fc_region ? fr.npattern : 0u;
    region = i < nr;
    h = region ? &fr : &ft;
    if (!region)
        i -= nr;
    if (fc_rd(region, h->pattern + 24u * i, e, sizeof e))
        return -1;
    p->identity = fc_u32(e);
    p->structure = fc_u32(e + 4);
    p->n = e[10];
    p->len = e[11];
    p->rate = e[12];
    p->swing = e[13];
    p->dir = e[14];
    p->gate = (int32_t)fc_u32(e + 16);
    if (p->n > FC_NOTES || fc_rd(region, h->pattern + fc_u16(e + 8), p->notes, 4u * p->n) ||
        m1_crc16((const uint8_t *)p->notes, 4u * p->n) != fc_u16(e + 22) ||
        fc_rd(region, h->pattern + fc_u16(e + 20), p->name, FC_PNAME))
        return -1;
    for (k = 0; k < FC_PNAME && p->name[k]; k++)
        ;
    for (; k <= FC_PNAME; k++)
        p->name[k] = 0;
    return 0;
}

/* ---- the user preset migrations (presetmig.c): the tier's */

static uint32_t fc_nmig(void) { fc_ready(); return ft.nmig; }

/* bytes of the migrations' section from offset `at` on */
static int fc_mig_rd(uint32_t at, void *dst, uint32_t n) { fc_ready(); return fc_rd(0, ft.mig + at, dst, n); }

/* ---- the demo sets (#1179): the region's */

/* the demo set of the patch layout `layout` (patlink.c pl_layout): its body's offset in the region in *at, its length in
 * *len, the bytes it takes in a patch in *cost, its hash in *hash. 0 found, -1 none (no region, or no set of that layout) */
static int fc_demo(uint32_t layout, uint32_t *at, uint32_t *len, uint32_t *cost, uint32_t *hash)
{
    uint8_t e[FC_DEMO_REC];
    uint32_t off, end, k, n;
    fc_ready();
    if (!fc_region || !fr.demo)
        return -1;
    end = FC_HDR + fr.len;
    off = end - fr.demo;
    if (fc_rd(1, off++, e, 1u))
        return -1;
    for (n = e[0], k = 0; k < n && off + FC_DEMO_REC <= end; k++) {
        if (fc_rd(1, off, e, FC_DEMO_REC))
            return -1;
        if (off + FC_DEMO_REC + fc_u16(e + 30) > end)
            return -1;
        if (fc_u32(e) == layout) {
            *at = off + FC_DEMO_REC;
            *len = fc_u16(e + 30);
            *cost = fc_u16(e + 24);
            *hash = fc_u32(e + 26);
            return 0;
        }
        off += FC_DEMO_REC + fc_u16(e + 30);
    }
    return -1;
}

/* ---- the editor link (proto.c): the region written, read and checked */

/* FACT_INFO's bytes into out (FC_INFO_LEN): the region's state, the layout this firmware reads, the region header's
 * layout, format, version, set, body length and patches, flags (bit 0 writing, bit 1 the tier alone plays), the region's
 * size, the newest patch format this firmware plays, the tier's version and patches, the merged patches. Not inlined:
 * inside proto.c's m1_handle its header copy sat past sp + 2 KB, where fm1-emu decodes no halfword or word load */
#define FC_INFO_LEN 26u
static __attribute__((noinline)) uint32_t m1_fact_info(uint8_t *out)
{
    uint8_t b[FC_HDR];
    fc_hdr_t h;
    uint32_t k;
    fc_ready();
    for (k = 0; k < FC_INFO_LEN; k++)
        out[k] = 0;
    out[0] = fc_state;
    out[1] = FC_LAYOUT;
    if (flash_ok && !st_read(FC_BASE, b, FC_HDR) && !fc_parse(b, &h)) {
        out[2] = h.layout;
        out[3] = h.format;
        out[4] = (uint8_t)h.version;
        out[5] = (uint8_t)(h.version >> 8);
        for (k = 0; k < 4u; k++) {
            out[6u + k] = (uint8_t)(h.set >> (8u * k));
            out[10u + k] = (uint8_t)(h.len >> (8u * k));
        }
        out[14] = (uint8_t)h.npatch;
        out[15] = (uint8_t)(h.npatch >> 8);
    }
    out[16] = (uint8_t)((fc_writing ? 1u : 0u) | (fc_region ? 0u : 2u));
    for (k = 0; k < 4u; k++)
        out[17u + k] = (uint8_t)(FC_SIZE >> (8u * k));
    out[21] = (uint8_t)ENG_PATCH_VERSION;
    out[22] = (uint8_t)ft.version;
    out[23] = (uint8_t)(ft.version >> 8);
    out[24] = (uint8_t)ft.npatch;
    out[25] = fc_np;
    return FC_INFO_LEN;
}

/* FACT_BEGIN: the header's sector erased; the tier alone plays until a commit */
static uint32_t m1_fact_begin(void)
{
    if (!flash_ok)
        return S_FLASH;
    fc_ready();
    fc_region = 0;
    fc_state = FC_NONE;
    fc_merge();
    fc_writing = 1;
    return st_erase(FC_BASE) ? S_FLASH : S_OK;
}

/* n bytes at offset off of the flash sector at sec, inside one page (offset 0 erases the sector first when `erase`); read
 * back and compared. The page an update record would be in is written whole and never as one. A status (S_OK ..): FACT_WRITE,
 * and the font area's writes (font_area.c) */
static uint32_t fc_page(uint32_t sec, uint32_t off, const uint8_t *p, uint32_t n, int erase)
{
    uint8_t b[256];
    uint32_t i;
    if (!n || n > 256u || (off & 0xFFu) + n > 256u || off + n > 0x1000u)
        return S_RANGE;
    if ((off & 0xF00u) == 0xF00u && (off != 0xF00u || n < LDR_REC_LEN || ldr_is_record(p)))
        return S_RANGE;                                /* (the page an update record would be in: whole, and not one) */
    if (!off && erase && st_erase(sec))
        return S_FLASH;
    if (st_prog(sec + off, p, n) || st_read(sec + off, b, n))
        return S_FLASH;
    for (i = 0; i < n; i++)
        if (b[i] != p[i])
            return S_FLASH;
    return S_OK;
}

/* CRC-16 of the 4096 bytes of the flash sector at sec into *crc: 0 ok (FACT_SUM, and the font area's, font_area.c) */
static int fc_sector_sum(uint32_t sec, uint32_t *crc)
{
    uint8_t b[256];
    uint32_t off, c = 0xFFFFu;
    for (off = 0; off < 0x1000u; off += sizeof b) {
        if (st_read(sec + off, b, sizeof b))
            return -1;
        c = fc_crc16(c, b, sizeof b);
    }
    *crc = c;
    return 0;
}

/* FACT_WRITE: n bytes at offset off of sector s, inside one page (offset 0 of sectors 1..17 erases the sector first);
 * read back and compared */
static uint32_t m1_fact_write(uint32_t s, uint32_t off, const uint8_t *p, uint32_t n)
{
    if (!flash_ok)
        return S_FLASH;
    if (!fc_writing)
        return S_NONE;
    if (s >= FC_SECTORS || (!s && off < FC_HDR))
        return S_RANGE;
    return fc_page(FC_BASE + s * 0x1000u, off, p, n, s != 0u);
}

/* FACT_SUM: CRC-16 of sector s's 4096 bytes into *crc: 0 ok */
static int m1_fact_sum(uint32_t s, uint32_t *crc)
{
    return flash_ok && s < FC_SECTORS ? fc_sector_sum(FC_BASE + s * 0x1000u, crc) : -1;
}

/* FACT_READ: n bytes of the region from offset off: 0 ok */
static int m1_fact_read(uint32_t off, uint8_t *p, uint32_t n)
{
    return flash_ok && off < FC_SIZE && n <= FC_SIZE - off ? st_read(FC_BASE + off, p, n) : -1;
}

/* FACT_COMMIT: the 64-byte header h checked (ours, an image for the region, a layout and format this firmware reads, the
 * body's CRC-32 as the flash holds it), then programmed: bytes 4..63, then the magic. A status (S_OK ..) */
static uint32_t m1_fact_commit(const uint8_t *h)
{
    uint8_t b[FC_HDR];
    fc_hdr_t x;
    uint32_t i, off, c = 0xFFFFFFFFu;
    if (!flash_ok)
        return S_FLASH;
    if (!fc_writing || fc_parse(h, &x) || x.kind != FC_KIND_REGION)
        return S_RANGE;
    if (x.layout < FC_LAYOUT_MIN || x.layout > FC_LAYOUT || x.format > ENG_PATCH_VERSION)
        return S_LOAD;
    if (st_read(FC_BASE, b, FC_HDR))
        return S_FLASH;
    for (i = 0; i < FC_HDR; i++)
        if (b[i] != 0xFFu)
            return S_RANGE;                            /* (a header is there: FACT_BEGIN first) */
    for (off = 0; off < x.len; off += 256u) {
        uint8_t d[256];
        uint32_t n = x.len - off < 256u ? x.len - off : 256u;
        if (st_read(FC_BASE + FC_HDR + off, d, n))
            return S_FLASH;
        c = fc_crc32(c, d, n);
    }
    if (~c != x.crc)
        return S_CRC;
    if (st_prog(FC_BASE + 4u, h + 4, FC_HDR - 4u) || st_prog(FC_BASE, h, 4u))
        return S_FLASH;
    fc_writing = 0;
    fc_scan();
    if (!fc_region)
        return S_FLASH;
    fc_sync_due = 1;
    return S_OK;
}
