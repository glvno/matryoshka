/* SPDX-License-Identifier: GPL-3.0-only */
/* The float kernels' result bits on the host (D-1114, #979): the hashes engine.c eng_fpu_probe gives for its fixed input,
 * one line per case, to compare with the FM-1's cores and the emulator (DIAG pages 140..142, tools/m1_link.py fpucheck).
 * Exits 1 when a hash differs from EXPECT, the FM-1's (both cores; the filters' cases measured in
 * docs/measurements/2026-11-17-fpu-filters.md). Without -ffp-contract=off a compiler may fuse a multiply and an add,
 * which the FM-1 never does (tools/build.py FPU_FLAGS), and the hashes differ.
 *   cc -O2 -ffp-contract=off -Ifirmware/src firmware/test/fpu_probe.c -o build/fpu_probe -lm && build/fpu_probe
 */
#include <stdio.h>
#include "../src/engine.c"

/* the filter with osc, drive, cv and morph; its lp12; the Ladder with stsat and fm; its diode mode; the Formant filter;
 * the Resonator; the Reverb */
static const uint32_t EXPECT[ENG_PROBE_CASES] = {0x11c96a92u, 0x51ca2f53u, 0x5dd8d5cfu, 0x3faa9188u, 0xf31baa1cu,
                                                 0x949362e1u, 0x975527b2u};

int main(void)
{
    uint32_t h[ENG_PROBE_CASES], c;
    int bad = 0;
    eng_fpu_probe(0, h);
    for (c = 0; c < ENG_PROBE_CASES; c++) {
        printf("%08x\n", h[c]);
        if (h[c] != EXPECT[c]) {
            fprintf(stderr, "fpu_probe: case %u gives %08x, the FM-1 %08x\n", (unsigned)c, (unsigned)h[c],
                    (unsigned)EXPECT[c]);
            bad = 1;
        }
    }
    return bad;
}
