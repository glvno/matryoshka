/* SPDX-License-Identifier: GPL-3.0-only */
#include <stdio.h>
#include <string.h>
#include "lanes_host.h"
#include "../src/engine.c"
#include "../src/presets.h"
/* tools/engine_exact.sh: every factory patch of presets.h (the working tree's, for both engines) with 8 notes held for
 * 200 blocks and released for 100, as one checksum of its output per patch */
int main(void)
{
    /* (PRESET_LIST follows whatever presets.h holds) */
    static const unsigned NOTES[8] = {60, 64, 67, 71, 72, 76, 79, 83};
    static int32_t l[128], r[128];
    unsigned t, b, k;
    for (t = 0; t < N_PRESETS; t++) {
        uint64_t h = 1469598103934665603ull;
        if (eng_load(PRESET_LIST[t].data, PRESET_LIST[t].len)) { printf("%2u load failed\n", t); continue; }
        for (b = 0; b < 300; b++) {
            if (b == 2) for (k = 0; k < 8; k++) eng_note_on(NOTES[k], 52000, 1);
            if (b == 200) for (k = 0; k < 8; k++) eng_note_off(NOTES[k], 1);
            eng_render(l, r, 128);
            for (k = 0; k < 128; k++) { h = (h ^ (uint32_t)l[k]) * 1099511628211ull; h = (h ^ (uint32_t)r[k]) * 1099511628211ull; }
        }
        printf("%2u %016llx\n", t, (unsigned long long)h);
    }
    return 0;
}
