/* SPDX-License-Identifier: GPL-3.0-only */
/* Experimental Oracle voice kernel. The template fingerprint and full cable matcher own the boundary.
 * Two analog saws, hard sync, Poly Mod, two envelopes, the saturated ladder and final VCA run here.
 * A modulation prepass preserves the ladder's whole-block mean and the oscillators' pitch lookahead.
 * The public Oracle controls are runtime values. Internal oscillator copies/feedback/alternate waves,
 * selector fades and the diode ladder use the ordinary AOT path, before any DSP state advances. */
#ifndef AOT_ORACLE_HIT
#define AOT_ORACLE_HIT(c) ((void)0)
#endif
#ifndef AOT_ORACLE_FALLBACK
#define AOT_ORACLE_FALLBACK(c) ((void)0)
#endif

static inline int32_t oracle_scale(aot_cx_t *c, uint32_t m, int32_t x)
{
    return mul16(x, EF(c->it[m], SCALE_P_GAIN)) + EF(c->it[m], SCALE_P_OFFSET);
}
static inline int32_t oracle_select(aot_cx_t *c, uint32_t m, int32_t x)
{
    int32_t k = c->k[m];
    return (k == 1 ? x : 0) + EF(c->it[m], SELECT_P_V1 + k);
}
static inline int32_t oracle_vca(aot_cx_t *c, uint32_t m, int32_t x, int32_t cv)
{
    return mul16(mul16(x, cv), EF(c->it[m], VCA_P_GAIN));
}

typedef struct { int32_t v, a, d, r, sus; uint8_t stage, prev; } oracle_env_t;
static oracle_env_t oracle_env_begin(const node_t *nd, inst_t *it)
{
    /* Reuse only the coefficient cache setup; no envelope samples or graph traversal are rendered. */
    m_adsr(nd, it, 0);
    oracle_env_t e = {it->s.adsr.v, it->s.adsr.ainc, it->s.adsr.ad, it->s.adsr.ar,
                      EF(it, ADSR_P_S) << 14, it->s.adsr.stage, it->s.adsr.prev};
    return e;
}
static inline int32_t oracle_env_sample(oracle_env_t *e, int32_t gate)
{
    uint8_t g = gate > 32768;
    if (g && !e->prev) e->stage = 1;
    else if (!g && e->stage && e->stage != 4) e->stage = 4; /* Oracle has no hold cable. */
    e->prev = g;
    switch (e->stage) {
    case 1:
        e->v += e->a;
        if (e->v >= 1 << 30) { e->v = 1 << 30; e->stage = 2; }
        break;
    case 2: {
        e->v += mulq(e->sus - e->v, e->d, 30);
        int32_t d = e->sus - e->v;
        if ((d < 0 ? -d : d) < 107374) e->stage = 3;
        break;
    }
    case 3: e->v = e->sus; break;
    case 4: {
        int32_t dv = mulq(e->v, e->r, 30);
        e->v -= dv > 0 ? dv : 1;
        if (e->v < 107374) { e->v = 0; e->stage = 0; }
        break;
    }
    }
    return e->v >> 14;
}
static void oracle_env_end(inst_t *it, const oracle_env_t *e)
{
    it->s.adsr.v = e->v; it->s.adsr.stage = e->stage; it->s.adsr.prev = e->prev;
}
static void oracle_osc_end(inst_t *it, uint32_t phase, int32_t sync)
{
    it->s.osc.phase = phase; it->s.osc.s1 = sync;
    it->s.osc.y1 = it->s.osc.y2 = it->s.osc.pm1 = it->s.osc.xb = 0;
    for (uint32_t i = 0; i < 8; i++) it->s.osc.ap[i] = 0;
}

/* The shared LFO and noise retain their DSP kernels. Their switches, sums, wheel/aftertouch routes
 * and all scaling are one fixed loop, with only the twelve voice-boundary signals materialized. */
