/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* A factory patch new in this firmware, placed after an update (#630, firmware/src/bank_new.h) on the host, with today's
 * presets.h: its own slot empty, its own slot taken, the bank full, a power cut before the settings record (the patch
 * already there by name), a set from between releases, a bank older than every remaining default, and what the bar says
 * (26 characters at most). Today's 22-patch bank removed the editor examples from the defaults (D-890), so at most one
 * patch (Verona Drum 1) is ever new; renamed Hera 3 counts as present wherever Hera 4 was (D-887).
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
    uint32_t set191 = 0xb9a4a8u, set113 = 0x5a93c5u, old = 0u;   /* 1.9.1's set, 1.12.0..1.13.0's; 0: 1.6.0 and older */
    uint64_t has21 = first(21);
    printf("bank_new: a new factory patch after an update (#630)\n");
    check("(Verona Drum 1 is factory index 21, 1.9.1's set had the 21 before it)", v == 21 && bn_new(set191) == (uint64_t)1 << 21);
    check("today's set: nothing new", bn_new(FACTORY_SET_ID) == 0);
    check("1.13.0's set: nothing new (Hera 3 is its Hera 4)", find("HERA 3") == 3 && bn_new(set113) == 0);

    bn_plan(set191, has21, has21, 64, &p);
    check("own slot empty: Verona Drum 1 into slot 21 (the FM-1's 22)", p.placed == 1 && p.skipped == 0 && p.slot[v] == 21);
    check("  the bar: NEW: 22. VERONA DRUM 1 (NEW PATCH: ... is 28 characters)", bn_msg(&p, msg) && !strcmp(msg, "NEW: 22. VERONA DRUM 1"));

    bn_plan(set191, first(22) | (uint64_t)1 << 23, has21, 64, &p);
    check("own slot taken (a user patch in 21): the first empty slot, 22 (the FM-1's 23), 21 untouched", p.placed == 1 && p.slot[v] == 22);
    check("  the bar: NEW: 23. VERONA DRUM 1", bn_msg(&p, msg) && !strcmp(msg, "NEW: 23. VERONA DRUM 1"));

    bn_plan(set191, ~(uint64_t)0, has21, 64, &p);
    check("bank full: skipped, nothing written", p.placed == 0 && p.skipped == 1 && p.slot[v] == BN_NONE);
    check("  the bar: NO FREE SLOT FOR NEW PATCH", bn_msg(&p, msg) && !strcmp(msg, "NO FREE SLOT FOR NEW PATCH"));

    bn_plan(set191, first(21), has21 | (uint64_t)1 << v, 64, &p);
    check("already there by name (a power cut before the settings record): not placed twice, nothing said",
          p.placed == 0 && p.skipped == 0 && !bn_msg(&p, msg));
    bn_plan(set191, first(10), first(10), 64, &p);
    check("a factory patch the owner deleted is not new: only Verona Drum 1 comes", p.placed == 1 && p.slot[v] == 21);

    bn_plan(0xabcdefu, has21, has21, 64, &p);
    /* since v1.10.0 every factory patch is in a released set, so a bank from between releases gets nothing new */
    check("a set from between releases: only what no release had (none since 1.10.0)", p.placed == 0);
    bn_plan(FACTORY_SET_ID, has21, has21, 64, &p);
    check("today's set: nothing placed, nothing said", p.placed == 0 && !bn_msg(&p, msg));

    /* a 1.6.0 bank (no set id) with the owner's patches in 0..21: the removed editor examples never come back, so
     * only Verona Drum 1 is new, into the first empty slot */
    bn_plan(old, first(22), has21, 64, &p);
    check("a 1.6.0 bank: only Verona Drum 1, not the removed examples", p.placed == 1 && p.skipped == 0 && p.slot[v] == 22);
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
        p.first = (uint32_t)find("IO 4");
        p.slot[p.first] = 1;
        check("  (NEW PATCH: 2. IO 4)", bn_msg(&p, msg) && !strcmp(msg, "NEW PATCH: 2. IO 4"));
    }
    printf(fails ? "bank_new: %d FAILED\n" : "bank_new: all passed\n", fails);
    return fails ? 1 : 0;
}
