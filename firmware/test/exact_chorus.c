/* SPDX-License-Identifier: GPL-3.0-only */
/* Build twice with -I pointing to the old/new engine.c, then compare stdout byte for byte:
 *   cc -O1 -w -I<engine-source-directory> firmware/test/exact_chorus.c -lm -o <emitter>
 *   <old-emitter> > <old-output>; <new-emitter> > <new-output>; cmp <old-output> <new-output>
 * Emits actual stereo samples, the complete Q13 ring and the original persistent write index/phase, never struct
 * padding, pointers or optimization-only caches. Connected inputs/outputs are separate: buf_take requires the previous
 * value's end to be strictly before the new definition, so eng_load does not permit Chorus input/output aliasing. */
#include <stdio.h>
#include "engine.c"

static int emit(const void *p, size_t n)
{
    return fwrite(p, 1, n, stdout) == n;
}

static int render_case(uint32_t trial, uint32_t phase, uint32_t w, uint32_t blocks, int endpoints)
{
    static const uint32_t lengths[] = {0, 1, 127, 128, 1, 128, 127, 0, 7, 63};
    static const int32_t levels[] = {0, ENG_ONE, ENG_ONE - 1, 32768, 1, 32767};
    static const int32_t extremes[] = {
        0, 1, -1, 3, 4, -4, -5, ENG_ONE, -ENG_ONE,
        4 * ENG_ONE - 5, 4 * ENG_ONE - 4, 4 * ENG_ONE - 1, 4 * ENG_ONE,
        -4 * ENG_ONE - 5, -4 * ENG_ONE - 4, -4 * ENG_ONE + 3, -4 * ENG_ONE + 4,
        8 * ENG_ONE, -8 * ENG_ONE
    };
    struct { int16_t before[8], data[CH_LEN], after[8]; } memory;
    esig_t input[ENG_BLOCK], left[ENG_BLOCK], right[ENG_BLOCK];
    int32_t params[CHORUS_NPAR] = {0};
    node_t node = {0};
    inst_t it = {0};
    uint32_t seed = 0x12345678u ^ (trial * 0x9e3779b9u), b, i;

    node.type = T_CHORUS;
    it.in[CHORUS_I_IN] = input;
    it.out[CHORUS_O_L] = left;
    it.out[CHORUS_O_R] = right;
    it.eff = params;
    it.s.ch.buf = memory.data;
    it.s.ch.w = w;
    it.s.ch.phase = phase;
    for (i = 0; i < 8; i++)
        memory.before[i] = memory.after[i] = 0x1234;
    for (i = 0; i < CH_LEN; i++) {
        seed = lcg(seed);
        memory.data[i] = trial % 3 == 0 ? 0 : trial % 3 == 1 ?
            (int16_t)((int32_t)(seed >> 16) - 32768) : (i & 1) ? -32768 : 32767;
    }

    for (b = 0; b < blocks; b++) {
        uint32_t n = lengths[b % (sizeof lengths / sizeof lengths[0])];
        /* The first one-sample call uses full depth/mix and maximum rate: starts just below table or quadrature
         * wrap cross immediately, while the following minimum-rate partial block spends many samples per endpoint. */
        switch (b % 6) {
        case 0: params[CHORUS_P_RATE] = CHORUS_MIN[CHORUS_P_RATE]; break;
        case 1: params[CHORUS_P_RATE] = CHORUS_MAX[CHORUS_P_RATE]; break;
        case 2: params[CHORUS_P_RATE] = CHORUS_MIN[CHORUS_P_RATE] + 1; break;
        case 3: params[CHORUS_P_RATE] = CHORUS_MAX[CHORUS_P_RATE] - 1; break;
        case 4: params[CHORUS_P_RATE] = CHORUS_DEF[CHORUS_P_RATE]; break;
        default: params[CHORUS_P_RATE] = ENG_ONE; break;
        }
        params[CHORUS_P_DEPTH] = levels[b % (sizeof levels / sizeof levels[0])];
        params[CHORUS_P_MIX] = levels[(endpoints ? b : b + trial) % (sizeof levels / sizeof levels[0])];
        if (!endpoints && b % 17 == 16) {
            uint32_t k;
            for (k = 0; k < CHORUS_NPAR; k++) {
                seed = lcg(seed);
                params[k] = CHORUS_MIN[k] + (int32_t)(seed % ((uint32_t)(CHORUS_MAX[k] - CHORUS_MIN[k]) + 1u));
            }
        }

        for (i = 0; i < ENG_BLOCK; i++) {
            seed = lcg(seed);
            switch (endpoints ? trial % 4 : (b / 128) % 5) {
            case 0:
                input[i] = extremes[(b + i) % (sizeof extremes / sizeof extremes[0])];
                break;
            case 1:
                /* Both signs, including an impulse in the final valid sample of a partial block. */
                input[i] = b % 8 == 1 && (i == 0 || i + 1u == n) ? (b & 8) ? -8 * ENG_ONE : 8 * ENG_ONE : 0;
                break;
            case 2:
                input[i] = (int32_t)(seed % (16u * ENG_ONE + 1u)) - 8 * ENG_ONE;
                break;
            case 3:
                input[i] = (i & 1) ? -8 * ENG_ONE : 8 * ENG_ONE;
                break;
            default:
                input[i] = 0;
                break;
            }
            left[i] = right[i] = 0x12345678;
        }

        m_chorus(&node, &it, n);
        for (i = n; i < ENG_BLOCK; i++)
            if (left[i] != 0x12345678 || right[i] != 0x12345678)
                return 2;
        for (i = 0; i < 8; i++)
            if (memory.before[i] != 0x1234 || memory.after[i] != 0x1234)
                return 3;
        if (it.s.ch.w >= CH_LEN)
            return 4;
        if (!emit(left, n * sizeof *left) || !emit(right, n * sizeof *right) ||
            !emit(memory.data, sizeof memory.data) || !emit(&it.s.ch.w, sizeof it.s.ch.w) ||
            !emit(&it.s.ch.phase, sizeof it.s.ch.phase))
            return 5;
    }
    return 0;
}

int main(void)
{
    /* Long, uninterrupted histories retain audio through dry/zero-depth periods and live control edits, then expose it
     * wet again. Start at the normal reset and immediately before phase/right-tap wrap, with write-head wrap as well. */
    static const uint32_t phases[] = {0, 0xffffffffu, 0xbfffffffu};
    /* Exhaust all 1024 table intervals, including both quadrature wraps, at the exact endpoint, its first interpolation
     * step, its final interpolation step and its final phase bit. The sine discards the low six phase bits. */
    static const uint32_t offsets[] = {0, 64, 0x003fffc0u, 0x003fffffu};
    uint32_t trial, index, edge;
    int result;

    for (trial = 0; trial < sizeof phases / sizeof phases[0]; trial++) {
        result = render_case(trial, phases[trial], trial ? CH_LEN - 1u : 0, 2048, 0);
        if (result)
            return result;
    }
    for (index = 0; index < 1024; index++)
        for (edge = 0; edge < sizeof offsets / sizeof offsets[0]; edge++) {
            trial = 3u + index * 4u + edge;
            result = render_case(trial, (index << 22) + offsets[edge], CH_LEN - 1u - edge, 8, 1);
            if (result)
                return result;
        }
    return fflush(stdout) ? 6 : 0;
}
