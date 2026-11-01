/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The preset store (firmware/src/presetstore.c, #194) on the host, over a RAM flash that behaves like NOR: an erase sets a
 * sector to 0xFF, a program only clears bits. A program can be cut after n bytes (a power cut). tools/preset_test.sh. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define FLASH_LO 0x99000u
#define FLASH_N (7u * 0x1000u)
static uint8_t flash[FLASH_N];
static long cut_after = -1;            /* bytes the next programs may write before the "power" goes, -1 no cut */
static int erases;
static int cut_hit;                    /* a program or erase was refused for the cut */

static void fm1_wdt_feed(void) {}
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    if (off < FLASH_LO || off + n > FLASH_LO + FLASH_N)
        return -8;
    memcpy(dst, flash + (off - FLASH_LO), n);
    return 0;
}
static int st_erase(uint32_t off)
{
    if (cut_after == 0) {               /* (the power is gone: an erase is not modelled half done) */
        cut_hit = 1;
        return -9;
    }
    if (off < FLASH_LO || off + 0x1000u > FLASH_LO + FLASH_N || (off & 0xFFFu))
        return -8;
    memset(flash + (off - FLASH_LO), 0xFF, 0x1000u);
    erases++;
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    const uint8_t *s = src;
    uint32_t i;
    if (off < FLASH_LO || off + n > FLASH_LO + FLASH_N)
        return -8;
    for (i = 0; i < n; i++) {
        if (cut_after == 0) {
            cut_hit = 1;
            return -9;
        }
        if (cut_after > 0)
            cut_after--;
        flash[off - FLASH_LO + i] &= s[i];
    }
    return 0;
}
static uint16_t m1_crc16(const uint8_t *p, uint32_t n)
{
    uint16_t c = 0xFFFFu;
    while (n--) {
        uint32_t b;
        c ^= (uint16_t)(*p++ << 8);
        for (b = 0; b < 8u; b++)
            c = (uint16_t)(c & 0x8000u ? (c << 1) ^ 0x1021u : c << 1);
    }
    return c;
}

#include "../src/presetstore.c"

static int fails;
#define CHECK(c, what) do { if (c) printf("ok    %s\n", what); else { printf("FAIL  %s\n", what); fails++; } } while (0)

static int get(uint32_t structure, const char *name, int32_t *v0, uint32_t *n)
{
    int i = ps_find(structure, name);
    uint32_t st;
    char nm[PS_NAME + 1];
    if (i < 0 || ps_read((uint32_t)i, &st, nm, n))
        return -1;
    *v0 = *n ? ps_vbuf[0] : 0;
    return 0;
}


/* ---- presets of two slots (#485): a model of what the store should hold, checked against it ---- */

#define MNAMES 48u
static struct { uint32_t n, seed; } model[MNAMES];     /* n 0: no such preset */
#define MST 0xCA551A01u                                 /* (the structure every model preset has) */

static void mname(char *nm, uint32_t k) { snprintf(nm, PS_NAME, "M%u", k); }
static void mvals(int32_t *v, uint32_t n, uint32_t seed)
{
    uint32_t k;
    for (k = 0; k < n; k++)
        v[k] = (int32_t)(seed * 4099u + k * 65537u);
}
static uint32_t mslots(uint32_t n) { return n ? (n > PS_SLOTV ? 2u : 1u) : 0u; }
static uint32_t mused(void)
{
    uint32_t k, u = 0;
    for (k = 0; k < MNAMES; k++)
        u += mslots(model[k].n);
    return u;
}

/* the store's bookkeeping holds together: every live record reads whole, a pair's second slot is claimed once and shares
 * its sector, no name twice, the live slots counted right */
