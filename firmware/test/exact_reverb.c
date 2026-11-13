/* SPDX-License-Identifier: GPL-3.0-only */
/* Build twice with -I pointing to the old/new engine.c, then compare stdout byte for byte. Exercises the real kernel
 * with live parameters and partial blocks; emits every output and all persistent Reverb state, not pointer/padding bytes.
 * Optional arguments are complete patch binaries (for example the original Canvas phase graphs), rendered unchanged. */
#include <stdio.h>
#include "engine.c"

static int emit(const void *p, size_t n)
{
    return fwrite(p, 1, n, stdout) == n;
}

static int render_patch(const char *path)
{
    static const uint32_t notes[] = {60, 64, 67, 71, 72, 76, 79, 83};
    static const uint32_t lengths[] = {1, 7, 63, 127, ENG_BLOCK};
    uint8_t patch[8192];
    int32_t left[ENG_BLOCK], right[ENG_BLOCK];
    uint32_t b, k, n;
    size_t len;
    FILE *f = fopen(path, "rb");
    if (!f)
        return 7;
    len = fread(patch, 1, sizeof patch, f);
    if (ferror(f) || !feof(f)) {
        fclose(f);
        return 7;
    }
    fclose(f);
    if (eng_load(patch, (uint32_t)len))
        return 8;
    eng_transport(1);
    for (b = 0; b < 1536; b++) {
        if (b < 768 && b % 256 == 0)
            for (k = 0; k < sizeof notes / sizeof notes[0]; k++)
                eng_note_on(notes[k], 49152, 1);
        if (b % 256 == 192)
            eng_all_notes_off();
        if (b == 768) {
            eng_all_notes_off();
            eng_transport(0);
        }
        n = b % 256 < 32 ? lengths[b % (sizeof lengths / sizeof lengths[0])] : ENG_BLOCK;
        eng_render(left, right, n);
        if (!emit(left, n * sizeof *left) || !emit(right, n * sizeof *right))
            return 5;
    }
    return 0;
}

int main(int argc, char **argv)
{
    static const uint32_t lengths[] = {128, 1, 2, 7, 31, 63, 127};
    static const int32_t edges[] = {0, 1, 32767, 32768, ENG_ONE};
    struct { int16_t before[8], data[RV_LEN], after[8]; } memory;
    esig_t input[ENG_BLOCK], output[ENG_BLOCK];
    uint32_t trial, b, i, k, seed = 0x12345678u;
    for (trial = 0; trial < 3; trial++) {
        int32_t params[REVERB_NPAR] = {0};
        node_t node = {0};
        inst_t it = {0};
        it.in[REVERB_I_IN] = input;
        it.out[0] = output;
        it.eff = params;
        it.s.rev.buf = memory.data;
        for (i = 0; i < 8; i++)
            memory.before[i] = memory.after[i] = 0x1234;
        for (i = 0; i < RV_LEN; i++) {
            seed = lcg(seed);
            memory.data[i] = trial == 0 ? 0 : trial == 1 ? (int16_t)((int32_t)(seed >> 16) - 32768) : (i & 1) ? -32768 : 32767;
        }
        for (k = 0; k < 8; k++) {
            it.s.rev.li[k] = trial ? RV_LINE[k] - 1u : 0;
            it.s.rev.lp[k] = trial ? (k & 1) ? -4 * ENG_ONE : 4 * ENG_ONE : 0;
        }
        it.s.rev.ai[0] = trial ? RV_DIFF[0] - 1u : 0;
        it.s.rev.ai[1] = trial ? RV_DIFF[1] - 1u : 0;
        it.s.rev.pi = trial ? RV_PRE - 1u : 0;
        it.s.rev.ph[0] = trial ? 0xffffffffu : 0;
        it.s.rev.ph[1] = trial ? 0x7fffffffu : 0;
        for (b = 0; b < 2048; b++) {
            uint32_t n = lengths[b % (sizeof lengths / sizeof lengths[0])];
            if (b % 64 == 0) {
                for (k = 0; k < REVERB_NPAR; k++)
                    params[k] = (int32_t)(((int64_t)edges[(b / 64 + k) % 5] * REVERB_MAX[k]) / ENG_ONE);
            } else if (b % 17 == 0) {
                for (k = 0; k < REVERB_NPAR; k++) {
                    seed = lcg(seed);
                    params[k] = (int32_t)(seed % ((uint32_t)REVERB_MAX[k] + 1u));
                }
            }
            /* Cross the freeze threshold in both directions, retaining tails through full and partial blocks. */
            params[REVERB_P_FREEZE] = edges[(b / 32) % 5];
            for (i = 0; i < ENG_BLOCK; i++) {
                seed = lcg(seed);
                switch ((b / 128) % 4) {
                case 0: input[i] = (int32_t)(seed % (16u * ENG_ONE)) - 8 * ENG_ONE; break;
                case 1: input[i] = b % 16 == 0 && i == 0 ? (b & 16) ? -8 * ENG_ONE : 8 * ENG_ONE : 0; break;
                case 2: input[i] = (b & 16) ? -ENG_ONE : ENG_ONE; break;
                default: input[i] = 0; break;
                }
                output[i] = 0x12345678;
            }
            m_reverb(&node, &it, n);
            for (i = n; i < ENG_BLOCK; i++)
                if (output[i] != 0x12345678)
                    return 2;
            for (i = 0; i < 8; i++) {
                if (memory.before[i] != 0x1234 || memory.after[i] != 0x1234 || it.s.rev.li[i] >= RV_LINE[i])
                    return 3;
            }
            if (it.s.rev.ai[0] >= RV_DIFF[0] || it.s.rev.ai[1] >= RV_DIFF[1] || it.s.rev.pi >= RV_PRE)
                return 4;
            if (!emit(output, sizeof output) || !emit(memory.data, sizeof memory.data) ||
                !emit(it.s.rev.li, sizeof it.s.rev.li) || !emit(it.s.rev.lp, sizeof it.s.rev.lp) ||
                !emit(it.s.rev.ai, sizeof it.s.rev.ai) || !emit(&it.s.rev.pi, sizeof it.s.rev.pi) ||
                !emit(it.s.rev.ph, sizeof it.s.rev.ph))
                return 5;
        }
    }
    for (int arg = 1; arg < argc; arg++) {
        int result = render_patch(argv[arg]);
        if (result)
            return result;
    }
    return fflush(stdout) ? 6 : 0;
}
