/* SPDX-License-Identifier: GPL-3.0-only */
/* Compile twice with -I<old/new engine directory> -Ifirmware/src, then compare stdout.
 * Emits real m_pd samples and its four original state fields, never padding or pointers.
 * Optional argument: a native patch to render as well (with every PD voice's state).
 * Compatible with the kernel-emitter loop in tools/engine_exact.sh; add pd to its kind list.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "engine.c"

#define PD_SENTINEL 0x12345678

static void emit(const void *p, size_t n)
{
    if (fwrite(p, 1, n, stdout) != n) exit(2);
}

static void emit_state(const inst_t *it)
{
    uint32_t state[] = {it->s.pd.phase, it->s.pd.r, (uint32_t)it->s.pd.s1, it->s.pd.odd};
    emit(state, sizeof state);
}

static void wave_pairs(void)
{
    static const uint32_t lengths[] = {0, 1, 2, 7, 8, 9, 63, 64, 65, 127, 128, 3};
    static const uint32_t phases[] = {0, 1, 0x0fffffffu, 0x10000000u, 0x7fffffffu,
                                    0x80000000u, 0xefffffffu, 0xfffffff0u, 0xffffffffu};
    static const int32_t control[] = {-ENG_ONE, 0, 1, ENG_ONE / 2, ENG_ONE - 1, ENG_ONE, 2 * ENG_ONE};
    static const int32_t ranges[] = {-ENG_ONE, 0, 1, ENG_ONE, 3 * ENG_ONE, 5 * ENG_ONE, 6 * ENG_ONE};
    esig_t pitch[ENG_BLOCK], dcw[ENG_BLOCK], pm[ENG_BLOCK], sync[ENG_BLOCK], output[ENG_BLOCK];
    uint32_t w1, w2, odd, mode, trial = 0;
    for (w1 = 0; w1 < 8; w1++) for (w2 = 0; w2 <= 8; w2++)
    for (odd = 0; odd < 2; odd++) for (mode = 0; mode < 8; mode++, trial++) {
        node_t node = {0};
        inst_t it = {0};
        int32_t params[PD_NPAR];
        uint32_t b, i;
        memcpy(params, PD_DEF, sizeof params);
        node.type = T_PD;
        it.eff = params;
        for (i = 0; i < MAX_IN; i++) it.in[i] = zero_buf;
        for (i = 0; i < MAX_OUT; i++) it.out[i] = dummy_out;
        it.in[PD_I_PITCH] = pitch;
        it.in[PD_I_DCW] = dcw;
        it.out[PD_O_OUT] = output;
        it.s.pd.phase = phases[trial % 9u];
        it.s.pd.r = 0xa128f731u + trial * 0x9e3779b9u;
        it.s.pd.odd = (uint8_t)odd;
        it.s.pd.s1 = trial & 1u ? ENG_ONE : -ENG_ONE;
        for (b = 0; b < 72; b++) {
            uint32_t n = lengths[b % 12u], live = b < 24 ? mode : (mode + b / 3u) % 8u;
            uint32_t record[] = {trial, b, n, live};
            node.conn = (1u << PD_I_PITCH) | (1u << PD_I_DCW) |
                        (live & 1u ? 1u << PD_I_SYNC : 0u) | (live & 2u ? 1u << PD_I_PM : 0u);
            it.in[PD_I_PM] = live & 2u ? pm : zero_buf;
            it.in[PD_I_SYNC] = live & 1u ? sync : zero_buf;
            params[PD_P_WAVE] = (int32_t)(b < 24 ? w1 : (w1 + b / 3u) % 8u) * ENG_ONE;
            params[PD_P_WAVE2] = (int32_t)(b < 24 ? w2 : (w2 + b / 2u) % 9u) * ENG_ONE;
            params[PD_P_DCW] = control[(b / 2u + trial) % 7u];
            params[PD_P_RANGE] = ranges[(b / 3u + trial) % 7u];
            params[PD_P_PM] = live & 4u ? (b & 1u ? 2 * ENG_ONE : ENG_ONE / 3) : 0;
            params[PD_P_LEVEL] = b % 7u ? ENG_ONE : ENG_ONE / 3;
            params[PD_P_COARSE] = ((int32_t)((b / 6u + trial) % 49u) - 24) * ENG_ONE;
            params[PD_P_FINE] = ((int32_t)((b + trial) % 201u) - 100) * ENG_ONE;
            for (i = 0; i < ENG_BLOCK; i++) {
                pitch[i] = b % 4u == 0 ? 0 : b % 4u == 1 ? 4 * ENG_ONE :
                    ((int32_t)((i / 7u + b + trial) % 17u) - 8) * (ENG_ONE / 2);
                dcw[i] = b % 3u == 0 ? control[(b + trial) % 7u] :
                    ((int32_t)((i * 7919u + trial * 31u + b * 997u) % (4u * ENG_ONE)) - 2 * ENG_ONE);
                pm[i] = (int32_t)((i * 13171u + b * 1123u) % (4u * ENG_ONE)) - 2 * ENG_ONE;
                sync[i] = (i + b) % 11u < 4u ? ENG_ONE : (i + b) % 11u == 4u ? 32767 : 32768;
                output[i] = PD_SENTINEL;
            }
            m_pd(&node, &it, n);
            for (i = n; i < ENG_BLOCK; i++) if (output[i] != PD_SENTINEL) exit(3);
            emit(record, sizeof record);
            emit(output, n * sizeof output[0]);
            emit_state(&it);
        }
    }
}

static void saved_patch(const char *path)
{
    uint8_t patch[65536];
    esig_t left[ENG_BLOCK], right[ENG_BLOCK];
    static const uint32_t lengths[] = {128, 1, 7, 63, 127};
    FILE *file = fopen(path, "rb");
    uint32_t len, b, m, v;
    if (!file) exit(4);
    len = (uint32_t)fread(patch, 1, sizeof patch, file);
    if (ferror(file) || !feof(file)) exit(4);
    fclose(file);
    if (eng_load(patch, len)) exit(5);
    for (m = 0; m < E.nmod; m++) if (E.node[m].type == T_PD) {
        const node_t *nd = &E.node[m];
        fprintf(stderr, "PD module-index=%u conn=0x%04x voices=%u wave=%d wave2=%d pm=%d range=%d sync=%u\n",
                m, nd->conn, nd->ninst, nd->par[PD_P_WAVE], nd->par[PD_P_WAVE2],
                nd->par[PD_P_PM], nd->par[PD_P_RANGE], (nd->conn >> PD_I_SYNC) & 1u);
    }
    eng_note_on(60, ENG_ONE, 1);
    eng_note_on(62, ENG_ONE, 1);
    eng_note_on(67, ENG_ONE, 1);
    eng_note_on(70, ENG_ONE, 1);
    for (b = 0; b < 768; b++) {
        uint32_t n = lengths[b % 5u];
        if (b == 384) eng_all_notes_off();
        eng_render(left, right, n);
        emit(left, n * sizeof left[0]);
        emit(right, n * sizeof right[0]);
        for (m = 0; m < E.nmod; m++) if (E.node[m].type == T_PD)
            for (v = 0; v < E.node[m].ninst; v++) emit_state(&inst_pool[E.node[m].inst0 + v]);
    }
}

int main(int argc, char **argv)
{
    if (argc > 2) return 4;
    wave_pairs();
    if (argc == 2) saved_patch(argv[1]);
    return fflush(stdout) || ferror(stdout) ? 2 : 0;
}
