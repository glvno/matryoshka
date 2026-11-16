/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* A factory patch new in the factory content reaches a bank kept through an update or a new factory region (#630, D-126,
 * D-283, #915): main.c bank_add places it once per factory set. The factory content is the firmware tier and the factory
 * region merged (factory.c). New means the set the bank was last brought to (bank_set) did not have a patch of that name
 * (the images' released sets, factory.c fc_released). A set an image does not know (a build between releases) counts
 * as having every patch of that image a release ever wrote; today's set counts as having them all; a bank written from
 * the firmware tier alone (FC_TIER_SET) as having none, so it gets every factory patch it does not hold by name. A patch
 * some slot already holds by name is not new (a power cut between the slot and the settings record: the next boot does
 * not place it twice). Each new patch goes into its own slot (the slot FACTORY RESET gives it) if that slot is empty,
 * else into the first empty slot; never over a used slot. Those that find their own slot empty take it first, so one
 * placed elsewhere never takes another's own slot. No empty slot left: the patch is skipped. Needs factory.c. Host test:
 * firmware/test/bank_new_test.c */
#define BN_NONE 0xFFu
typedef struct {
    uint8_t slot[FC_PATCHES];                   /* the slot each factory patch goes into (BN_NONE: none) */
    uint32_t placed, skipped;
    uint32_t first;                             /* the first placed patch (its index) */
} bn_plan_t;

/* the factory patches (bit n: patch n) a bank brought to factory set `set` does not have */
static uint64_t bn_new(uint32_t set)
{
    uint32_t n = fc_npatches();
    uint64_t all = n >= 64u ? ~(uint64_t)0 : ((uint64_t)1 << n) - 1u, has = 0, any = 0;
    if (set == fc_set())                        /* (a format change alone: the bank has today's set) */
        return 0;
    if (set == FC_TIER_SET)
        return all;
    (void)fc_released(set, &has, &any);         /* (an image that does not know the set: has = any) */
    return all & ~has;
}

/* where the new patches go: `used` the occupied slots of `nslots`, `named` the factory patches a slot holds by name */
static void bn_plan(uint32_t set, uint64_t used, uint64_t named, uint32_t nslots, bn_plan_t *p)
{
    uint64_t todo = bn_new(set) & ~named;
    char name[M1_NAME];
    uint32_t i, s, own, n = fc_npatches();
    p->placed = p->skipped = 0;
    p->first = BN_NONE;
    for (i = 0; i < FC_PATCHES; i++)
        p->slot[i] = BN_NONE;
    for (i = 0; i < n; i++) {
        if ((todo >> i & 1u) && !fc_patch_info(i, name, 0, &own) && own < nslots && !(used >> own & 1u)) {   /* its own slot, empty */
            p->slot[i] = (uint8_t)own;
            used |= (uint64_t)1 << own;
        }
    }
    for (i = 0; i < n; i++) {
        if (!(todo >> i & 1u))
            continue;
        if (p->slot[i] == BN_NONE) {                                    /* the first empty slot */
            for (s = 0; s < nslots && (used >> s & 1u); s++)
                ;
            if (s >= nslots) {
                p->skipped++;
                continue;
            }
            p->slot[i] = (uint8_t)s;
            used |= (uint64_t)1 << s;
        }
        if (p->first == BN_NONE)
            p->first = i;
        p->placed++;
    }
}

static char *bn_put(char *d, const char *s, const char *end)
{
    while (*s && d < end)
        *d++ = *s++;
    return d;
}
static char *bn_num(char *d, uint32_t v)
{
    if (v >= 10u)
        *d++ = (char)('0' + v / 10u % 10u);
    *d++ = (char)('0' + v % 10u);
    return d;
}

/* what the bar says once (at most 26 characters, D-249; out holds 27): NEW PATCH: 30. VERONA DRUM 1 when it fits, else
 * NEW: 30. VERONA DRUM 1 (cut at 26); several: 2 NEW PATCHES ADDED; no empty slot for one: NO FREE SLOT FOR NEW PATCH,
 * for several: NO FREE SLOT: 2 SKIPPED. Returns 0 when there is nothing to say */
#define BN_BAR 26u
static int bn_msg(const bn_plan_t *p, char *out)
{
    char *d = out, *end = out + BN_BAR, name[M1_NAME + 1u];
    uint32_t n;
    if (p->skipped == 1u)
        d = bn_put(d, "NO FREE SLOT FOR NEW PATCH", end);
    else if (p->skipped) {
        d = bn_put(d, "NO FREE SLOT: ", end);
        d = bn_num(d, p->skipped);
        d = bn_put(d, " SKIPPED", end);
    } else if (p->placed > 1u) {
        d = bn_num(d, p->placed);
        d = bn_put(d, " NEW PATCHES ADDED", end);
    } else if (p->placed == 1u) {
        name[M1_NAME] = 0;
        if (fc_patch_info(p->first, name, 0, 0))
            name[0] = 0;
        for (n = 0; name[n]; n++)
            ;
        n += p->slot[p->first] >= 9u ? 4u : 3u;                       /* (the number, ". ") */
        d = bn_put(d, n + 11u > BN_BAR ? "NEW: " : "NEW PATCH: ", end);
        d = bn_num(d, p->slot[p->first] + 1u);
        d = bn_put(d, ". ", end);
        d = bn_put(d, name, end);
    } else
        return 0;
    *d = 0;
    return 1;
}
