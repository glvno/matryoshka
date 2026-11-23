/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The palette's record (#1196): its own two flash sectors, A at 0xE5000 and B at 0xE6000 (Felucca's autosave A/B,
 * unused by Matryoshka; hal/fm1_flash.h FL_STORE_OK lets the store write there). A write goes to the other sector and its
 * header's magic is written last, so a cut write leaves the old sector as the record. The valid sector with the higher
 * seq (compared mod 2^16) wins. FACTORY RESET erases both.
 *
 *   +0 u32 magic 'M1PL'   +4 u8 version 1   +5 u8 entries 8   +6 u16 seq   +8 u16 body length   +10 u16 CRC-16 of the body
 *   +12 u32 0xFFFFFFFF    +16 body: 8 x {u16 n LE (0 = empty), n bytes = ENTRY (up to 335)}
 *
 * The record ends before 0xF00: the update loader erases a sector there whose 80 bytes at 0xF00 look like an update
 * record (loader/ldr_record.h), so those bytes stay erased.
 * Needs palette.h, st_read / st_erase / st_prog, m1_crc16 and the hook pal_slot_name (the slot's patch name and length
 * now, -1 when the slot is empty). Host test: firmware/test/palette_test.c (tools/palette_test.sh). */
#ifndef PAL_STORE_H
#define PAL_STORE_H

#define PAL_SEC_A 0xE5000u
#define PAL_SEC_B 0xE6000u
#define PAL_MAGIC 0x4C50314Du                    /* 'M1PL' */
#define PAL_VERSION 1u
#define PAL_HDR 16u
#define PAL_END 0xF00u                           /* the record stays before this (the update loader's record place) */
_Static_assert(PAL_HDR + PAL_N * (2u + PAL_ENTRY_MAX) <= PAL_END, "the largest palette record ends before 0xF00");

static int pal_slot_name(uint32_t slot, char *name, uint32_t *len);   /* the hook: the slot's name (PAL_NAME) and length */

static uint8_t pal_side = PAL_NONE;              /* the valid sector: 0 A, 1 B, PAL_NONE none (an empty palette) */
static uint16_t pal_seq;                         /* its seq */

static uint32_t pal_sec(uint32_t side) { return side ? PAL_SEC_B : PAL_SEC_A; }
static uint32_t pal_crc_step(uint32_t c, uint32_t b)   /* CRC-16/CCITT-FALSE, a byte at a time (as m1_crc16) */
{
    uint32_t k;
    c ^= b << 8;
    for (k = 0; k < 8u; k++)
        c = c & 0x8000u ? ((c << 1) ^ 0x1021u) & 0xFFFFu : (c << 1) & 0xFFFFu;
    return c;
}
static uint32_t pal_rd16(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8; }
static uint32_t pal_rd32(const uint8_t *p) { return pal_rd16(p) | pal_rd16(p + 2) << 16; }

/* sector side's header if its record is valid (magic, a version this firmware reads, the CRC): 0, its seq and body
 * length; else -1 (erased, cut, garbage, or a newer version: read as empty) */
static int pal_head(uint32_t side, uint32_t *seq, uint32_t *blen)
{
    uint8_t h[PAL_HDR], b[64];
    uint32_t a = pal_sec(side), n, c = 0xFFFFu, i, k;
    if (st_read(a, h, PAL_HDR) || pal_rd32(h) != PAL_MAGIC || h[4] != PAL_VERSION || h[5] != PAL_N)
        return -1;
    n = pal_rd16(h + 8);
    if (n > PAL_END - PAL_HDR)
        return -1;
    for (i = 0; i < n; i += k) {
        uint32_t j;
        k = n - i < sizeof b ? n - i : sizeof b;
        if (st_read(a + PAL_HDR + i, b, k))
            return -1;
        for (j = 0; j < k; j++)
            c = pal_crc_step(c, b[j]);
    }
    if (c != pal_rd16(h + 10))
        return -1;
    *seq = pal_rd16(h + 6);
    *blen = n;
    return 0;
}

/* boot: which sector holds the record */
static void pal_scan(void)
{
    uint32_t sa, sb, la, lb;
    int a = pal_head(0, &sa, &la), b = pal_head(1, &sb, &lb);
    pal_side = PAL_NONE;
    if (!a && (b || (int16_t)(uint16_t)(sa - sb) >= 0)) {
        pal_side = 0;
        pal_seq = (uint16_t)sa;
    } else if (!b) {
        pal_side = 1;
        pal_seq = (uint16_t)sb;
    }
}

/* where position pos's entry starts in the valid sector (its length), and its length; -1 with no record */
static int pal_at(uint32_t pos, uint32_t *at, uint32_t *n)
{
    uint32_t a, i;
    uint8_t l[2] = { 0, 0 };
    if (pal_side == PAL_NONE || pos >= PAL_N)
        return -1;
    a = pal_sec(pal_side) + PAL_HDR;
    for (i = 0; i <= pos; i++) {
        if (st_read(a, l, 2) || pal_rd16(l) > PAL_ENTRY_MAX)
            return -1;
        if (i < pos)
            a += 2u + pal_rd16(l);
    }
    *at = a;
    *n = pal_rd16(l);
    return 0;
}

/* position pos's ENTRY bytes into e (PAL_ENTRY_MAX): their count, 0 when empty */
static uint32_t pal_entry(uint32_t pos, uint8_t *e)
{
    uint32_t at, n;
    if (pal_at(pos, &at, &n) || n > PAL_ENTRY_MAX || st_read(at + 2u, e, n))
        return 0;
    return n;
}

/* an ENTRY is well formed: the fixed part, ndev <= PAL_DEVS, each device's structure not 0 and its name 1..16
 * characters, nothing after the last device */