static int store_ok(void)
{
    uint32_t i, j, claims[PS_SLOTS] = {0}, used = 0;
    ps_hdr_t h, o;
    for (i = 0; i < PS_SLOTS; i++) {
        if (ps_state[i] != PS_LIVE)
            continue;
        if (ps_check(i, &h, 1))
            return 0;
        used += ps_size(i);
        if (h.nvals > PS_SLOTV) {
            if (ps_link[i] >= PS_SLOTS || ps_state[ps_link[i]] != PS_TAIL || ps_link[i] / PS_PER_SEC != i / PS_PER_SEC)
                return 0;
            claims[ps_link[i]]++;
        } else if (ps_link[i] != PS_NONE)
            return 0;
        for (j = i + 1u; j < PS_SLOTS; j++)
            if (ps_state[j] == PS_LIVE && !ps_check(j, &o, 0) && o.structure == h.structure && ps_name_eq(o.name, h.name))
                return 0;
    }
    for (i = 0; i < PS_SLOTS; i++)
        if ((ps_state[i] == PS_TAIL) != (claims[i] == 1u))
            return 0;
    return used == ps_count(PS_LIVE);
}

/* model preset k as the store holds it: 0 none, 1 n values of seed, 2 something else */
static int holds(uint32_t k, uint32_t n, uint32_t seed)
{
    static int32_t want[PS_MAXV];
    char nm[PS_NAME], got[PS_NAME + 1];
    uint32_t st, m, i;
    int at;
    mname(nm, k);
    if ((at = ps_find(MST, nm)) < 0)
        return 0;
    if (ps_read((uint32_t)at, &st, got, &m) || m != n)
        return 2;
    mvals(want, n, seed);
    for (i = 0; i < n; i++)
        if (ps_vbuf[i] != want[i])
            return 2;
    return 1;
}

/* the store holds what the model says, and its bookkeeping holds together */
static int store_is(void)
{
    uint32_t k;
    if (!store_ok())
        return 0;
    for (k = 0; k < MNAMES; k++)
        if (holds(k, model[k].n, model[k].seed) != (model[k].n ? 1 : 0))
            return 0;
    return 1;
}

/* store model preset k (n values, seed), the model following: 0 ok, or the store's code */
static int mput(uint32_t k, uint32_t n, uint32_t seed)
{
    static int32_t v[PS_MAXV];
    char nm[PS_NAME];
    int rc;
    mname(nm, k);
    mvals(v, n, seed);
    rc = ps_put(MST, nm, v, n);
    if (!rc) {
        model[k].n = n;
        model[k].seed = seed;
    }
    return rc;
}

static void mreset(void)
{
    memset(flash, 0xFF, sizeof flash);
    memset(model, 0, sizeof model);
    ps_scan();
}

/* a put of model preset k (n values, seed) cut after every byte it programs in turn, from the flash as it is: after each
 * cut and a power cycle the store holds the old preset or the new one whole (the new one only from some cut on), every
 * other preset as it was, and the bookkeeping holds together. Returns the cuts tried (the last one the put that finished),
 * 0 on a failure; sawold / sawnew: some cut left the old / the new; compacted: the put erased a sector */
static uint8_t snap[FLASH_N];
static uint32_t full_after_cut, most_dels;   /* cuts after which the store was full for the preset */
static uint32_t cut_sweep(uint32_t k, uint32_t n, uint32_t seed, int *sawold, int *sawnew, int *compacted)
{
    uint32_t c, on = model[k].n, oseed = model[k].seed;
    static struct { uint32_t n, seed; } msnap[MNAMES];
    memcpy(snap, flash, sizeof flash);
    memcpy(msnap, model, sizeof model);
    *sawold = *sawnew = *compacted = 0;
    for (c = 0; c < 50000u; c++) {
        int rc, e0 = erases, now;
        memcpy(flash, snap, sizeof flash);
        memcpy(model, msnap, sizeof model);
        ps_scan();
        cut_after = (long)c;
        cut_hit = 0;
        rc = mput(k, n, seed);
        cut_after = -1;
        *compacted |= erases != e0;
        if (!cut_hit) {                                 /* (the put ran to its end: every cut was tried) */
            ps_scan();
            return !rc && store_is() ? c + 1u : 0u;
        }
        (void)rc;
        ps_scan();                                      /* (the power comes back) */
        now = holds(k, n, seed) == 1 ? 2 : holds(k, on, oseed) == 1 && on ? 1 : on ? -1 : holds(k, 0, 0) == 0 ? 0 : -1;
        if (now < 0 || (now == 1 && *sawnew)) {
            printf("      (cut after %u bytes: preset M%u is neither the old nor the new)\n", c, k);
            return 0;
        }
        *sawold |= now == 1;
        *sawnew |= now == 2;
        if (now == 2) {
            model[k].n = n;
            model[k].seed = seed;
        }
        if (!store_is()) {
            printf("      (cut after %u bytes: another preset changed, or the bookkeeping is wrong)\n", c);
            return 0;
        }
        rc = mput(k, n, seed);
        if (rc == -2 && store_is()) {                   /* (a cut in a full store can cost a slot: full until deletes) */
            uint32_t k2, dels = 0;
            char nm2[PS_NAME];
            full_after_cut++;
            while (rc == -2 && dels < 12u) {
                for (k2 = 0; k2 < MNAMES && (k2 == k || !model[k2].n); k2++)
                    ;
                mname(nm2, k2);
                if (k2 == MNAMES || ps_del(MST, nm2))
                    break;
                model[k2].n = 0;
                dels++;
                rc = mput(k, n, seed);
            }
            if (dels > most_dels)
                most_dels = dels;
            if (rc || !store_is()) {
                printf("      (cut after %u bytes: full, and still after %u deletes: %d)\n", c, dels, rc);
                return 0;
            }
        } else if (rc || !store_is()) {                   /* (and storing works again) */
            printf("      (cut after %u bytes: storing again failed: %d, clean %u dead %u live %u)\n", c, rc, ps_count(PS_CLEAN), ps_count(PS_DEAD), ps_count(PS_LIVE));
            return 0;
        }
    }
    return 0;
}

