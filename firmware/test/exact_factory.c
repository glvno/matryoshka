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
    static const struct { const uint8_t *p; unsigned n; } T[] = {
#define X(k) { PRESET_##k, sizeof PRESET_##k },
X(0) X(1) X(2) X(3) X(4) X(5) X(6) X(7) X(8) X(9) X(10) X(11) X(12) X(13) X(14) X(15) X(16) X(17) X(18) X(19) X(20) X(21) X(22) X(23) X(24) X(25) X(26) X(27) X(28) X(29)
    };
    static const unsigned NOTES[8] = {60, 64, 67, 71, 72, 76, 79, 83};
    static int32_t l[128], r[128];
    unsigned t, b, k;
    for (t = 0; t < sizeof T / sizeof T[0]; t++) {
        uint64_t h = 1469598103934665603ull;
        if (eng_load(T[t].p, T[t].n)) { printf("%2u load failed\n", t); continue; }
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
