// SPDX-License-Identifier: Apache-2.0
// Spike #1338: render msfa voices on the host to a raw file of int32 Q16 samples.
//   host_render OUT.i32 [BANK.syx VOICE] [NOTES]
// Plays NOTES (default 4) notes from C4 in thirds for 2 s, then releases them for 1 s.
#include <stdio.h>
#include <stdlib.h>
#include "core/dxs.h"

int main(int argc, char **argv) {
    static int32_t buf[128];
    dxs_init();
    if (argc > 3) {
        FILE *f = fopen(argv[2], "rb");
        static uint8_t syx[4104];
        if (!f || fread(syx, 1, sizeof syx, f) != sizeof syx) return 2;
        fclose(f);
        uint8_t v[156];
        dxs_unpack(syx + 6 + 128 * atoi(argv[3]), v);
        dxs_set_voice(v);
    }
    int notes = argc > 4 ? atoi(argv[4]) : argc == 3 ? atoi(argv[2]) : 4;
    static const int k[8] = {60, 64, 67, 71, 72, 76, 79, 83};
    for (int i = 0; i < notes; i++) dxs_note_on(k[i % 8], 100);
    FILE *o = fopen(argv[1], "wb");
    for (int b = 0; b < 3 * 44118 / 128; b++) {
        if (b == 2 * 44118 / 128)
            for (int i = 0; i < notes; i++) dxs_note_off(k[i % 8]);
        for (int i = 0; i < 128; i++) buf[i] = 0;
        dxs_render(buf, 128);
        fwrite(buf, 4, 128, o);
    }
    fclose(o);
    fprintf(stderr, "voice %u B, shared %u B, live at end %d\n", dxs_voice_bytes(), dxs_shared_bytes(), dxs_live());
    return 0;
}
