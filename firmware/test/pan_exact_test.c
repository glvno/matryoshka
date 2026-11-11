/* SPDX-License-Identifier: GPL-3.0-only */
/* The fixed-position Pan fast path against its original per-sample expression. */
#include <stdio.h>
#include "../src/engine.c"
#include "../src/div64.c"

int main(void)
{
    esig_t input[ENG_BLOCK], position[ENG_BLOCK], left[ENG_BLOCK], right[ENG_BLOCK];
    int32_t params[PAN_NPAR] = {0};
    node_t node = {0};
    inst_t it = {0};
    uint32_t mode, n, i, seed = 123456789u, checks = 0;
    static const int32_t edges[] = {-2 * ENG_ONE, -ENG_ONE - 1, -ENG_ONE, -1, 0, 1, ENG_ONE, ENG_ONE + 1, 2 * ENG_ONE};
    int32_t base;
    uint32_t trial;
    it.in[PAN_I_IN] = input;
    it.out[PAN_O_L] = left;
    it.out[PAN_O_R] = right;
    it.eff = params;
    for (mode = 0; mode < 3; mode++) {
        it.in[PAN_I_POS] = mode ? position : zero_buf;
        for (trial = 0; trial < 1033; trial++) {
            base = trial < 9 ? edges[trial] : -2 * ENG_ONE + (int32_t)(trial - 9) * 257;
            params[PAN_P_PAN] = base;
            for (n = 1; n <= ENG_BLOCK; n++) {
                for (i = 0; i < ENG_BLOCK; i++) {
                    seed = seed * 1664525u + 1013904223u;
                    input[i] = (int32_t)(seed % (8 * ENG_ONE)) - 4 * ENG_ONE;
                    position[i] = mode == 2 ? (int32_t)(seed % (4 * ENG_ONE)) - 2 * ENG_ONE : 0;
                    left[i] = right[i] = 0x12345678;
                }
                m_pan(&node, &it, n);
                for (i = 0; i < ENG_BLOCK; i++) {
                    int32_t p = clampi(base + (mode ? position[i] : 0), -ENG_ONE, ENG_ONE);
                    uint32_t turn = (uint32_t)(p + ENG_ONE) << 13;
                    int32_t l = i < n ? mul16(input[i], sin_turn(turn + 0x40000000u)) : 0x12345678;
                    int32_t r = i < n ? mul16(input[i], sin_turn(turn)) : 0x12345678;
                    if (left[i] != l || right[i] != r) {
                        printf("Pan differs: mode %u base %d block %u sample %u\n", mode, base, n, i);
                        return 1;
                    }
                    checks++;
                }
            }
        }
    }
    printf("Pan: %u exact stereo comparisons, unconnected/zero/moving position, blocks 1..128\n", checks);
    return 0;
}
