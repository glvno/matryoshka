/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* A factory patch new in this firmware, placed after an update (#630, firmware/src/bank_new.h) on the host, with today's
 * presets.h: its own slot empty, its own slot taken, the bank full, several new (one placed elsewhere never takes another's
 * own slot), a power cut before the settings record (the patch already there by name), a set from between releases, and
 * what the bar says (26 characters at most).
 *   tools/bank_new_test.sh */
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "../src/presets.h"
#include "../src/bank_new.h"

static int fails;
static void check(const char *what, int ok)
{
    printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
    if (!ok)
        fails++;
}
static uint64_t first(uint32_t n) { return n >= 64u ? ~(uint64_t)0 : ((uint64_t)1 << n) - 1u; }
static int find(const char *name)
{
    int i;
    for (i = 0; i < N_PRESETS; i++)
        if (!strcmp(PRESET_LIST[i].name, name))
            return i;
    return -1;
}

int main(void)
{
    bn_plan_t p;
    char msg[BN_BAR + 1u];
    int v = find("VERONA DRUM 1"), i, s;
    uint32_t set191 = 0xb9a4a8u, old = 0u;                  /* 1.9.1's set; 0: 1.6.0 and older */
    uint64_t has29 = first(29);
    printf("bank_new: a new factory patch after an update (#630)\n");
    check("(Verona Drum 1 is factory index 29, 1.9.1's set had the 29 before it)", v == 29 && bn_new(set191) == (uint64_t)1 << 29);
    check("today's set: nothing new", bn_new(FACTORY_SET_ID) == 0);

    bn_plan(set191, has29, has29, 64, &p);
    check("own slot empty: Verona Drum 1 into slot 29 (the FM-1's 30)", p.placed == 1 && p.skipped == 0 && p.slot[v] == 29);
    check("  the bar: NEW: 30. VERONA DRUM 1 (NEW PATCH: ... is 28 characters)", bn_msg(&p, msg) && !strcmp(msg, "NEW: 30. VERONA DRUM 1"));

    bn_plan(set191, first(30) | (uint64_t)1 << 31, has29, 64, &p);
    check("own slot taken (a user patch in 29): the first empty slot, 30 (the FM-1's 31), 29 untouched", p.placed == 1 && p.slot[v] == 30);
    check("  the bar: NEW: 31. VERONA DRUM 1", bn_msg(&p, msg) && !strcmp(msg, "NEW: 31. VERONA DRUM 1"));

    bn_plan(set191, ~(uint64_t)0, has29, 64, &p);
    check("bank full: skipped, nothing written", p.placed == 0 && p.skipped == 1 && p.slot[v] == BN_NONE);
    check("  the bar: NO FREE SLOT FOR NEW PATCH", bn_msg(&p, msg) && !strcmp(msg, "NO FREE SLOT FOR NEW PATCH"));

    bn_plan(set191, first(29), has29 | (uint64_t)1 << v, 64, &p);
    check("already there by name (a power cut before the settings record): not placed twice, nothing said",
          p.placed == 0 && p.skipped == 0 && !bn_msg(&p, msg));
    bn_plan(set191, first(10), first(10), 64, &p);
    check("a factory patch the owner deleted is not new: only Verona Drum 1 comes", p.placed == 1 && p.slot[v] == 29);

    bn_plan(0xabcdefu, has29, has29, 64, &p);
    check("a set from between releases: only what no release had (Verona Drum 1)", p.placed == 1 && p.slot[v] == 29);
    bn_plan(FACTORY_SET_ID, has29, has29, 64, &p);
    check("today's set: nothing placed, nothing said", p.placed == 0 && !bn_msg(&p, msg));

    {   /* a 1.6.0 bank (no set id): Basic Poly, Drift Poly, Mono Lead, Supersaw Stack (1.7.0) and Verona Drum 1 are new;
         * the owner's patch sits in 25 (Basic Poly's own slot) */
        uint64_t used = first(26), named = first(25);
        int ok = 1;
        bn_plan(old, used, named, 64, &p);
        for (i = 26; i < 30; i++)
            ok &= p.slot[i] == (uint8_t)i;
        check("several new: each into its own slot where empty", ok && p.placed == 5);
        check("  Basic Poly (own slot taken) into the first empty one after the others took theirs: 30", p.slot[25] == 30);
        check("  the bar: 5 NEW PATCHES ADDED", bn_msg(&p, msg) && !strcmp(msg, "5 NEW PATCHES ADDED"));
        bn_plan(old, ~(uint64_t)0 & ~((uint64_t)1 << 40 | (uint64_t)1 << 50), named, 64, &p);
        check("several new, two empty slots: two placed (40, 50), three skipped", p.placed == 2 && p.skipped == 3 && p.slot[25] == 40 && p.slot[26] == 50);
        check("  the bar: NO FREE SLOT: 3 SKIPPED", bn_msg(&p, msg) && !strcmp(msg, "NO FREE SLOT: 3 SKIPPED"));
    }
    {   /* every factory name in every slot: the bar never takes more than 26 characters */
        int ok = 1;
        for (i = 0; i < N_PRESETS; i++)
            for (s = 0; s < 64; s++) {
                memset(&p, 0, sizeof p);
                p.placed = 1;
                p.first = (uint32_t)i;
                p.slot[i] = (uint8_t)s;
                ok &= bn_msg(&p, msg) && strlen(msg) <= BN_BAR;
                if (strlen(PRESET_LIST[i].name) + (s >= 9 ? 15u : 14u) <= BN_BAR)
                    ok &= !strncmp(msg, "NEW PATCH: ", 11);
            }
        check("every factory name in every slot: at most 26 characters, NEW PATCH: when it fits", ok);
        memset(&p, 0, sizeof p);
        p.placed = 1;
        p.first = (uint32_t)find("INIT");
        p.slot[p.first] = 1;
        check("  (NEW PATCH: 2. INIT)", bn_msg(&p, msg) && !strcmp(msg, "NEW PATCH: 2. INIT"));
    }
    printf(fails ? "bank_new: %d FAILED\n" : "bank_new: all passed\n", fails);
    return fails ? 1 : 0;
}
