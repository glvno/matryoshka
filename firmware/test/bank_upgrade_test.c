/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* Factory updates reach untouched slots (firmware/src/bank_upgrade.h, D-887 amended 2026-11-19) on the host: the bank
 * (slotstore.c) over RAM that behaves like NOR, the firmware tier and today's factory region merged (factory_host.h,
 * factory.c) with their released copies, and the released copies of released_cases.h (legacy-factory.ts: one firmware-tier
 * patch and one factory-region patch as a release wrote them, unlike today's). Checked:
 *   - every released copy in the images belongs to a factory patch of today's and is unlike today's bytes of it;
 *   - an untouched released copy under its name gets today's patch, in its slot, under its name;
 *   - these stay as they are, not written: an edited copy (one byte changed), a renamed copy, a copy of one factory patch
 *     under another factory patch's name, today's patch, a patch of the owner's under a factory name;
 *   - a second run writes nothing;
 *   - with the firmware tier alone only the tier's copies count; the region installed later (the editor while the FM-1
 *     runs: factory.c rescans, main.c factory_installed runs it again) brings the region's;
 *   - a power cut after every byte the run programs, and at every erase: each slot holds the old patch or the new one,
 *     every other slot is intact, and the run from there finishes with the same bank.
 *   tools/bank_upgrade_test.sh */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "../src/engine.h"

#define M1_NAME 20u
#define M1_SLOTS 64u
#define M1_PATCH_MAX 3840u
#define ENG_POOL
enum { S_OK, S_RANGE, S_CRC, S_LOAD, S_FLASH, S_CMD, S_NONE, S_FULL, S_MISSING, S_USED };
static uint32_t bank_slots = M1_SLOTS;          /* (proto.c's) */
static uint8_t m1_up[M1_PATCH_MAX];             /* (proto.c's: the store's scan keeps half its table there) */
static uint8_t flash_ok = 1;
static uint16_t m1_crc16(const uint8_t *p, uint32_t n)
{
    uint32_t c = 0xFFFFu, k;
    while (n--) {
        c ^= (uint32_t)*p++ << 8;
        for (k = 0; k < 8u; k++)
            c = c & 0x8000u ? ((c << 1) ^ 0x1021u) & 0xFFFFu : (c << 1) & 0xFFFFu;
    }
    return (uint16_t)c;
}
static void fm1_wdt_feed(void) {}

#include "factory_host.h"

/* the bank's sectors and the pattern store's (0x97000 .. 0xE0000) as RAM NOR; the region's through factory_host.h. A
 * program can be cut after n bytes and an erase refused (the power goes) */
#define FLASH_LO 0x97000u
#define FLASH_HI 0xE0000u
static uint8_t flash[FLASH_HI];
static long cut_after = -1;                     /* bytes the next programs may write before the power goes, -1 no cut */
static int cut_hit;
static uint32_t programmed;                     /* bank bytes programmed since the count was cleared */
static int st_read(uint32_t off, void *dst, uint32_t n)
{
    const uint8_t *f = host_fr(off, n);
    if (f) {
        memcpy(dst, f, n);
        return 0;
    }
    if (off < FLASH_LO || off + n > FLASH_HI)
        return -8;
    memcpy(dst, flash + off, n);
    return 0;
}
static int st_erase(uint32_t off)
{
    uint8_t *f = host_fr(off, 0x1000u);
    if (f) {
        memset(f, 0xFF, 0x1000u);
        return 0;
    }
    if (cut_after == 0) {
        cut_hit = 1;
        return -9;
    }
    if (off < FLASH_LO || off + 0x1000u > FLASH_HI || (off & 0xFFFu))
        return -8;
    memset(flash + off, 0xFF, 0x1000u);
    return 0;
}
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    const uint8_t *s = src;
    uint8_t *f = host_fr(off, n);
    uint32_t i;
    if (f) {
        for (i = 0; i < n; i++)
            f[i] &= s[i];
        return 0;
    }
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
        programmed++;
    }
    return 0;
}

#include "../src/factory.c"
#include "../src/slotstore.c"
#include "../src/patstore.c"
#include "../src/bank_upgrade.h"
#include "released_cases.h"

static int fails;
static void check(const char *what, int ok)
{
    printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
    if (!ok)
        fails++;
}