static int aot_oracle_shared(aot_cx_t *c)
{
    static const uint8_t members[] = {0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,28,42};
    static const uint8_t selectors[] = {12,13,14,23,24,25};
    uint32_t n = c->n;
    for (uint32_t j = 0; j < sizeof members; j++) aot_prepf(c, members[j], 0);
    for (uint32_t j = 0; j < sizeof selectors; j++)
        if (EF(c->it[selectors[j]], SELECT_P_FADE) != 0) return 0;
    for (uint32_t j = 0; j < sizeof selectors; j++) {
        uint32_t m = selectors[j]; c->k[m] = (int8_t)ag_select_k(c->it[m], AU(0));
        if (c->k[m] < 0) return 0;
    }
    asig_t cv[MAX_IN];
    cv[1] = AU(oracle_select(c, 25, 0));
    aot_prep_in(c, 27, 0x100u, 2u, cv);
    m_lfo(AOT_ND(c, 0), c->it[0], n);
    m_noise(AOT_ND(c, 3), c->it[3], n);
    asig_t at_filter = aot_gsum(c->it[21], 0, n), at_lfo = aot_gsum(c->it[22], 0, n);
    fill(c->it[16]->out[0], EF(c->it[16], CONST_P_VALUE), n);
    for (uint32_t i = 0; i < n; i++) c->it[22]->out[0][i] = oracle_scale(c, 22, af_read(at_lfo, i));
    asig_t wheel = aot_gsum(c->it[1], 1, n);
    int32_t mix = clampi(EF(c->it[15], XFADE_P_MIX), 0, ENG_ONE);
    int32_t minus_half = EF(c->it[5], CONST_P_VALUE), minus_one = EF(c->it[6], CONST_P_VALUE);
    for (uint32_t i = 0; i < n; i++) {
        int32_t lfo = c->it[0]->out[0][i], noise = c->it[3]->out[0][i];
        int32_t tri = math_y(5, mul16(lfo, EF(c->it[9], MATH_P_KA)) + EF(c->it[9], MATH_P_OFF), 0);
        int32_t pulse = oracle_scale(c, 11, math_y(6, mul16(lfo, EF(c->it[10], MATH_P_KA)) + EF(c->it[10], MATH_P_OFF), 0));
        int32_t shape = oracle_select(c, 12, lfo) + oracle_select(c, 13, tri + minus_half) + oracle_select(c, 14, pulse);
        int32_t source = mul16(shape, ENG_ONE - mix) + mul16(noise, mix);
        int32_t mod = oracle_vca(c, 1, source, af_read(wheel, i));
        c->it[42]->out[0][i] = oracle_scale(c, 42, oracle_scale(c, 8, 0) + oracle_scale(c, 19, mod));
        c->it[28]->out[0][i] = oracle_scale(c, 28, oracle_scale(c, 21, af_read(at_filter, i)) + oracle_scale(c, 20, mod));
        c->it[2]->out[0][i] = oracle_scale(c, 2, mod);
        c->it[17]->out[0][i] = oracle_scale(c, 17, mod);
        c->it[18]->out[0][i] = oracle_scale(c, 18, mod);
    }
    /* Materialize shared inputs before either voice lane can write through aot_in. */
    c->x->sh[0] = aot_fin(AU(oracle_scale(c, 27, EF(c->it[26], CONST_P_VALUE))), c->it[27]->out[0], 2u, n);
    c->x->sh[1] = aot_fin(AU(oracle_select(c, 23, 0)), c->it[23]->out[0], 2u, n);
    c->x->sh[2] = AU(oracle_scale(c, 7, 0));
    c->x->sh[3] = aot_fin(AU(minus_one), c->it[6]->out[0], 2u, n);
    c->x->sh[4] = AB(c->it[42]->out[0]);
    c->x->sh[5] = aot_fin(AU(minus_half), c->it[5]->out[0], 2u, n);
    c->x->sh[6] = AB(c->it[3]->out[0]);
    c->x->sh[7] = AB(c->it[28]->out[0]);
    c->x->sh[8] = AB(c->it[2]->out[0]);
    c->x->sh[9] = AB(c->it[17]->out[0]);
    c->x->sh[10] = AB(c->it[18]->out[0]);
    c->x->sh[11] = aot_fin(AU(oracle_select(c, 24, 0)), c->it[24]->out[0], 2u, n);
    return 1;
}

