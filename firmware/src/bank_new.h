/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* A factory patch that is new in this firmware reaches a bank kept through an update (#630, D-126, D-283): main.c
 * bank_add places it once per factory set, after bank_upgrade. New means the set the bank was last brought to
 * (bank_set) did not have a patch of that name (presets.h RELEASED_SETS). A set not in that table (a build between
 * releases) counts as having every patch a release ever wrote; today's set counts as having them all. A patch some
 * slot already holds by name is not new (a power cut between the slot and the settings record: the next boot does not
 * place it twice). Each new patch goes into its own slot (its PRESET_LIST index) if that slot is empty, else into the
 * first empty slot; never over a used slot. Those that find their own slot empty take it first, so one placed elsewhere
 * never takes another's own slot. No empty slot left: the patch is skipped. Needs presets.h. Host test:
 * firmware/test/bank_new_test.c */
#define BN_NONE 0xFFu
typedef struct {
    uint8_t slot[N_PRESETS];                    /* the slot each factory patch goes into (BN_NONE: none) */
    uint32_t placed, skipped;
    uint32_t first;                             /* the first placed patch (PRESET_LIST index) */
} bn_plan_t;

/* the factory patches (bit n: PRESET_LIST[n]) a bank brought to factory set `set` does not have */
static uint64_t bn_new(uint32_t set)
{
    uint64_t all = N_PRESETS >= 64 ? ~(uint64_t)0 : ((uint64_t)1 << N_PRESETS) - 1u, any = 0;
    uint32_t k;
    if (set == FACTORY_SET_ID)                  /* (a format change alone: the bank has today's set) */
        return 0;
    for (k = 0; k < N_RELEASED_SETS; k++) {
        if (RELEASED_SETS[k].set == set)
            return all & ~RELEASED_SETS[k].has;
        any |= RELEASED_SETS[k].has;
    }
    return all & ~any;
}

/* where the new patches go: `used` the occupied slots of `nslots`, `named` the factory patches a slot holds by name */
static void bn_plan(uint32_t set, uint64_t used, uint64_t named, uint32_t nslots, bn_plan_t *p)
{
    uint64_t todo = bn_new(set) & ~named;
    uint32_t i, s;
    p->placed = p->skipped = 0;
    p->first = BN_NONE;
    for (i = 0; i < N_PRESETS; i++) {
        p->slot[i] = BN_NONE;
        if ((todo >> i & 1u) && i < nslots && !(used >> i & 1u)) {     /* its own slot, empty */
            p->slot[i] = (uint8_t)i;
            used |= (uint64_t)1 << i;
        }
    }
    for (i = 0; i < N_PRESETS; i++) {
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
    char *d = out, *end = out + BN_BAR;
    uint32_t n;
    const char *name;
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
        name = PRESET_LIST[p->first].name;
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
