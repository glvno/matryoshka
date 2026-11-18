/* SPDX-License-Identifier: GPL-3.0-only */
/* tools/sched_record.sh: the two-core plan (engine.c sched_build) of every factory patch of presets.h, then of each patch
 * binary given, one line each: its name, whether it has a schedule, then each lane's items (module/part) in order */
#include <stdio.h>
#include <string.h>
#include "lanes_host.h"
#include "../src/engine.c"
#include "../src/presets.h"
static void dump(const char *name)
{
    uint32_t l, i;
    printf("%s|%u", name, sch.on);
    for (l = 0; l < 2; l++) {
        printf("|");
        if (sch.on)
            for (i = 0; i < sch.n[l]; i++) {
                uint16_t x = sch.it[(l ? sch.n[0] : 0u) + i];
                printf("%s%u/%u%s", i ? " " : "", (x & ~SCH_PUB) >> 3, x & 7u, x & SCH_PUB ? "p" : "");
            }
        printf("|");
        if (sch.on)
            for (i = 0; i < sch.n[l]; i++)
                printf("%s%u", i ? " " : "", sch.need[(l ? sch.n[0] : 0u) + i]);
    }
    printf("\n");
}
int main(int argc, char **argv)
{
    static uint8_t bin[1u << 16];
    unsigned t;
    int a;
    for (t = 0; t < N_PRESETS; t++) {
        if (lz_unpack(PRESET_LIST[t].lz, PRESET_LIST[t].lz_len, bin, sizeof bin) != (int32_t)PRESET_LIST[t].len ||
            eng_load(bin, PRESET_LIST[t].len)) { printf("%s|load failed\n", PRESET_LIST[t].name); continue; }
        dump(PRESET_LIST[t].name);
    }
    for (a = 1; a < argc; a++) {
        FILE *f = fopen(argv[a], "rb");
        size_t n = f ? fread(bin, 1, sizeof bin, f) : 0;
        if (f) fclose(f);
        if (!n || eng_load(bin, (uint32_t)n)) { printf("%s|load failed\n", argv[a]); continue; }
        dump(argv[a]);
    }
    return 0;
}