static int aot_oracle_voice(aot_cx_t *c)
{
    static const uint8_t plain[] = {4,29,32,33,35,37,38,39,40,41,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59};
    static const uint8_t selectors[] = {40,41,44,45,46,50,51,52,53,54,58};
    const uint32_t n = c->n;
    asig_t cv[MAX_IN];
    for (uint32_t j = 0; j < sizeof plain; j++) {
        uint32_t m = plain[j];
        aot_prepf(c, m, m == 35 || m == 37 || m == 55 || m == 57 || m == 59);
    }
    cv[3] = c->x->sh[9]; aot_prep_in(c, 30, 0x200u, 8u, cv);
    cv[3] = c->x->sh[8]; aot_prep_in(c, 31, 0x300u, 8u, cv);
    cv[2] = c->x->sh[11];
    aot_prep_in(c, 34, 0x401u, 4u, cv);
    aot_prep_in(c, 36, 0x501u, 4u, cv);
    for (uint32_t m = 30; m <= 31; m++) {
        inst_t *it = c->it[m];
        if (round_q16(EF(it, OSC_P_WAVE)) != 2 || EF(it, OSC_P_ANALOG) <= 0
            || clampi(round_q16(EF(it, OSC_P_UNISON)), 1, 5) != 1
            || clampi(round_q16(EF(it, OSC_P_STACK)), 0, 4) != 0 || EF(it, OSC_P_FB) > 0)
            goto fallback;
    }
    if (!n || EF(c->it[35], LADDER_P_DIODE) >= 32768 || EF(c->it[35], LADDER_P_STSAT) < 32768)
        goto fallback;
    for (uint32_t j = 0; j < sizeof selectors; j++)
        if (EF(c->it[selectors[j]], SELECT_P_FADE) != 0) goto fallback;
    /* All rejection checks precede selector, envelope, glide and oscillator state updates. */
    for (uint32_t j = 0; j < sizeof selectors; j++) {
        uint32_t m = selectors[j];
        c->k[m] = (int8_t)ag_select_k(c->it[m], AU(0));
        if (c->k[m] < 0) goto fallback;
    }
    AOT_ORACLE_HIT(c);
    const node_t *part = AOT_ND(c, 4);
    const pv_t *pv = IT_PV(part, c->it[4]);
    const grp_t *group = IT_G(part);
    const int32_t np = group->parts;
    const int32_t index = np > 1 ? (2 * (int32_t)IT_V(part, c->it[4]) - (np - 1)) * 65536 / (np - 1) : 0;
    const int32_t key = pv->pitch + mulq(E.ctl[ENG_CTL_BEND], 10923, 16) + pv->flaw;
    const int32_t uni = oracle_vca(c, 59, index, group->unison ? ENG_ONE : 0);
    esig_t *glide = c->it[29]->out[0], *pitch_b = c->it[30]->out[0];
    inst_t *gi = c->it[29];
    int32_t gy = gi->s.gld.y, fall = EF(gi, GLIDE_P_FALL);
    int linear = round_q16(EF(gi, GLIDE_P_CURVE)) == 1;
    int32_t rise = linear ? glide_step(EF(gi, GLIDE_P_TIME)) : env_rate(EF(gi, GLIDE_P_TIME));
    int32_t down = fall > 0 ? (linear ? glide_step(fall) : env_rate(fall)) : rise;
    for (uint32_t i = 0; i < n; i++) {
        int32_t x = key + af_read(c->x->sh[0], i) + uni;
        int32_t d = (clampi(x, -(1 << 23), (1 << 23) - 1) << 8) - gy;
        if (linear) gy += d > rise ? rise : d < -down ? -down : d;
        else gy += mulq(d >= 0 ? rise : down, d, 30);
        glide[i] = (gy + 128) >> 8;
        pitch_b[i] = oracle_select(c, 58, glide[i]) + af_read(c->x->sh[1], i);
    }
    gi->s.gld.y = gy;

    inst_t *ob = c->it[30], *oa = c->it[31], *filter = c->it[35];
    oracle_env_t fe = oracle_env_begin(AOT_ND(c, 34), c->it[34]);
    oracle_env_t ae = oracle_env_begin(AOT_ND(c, 36), c->it[36]);
    ana_t ab;
    ana_init(&ab, clampi(EF(ob, OSC_P_ANALOG), 0, ENG_ONE), ob->s.osc.tol,
             ANALOG_DIP_SAMPLES_Q16, clampi(EF(ob, OSC_P_PW), 3277, 62259));
    int32_t base_b = EF(ob, OSC_P_COARSE) / 12 + EF(ob, OSC_P_FINE) / 1200;
    uint32_t phase_b = ob->s.osc.phase, i;
    const esig_t *pitch = pitch_b;
    inc_ramp_t rb;
    int64_t filter_sum = 0;
    esig_t *pitch_a = oa->out[0], *sync_a = c->it[33]->out[0];
    esig_t *pulse_a = c->it[38]->out[0], *mix_b = c->it[47]->out[0], *amp = c->it[57]->out[0];
    const int32_t vf = oracle_select(c, 53, pv->vel), va = oracle_select(c, 54, pv->vel);
    INC_LOOP(rb, base_b) {
        phase_b += dt_;
        int32_t b = mul16(ana_saw(phase_b, dt_, ab, ob->s.osc.rc[0]), EF(ob, OSC_P_LEVEL));
        pitch_b[i] = b; /* Pitch lookahead reads only future indices: this now holds oscillator B's output. */
        int32_t gate = i == 0 && pv->retrig ? 0 : pv->gate;
        int32_t env_f = oracle_env_sample(&fe, gate), env_a = oracle_env_sample(&ae, gate);
        int32_t bx = mul16(b, EF(c->it[43], MATH_P_KA)) + EF(c->it[43], MATH_P_OFF);
        int32_t by = mul16(af_read(c->x->sh[4], i), EF(c->it[43], MATH_P_KB));
        int32_t bmix = oracle_select(c, 44, b)
            + oracle_select(c, 45, math_y(5, bx, by) + af_read(c->x->sh[5], i))
            + oracle_select(c, 46, math_y(6, bx, by) + af_read(c->x->sh[3], i));
        int32_t mod = oracle_scale(c, 49, oracle_scale(c, 32, env_f) + oracle_scale(c, 48, bmix));
        pitch_a[i] = glide[i] + oracle_select(c, 50, mod);
        sync_a[i] = oracle_scale(c, 33, b);
        pulse_a[i] = oracle_scale(c, 38, af_read(c->x->sh[2], i) + oracle_select(c, 51, mod) + af_read(c->x->sh[10], i));
        filter_sum += oracle_scale(c, 56, oracle_vca(c, 55, env_f, vf))
            + oracle_select(c, 52, mod) + af_read(c->x->sh[7], i);
        mix_b[i] = mul16(bmix, EF(c->it[47], MIXER_P_L2)) + mul16(af_read(c->x->sh[6], i), EF(c->it[47], MIXER_P_L3));
        amp[i] = oracle_vca(c, 57, env_a, va);
    }
    oracle_osc_end(ob, phase_b, 0);
    oracle_env_end(c->it[34], &fe); oracle_env_end(c->it[36], &ae);

    int32_t octave = (EF(filter, LADDER_P_TRACK) >= 32768 ? pv->pitch : 0)
        + mul16(block_mean(filter_sum, n), EF(filter, LADDER_P_CVAMT));
    uint32_t base = hz_turns((uint32_t)EF(filter, LADDER_P_CUTOFF));
    int32_t g = svf_g(octave ? exp2_scale(base, octave) : base);
    int32_t G = mulq(g, recip24((1 << 24) + g), 24), G2 = mulq(G, G, 24);
    int32_t G3 = mulq(G2, G, 24), G4 = mulq(G3, G, 24), hG = (1 << 24) - G;
    int32_t k24 = EF(filter, LADDER_P_RES) << 10, F = recip24((1 << 24) + mulq(k24, G4, 24));
    int32_t s0 = filter->s.lad.s[0], s1 = filter->s.lad.s[1], s2 = filter->s.lad.s[2], s3 = filter->s.lad.s[3];
    ana_t aa;
    ana_init(&aa, clampi(EF(oa, OSC_P_ANALOG), 0, ENG_ONE), oa->s.osc.tol,
             ANALOG_DIP_SAMPLES_Q16, clampi(EF(oa, OSC_P_PW), 3277, 62259));
    int32_t base_a = EF(oa, OSC_P_COARSE) / 12 + EF(oa, OSC_P_FINE) / 1200;
    uint32_t phase_a = oa->s.osc.phase;
    int32_t previous_sync = oa->s.osc.s1;
    inc_ramp_t ra;
    pitch = pitch_a;
    INC_LOOP(ra, base_a) {
        if (sync_a[i] >= 32768 && previous_sync < 32768) phase_a = 0;
        previous_sync = sync_a[i];
        phase_a += dt_;
        int32_t a = mul16(ana_saw(phase_a, dt_, aa, oa->s.osc.rc[0]), EF(oa, OSC_P_LEVEL));
        int32_t ax = mul16(a, EF(c->it[39], MATH_P_KA)) + EF(c->it[39], MATH_P_OFF);
        int32_t ay = mul16(pulse_a[i], EF(c->it[39], MATH_P_KB));
        int32_t amix = oracle_select(c, 40, a) + oracle_select(c, 41, math_y(6, ax, ay) + af_read(c->x->sh[3], i));
        int32_t x20 = (mul16(amix, EF(c->it[47], MIXER_P_L1)) + mix_b[i]) << 4;
        int32_t S = mulr(G3, s0, 24) + mulr(G2, s1, 24) + mulr(G, s2, 24) + s3;
        S = mulr(S, hG, 24);
        int32_t y4 = mulr(F, mulr(G4, x20, 24) + S, 24);
        int32_t u = lad_sat(mulq(x20, EF(filter, LADDER_P_DRIVE), 16) - mulq(k24, y4, 24)), v;
        v = mulr(G, u - s0, 24); u = v + s0; s0 = u + v;
        u = lad_sat_st(u);
        v = mulr(G, u - s1, 24); u = v + s1; s1 = u + v;
        u = lad_sat_st(u);
        v = mulr(G, u - s2, 24); u = v + s2; s2 = u + v;
        u = lad_sat_st(u);
        v = mulr(G, u - s3, 24); u = v + s3; s3 = u + v;
        c->it[37]->out[0][i] = oracle_vca(c, 37, (u + 8) >> 4, amp[i]);
    }
    oracle_osc_end(oa, phase_a, previous_sync);
    filter->s.lad.s[0] = s0; filter->s.lad.s[1] = s1; filter->s.lad.s[2] = s2; filter->s.lad.s[3] = s3;
    return 1;
fallback:
    AOT_ORACLE_FALLBACK(c);
    return 0;
}