/* a power-on: the RAM state as after a reset, then the boot's sl_scan and pt_claim */
static void boot(void)
{
    cut_after = -1;
    cut_hit = 0;
    sl_next = 0;
    sl_seq = 0;
    sl_layout(0);
    bank_mask = 0;
    pt_on = 0;
    pt_scanned = 0;
    pt_seq = pt_nextid = 0;
    memset(pt_tail, 0, sizeof pt_tail);
    sl_scan();
    pt_claim();
    if (pt_on)
        pt_scan();
}

/* name padded to M1_NAME bytes */
static const char *nm(const char *s)
{
    static char b[4][M1_NAME];
    static uint32_t k;
    char *d = b[k++ & 3u];
    memset(d, 0, M1_NAME);
    memcpy(d, s, strlen(s) < M1_NAME ? strlen(s) : M1_NAME);
    return d;
}

/* merged factory patch named `name`, -1 none */
static int factory_index(const char *name)
{
    char n[M1_NAME + 1];
    uint32_t i;
    n[M1_NAME] = 0;
    for (i = 0; i < fc_npatches(); i++)
        if (!fc_patch_info(i, n, 0, 0) && !strcmp(n, name))
            return (int)i;
    return -1;
}

static uint8_t today[2][M1_PATCH_MAX], old[2][M1_PATCH_MAX], edited[M1_PATCH_MAX], mine[M1_PATCH_MAX];
static uint32_t today_len[2], old_len[2];
static uint32_t own[2];                         /* each case's own slot (FACTORY RESET's) */
enum { S_EDITED = 30, S_RENAMED, S_CROSS, S_TODAY, S_MINE };

/* slot s holds len bytes p under name: its sequence number, else -1 */
static long holds(uint32_t s, const char *name, const uint8_t *p, uint32_t len)
{
    sl_hdr_t h;
    if (sl_head(s, &h, 1) || h.len != len || memcmp(sl_buf, p, len) || memcmp(h.name, nm(name), M1_NAME))
        return -1;
    return (long)h.seq;
}

/* the bank before the update: both cases' released copies in their own slots, and the slots that must stay */
static void old_bank(void)
{
    uint32_t c;
    memset(flash + FLASH_LO, 0xFF, FLASH_HI - FLASH_LO);
    boot();
    for (c = 0; c < 2u; c++)
        (void)sl_write(own[c], nm(RELEASED_CASES[c].name), old[c], old_len[c]);
    (void)sl_write(S_EDITED, nm(RELEASED_CASES[0].name), edited, old_len[0]);
    (void)sl_write(S_RENAMED, nm("MY PATCH"), old[0], old_len[0]);
    (void)sl_write(S_CROSS, nm(RELEASED_CASES[0].name), old[1], old_len[1]);   /* (case 1's bytes under case 0's name) */
    (void)sl_write(S_TODAY, nm(RELEASED_CASES[1].name), today[1], today_len[1]);
    (void)sl_write(S_MINE, nm(RELEASED_CASES[1].name), mine, old_len[1]);
    boot();
}

/* the slots that stay, as old_bank wrote them */
static int kept(void)
{
    return holds(S_EDITED, RELEASED_CASES[0].name, edited, old_len[0]) >= 0 &&
           holds(S_RENAMED, "MY PATCH", old[0], old_len[0]) >= 0 &&
           holds(S_CROSS, RELEASED_CASES[0].name, old[1], old_len[1]) >= 0 &&
           holds(S_TODAY, RELEASED_CASES[1].name, today[1], today_len[1]) >= 0 &&
           holds(S_MINE, RELEASED_CASES[1].name, mine, old_len[1]) >= 0;
}

static uint8_t buf[M1_PATCH_MAX];

