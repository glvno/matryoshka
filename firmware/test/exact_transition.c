/* SPDX-License-Identifier: GPL-3.0-only */
/* tools/engine_exact.sh builds this against both revisions. Compare raw output while controls change and notes wake
 * idle voices, with partial blocks as well as full ones. The golden kits separately compare the two engine languages. */
#include <stdio.h>
#include <stdlib.h>
#include "engine.c"

int main(int argc, char **argv)
{
    uint8_t patch[8192];
    int32_t left[128], right[128];
    const uint32_t lengths[] = {128, 1, 7, 63, 127};
    const int32_t waves[] = {0, 2, 0, 3, 0, 1, 0};
    uint32_t b, m, n, len;
    FILE *f;
    if (argc != 2 || !(f = fopen(argv[1], "rb")))
        return 2;
    len = (uint32_t)fread(patch, 1, sizeof patch, f);
    fclose(f);
    if (eng_load(patch, len))
        return 3;
    for (b = 0; b < 768; b++) {
        if (b % 192 == 0) {
            eng_note_on(48, ENG_ONE, 1);
            eng_note_on(55, ENG_ONE / 2, 1);
            eng_note_on(60, ENG_ONE * 3 / 4, 1);
            eng_note_on(64, ENG_ONE, 1);
        } else if (b % 192 == 24) {
            eng_all_notes_off();
        }
        if (b % 11 == 0)
            for (m = 0; m < (uint32_t)eng_nmodules(); m++) {
                eng_set_att(m, 0, (b & 1) ? ENG_ONE : -ENG_ONE);
                if (eng_type(m) == T_OSC) {
                    eng_set_param(m, OSC_P_WAVE, waves[(b / 11) % 7] * ENG_ONE);
                    eng_set_param(m, OSC_P_PM, (b % 3) * ENG_ONE);
                    eng_set_param(m, OSC_P_FB, b % 4 ? 0 : ENG_ONE / 3);
                    eng_set_param(m, OSC_P_COARSE, ((int32_t)(b % 37) - 18) * ENG_ONE);
                }
            }
        n = b % 192 < 32 ? lengths[b % 5] : 128;
        eng_render(left, right, n);
        if (fwrite(left, sizeof *left, n, stdout) != n || fwrite(right, sizeof *right, n, stdout) != n)
            return 4;
    }
    return 0;
}
