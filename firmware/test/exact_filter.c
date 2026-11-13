/* SPDX-License-Identifier: GPL-3.0-only */
/* Compile this emitter twice, selecting old/new engine.c with -I, then compare stdout byte for byte:
 * cc -O1 -I<engine-directory> -Ifirmware/src firmware/test/exact_filter.c -lm -o <emitter>
 * <old-emitter> > <old.raw>; <new-emitter> > <new.raw>; cmp <old.raw> <new.raw>
 * Renders the real multimode kernel through m_filter, including all four specialization paths.
 * Only samples and the four original integrators are serialized: never pointers, padding or cache fields.
 * Return 2: output overrun; 3: seed-edge scenario unavailable; 5: write failure; 6: flush failure.
 */
#include <stdio.h>
#include <string.h>
#include "engine.c"

#define FILTER_SENTINEL 0x12345678
#define FILTER_ALL_OUTPUTS ((1u << FILTER_NOUT) - 1u)

static int emit(const void *p, size_t n)
{
    return fwrite(p, 1, n, stdout) == n;
}

typedef struct {
    node_t node;
    int32_t params[FILTER_NPAR];
    esig_t input[ENG_BLOCK], cv[ENG_BLOCK], morph[ENG_BLOCK];
    esig_t output[FILTER_NOUT][ENG_BLOCK];
} filter_fixture_t;

static inst_t *fixture_init(filter_fixture_t *f, uint32_t voice, uint32_t trial)
{
    inst_t *it = &inst_pool[voice + 1u];
    uint32_t k;
    memset(f, 0, sizeof *f);
    memset(it, 0, sizeof *it);
    f->node.type = T_FILTER;
    f->node.inst0 = (uint8_t)(voice + 1u);
    f->node.ninst = 1;
    f->node.grp = (uint8_t)(voice + 1u);
    E.grp[voice + 1u].pv0 = (uint8_t)(voice + 1u);
    it->eff = f->params;
    for (k = 0; k < MAX_IN; k++)
        it->in[k] = zero_buf;
    it->in[FILTER_I_IN] = f->input;
    for (k = 0; k < MAX_OUT; k++)
        it->out[k] = dummy_out;
    for (k = 0; k < FILTER_NPAR; k++)
        f->params[k] = FILTER_DEF[k];
    /* Large but representable Q20 integrators, with both signs and different stage histories. */
    if (trial) {
        int32_t a = trial == 1 ? (1 << 28) - 1 : -((1 << 28) - 1);
        it->s.flt.ic1 = a;
        it->s.flt.ic2 = -a / 2;
        it->s.flt.jc1 = -a;
        it->s.flt.jc2 = a / 3;
    }
    return it;
}

static int render(filter_fixture_t *f, inst_t *it, uint32_t n, uint32_t live,
                  uint32_t scenario, uint32_t block)
{
    uint32_t k, i;
    uint32_t record[] = {scenario, block, n, live};
    int32_t state[4];
    for (k = 0; k < FILTER_NOUT; k++) {
        it->out[k] = live & (1u << k) ? f->output[k] : dummy_out;
        for (i = 0; i < ENG_BLOCK; i++)
            f->output[k][i] = FILTER_SENTINEL;
    }
    for (i = 0; i < ENG_BLOCK; i++)
        dummy_out[i] = FILTER_SENTINEL;
    m_filter(&f->node, it, n);
    for (k = 0; k < FILTER_NOUT; k++) {
        uint32_t start = live & (1u << k) ? n : 0;
        for (i = start; i < ENG_BLOCK; i++)
            if (f->output[k][i] != FILTER_SENTINEL)
                return 2;
    }
    for (i = n; i < ENG_BLOCK; i++)
        if (dummy_out[i] != FILTER_SENTINEL)
            return 2;
    state[0] = it->s.flt.ic1;
    state[1] = it->s.flt.ic2;
    state[2] = it->s.flt.jc1;
    state[3] = it->s.flt.jc2;
    if (!emit(record, sizeof record) || !emit(f->output, sizeof f->output) || !emit(state, sizeof state))
        return 5;
    return 0;
}

/* Scenario selection only, not a replacement filter or an oracle for rendered results. The first two CVs
 * give different full denominators/refined reciprocals but the same denominator >> 8. The third crosses
 * the seed key boundary and changes the integer division result. Select independently for each stage.
 */
static int32_t selection_den(int32_t cv, int32_t damping)
{
    int32_t g = svf_g(exp2_scale(hz_turns(1200 * ENG_ONE), cv));
    return (1 << 24) + mulq(g, g + damping, 24);
}