int main(void)
{
    uint32_t c, k, i, len, fnv, crc, bad = 0, total, cuts = 0, mixed = 0;
    long seq[2];
    uint64_t up;
    int idx;

    printf("the released copies in the images\n");
    host_fr_load();
    fc_scan();
    for (k = 0; k < fc_ncopies(); k++) {
        int32_t n;
        if ((idx = fc_copy(k, &len, &fnv, &crc)) < 0 || (n = fc_patch((uint32_t)idx, buf, sizeof buf)) <= 0 ||
            ((uint32_t)n == len && bu_is(buf, len, fnv, crc)))
            bad++;
    }
    check("the tier and the region list released copies", ft.ncopy > 0 && fr.ncopy > 0);
    check("each released copy belongs to one of today's factory patches and is unlike today's bytes of it", !bad);

    for (c = 0; c < 2u; c++) {
        uint32_t slot;
        old_len[c] = (uint32_t)lz_unpack(RELEASED_CASES[c].lz, RELEASED_CASES[c].lz_len, old[c], M1_PATCH_MAX);
        idx = factory_index(RELEASED_CASES[c].name);
        if (idx < 0 || old_len[c] != RELEASED_CASES[c].len || fc_patch_info((uint32_t)idx, (char *)buf, 0, &slot)) {
            check("released_cases.h names today's factory patches (run web/scripts/legacy-factory.ts)", 0);
            return 1;
        }
        own[c] = slot;
        today_len[c] = (uint32_t)fc_patch((uint32_t)idx, today[c], M1_PATCH_MAX);
        check(c ? "  the region's case is a region patch" : "  the tier's case is a firmware-tier patch",
              fc_patch_region((uint32_t)idx) == (int)c);
        check("  its released copy is unlike today's", today_len[c] != old_len[c] || memcmp(today[c], old[c], old_len[c]));
    }
    memcpy(edited, old[0], old_len[0]);
    edited[old_len[0] - 1u] ^= 1u;
    for (i = 0; i < old_len[1]; i++)
        mine[i] = (uint8_t)(i * 37u + 11u);

    printf("an update with the factory region\n");
    old_bank();
    seq[0] = holds(S_TODAY, RELEASED_CASES[1].name, today[1], today_len[1]);
    up = bu_run(buf, sizeof buf);
    for (c = 0; c < 2u; c++)
        check(c ? "  the region patch's untouched copy has today's patch, its slot and name"
                : "  the tier patch's untouched copy has today's patch, its slot and name",
              holds(own[c], RELEASED_CASES[c].name, today[c], today_len[c]) >= 0);
    check("  the edited, renamed and cross-named copies, today's patch and the owner's patch stay", kept());
    check("  today's patch is not written again", holds(S_TODAY, RELEASED_CASES[1].name, today[1], today_len[1]) == seq[0]);
    check("  the run says which slots it rewrote", up == ((uint64_t)1 << own[0] | (uint64_t)1 << own[1]));
    boot();
    programmed = 0;
    check("  a second run writes nothing", !bu_run(buf, sizeof buf) && !programmed);

    printf("the firmware tier alone, then the region installed while the FM-1 runs\n");
    host_fr_blank();
    fc_scan();
    old_bank();
    up = bu_run(buf, sizeof buf);
    check("  the tier patch's copy has today's patch", holds(own[0], RELEASED_CASES[0].name, today[0], today_len[0]) >= 0);
    check("  the region patch's copy waits for the region", up == (uint64_t)1 << own[0] &&
          holds(own[1], RELEASED_CASES[1].name, old[1], old_len[1]) >= 0);
    host_fr_load();
    fc_scan();                                  /* (what FACT_COMMIT does) */
    up = bu_run(buf, sizeof buf);
    check("  with the region installed it has today's patch too", up == (uint64_t)1 << own[1] &&
          holds(own[1], RELEASED_CASES[1].name, today[1], today_len[1]) >= 0 && kept());

    printf("a power cut during the run\n");
    old_bank();
    programmed = 0;
    (void)bu_run(buf, sizeof buf);
    total = programmed;
    for (k = 0; k <= total; k++) {
        old_bank();
        cut_after = (long)k;
        (void)bu_run(buf, sizeof buf);
        if (!cut_hit)
            continue;
        cuts++;
        boot();                                 /* (the power comes back) */
        for (c = 0; c < 2u; c++) {
            seq[c] = holds(own[c], RELEASED_CASES[c].name, today[c], today_len[c]);
            if (seq[c] < 0 && holds(own[c], RELEASED_CASES[c].name, old[c], old_len[c]) < 0)
                mixed++;
        }
        if (!kept())
            mixed++;
        (void)bu_run(buf, sizeof buf);          /* (the next boot: the settings record still has the old set) */
        if (holds(own[0], RELEASED_CASES[0].name, today[0], today_len[0]) < 0 ||
            holds(own[1], RELEASED_CASES[1].name, today[1], today_len[1]) < 0 || !kept())
            mixed++;
    }
    printf("  %u cuts over %u bytes programmed\n", cuts, total);
    check("  every cut leaves each slot with its old patch or today's, the others intact, and the next run finishes",
          cuts > 0 && !mixed);

    printf(fails ? "bank upgrade: %d FAILED\n" : "bank upgrade: all ok\n", fails);
    return fails ? 1 : 0;
}