static int pal_entry_ok(const uint8_t *e, uint32_t n)
{
    uint32_t at = PAL_FIXED, d;
    if (n < PAL_FIXED || n > PAL_ENTRY_MAX || e[PAL_FIXED - 1u] > PAL_DEVS)
        return 0;
    for (d = 0; d < e[PAL_FIXED - 1u]; d++) {
        if (at + 10u > n || !pal_rd32(e + at + 1u) || e[at + 9u] < 1u || e[at + 9u] > PAL_PNAME)
            return 0;
        at += 10u + e[at + 9u];
    }
    return at == n;
}

/* the names match: up to PAL_NAME characters, a zero ends one */
static int pal_name_eq(const char *a, const char *b)
{
    uint32_t i;
    for (i = 0; i < PAL_NAME && a[i] == b[i] && a[i]; i++)
        ;
    return i == PAL_NAME || a[i] == b[i];
}

/* the RAM index again from the record and the bank: each entry's state (OK while its slot holds its name now, else
 * MISSING), hash and the slot's length. Returns a bit per position whose state, hash or length changed */
static uint32_t pal_check(void)
{
    uint8_t e[PAL_ENTRY_MAX];
    uint32_t pos, i, n, len, changed = 0;
    char name[PAL_NAME + 1];
    for (pos = 0; pos < PAL_N; pos++) {
        pal_ix_t x = { 0 }, *o = &pal_ix[pos];
        n = pal_entry(pos, e);
        if (n >= PAL_FIXED) {
            x.slot = e[0];
            x.pattern = e[1];
            for (i = 0; i < PAL_NAME; i++)
                x.name[i] = (char)e[2u + i];
            for (i = 0, x.hash = 0xFFFFu; i < n; i++)
                x.hash = (uint16_t)pal_crc_step(x.hash, e[i]);
            x.state = PAL_MISSING;
            if (!pal_slot_name(x.slot, name, &len) && pal_name_eq(name, x.name)) {
                x.state = PAL_OK;
                x.len = (uint16_t)len;
            }
        }
        if (x.state != o->state || x.hash != o->hash || x.len != o->len || x.slot != o->slot || x.pattern != o->pattern)
            changed |= 1u << pos;
        *o = x;
    }
    return changed;
}

/* a new record into the other sector: new position i takes the old position from[i] (PAL_NONE: empty), except position
 * put (PAL_NONE: none), which takes the n bytes at e (n 0: empty). The old sector stays as it is (the fallback until the
 * new magic is written). 0 = written; -1 the flash refused (the old record stays) */
static int pal_write(const uint8_t *from, uint32_t put, const uint8_t *e, uint32_t n)
{
    uint8_t pg[256], b[32];
    uint32_t side = pal_side == PAL_NONE ? 0u : pal_side ^ 1u, a = pal_sec(side), w = PAL_HDR, c = 0xFFFFu, i, k, m;
    uint32_t at[PAL_N], len[PAL_N];
    uint16_t seq = (uint16_t)(pal_side == PAL_NONE ? 1u : pal_seq + 1u);
    for (i = 0; i < PAL_N; i++)                  /* (the old entries' places first: the walk reads the old sector) */
        if (pal_at(i, &at[i], &len[i]))
            len[i] = 0;
    if (st_erase(a))
        return -1;
    for (i = 0; i < 256u; i++)
        pg[i] = 0xFFu;
#define PAL_PUT(x) do { pg[w & 255u] = (uint8_t)(x); c = pal_crc_step(c, pg[w & 255u]); if ((++w & 255u) == 0u) { \
        if (st_prog(a + w - 256u, pg, 256u)) return -1; for (k = 0; k < 256u; k++) pg[k] = 0xFFu; } } while (0)
    for (i = 0; i < PAL_N; i++) {
        if (i == put) {
            PAL_PUT(n);
            PAL_PUT(n >> 8);
            for (m = 0; m < n; m++)
                PAL_PUT(e[m]);
        } else if (from[i] < PAL_N && len[from[i]]) {
            uint32_t src = at[from[i]] + 2u, left = len[from[i]];
            PAL_PUT(left);
            PAL_PUT(left >> 8);
            while (left) {
                uint32_t q = left < sizeof b ? left : sizeof b;
                if (st_read(src, b, q))
                    return -1;
                for (m = 0; m < q; m++)
                    PAL_PUT(b[m]);
                src += q;
                left -= q;
            }
        } else {
            PAL_PUT(0);
            PAL_PUT(0);
        }
    }
#undef PAL_PUT
    if ((w & 255u) && st_prog(a + (w & ~255u), pg, w & 255u))
        return -1;
    {                                            /* the header, the magic last: the commit */
        uint8_t h[PAL_HDR] = { 0x4D, 0x31, 0x50, 0x4C, PAL_VERSION, PAL_N, (uint8_t)seq, (uint8_t)(seq >> 8),
                               (uint8_t)(w - PAL_HDR), (uint8_t)((w - PAL_HDR) >> 8), (uint8_t)c, (uint8_t)(c >> 8),
                               0xFF, 0xFF, 0xFF, 0xFF };
        if (st_prog(a + 4u, h + 4, PAL_HDR - 4u) || st_prog(a, h, 4u))
            return -1;
    }
    pal_side = (uint8_t)side;
    pal_seq = seq;
    return 0;
}

/* FACTORY RESET: both sectors erased, the palette empty */
static void pal_clear_all(void)
{
    (void)st_erase(PAL_SEC_A);
    (void)st_erase(PAL_SEC_B);
    pal_side = PAL_NONE;
    pal_cur = pal_next = PAL_NONE;
    (void)pal_check();
}

#endif