static int32_t selection_recip(int32_t d)
{
    int32_t x = (int32_t)(0xffffffffu / ((uint32_t)d >> 8)) << 8;
    int32_t t = (int32_t)(((int64_t)d * x) >> 24);
    return (int32_t)(((int64_t)x * ((2 << 24) - t)) >> 24);
}

static int select_seed_edge(int32_t damping, int32_t cv[3])
{
    int32_t first = -ENG_ONE, last = first;
    int32_t first_den = selection_den(first, damping), last_den = first_den;
    int32_t v;
    for (v = first + 1; v <= ENG_ONE; v++) {
        int32_t den = selection_den(v, damping);
        if (((uint32_t)den >> 8) != ((uint32_t)first_den >> 8)) {
            if (selection_recip(first_den) != selection_recip(last_den) &&
                0xffffffffu / ((uint32_t)last_den >> 8) != 0xffffffffu / ((uint32_t)den >> 8)) {
                cv[0] = first;
                cv[1] = last;
                cv[2] = v;
                return 1;
            }
            first = v;
            first_den = den;
        }
        last = v;
        last_den = den;
    }
    return 0;
}

static int seed_edges(void)
{
    static const uint32_t lengths[] = {128, 1, 127, 0, 1, 7, 128, 2};
    static const uint32_t order[] = {0, 0, 1, 1, 0, 2, 2, 1, 0, 1, 2, 0};
    filter_fixture_t f;
    uint32_t stage, trial, b, i;
    int32_t damping = (2 << 24) - mulq(ENG_ONE / 2, 33218888, 16);
    for (stage = 0; stage < 2; stage++) {
        int32_t cv[3];
        if (!select_seed_edge(stage ? SQRT2_24 : damping, cv))
            return 3;
        for (trial = 0; trial < 3; trial++) {
            inst_t *it = fixture_init(&f, 0, trial);
            f.node.conn = (1u << FILTER_I_IN) | (1u << FILTER_I_CV) | (1u << FILTER_I_MORPH);
            it->in[FILTER_I_CV] = f.cv;
            it->in[FILTER_I_MORPH] = f.morph;
            f.params[FILTER_P_CUTOFF] = 1200 * ENG_ONE;
            f.params[FILTER_P_RES] = ENG_ONE / 2;
            f.params[FILTER_P_CVAMT] = ENG_ONE;
            for (b = 0; b < 128; b++) {
                uint32_t n = lengths[b % (sizeof lengths / sizeof lengths[0])];
                int result;
                for (i = 0; i < ENG_BLOCK; i++) {
                    /* Fine CV motion is genuine audio input. Repeated keys occur both within blocks and
                     * across one-sample calls; moving back also forces invalidation in both directions. */
                    f.cv[i] = cv[order[(b + i) % (sizeof order / sizeof order[0])]];
                    f.input[i] = ((b + i) & 1u) ? -4 * ENG_ONE : 4 * ENG_ONE;
                    f.morph[i] = (int32_t)((b * 131u + i * 977u) % (3u * ENG_ONE)) - ENG_ONE;
                }
                result = render(&f, it, n, FILTER_ALL_OUTPUTS, 100u + stage * 3u + trial, b);
                if (result)
                    return result;
            }
        }
    }
    return 0;
}

