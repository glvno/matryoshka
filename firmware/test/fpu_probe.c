/* SPDX-License-Identifier: GPL-3.0-only */
/* The float kernels' result bits on the host (D-1114, #979): the hashes engine.c eng_fpu_probe gives for its fixed input,
 * one line per case, to compare with the FM-1's cores and the emulator (DIAG pages 140..142, tools/m1_link.py fpucheck).
 *   cc -O2 -Ifirmware/src firmware/test/fpu_probe.c -o build/fpu_probe -lm && build/fpu_probe
 */
#include <stdio.h>
#include "../src/engine.c"

int main(void)
{
    uint32_t h[ENG_PROBE_CASES], c;
    eng_fpu_probe(0, h);
    for (c = 0; c < ENG_PROBE_CASES; c++)
        printf("%08x\n", h[c]);
    return 0;
}
