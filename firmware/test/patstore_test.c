/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The pattern store (firmware/src/patstore.c, #901, #1202) and the bank's hand-over of its sectors (slotstore.c pt_claim:
 * 48 slots and 16 store sectors, or 60 and 4) on the host, over a RAM flash that behaves like NOR: an erase sets a sector
 * to 0xFF, a program only clears bits. A program can be cut after n bytes and an erase refused (a power cut); each cut
 * test cuts at every byte the operation programs and at every erase, boots again (sl_scan, pt_claim, the store's scan)
 * and checks that the record is the old one or the new one, that every other record is intact, and that the store takes
 * writes again. tools/patstore_test.sh. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define M1_NAME 20u
#define M1_SLOTS 64u
#define M1_PATCH_MAX 3840u
#define ENG_POOL
static uint32_t bank_slots = M1_SLOTS;          /* (proto.c's) */
static uint8_t m1_up[M1_PATCH_MAX];             /* (proto.c's: the store's scan keeps half its table there) */

#define FLASH_LO 0x97000u                       /* the bank's first sector .. the pattern store's last */
#define FLASH_HI 0xE0000u
static uint8_t flash[FLASH_HI], saved[FLASH_HI];
static long cut_after = -1;                     /* bytes the next programs may write before the "power" goes, -1 no cut */
static int cut_hit;                             /* a program or erase was refused for the cut */
static uint32_t erases;

static void fm1_wdt_feed(void) {}
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    if (off < FLASH_LO || off + n > FLASH_HI)
        return -8;
    memcpy(dst, flash + off, n);
    return 0;
}
static int st_erase(uint32_t off)
{
    if (cut_after == 0) {                       /* (the power is gone: an erase is not modelled half done) */
        cut_hit = 1;
        return -9;
    }
    if (off < FLASH_LO || off + 0x1000u > FLASH_HI || (off & 0xFFFu))
        return -8;
    memset(flash + off, 0xFF, 0x1000u);
    erases++;
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    const uint8_t *s = src;
    uint32_t i;
    if (off < FLASH_LO || off + n > FLASH_HI)
        return -8;
    for (i = 0; i < n; i++) {
        if (cut_after == 0) {
            cut_hit = 1;
            return -9;
        }
        if (cut_after > 0)
            cut_after--;
        flash[off + i] &= s[i];
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

#include "../src/slotstore.c"
#include "../src/patstore.c"
#define NS ((uint32_t)SL_L48.pt_nsec)            /* the store's sectors in the 48-slot layout */

static int fails;
#define CHECK(c, ...) do { if (!(c)) { if (fails++ < 40) { printf("FAIL  "); printf(__VA_ARGS__); printf("\n"); } } } while (0)

static void save(void) { memcpy(saved + FLASH_LO, flash + FLASH_LO, FLASH_HI - FLASH_LO); }
static void restore(void) { memcpy(flash + FLASH_LO, saved + FLASH_LO, FLASH_HI - FLASH_LO); }

/* a power-on: the RAM state as after a reset, then the boot's sl_scan, pt_claim and the store's scan (main.c) */
static void boot(void)
{
    cut_after = -1;
    sl_next = 0;
    sl_layout(0);
    pt_on = 0;
    pt_scanned = 0;
    pt_seq = pt_nextid = 0;
    memset(pt_tail, 0, sizeof pt_tail);
    sl_scan();
    pt_claim();
    if (pt_on)
        pt_scan();
}

static void fresh(void)
{
    memset(flash, 0xFF, sizeof flash);
    boot();
}

static void mk(uint8_t *p, uint32_t len, uint32_t seed)
{
    uint32_t i;
    for (i = 0; i < len; i++)
        p[i] = (uint8_t)(seed * 131u + i * 7u + (i >> 5) * 3u + (seed >> 3));
}

/* ---- a model of the store's records ---- */

typedef struct { uint32_t id, len, seed; char name[PT_NAME + 1]; } rec_t;
static rec_t model[2048];
static uint32_t nmodel;

static int put(rec_t *r)
{
    static uint8_t b[PT_MAX];
    uint32_t id = r->id;
    int rc;
    mk(b, r->len, r->seed);
    rc = pt_put(&id, r->name, b, r->len);
    if (!rc)
        r->id = id;
    return rc;
}

/* the store holds r under id (r 0: nothing under id) */
static int same(uint32_t id, const rec_t *r)
{
    static uint8_t got[PT_MAX], want[PT_MAX];
    pt_info_t in;
    int rc = pt_read(id, got, sizeof got, &in);
    if (!r)
        return rc == -1 && pt_stat(id, &in) == -1;
    mk(want, r->len, r->seed);
    return rc == 0 && in.id == id && in.len == r->len && !memcmp(got, want, r->len) && !strcmp(in.name, r->name)
        && in.hash == pt_fnv(PT_FNV0, want, r->len);
}

static rec_t *add(uint32_t len, uint32_t seed)
{
    rec_t *r = &model[nmodel];
    r->id = 0;
    r->len = len;
    r->seed = seed;
    snprintf(r->name, sizeof r->name, "PAT %u", seed);
    if (put(r))
        return 0;
    nmodel++;
    return r;
}

static void drop(uint32_t id)
{
    uint32_t k;
    for (k = 0; k < nmodel; k++)
        if (model[k].id == id) {
            model[k] = model[--nmodel];
            return;
        }
}

static rec_t *find(uint32_t id)
{
    uint32_t k;
    for (k = 0; k < nmodel; k++)
        if (model[k].id == id)
            return &model[k];
    return 0;
}

/* every model record is in the store, and nothing else but (with extra != 0) one more */
static int model_ok(uint32_t extra)
{
    uint32_t k;
    for (k = 0; k < nmodel; k++)
        if (!same(model[k].id, &model[k]))
            return 0;
    return pt_count() == nmodel + extra;
}

/* ---- the API ---- */

static void api_tests(void)
{
    static uint8_t b[PT_MAX + 4];
    static const uint32_t lens[] = {1, 3, 4, 5, 100, 257, 1000, 2048, 64, 65};
    pt_info_t in;
    uint32_t k, id, prev;
    rec_t *r;
    fresh();
    CHECK(pt_on && bank_slots == 48u && pt_nsec == NS, "an empty bank: the store is claimed, 48 slots, %u sectors", NS);
    CHECK(pt_count() == 0u && pt_next(0, &in) == -1 && pt_prev(0xFFFFu, &in) == -1, "an empty store");
    CHECK(pt_total_bytes() == (NS - 1u) * 4080u && pt_free_bytes() == PT_MAX, "room: all sectors but one, a record of PT_MAX fits");
    nmodel = 0;
    for (k = 0; k < sizeof lens / sizeof lens[0]; k++) {
        r = add(lens[k], 10u + k);
        CHECK(r && r->id == k + 1u, "new pattern %u (len %u) gets id %u", k, lens[k], k + 1u);
    }
    CHECK(model_ok(0), "they read back whole");
    for (prev = 0, k = 0; !pt_next(prev, &in); k++)
        prev = in.id;
    CHECK(k == nmodel && prev == nmodel, "pt_next walks them all by id");
    CHECK(!pt_prev(0xFFFFu, &in) && in.id == nmodel && !pt_prev(in.id, &in) && in.id == nmodel - 1u && pt_prev(1, &in) == -1,
          "pt_prev walks back");
    r = find(7);
    r->len = 333;
    r->seed = 77;
    CHECK(put(r) == 0 && r->id == 7u && model_ok(0), "a replace keeps the id, the new contents read back");
    r->seed = 78;
    strcpy(r->name, "RENAMED");
    CHECK(put(r) == 0 && model_ok(0), "a rename (the same id, a new name)");
    CHECK(pt_read(8, b, 10, &in) == -3 && in.id == 8u && in.len == 2048u, "pt_read: longer than cap: -3, the info filled");
    CHECK(pt_del(3) == 0 && pt_del(3) == -4, "delete; a second delete: missing");
    drop(3);
    CHECK(model_ok(0) && pt_stat(3, &in) == -1 && pt_read(3, b, sizeof b, &in) == -1, "the deleted one is gone, the rest stay");
    CHECK(!pt_next(2, &in) && in.id == 4u && !pt_prev(4, &in) && in.id == 2u, "next / prev step over the deleted id");
    id = 3;
    CHECK(pt_put(&id, "X", b, 10) == -4, "a put over a deleted id: missing");
    id = 0;
    CHECK(pt_put(&id, "X", b, 0) == -3 && pt_put(&id, "X", b, PT_MAX + 1u) == -3, "len 0 or > PT_MAX: range");
    r = add(20, 99);
    CHECK(r && r->id == 11u, "the next new id is 11 (3 is not taken again)");
    boot();
    CHECK(model_ok(0), "after a power cycle: all there");
    r = add(20, 100);
    CHECK(r && r->id == 12u, "and new ids go on from 12");
    pt_nextid = PT_ID_MAX;
    r = add(8, 101);
    CHECK(r && r->id == PT_ID_MAX, "the last id");
    id = 0;
    CHECK(pt_put(&id, "X", b, 8) == -3, "then the ids are used up: range");
    boot();
    id = 0;
    CHECK(pt_put(&id, "X", b, 8) == -3 && model_ok(0), "also after a power cycle");
    printf("ok    the API: put / read / replace / rename / delete / next / prev / ranges\n");
}

/* every call refuses while the store is off */
static void refuses(const char *what)
{
    uint8_t b[8] = {0};
    pt_info_t in;
    uint32_t id = 0;
    CHECK(!pt_on && pt_put(&id, "X", b, 8) == -1 && pt_read(1, b, 8, &in) == -1 && pt_stat(1, &in) == -1 && pt_del(1) == -1
          && pt_count() == 0u && pt_next(0, &in) == -1 && pt_prev(9, &in) == -1 && pt_free_bytes() == 0u
          && pt_total_bytes() == 0u, "%s: every pt_ call refuses", what);
    save();
    pt_clear_all();
    CHECK(!memcmp(flash + FLASH_LO, saved + FLASH_LO, FLASH_HI - FLASH_LO), "%s: pt_clear_all leaves the flash alone", what);
}

/* ---- full, and the free room it reports ---- */

static uint32_t lcg = 12345u;
static uint32_t rnd(uint32_t n)
{
    lcg = lcg * 1103515245u + 12345u;
    return (lcg >> 8) % n;
}

static void full_tests(void)
{
    uint32_t k, n, f, len, mism = 0, puts = 0, fulls = 0;
    rec_t r;
    fresh();
    nmodel = 0;
    for (n = 0; add(4, n); n++)
        ;
    CHECK(n == 102u * (NS - 1u) && pt_free_bytes() == 0u, "records of 4 bytes: full at 102 in each sector but the clean one");
    boot();
    CHECK(model_ok(0), "all there after a power cycle");
    fresh();
    nmodel = 0;
    for (n = 0; add(PT_MAX, n); n++)
        ;
    CHECK(n == NS - 1u && pt_free_bytes() == 1960u, "records of PT_MAX: one a sector, a record of 1960 bytes still fits");
    for (k = 0; k < NS - 1u; k++)
        CHECK(add(1960, 50u + k) != 0, "1960 bytes in sector %u's tail", k);
    CHECK(pt_free_bytes() == 0u && !add(4, 70), "one in each sector's tail; then nothing fits");
    fresh();
    nmodel = 0;
    for (k = 0; k < 4000u; k++) {                       /* random puts, replaces and deletes: what pt_free_bytes says fits fits */
        uint32_t op = rnd(10);
        if (op < 5u || !nmodel) {
            len = rnd(4) ? 1u + rnd(300) : 1u + rnd(PT_MAX);
            f = pt_free_bytes();
            r.id = 0;
            r.len = len;
            r.seed = 1000u + k;
            snprintf(r.name, sizeof r.name, "R%u", k);
            int rc = put(&r);
            mism += (rc == 0) != (len <= f) || (rc && rc != -2);
            if (!rc)
                model[nmodel++] = r;
            puts++;
            fulls += rc == -2;
        } else if (op < 8u) {
            rec_t *m = &model[rnd(nmodel)];
            r = *m;
            r.len = 1u + rnd(400);
            r.seed = 5000u + k;
            int rc = put(&r);
            mism += rc && rc != -2;
            if (!rc)
                *m = r;
        } else {
            uint32_t i = rnd(nmodel);
            mism += pt_del(model[i].id) != 0;
            drop(model[i].id);
        }
        if (k % 250u == 249u) {
            boot();
            mism += !model_ok(0);
        }
    }
    CHECK(!mism && fulls > 0, "4000 random operations: a new pattern fits exactly when pt_free_bytes says so (%u full)", fulls);
    CHECK(model_ok(0), "and the store holds what it should");
    printf("ok    full stores and the free room (%u puts)\n", puts);
}

/* ---- ids are never taken again ---- */

static void id_tests(void)
{
    rec_t *r;
    uint32_t k, top;
    fresh();
    nmodel = 0;
    for (k = 0; k < 10u; k++)
        add(500, k);
    top = model[nmodel - 1u].id;
    while (nmodel) {
        CHECK(pt_del(model[0].id) == 0, "delete %u", model[0].id);
        drop(model[0].id);
    }
    for (k = 0; k < 40u; k++) {                         /* churn: compactions erase the killed records' sectors */
        r = add(1500, 100u + k);
        CHECK(r != 0, "churn put %u", k);
        if (r)
            top = r->id;
        if (nmodel > 3u) {
            CHECK(pt_del(model[0].id) == 0, "churn delete");
            drop(model[0].id);
        }
    }
    CHECK(erases > 0, "the churn compacted");
    while (nmodel) {
        pt_del(model[0].id);
        drop(model[0].id);
    }
    boot();
    r = add(10, 999);
    CHECK(r && r->id == top + 1u, "after deletes, compactions and a power cycle the next id is %u (got %u)", top + 1u, r ? r->id : 0u);
}

/* ---- power cuts ---- */

static uint8_t sw_buf[PT_MAX];
static rec_t sw_old, sw_new;
static int sw_has_old, sw_has_new;
static uint32_t sw_target;

static int op_put(void)
{
    uint32_t id = sw_has_old ? sw_target : 0u;
    mk(sw_buf, sw_new.len, sw_new.seed);
    return pt_put(&id, sw_new.name, sw_buf, sw_new.len);
}
static int op_del(void) { return pt_del(sw_target); }

/* cut op at every byte it programs and at every erase, from the flash as it is now; the model holds the other records,
 * sw_old / sw_new the target before and after (sw_has_*: it exists) */
static void sweep(const char *what, int (*op)(void), int compacts)
{
    uint32_t c, before = erases, maxid;
    save();
    for (c = 0;; c++) {
        int rc, done, present;
        rec_t a;
        restore();
        boot();
        (void)pt_count();                               /* (the scan, before the cut) */
        maxid = pt_nextid;
        cut_hit = 0;
        before = erases;
        cut_after = (long)c;
        rc = op();
        done = !cut_hit;
        cut_after = -1;
        if (done)
            CHECK(rc == 0 && (!compacts || erases > before), "%s: uncut, it works%s", what, compacts ? " and compacts" : "");
        boot();
        present = pt_stat(sw_target, 0) == 0;
        CHECK(model_ok(present ? 1u : 0u), "%s, cut at %u: every other record intact", what, c);
        CHECK((sw_has_old && same(sw_target, &sw_old)) || (sw_has_new && same(sw_target, &sw_new))
              || (!present && (!sw_has_old || !sw_has_new)), "%s, cut at %u: the record is the old one or the new one", what, c);
        if (done)
            CHECK(sw_has_new ? same(sw_target, &sw_new) : !present, "%s: uncut, the new state", what);
        CHECK(pt_clean(PT_NSEC) < PT_NSEC, "%s, cut at %u: a clean sector again", what, c);
        a.id = 0;
        a.len = 24;
        a.seed = 7000u + c;
        strcpy(a.name, "AFTER");
        CHECK(!put(&a) && same(a.id, &a) && a.id >= maxid && (!present || a.id > sw_target),
              "%s, cut at %u: the store takes a new pattern (id %u, at least %u)", what, c, a.id, maxid);
        CHECK(model_ok(present ? 2u : 1u), "%s, cut at %u: and the others are still there", what, c);
        if (done)
            break;
    }
    restore();
    printf("ok    a cut at every one of the %u steps of %s\n", c + 1u, what);
}

/* the basic state: a few records in sector 0 and 1 */
static void state_basic(void)
{
    static const uint32_t lens[] = {1, 5, 100, 257, 1000, 2048, 64, 300};
    uint32_t k;
    fresh();
    nmodel = 0;
    for (k = 0; k < sizeof lens / sizeof lens[0]; k++)
        add(lens[k], 20u + k);
}

/* the target, taken out of the model */
static void target(uint32_t id, uint32_t newlen, uint32_t newseed, int del)
{
    rec_t *r = find(id);
    sw_target = id;
    sw_has_old = r != 0;
    if (r) {
        sw_old = *r;
        drop(id);
    }
    sw_has_new = !del;
    sw_new.id = id;
    sw_new.len = newlen;
    sw_new.seed = newseed;
    snprintf(sw_new.name, sizeof sw_new.name, "NEW %u", newseed);
}

/* sectors 0..14 full of 200-byte records (17 each), 15 clean, then 3 deleted in sector 1: the next put that finds no free
 * tail compacts sector 1 (14 records copied) */
static void state_compact(void)
{
    uint32_t k;
    fresh();
    nmodel = 0;
    for (k = 0; k < 17u * (NS - 1u); k++)
        add(200, 40u + k);
    CHECK(!add(200, 999) && pt_count() == 17u * (NS - 1u), "records of 200 bytes fill the store");
    for (k = 20; k <= 30u; k += 5u) {
        pt_del(k);
        drop(k);
    }
}

static void cut_tests(void)
{
    uint32_t k;
    state_basic();
    target(pt_nextid, 300, 500, 0);
    sweep("a new record", op_put, 0);
    state_basic();
    target(4, 700, 501, 0);
    sweep("a replace", op_put, 0);
    state_basic();
    target(5, 0, 0, 1);
    sweep("a delete", op_del, 0);
    state_compact();
    target(pt_nextid, 600, 502, 0);
    sweep("a new record that compacts", op_put, 1);
    state_compact();
    target(22, 400, 503, 0);
    sweep("a replace that compacts the record's own sector", op_put, 1);
    state_compact();
    target(5, 300, 504, 0);
    sweep("a replace that compacts another sector", op_put, 1);
    /* the largest id deleted, alone in its sector: compacting that sector copies nothing, so the clean sector is
     * formatted again first (it carries the next id) and the deleted id is not taken again after any cut */
    fresh();
    nmodel = 0;
    for (k = 0; k < NS - 1u; k++)
        add(PT_MAX, 60u + k);
    pt_del(NS - 1u);
    drop(NS - 1u);
    target(pt_nextid, PT_MAX, 505, 0);
    CHECK(sw_target == NS, "the next id is %u", NS);
    sweep("a new record that compacts a sector of deleted records only", op_put, 1);
}

/* ---- foreign bytes ---- */

static void foreign_tests(void)
{
    uint32_t a, k;
    pt_hdr_t h;
    for (a = 0xE0000u - NS * 0x1000u; a < 0xE0000u; a++)   /* another firmware's data where the store goes */
        flash[a] = (uint8_t)(a * 37u + 11u);
    memset(flash + FLASH_LO, 0xFF, 0xE0000u - NS * 0x1000u - FLASH_LO);
    boot();
    for (k = 0; k < NS && pt_sec_ok(k); k++)
        ;
    CHECK(pt_on && k == NS && pt_count() == 0u, "foreign bytes in the store's sectors before the claim: formatted, an empty store");
    nmodel = 0;
    CHECK(add(100, 1) && add(200, 2) && model_ok(0), "and it works");
    a = PT_BASE + pt_tail[0] + 64u;                     /* bytes programmed into sector 0's free tail */
    for (k = 0; k < 40u; k++)
        flash[a + k] &= (uint8_t)(k * 13u);
    boot();
    CHECK(model_ok(0) && pt_tail[0] == PT_SEC, "foreign bytes in a free tail: the records stay, the rest of the sector is dead");
    for (k = 0; k < 30u; k++)
        CHECK(add(150, 10u + k) != 0, "puts after it %u", k);
    CHECK(model_ok(0), "and the store goes on");
    memset(&h, 0, sizeof h);                            /* a committed header over garbage at sector 1's tail */
    h.magic = PT_MAGIC;
    h.seq = 1;
    h.id = 3333;
    h.len = 40;
    h.crc = 0x1234;
    a = PT_BASE + PT_SEC + pt_tail[1];
    for (k = 0; k < sizeof h; k++)
        flash[a + k] &= ((uint8_t *)&h)[k];
    for (k = 0; k < 40u; k++)
        flash[a + sizeof h + k] &= (uint8_t)k;
    boot();
    CHECK(model_ok(0) && pt_stat(3333, 0) == -1 && flash[a] == 0, "a committed record whose CRC fails: killed, not listed");
    CHECK(add(10, 99) && add(10, 98) && model_ok(0), "the store goes on");
    printf("ok    foreign bytes\n");
}

/* ---- the claim ---- */

#define SET_SEED 777u
static uint32_t plen(uint32_t id) { return 64u + (id * 37u) % 900u; }
static void pname(char *nm, uint32_t id) { snprintf(nm, M1_NAME, "P%02u", id); }

static void bank_write(uint32_t id)
{
    static uint8_t b[M1_PATCH_MAX];
    char nm[M1_NAME + 1] = {0};
    if (id == SL_SETTINGS) {
        mk(b, 16, SET_SEED);
        CHECK(sl_write(SL_SETTINGS, 0, b, 16) == 0, "settings written");
        return;
    }
    pname(nm, id);
    mk(b, plen(id), id);
    CHECK(sl_write(id, nm, b, plen(id)) == 0, "patch %u written", id);
}

/* the bank an older firmware left (64 slots, 66 sectors): patches 0..55 and 60..63, the settings; the settings and
 * patches 60, 61 and 50 in sectors 62..65 */
static void old_bank(void)
{
    uint32_t id;
    memset(flash, 0xFF, sizeof flash);
    sl_layout(0);
    pt_on = 0;
    sl_next = 0;
    sl_scan();
    for (id = 0; id < 50u; id++)
        bank_write(id);
    sl_next = 62;
    bank_write(SL_SETTINGS);
    bank_write(60);
    bank_write(61);
    bank_write(50);
    for (id = 51; id < 56u; id++)
        bank_write(id);
    bank_write(62);
    bank_write(63);
    CHECK(sl_sec[SL_SETTINGS] == 62u && sl_sec[60] == 63u && sl_sec[50] == 65u, "the old bank's layout");
}
static uint32_t id_old(uint32_t s) { return s < 56u ? s : s + 4u; }

/* the bank of 1.25 (60 slots, the store in the last 4 sectors): patches 0..39 and 50..57 (48), the settings; the
 * settings and patches 52..57 in sectors 50..56; 3 stored patterns */
static void bank_125(void)
{
    uint32_t id;
    memset(flash, 0xFF, sizeof flash);
    sl_layout(0);
    pt_on = 0;
    sl_next = 0;
    sl_scan();
    sl_layout(&SL_L60);
    for (id = 0; id < 40u; id++)
        bank_write(id);
    bank_write(50);
    bank_write(51);
    sl_next = 50;
    bank_write(SL_SETTINGS);
    for (id = 52; id < 58u; id++)
        bank_write(id);
    pt_on = 1;                                          /* (1.25's claim got through) */
    pt_clear_all();
    nmodel = 0;
    add(300, 1);
    add(2000, 2);
    add(40, 3);
    CHECK(sl_sec[SL_SETTINGS] == 50u && sl_sec[57] == 56u && pt_count() == 3u, "the bank of 1.25");
}
static uint32_t id_125(uint32_t s) { return s < 40u ? s : s + 10u; }

/* the layout l is on with n patches: slot s < n holds patch id_of(s), every other slot is empty, the settings record is
 * there, the records are in the bank's sectors only, and the store's sectors are formatted */
static int bank_ok(const sl_layout_t *l, uint32_t n, uint32_t (*id_of)(uint32_t))
{
    static uint8_t b[M1_PATCH_MAX], w[M1_PATCH_MAX];
    char nm[M1_NAME + 1], want[M1_NAME + 1];
    uint32_t id, s, len;
    if (!pt_on || bank_slots != l->slots || pt_nsec != l->pt_nsec || bank_mask >> l->slots)
        return 0;
    for (s = 0; s < l->slots; s++) {
        if (s >= n) {
            if (bank_mask >> s & 1u)
                return 0;
            continue;
        }
        id = id_of(s);
        memset(want, 0, sizeof want);
        pname(want, id);
        mk(w, plen(id), id);
        if (!(bank_mask >> s & 1u) || sl_read(s, b, &len, nm) || strcmp(nm, want) || len != plen(id) || memcmp(b, w, len))
            return 0;
    }
    mk(w, 16, SET_SEED);
    if (sl_read(SL_SETTINGS, b, &len, 0) || len != 16u || memcmp(b, w, 16) || sl_sec[SL_SETTINGS] >= l->nsec)
        return 0;
    for (s = l->nsec; s < SL_NSEC; s++)
        if (sl_live[s])
            return 0;
    for (s = 0; s < l->pt_nsec; s++)
        if (!pt_sec_ok(s))
            return 0;
    return 1;
}

/* the claim cut at every byte and erase it programs, from the flash save() kept; after each a boot, then ok() */
static uint32_t claim_cuts(int (*ok)(void), const char *what)
{
    uint32_t c;
    for (c = 0;; c++) {
        int done;
        restore();
        sl_layout(0);
        pt_on = 0;
        sl_next = 0;
        sl_scan();
        cut_hit = 0;
        cut_after = (long)c;
        pt_claim();
        done = !cut_hit;
        cut_after = -1;
        if (!done)
            CHECK(!pt_on && bank_slots == M1_SLOTS, "%s cut at %u: the store stays off until a claim gets through", what, c);
        boot();
        CHECK(ok(), "%s cut at %u, then a boot: no patch lost or doubled, the settings and the patterns kept", what, c);
        if (done)
            break;
    }
    return c + 1u;
}
static int old_ok(void) { return bank_ok(&SL_L60, 60u, id_old); }
static int ok_125(void) { return bank_ok(&SL_L48, 48u, id_125) && model_ok(0); }

static void claim_tests(void)
{
    uint32_t c, k;
    rec_t *r;
    old_bank();
    save();
    boot();
    CHECK(old_ok(), "an old bank of 60 patches with some in sectors 62..65 and in slots 61..64 moves into 60 slots");
    nmodel = 0;
    r = add(500, 1);
    CHECK(r && model_ok(0), "and the store works");
    for (k = 0; k < 200u; k++)
        bank_write(k % 3u);
    for (k = 0; k <= SL_SETTINGS; k++)
        CHECK(sl_sec[k] == SL_NONE || sl_sec[k] < SL_L60.nsec, "the bank writes only sectors 0..61 (id %u)", k);
    boot();
    CHECK(model_ok(0) && bank_slots == 60u, "200 bank writes later the store is intact");
    c = claim_cuts(old_ok, "the old bank's move");
    printf("ok    the claim: an old bank of 60 moves into 60 slots; a cut at every one of its %u steps\n", c);

    bank_125();                                         /* #1202: 1.25's 48 patches and store into 48 slots and 16 sectors */
    save();
    boot();
    CHECK(ok_125(), "the bank of 1.25: slots 51..58 move into 41..48, the records out of sectors 50..61, the patterns stay");
    CHECK(pt_total_bytes() == (NS - 1u) * 4080u && sl_font_room(), "the store has its sectors; the font's are free");
    r = add(1500, 4);
    CHECK(r && r->id == 4u && model_ok(0), "and takes new patterns, the ids going on");
    for (k = 0; k < 200u; k++)
        bank_write(k % 3u);
    for (k = 0; k <= SL_SETTINGS; k++)
        CHECK(sl_sec[k] == SL_NONE || sl_sec[k] < SL_L48.nsec, "the bank writes only sectors 0..49 (id %u)", k);
    boot();
    CHECK(model_ok(0) && bank_slots == 48u, "200 bank writes later the store is intact");
    nmodel = 3;                                         /* (the 3 patterns of 1.25 again, for the cuts) */
    c = claim_cuts(ok_125, "the move from 1.25");
    printf("ok    the claim: 1.25's bank and store into 48 slots and 16 sectors; a cut at every one of its %u steps\n", c);

    memset(flash, 0xFF, sizeof flash);                  /* 61 patches: the store stays off */
    sl_layout(0);
    pt_on = 0;
    sl_scan();
    for (k = 0; k < 58u; k++)
        bank_write(k);
    bank_write(60);
    bank_write(61);
    bank_write(62);
    bank_write(SL_SETTINGS);
    save();
    boot();
    CHECK(!pt_on && bank_slots == M1_SLOTS && !memcmp(flash + FLASH_LO, saved + FLASH_LO, FLASH_HI - FLASH_LO),
          "61 patches: nothing moves, the store is off, 64 slots");
    refuses("61 patches");
    for (k = 0; k < 20u; k++)                           /* (the store off: these may land in sectors 62..65) */
        bank_write(62);
    CHECK(sl_erase(57) == 0, "a slot freed");
    boot();
    CHECK(pt_on && bank_slots == 60u && pt_nsec == 4u && bank_mask >> 60 == 0 && sl_sec[SL_SETTINGS] != SL_NONE,
          "60 patches at the next boot: the store of 4 sectors comes on, slots 61..63 moved");
    nmodel = 0;
    CHECK(add(300, 5) && add(900, 6) && model_ok(0), "and works");
    for (k = 40; k < 52u; k++)
        CHECK(sl_erase(k) == 0, "slot %u freed", k);
    boot();
    CHECK(pt_on && bank_slots == 48u && pt_nsec == NS && bank_mask >> 48 == 0 && model_ok(0),
          "48 patches at the next boot: 48 slots, the store with its patterns");

    memset(flash, 0xFF, sizeof flash);                  /* FACTORY RESET from a bank of 61 (the store off) */
    sl_layout(0);
    pt_on = 0;
    sl_scan();
    for (k = 0; k < 61u; k++)
        bank_write(k);
    boot();
    CHECK(!pt_on, "61 patches: off");
    sl_clear_all();
    pt_clear_all();
    CHECK(pt_on && bank_slots == 48u && pt_nsec == NS && !bank_mask && pt_count() == 0u,
          "FACTORY RESET with the store off: the bank empty, 48 slots, the store on and empty");
    boot();
    CHECK(pt_on && !bank_mask && sl_sec[SL_SETTINGS] == SL_NONE && pt_count() == 0u, "after a power cycle too");
    nmodel = 0;
    for (k = 0; k < 5u; k++)
        add(700, k);
    bank_write(0);
    bank_write(SL_SETTINGS);
    sl_clear_all();
    pt_clear_all();
    boot();
    r = add(10, 9);
    CHECK(pt_on && !bank_mask && sl_sec[SL_SETTINGS] == SL_NONE && pt_count() == 1u && r && r->id == 1u,
          "FACTORY RESET with the store on: the bank and the store empty, the ids from 1");
    printf("ok    the claim: more than 60 patches, freed slots, FACTORY RESET\n");
}

int main(void)
{
    api_tests();
    full_tests();
    id_tests();
    foreign_tests();
    cut_tests();
    claim_tests();
    printf(fails ? "pattern store test FAILED (%d)\n" : "pattern store test passed\n", fails);
    return fails != 0;
}