static void pair_tests(void)
{
    static int32_t v[PS_MAXV + 1u];
    uint32_t k, n, i;
    int sawold, sawnew, comp, ok;

    /* a preset of two slots */
    mreset();
    CHECK(mput(0, 118, 1) == 0 && store_is() && ps_count(PS_LIVE) == 2u, "a 118-value preset (Cassia 1): stored whole, in two slots");
    ps_scan();
    CHECK(store_is() && ps_list(MST, 0, 0) == 1u, "after a power cycle: all 118 values, one preset");
    CHECK(mput(0, 118, 2) == 0 && store_is() && ps_count(PS_LIVE) == 2u, "stored over: the new values, still two slots");
    CHECK(mput(0, 60, 3) == 0 && store_is() && ps_count(PS_LIVE) == 1u, "over it with 60 values: one slot");
    CHECK(mput(0, PS_MAXV, 4) == 0 && store_is() && ps_count(PS_LIVE) == 2u, "and with 176, the most: two slots");
    mvals(v, PS_MAXV + 1u, 5);
    CHECK(ps_put(MST, "M0", v, PS_MAXV + 1u) == -3 && store_is(), "177 values: refused, the old one stays");
    CHECK(mput(1, 88, 6) == 0 && ps_count(PS_LIVE) == 3u && store_is(), "88 values still take one slot");
    {
        int at = ps_find(MST, "M0");
        uint32_t t = at >= 0 ? ps_link[at] : PS_NONE;
        CHECK(at >= 0 && t < PS_SLOTS && ps_del(MST, "M0") == 0 && ps_state[at] == PS_DEAD && ps_state[t] == PS_DEAD, "deleted: both its slots dead");
        model[0].n = 0;
        ps_scan();
        CHECK(store_is() && ps_count(PS_LIVE) == 1u, "after a power cycle: gone, the other kept");
    }

    /* a record as older firmware wrote it (one slot, PRS1, magic last) reads as it is */
    mreset();
    {
        ps_hdr_t h;
        memset(&h, 0, sizeof h);
        mvals(v, 40, 7);
        h.magic = PS_MAGIC;
        h.seq = 5;
        h.structure = MST;
        h.nvals = 40;
        h.crc = m1_crc16((const uint8_t *)v, 160);
        memcpy(h.name, "M2", 3);
        memcpy(flash + 3u * PS_SLOT + 32u, v, 160);
        memcpy(flash + 3u * PS_SLOT, &h, sizeof h);
        ps_scan();
        model[2].n = 40;
        model[2].seed = 7;
        CHECK(store_is() && ps_count(PS_LIVE) == 1u, "a preset an older firmware stored: read as it was");
        CHECK(mput(2, 118, 8) == 0 && store_is() && ps_count(PS_LIVE) == 2u, "stored over with 118 values: two slots");
    }

    /* a second slot nobody claims (a write cut after it, before the first slot's commit): killed by the scan */
    mreset();
    {
        uint32_t s[2];
        mvals(v, 118, 9);
        CHECK(!ps_alloc(2, PS_NSEC, s), "(two clean slots)");
        cut_after = 32 + 30 * 4 + 88 * 4;               /* the second slot whole, the first's values, no header */
        CHECK(ps_prog(s[0], s[1], MST, "M3", v, 118) != 0, "(a pair cut before its commit)");
        cut_after = -1;
        ps_scan();
        CHECK(ps_state[s[1]] == PS_DEAD && ps_list(0, 0, 0) == 0u && store_is(), "its second slot: killed at the next scan, no preset");
        CHECK(mput(3, 118, 10) == 0 && store_is(), "and storing works");
    }

    /* cut at every byte: a new pair, a pair over a pair, a pair over one slot, one slot over a pair */
    mreset();
    (void)mput(10, 30, 11);
    (void)mput(11, 118, 12);
    n = cut_sweep(0, 118, 13, &sawold, &sawnew, &comp);
    CHECK(n > 0u && !sawold && !sawnew, "a new 118-value preset cut at each of its bytes: none of it or all, the others kept");
    printf("      (%u cuts)\n", n);
    n = cut_sweep(0, 118, 14, &sawold, &sawnew, &comp);
    CHECK(n > 0u && sawold && sawnew, "stored over, cut at each byte: the old values or the new, never a mix");
    printf("      (%u cuts)\n", n);
    n = cut_sweep(10, 118, 15, &sawold, &sawnew, &comp);
    CHECK(n > 0u && sawold && sawnew, "one slot replaced by two, cut at each byte: the old or the new");
    n = cut_sweep(11, 50, 16, &sawold, &sawnew, &comp);
    CHECK(n > 0u && sawold && sawnew, "two slots replaced by one, cut at each byte: the old or the new");
    n = cut_sweep(1, 30, 17, &sawold, &sawnew, &comp);
    CHECK(n > 0u, "a one-slot preset beside pairs, cut at each byte");

    /* a full store of pairs: 30 of them, then full; storing over goes on (compaction moves pairs whole) */
    mreset();
    for (k = 0, ok = 1; k < 30u; k++)
        ok &= mput(k, 118, 100u + k) == 0;
    CHECK(ok && ps_count(PS_LIVE) == PS_MAX && store_is(), "30 presets of 118 values: the store's 60 slots");
    mvals(v, 118, 1);
    CHECK(ps_put(MST, "M40", v, 118) == -2 && ps_put(MST, "M41", v, 10) == -2, "full: another pair refused, and a single");
    for (i = 0, ok = 1; i < 600u && ok; i++)
        ok = mput(i * 7u % 30u, 118, 1000u + i) == 0;
    CHECK(ok && store_is() && erases > 0, "600 pairs stored over in a full store: each fits (compaction)");
    CHECK(mput(5, 20, 7) == 0 && mput(40, 20, 8) == 0 && ps_count(PS_LIVE) == PS_MAX, "a pair stored as one slot frees one: a new one-slot preset fits");
    CHECK(ps_put(MST, "M41", v, 118) == -2 && mput(6, 118, 9) == 0, "full: a new pair refused, a pair over a pair fits");
    ps_scan();
    CHECK(store_is(), "after a power cycle: all of them");

    /* compaction moving pairs, cut at every byte: store over in the full store until a put would compact a sector holding a
     * pair, then cut that put at each byte */
    {
        uint32_t sweeps = 0, total = 0;
        for (i = 0; i < 400u && sweeps < 4u; i++) {
            uint32_t sec, best = PS_NSEC, most = 0, kk, pair = 0, name = (i * 11u + 3u) % 30u;
            if (name == 5u)
                name = 7u;
            for (sec = 0; sec < PS_NSEC; sec++) {
                uint32_t dead = 0;
                for (kk = 0; kk < PS_PER_SEC; kk++)
                    dead += ps_state[sec * PS_PER_SEC + kk] == PS_DEAD;
                if (dead > most) {
                    most = dead;
                    best = sec;
                }
            }
            for (kk = 0; best < PS_NSEC && kk < PS_PER_SEC; kk++)
                pair |= ps_state[best * PS_PER_SEC + kk] == PS_TAIL;
            if (ps_count(PS_CLEAN) < PS_KEEP + 2u && pair) {
                n = cut_sweep(name, 118, 5000u + i, &sawold, &sawnew, &comp);
                if (!n || !comp || !sawold || !sawnew)
                    break;
                total += n;
                sweeps++;
            } else if (mput(name, 118, 3000u + i))
                break;
        }
        CHECK(sweeps == 4u, "four compactions that move pairs, each cut at every byte: every preset whole after each cut");
        printf("      (%u cuts in all; after %u of them storing it again was refused as full until up to %u presets were deleted)\n", total, full_after_cut, most_dels);
    }

    /* a mixed workload against the model: refused as full exactly when the live slots would pass 60, never otherwise */
    {
        static const uint32_t sizes[] = { 1, 30, 88, 89, 118, 176 };
        uint32_t seed = 12345, refused = 0;
        mreset();
        for (i = 0, ok = 1; i < 6000u && ok; i++) {
            uint32_t r, nk, want, over;
            int rc;
            char nm[PS_NAME];
            seed = seed * 1103515245u + 12345u;
            r = seed >> 8;
            nk = r % MNAMES;
            mname(nm, nk);
            if ((r >> 8) % 7u == 0u) {
                rc = ps_del(MST, nm);
                ok = (rc == 0) == (model[nk].n != 0);
                model[nk].n = 0;
            } else {
                want = sizes[(r >> 12) % 6u];
                over = mused() - mslots(model[nk].n) + mslots(want) > PS_MAX;
                rc = mput(nk, want, i + 1u);
                refused += rc == -2;
                ok = over ? rc == -2 : rc == 0;
            }
            if (ok && i % 97u == 0u) {
                ps_scan();
                ok = store_is();
            }
            if (!ok)
                printf("      (step %u went wrong)\n", i);
        }
        CHECK(ok && store_is(), "6000 mixed stores and deletes (1 to 176 values): full only past 60 slots, every preset whole");
        printf("      (%u refused as full)\n", refused);
    }

    /* a second slot's magic in foreign bytes: no record claims it, the scan kills it */
    mreset();
    {
        uint32_t m = PS_TAILM;
        memcpy(flash + 5u * PS_SLOT, &m, 4);
        ps_scan();
        CHECK(ps_state[5] == PS_DEAD && ps_list(0, 0, 0) == 0u && store_is(), "a lone second slot: dead, no preset");
    }
}