int main(void)
{
    static const uint32_t lengths[] = {0, 1, 127, 128, 2, 7, 31, 63, 128, 1};
    static const int32_t cutoffs[] = {20, 21, 80, 261, 1200, 4000, 12000, 16000};
    static const int32_t resonance[] = {0, 1, 32768, FILTER_OSC_FROM_Q16 - 1,
                                      FILTER_OSC_FROM_Q16, FILTER_OSC_FROM_Q16 + 1, 65535, 65536};
    static const int32_t drives[] = {0, 1, 32768, 65536, 2 * ENG_ONE, 8 * ENG_ONE};
    static const int32_t depths[] = {0, 0, 1, ENG_ONE, 4 * ENG_ONE, ENG_ONE / 2, 0, 2 * ENG_ONE};
    static const int32_t pitches[] = {-4 * ENG_ONE, -ENG_ONE, -1, 0, 1, ENG_ONE, 4 * ENG_ONE};
    static const uint32_t topologies[] = {
        FILTER_ALL_OUTPUTS,
        (1u << FILTER_O_LP12) | (1u << FILTER_O_BP) | (1u << FILTER_O_HP),
        (1u << FILTER_O_LP12) | (1u << FILTER_O_BP) | (1u << FILTER_O_HP) | (1u << FILTER_O_HP6),
        (1u << FILTER_O_LP12) | (1u << FILTER_O_BP) | (1u << FILTER_O_HP) | (1u << FILTER_O_MIX)
    };
    filter_fixture_t fixtures[2];
    inst_t *instances[2];
    uint32_t trial, b, voice, i, seed = 0x78abcdefu;
    int result = seed_edges();
    if (result)
        return result;
    for (trial = 0; trial < 3; trial++) {
        for (voice = 0; voice < 2; voice++)
            instances[voice] = fixture_init(&fixtures[voice], voice, (trial + voice) % 3u);
        for (b = 0; b < 768; b++) {
            for (voice = 0; voice < 2; voice++) {
                filter_fixture_t *f = &fixtures[voice];
                inst_t *it = instances[voice];
                uint32_t step = b + voice * 37u;
                uint32_t mode = (b / 8u + voice) % 4u;
                uint32_t cv_connected = (step / 16u) % 2u;
                uint32_t morph_connected = (step / 13u) % 2u;
                uint32_t n = lengths[step % (sizeof lengths / sizeof lengths[0])];
                uint32_t live = topologies[(b / 32u + voice) % 4u];
                f->node.conn = (uint16_t)((1u << FILTER_I_IN) |
                    (cv_connected ? 1u << FILTER_I_CV : 0u) |
                    (morph_connected ? 1u << FILTER_I_MORPH : 0u));
                it->in[FILTER_I_CV] = cv_connected ? f->cv : zero_buf;
                it->in[FILTER_I_MORPH] = morph_connected ? f->morph : zero_buf;
                f->params[FILTER_P_CUTOFF] = cutoffs[(step / 3u) % 8u] * ENG_ONE;
                /* Extended runs force each specialization; alternate sections cross all resonance edges. */
                f->params[FILTER_P_RES] = (b / 64u) & 1u ? resonance[(step / 2u) % 8u] :
                    mode >= 2 ? 65536 : 32768;
                f->params[FILTER_P_OSC] = mode >= 2 ? 65536 : 0;
                f->params[FILTER_P_DRIVE] = mode & 1u ? drives[1u + (step / 5u) % 5u] : 0;
                f->params[FILTER_P_CVAMT] = depths[(step / 2u) % 8u];
                f->params[FILTER_P_TRACK] = (step / 7u) % 4u == 0 ? 32767 :
                    (step / 7u) % 4u == 1 ? 32768 : (step / 7u) % 4u == 2 ? 0 : 65536;
                f->params[FILTER_P_MORPH] = (int32_t)((step * 1531u) % 65537u);
                E.pv[voice + 1u].pitch = pitches[(step / 5u) % 7u];
                E.pv[voice + 1u].note = (uint8_t)(12u + (step * 7u) % 109u);
                E.pv[voice + 1u].gate = step & 1u ? ENG_ONE : 0;
                for (i = 0; i < ENG_BLOCK; i++) {
                    seed = lcg(seed);
                    switch ((b / 48u) % 4u) {
                    case 0: f->input[i] = (int32_t)(seed % (16u * ENG_ONE)) - 8 * ENG_ONE; break;
                    case 1: f->input[i] = i == 0 ? (b & 1u ? -8 * ENG_ONE : 8 * ENG_ONE) : 0; break;
                    case 2: f->input[i] = (i + b) & 8u ? -ENG_ONE : ENG_ONE; break;
                    default: f->input[i] = 0; break;
                    }
                    switch ((b / 11u) % 4u) {
                    case 0: f->cv[i] = (int32_t)((i * 997u + step * 53u) % (2u * ENG_ONE)) - ENG_ONE; break;
                    case 1: f->cv[i] = (int32_t)((step * 17u + i / 8u) % 257u) - 128; break;
                    case 2: f->cv[i] = (int32_t)(seed % (2u * ENG_ONE + 1u)) - ENG_ONE; break;
                    default: f->cv[i] = (int32_t)(step % 3u) - 1; break;
                    }
                    f->morph[i] = (int32_t)((seed >> 8) % (4u * ENG_ONE)) - 2 * ENG_ONE;
                }
                result = render(f, it, n, live, trial * 2u + voice, b);
                if (result)
                    return result;
            }
        }
    }
    return fflush(stdout) ? 6 : 0;
}
