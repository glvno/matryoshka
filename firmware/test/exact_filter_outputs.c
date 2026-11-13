/* SPDX-License-Identifier: GPL-3.0-only */
/* Differential companion to exact_filter.c. Build with the old/new engine directories first in -I:
 * cc -O1 -I<engine-directory> -Ifirmware/src firmware/test/exact_filter_outputs.c -lm -o <emitter>
 * Compare stdout byte-for-byte. Every output mask, both dummy lanes, all four nonlinear modes,
 * zero/short/full blocks, reconnects, control transitions and input/output feedback are exercised.
 * Dummy contents are deliberately not serialized: no input may read a dummy output buffer.
 * Returns 2 on overwrite, 5 on write failure, 6 on flush failure.
 */
#define main exact_filter_control_main
#include "exact_filter.c"
#undef main

static int output_masks(void)
{
    static const uint32_t lengths[] = {0, 1, 7, 127, 128, 2, 31, 128, 7};
    static const int32_t resonances[] = {0, 1, 32768, FILTER_OSC_FROM_Q16 - 1,
        FILTER_OSC_FROM_Q16, FILTER_OSC_FROM_Q16 + 1, 65535, 65536};
    filter_fixture_t f;
    uint32_t mode, lane, trial, mask, b, i, k, seed = 0x19ac73f5u;
    for (mode = 0; mode < 4; mode++) {
        for (lane = 0; lane < 2; lane++) {
            for (trial = 0; trial < 3; trial++) {
                inst_t *it = fixture_init(&f, lane, trial);
                esig_t *dummy = lane ? dummy_out1 : dummy_out;
                for (mask = 0; mask <= FILTER_ALL_OUTPUTS; mask++) {
                    for (b = 0; b < sizeof lengths / sizeof lengths[0]; b++) {
                        uint32_t n = lengths[b], live = mask;
                        uint32_t record[] = {mode, lane, trial, mask, b, n};
                        int32_t state[4];
                        int32_t alias = -1;
                        const esig_t *before = 0;
                        /* Reconnect everything after a one-sample run, exposing any incorrectly skipped state. */
                        if (b == 2)
                            live = FILTER_ALL_OUTPUTS;
                        for (k = 0; k < FILTER_NOUT; k++) {
                            it->out[k] = live & (1u << k) ? f.output[k] : dummy;
                            for (i = 0; i < ENG_BLOCK; i++)
                                f.output[k][i] = FILTER_SENTINEL;
                        }
                        f.node.conn = (1u << FILTER_I_IN) | (1u << FILTER_I_CV) | (1u << FILTER_I_MORPH);
                        it->in[FILTER_I_IN] = f.input;
                        it->in[FILTER_I_CV] = f.cv;
                        it->in[FILTER_I_MORPH] = f.morph;
                        f.params[FILTER_P_CUTOFF] = ((mask & 1u) ? 20 : (mask & 2u) ? 16000 : 1200) * ENG_ONE;
                        f.params[FILTER_P_RES] = b < 4 ? (mode >= 2 ? ENG_ONE : ENG_ONE / 2) : resonances[mask % 8u];
                        f.params[FILTER_P_OSC] = mode >= 2 ? ENG_ONE : 0;
                        f.params[FILTER_P_DRIVE] = mode & 1u ? (b < 4 ? 3 : 8) * ENG_ONE : 0;
                        f.params[FILTER_P_CVAMT] = mask & 4u ? 0 : ENG_ONE;
                        f.params[FILTER_P_TRACK] = mask & 8u ? ENG_ONE : 0;
                        f.params[FILTER_P_MORPH] = (int32_t)((mask * 997u + b * 131u) % (ENG_ONE + 1u));
                        E.pv[lane + 1u].pitch = (int32_t)(mask % (8u * ENG_ONE)) - 4 * ENG_ONE;
                        for (i = 0; i < ENG_BLOCK; i++) {
                            seed = lcg(seed);
                            f.input[i] = trial ? (int32_t)(seed % (16u * ENG_ONE)) - 8 * ENG_ONE : 0;
                            f.cv[i] = b & 1u ? (int32_t)(i / 8u) : (int32_t)(seed % (4u * ENG_ONE)) - 2 * ENG_ONE;
                            f.morph[i] = (int32_t)((seed >> 4) % (4u * ENG_ONE)) - 2 * ENG_ONE;
                            dummy_out[i] = dummy_out1[i] = FILTER_SENTINEL;
                        }
                        /* Preserve the original read-before-write ordering for valid feedback aliases. */
                        if (b >= 5 && live) {
                            if (b == 7 && (live & (1u << FILTER_O_LP24)))
                                k = FILTER_O_LP24;
                            else if (b == 8 && (live & (1u << FILTER_O_LP12)))
                                k = FILTER_O_LP12;
                            else
                                for (k = 0; !(live & (1u << k)); k++)
                                    ;
                            alias = (int32_t)k;
                            before = b == 5 ? f.input : b == 6 ? f.cv : f.morph;
                            memcpy(f.output[k], before, sizeof f.input);
                            it->in[b == 5 ? FILTER_I_IN : b == 6 ? FILTER_I_CV : FILTER_I_MORPH] = f.output[k];
                        }
                        m_filter(&f.node, it, n);
                        if (!emit(record, sizeof record))
                            return 5;
                        for (k = 0; k < FILTER_NOUT; k++) {
                            if (live & (1u << k)) {
                                if (!emit(f.output[k], n * sizeof(esig_t)))
                                    return 5;
                            } else {
                                for (i = 0; i < ENG_BLOCK; i++)
                                    if (f.output[k][i] != FILTER_SENTINEL)
                                        return 2;
                            }
                            for (i = n; i < ENG_BLOCK; i++) {
                                int32_t expected = (int32_t)k == alias ? before[i] : FILTER_SENTINEL;
                                if (f.output[k][i] != expected)
                                    return 2;
                            }
                        }
                        for (i = n; i < ENG_BLOCK; i++)
                            if (dummy_out[i] != FILTER_SENTINEL || dummy_out1[i] != FILTER_SENTINEL)
                                return 2;
                        state[0] = it->s.flt.ic1;
                        state[1] = it->s.flt.ic2;
                        state[2] = it->s.flt.jc1;
                        state[3] = it->s.flt.jc2;
                        if (!emit(state, sizeof state))
                            return 5;
                    }
                }
            }
        }
    }
    return 0;
}

int main(void)
{
    int result = output_masks();
    return result ? result : fflush(stdout) ? 6 : 0;
}