int main(void)
{
    int32_t v[PS_MAXV], got;
    uint32_t n, i, k;
    char name[PS_NAME + 1];
    uint8_t list[PS_SLOTS];
    memset(flash, 0xFF, sizeof flash);
    for (i = 0; i < PS_MAXV; i++)
        v[i] = (int32_t)(i * 65536);
    ps_scan();
    CHECK(ps_list(0, 0, 0) == 0u, "an erased store: no presets");

    CHECK(ps_put(0xABCD1234u, "GLASS", v, 24) == 0, "store a preset");
    v[0] = 7;
    CHECK(ps_put(0xABCD1234u, "DUSK", v, 24) == 0, "and another of the same structure");
    CHECK(ps_put(0x11111111u, "KIT", v, 8) == 0, "and one of another structure");
    CHECK(ps_list(0xABCD1234u, list, PS_SLOTS) == 2u, "two of the first structure");
    CHECK(!ps_read(list[0], &k, name, &n) && !strcmp(name, "DUSK") && n == 24u && ps_vbuf[0] == 7, "in name order: DUSK first, its values");
    v[0] = 99;
    CHECK(ps_put(0xABCD1234u, "GLASS", v, 24) == 0 && !get(0xABCD1234u, "GLASS", &got, &n) && got == 99, "overwrite: the new values");
    CHECK(ps_list(0xABCD1234u, 0, 0) == 2u, "still two");
    v[0] = 98;
    CHECK(ps_put(0xABCD1234u, "Glass", v, 24) == 0 && ps_list(0xABCD1234u, 0, 0) == 2u && !get(0xABCD1234u, "GLASS", &got, &n) && got == 98,
          "a name in another case is the same preset (the editor's Glass is the panel's GLASS)");
    v[0] = 99;
    CHECK(ps_put(0xABCD1234u, "GLASS", v, 24) == 0, "(back to its values)");
    ps_scan();
    CHECK(ps_list(0, 0, 0) == 3u && !get(0xABCD1234u, "GLASS", &got, &n) && got == 99, "after a power cycle: the same three, the new values");
    CHECK(ps_del(0x11111111u, "KIT") == 0 && ps_list(0, 0, 0) == 2u && ps_del(0x11111111u, "KIT") == -1, "delete one; again: none");
    CHECK(ps_put(1, "X", v, PS_MAXV + 1u) == -3, "too many values: refused");

    /* a cut write: the old record stays */
    v[0] = 5;
    cut_after = 40;                                     /* the values go, the header not */
    CHECK(ps_put(0xABCD1234u, "GLASS", v, 24) != 0, "a write cut before its header: an error");
    cut_after = -1;
    ps_scan();
    CHECK(!get(0xABCD1234u, "GLASS", &got, &n) && got == 99, "after the power comes back: the old values");
    cut_after = 24 * 4 + 20;                            /* the values, the header half written, no magic */
    (void)ps_put(0xABCD1234u, "GLASS", v, 24);
    cut_after = -1;
    ps_scan();
    CHECK(!get(0xABCD1234u, "GLASS", &got, &n) && got == 99 && ps_list(0, 0, 0) == 2u, "a half-written header: the old record, no ghost");

    /* a cut between the new record and the old one's kill: both valid, the newer wins at the next scan */
    {
        uint32_t s[2];
        int old = ps_find(0xABCD1234u, "GLASS");
        v[0] = 123;
        CHECK(!ps_alloc(1, PS_NSEC, s) && ps_prog(s[0], 0, 0xABCD1234u, "GLASS", v, 24) == 0 && old >= 0, "(a new copy written, the old not killed)");
        ps_scan();
        CHECK(!get(0xABCD1234u, "GLASS", &got, &n) && got == 123 && ps_list(0xABCD1234u, 0, 0) == 2u, "the next scan: the newer copy, one GLASS");
    }

    /* fill it: compaction makes room until PS_MAX live presets, then full */
    for (i = 0; ; i++) {
        char nm[PS_NAME];
        int rc;
        snprintf(nm, sizeof nm, "P%u", i);
        v[0] = (int32_t)i;
        rc = ps_put(0x22222222u, nm, v, 30);
        if (rc) {
            CHECK(rc == -2, "full: refused as full");
            break;
        }
        if (i > 500u)
            break;
    }
    CHECK(ps_list(0, 0, 0) == PS_MAX, "full at PS_MAX live presets (about 60)");
    for (i = 0; i < 2000u; i++) {                       /* overwrites go on forever: compaction keeps up */
        char nm[PS_NAME];
        snprintf(nm, sizeof nm, "P%u", i % 20u);
        v[0] = (int32_t)(1000 + i);
        if (ps_put(0x22222222u, nm, v, 30)) {
            printf("      (overwrite %u failed)\n", i);
            break;
        }
    }
    CHECK(i == 2000u && erases > 0, "2000 overwrites in a full store: every one fits (compaction)");
    ps_scan();
    CHECK(ps_list(0, 0, 0) == PS_MAX && !get(0x22222222u, "P19", &got, &n) && got == 1000 + 1999, "after a power cycle: all there, the newest values");

    /* foreign bytes: another firmware's data in the sectors */
    for (i = 0; i < FLASH_N; i++)
        flash[i] = (uint8_t)(i * 37u + 11u);
    ps_scan();
    CHECK(ps_list(0, 0, 0) == 0u, "foreign bytes: no presets read");
    CHECK(ps_put(0xABCD1234u, "NEW", v, 10) == 0 && ps_list(0, 0, 0) == 1u, "and storing works (dead slots compacted)");
    pair_tests();
    printf(fails ? "preset store test FAILED\n" : "preset store test passed\n");
    return fails != 0;
}
