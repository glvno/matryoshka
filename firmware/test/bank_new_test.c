/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* A factory patch new in the factory content, placed after an update or a new factory region (#630, #915,
 * firmware/src/bank_new.h) on the host, with the firmware tier and today's factory region merged (factory_host.h,
 * factory.c): its own slot empty, its own slot taken, the bank full, a power cut before the settings record (the patch
 * already there by name), a set from between releases, a bank older than every remaining default, a bank written from the
 * firmware tier alone, and what the bar says (26 characters at most). A factory patch's index in the merged list is not
 * its slot (the tier's come first): the plan's slots are checked against each patch's own slot. Today's bank removed the
 * editor examples from the defaults (D-890), so the only patches ever new are Verona Drum 1 and Shush 101 (no release has
 * it yet, D-1202); renamed Hera 6 counts as present wherever Hera 3 or Hera 4 was (D-887). Most cases below treat Shush
 * 101 as already in the bank, so they place Verona Drum 1 alone.
 *   tools/bank_new_test.sh */
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "../src/engine.h"
#define HOST_FR_STANDALONE
#include "factory_host.h"
#include "../src/factory.c"
#include "../src/bank_new.h"

static int fails;
static void check(const char *what, int ok)
{
    printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
    if (!ok)
        fails++;
}
static uint64_t first(uint32_t n) { return n >= 64u ? ~(uint64_t)0 : ((uint64_t)1 << n) - 1u; }
static const char *name_of(uint32_t i)
{
    static char name[M1_NAME + 1u];
    name[M1_NAME] = 0;
    return fc_patch_info(i, name, 0, 0) ? "" : name;
}
static int find(const char *name)
{
    uint32_t i;
    for (i = 0; i < fc_npatches(); i++)
        if (!strcmp(name_of(i), name))
            return (int)i;
    return -1;
}
static uint32_t slot_of(uint32_t i)
{
    char name[M1_NAME];
    uint32_t s = BN_NONE;
    (void)fc_patch_info(i, name, 0, &s);
    return s;
}
/* the slots (bit s) of the merged patches in mask */
static uint64_t slots_of(uint64_t mask)
{
    uint64_t out = 0;
    uint32_t i;
    for (i = 0; i < fc_npatches(); i++)
        if (mask >> i & 1u)
            out |= (uint64_t)1 << slot_of(i);
    return out;
}

int main(void)
{
    bn_plan_t p;
    char msg[BN_BAR + 1u], want[BN_BAR + 1u];
    int v = find("VERONA DRUM 1"), sh = find("SHUSH 101"), i, s, vs;
    uint32_t set191 = 0xb9a4a8u, set113 = 0x5a93c5u, old = 0u, today = fc_set(), n = fc_npatches();
    uint64_t vbit = v >= 0 ? (uint64_t)1 << v : 0u, nbit = sh >= 0 ? (uint64_t)1 << sh : 0u;
    uint64_t had = first(n) & ~vbit, used;                     /* (every factory patch but Verona Drum 1) */
    printf("bank_new: a new factory patch after an update or a new factory region (#630, #915)\n");
    check("(the factory region's content is read, merged with the firmware tier)", fc_region && n >= 3u && n > ft.npatch);
    check("(Verona Drum 1 and Shush 101 are in the factory bank, 1.9.1's set had every other patch)",
          v >= 0 && sh >= 0 && bn_new(set191) == (vbit | nbit));
    if (v < 0 || sh < 0)
        return 1;
    vs = (int)slot_of((uint32_t)v);
    used = slots_of(had);
    check("today's set: nothing new", bn_new(today) == 0);
    check("1.13.0's set: only Shush 101 is new (Hera 6 is its Hera 4)", find("HERA 6") >= 0 && bn_new(set113) == nbit);

    bn_plan(set191, used, had, 64, &p);
    snprintf(want, sizeof want, "NEW: %d. VERONA DRUM 1", vs + 1);
    check("own slot empty: Verona Drum 1 into its own slot", p.placed == 1 && p.skipped == 0 && p.slot[v] == vs);
    check("  the bar: NEW: <slot>. VERONA DRUM 1 (NEW PATCH: ... is 28 characters)", bn_msg(&p, msg) && !strcmp(msg, want));

    bn_plan(set191, first((uint32_t)vs + 1u) | (uint64_t)1 << (vs + 2), had, 64, &p);
    snprintf(want, sizeof want, "NEW: %d. VERONA DRUM 1", vs + 2);
    check("own slot taken (a user patch in it): the first empty slot after it, its own untouched", p.placed == 1 && p.slot[v] == vs + 1);
    check("  the bar: NEW: <slot>. VERONA DRUM 1", bn_msg(&p, msg) && !strcmp(msg, want));

    bn_plan(set191, ~(uint64_t)0, had, 64, &p);
    check("bank full: skipped, nothing written", p.placed == 0 && p.skipped == 1 && p.slot[v] == BN_NONE);
    check("  the bar: NO FREE SLOT FOR NEW PATCH", bn_msg(&p, msg) && !strcmp(msg, "NO FREE SLOT FOR NEW PATCH"));

    bn_plan(set191, used, had | vbit, 64, &p);
    check("already there by name (a power cut before the settings record): not placed twice, nothing said",
          p.placed == 0 && p.skipped == 0 && !bn_msg(&p, msg));
    for (i = 0, used = 0; i < (int)n; i++)                     /* (the owner kept slots 1..10 alone) */
        used |= slot_of((uint32_t)i) < 10u ? (uint64_t)1 << i : 0u;
    bn_plan(set191, first(10), used, 64, &p);
    check("a factory patch the owner deleted is not new: only Verona Drum 1 and Shush 101 come, each into its own slot",
          p.placed == 2 && p.slot[v] == vs && p.slot[sh] == slot_of((uint32_t)sh));
    used = slots_of(had);

    bn_plan(0xabcdefu, used, had & ~nbit, 64, &p);
    /* a bank from between releases gets only what no release had: Shush 101 until a release has it, else nothing */
    check("a set from between releases: only what no release had (Shush 101 until a release has it)",
          bn_new(0xabcdefu) == (bn_new(0xabcdefu) & nbit) && p.placed == (bn_new(0xabcdefu) ? 1u : 0u));
    bn_plan(today, used, had, 64, &p);
    check("today's set: nothing placed, nothing said", p.placed == 0 && !bn_msg(&p, msg));

    /* a 1.6.0 bank (no set id) with the owner's patches up to Verona Drum 1's slot: the removed editor examples never come
     * back, so only Verona Drum 1 is new, into the first empty slot */
    bn_plan(old, first((uint32_t)vs + 1u), had, 64, &p);
    check("a 1.6.0 bank: only Verona Drum 1, not the removed examples", p.placed == 1 && p.skipped == 0 && p.slot[v] == vs + 1);

    /* a bank written from the firmware tier alone (#915): the tier's patches in their own slots; the factory region brings
     * every other factory patch into its own slot */
    {
        uint64_t tier = first(ft.npatch);                       /* (the merged list starts with the tier's) */
        int own = 1;
        bn_plan(FC_TIER_SET, slots_of(tier), tier, 60, &p);
        for (i = 0; i < (int)n; i++)
            own &= i < (int)ft.npatch ? p.slot[i] == BN_NONE : p.slot[i] == slot_of((uint32_t)i);
        snprintf(want, sizeof want, "%u NEW PATCHES ADDED", (unsigned)(n - ft.npatch));
        check("a firmware-tier bank: every region patch into its own slot, the tier's untouched",
              p.placed == n - ft.npatch && p.skipped == 0 && own);
        check("  the bar: <n> NEW PATCHES ADDED", bn_msg(&p, msg) && !strcmp(msg, want));
    }
    {   /* every factory name in every slot: the bar never takes more than 26 characters */
        int ok = 1;
        for (i = 0; i < (int)n; i++)
            for (s = 0; s < 64; s++) {
                memset(&p, 0, sizeof p);
                p.placed = 1;
                p.first = (uint32_t)i;
                p.slot[i] = (uint8_t)s;
                ok &= bn_msg(&p, msg) && strlen(msg) <= BN_BAR;
                if (strlen(name_of((uint32_t)i)) + (s >= 9 ? 15u : 14u) <= BN_BAR)
                    ok &= !strncmp(msg, "NEW PATCH: ", 11);
            }
        check("every factory name in every slot: at most 26 characters, NEW PATCH: when it fits", ok);
        memset(&p, 0, sizeof p);
        p.placed = 1;
        p.first = (uint32_t)find("IO 4");
        p.slot[p.first] = 1;
        check("  (NEW PATCH: 2. IO 4)", bn_msg(&p, msg) && !strcmp(msg, "NEW PATCH: 2. IO 4"));
    }
    printf(fails ? "bank_new: %d FAILED\n" : "bank_new: all passed\n", fails);
    return fails ? 1 : 0;
}
