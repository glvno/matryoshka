/* SPDX-License-Identifier: GPL-3.0-only */
/* Factory assemblies compiled ahead of time (#808, a spike). Included by engine.c after process(), before render_split.
 *
 * web/scripts/gen-aot.ts (run by npm run export-defs) writes aot_gen.h: for each compiled factory assembly a template
 * (its members' types and groups, its cables, the ports the patch may cable from outside) and one routine per segment
 * (a run of members of one group: once, or once per part). At load, aot_bind finds each device whose structure fingerprint
 * (the device extras, format 34) is a template's, checks that the loaded modules are the template's module for module and
 * cable for cable, and that running its members together gives the same result as the interpreter (every cable keeps its
 * direction in the processing order, no other module runs between them that is cabled to them). Anything else runs on the
 * interpreter as before.
 *
 * The routines call the interpreter's own pieces (apply_cv, apply_flaws, process), so the arithmetic is the same by
 * construction. What they leave out:
 *   - the per-module dispatch and the summing loops of render_mods;
 *   - the stateless modules (Constant, Scale, VCA, Math, Selector, Mixer, Crossfade): a signal is a buffer or, when every
 *     sample of the block is the same, one value (asig_t), and these modules work on it as the interpreter's loop would on
 *     every sample. A buffer is written only where a module the routine does not inline reads it;
 *   - stateless modules nothing reads in this block: their outputs are worked out when first read (a Selector reads only
 *     the input it has chosen), so a switch's other side costs nothing.
 * A member's state is never skipped: every stateful module runs in every block, a Selector updates its position in every
 * block. */

#ifndef ENG_AOT
#define ENG_AOT 1
#endif

#if ENG_AOT

typedef struct { const esig_t *b; int32_t u; } asig_t;   /* a signal: a buffer, or (b 0) the value of every sample */

#define AOT_MAXM 64u          /* members of a compiled assembly (gen-aot.ts checks these limits) */
#define AOT_MAXX 4u           /* compiled instances in a patch (more run on the interpreter) */
#define AOT_MAXSH 32u         /* signals a segment hands to the later ones */
#define AOT_MAXS 48u          /* signals of one segment */
#define AOT_MAXCV 12u         /* members with a parameter input cabled (their means kept from part to part) */

typedef struct { uint8_t from, fp, to, tp, fwd; } aot_cab_t;   /* member indices; fwd: from runs before to */
struct aot_x;
typedef void (*aot_seg_fn)(struct aot_x *x, uint32_t v, uint32_t n);
typedef struct {
    uint32_t structure;              /* structure.ts fingerprint */
    uint8_t n, ncab, nseg;
    const uint8_t *type, *grp;       /* per member: its type, its group (0 runs once, k: the template's poly group k) */
    const aot_cab_t *cab;
    const uint8_t *xin, *xout;       /* the ports that may be cabled from / to outside: pairs (member, port), 0xFF ends */
    const uint8_t *seg_grp, *seg_lead;   /* per segment: its group, a member of it */
    const aot_seg_fn *seg;
    const char *name;
} aot_tpl_t;

typedef struct aot_x {
    const aot_tpl_t *t;
    uint8_t node[AOT_MAXM];          /* member -> module index */
    asig_t sh[AOT_MAXSH];
    uint8_t on;                      /* this block: compiled (else the interpreter renders its members) */
} aot_x_t;

typedef struct {                     /* one lane's context while a segment renders one part */
    aot_x_t *x;
    uint32_t n, v;
    inst_t *it[AOT_MAXM];
    asig_t s[AOT_MAXS];
    uint8_t d[AOT_MAXS];             /* s[k] is worked out */
    uint8_t prep[AOT_MAXM];          /* the member's parameters are worked out (apply_cv) */
    int8_t k[AOT_MAXM];              /* a Selector's chosen input (-1: it fades, its outputs are buffers) */
    int32_t means[MAX_IN];
    const inst_t *pv[AOT_MAXCV];     /* apply_cv's prev: the member's last part in this lane and block, whose means mc holds */
    int32_t mc[AOT_MAXCV][MAX_IN];
} aot_cx_t;

/* the state lives in the engine's arena, after the lines (what a load leaves free; RAM has no room for it): */
typedef struct {
    aot_cx_t cx[2];                          /* (one per lane) */
    aot_x_t x[AOT_MAXX];
    uint8_t slot[ENG_MAX_MODULES];           /* per position in E.order: 0, or 1 + the instance it belongs to (bit 7: its first) */
} aot_mem_t;
static aot_mem_t *aot_m;
#define aot_x (aot_m->x)
#define aot_cx (aot_m->cx)
#define aot_slot (aot_m->slot)
static uint8_t aot_nx;                       /* instances bound by the last load (0: aot_m may be stale) */
static uint8_t aot_enabled = 1;              /* 0: the interpreter for every module (aot_test.c renders both ways) */
static struct { aot_x_t *x; uint32_t seg, n; } aot_job;

#define AU(v) ((asig_t){0, (int32_t)(v)})
static inline asig_t AB(const esig_t *b) { asig_t s; s.b = b; s.u = 0; return s; }

/* the context of member L for part v of this segment */
#define AOT_IT(c, L) ((c)->it[L])
#define AOT_ND(c, L) (&E.node[(c)->x->node[L]])
static inline void aot_bind_it(aot_cx_t *c, uint32_t L)
{
    const node_t *nd = &E.node[c->x->node[L]];
    c->it[L] = &inst_pool[nd->inst0 + (nd->ninst > 1u ? c->v : 0u)];
}

/* s into dst (filled, or copied), dst returned */
static esig_t *aot_put(asig_t s, esig_t *dst, uint32_t n)
{
    uint32_t i;
    if (!s.b)
        fill(dst, s.u, n);
    else if (s.b != dst)
        for (i = 0; i < n; i++)
            dst[i] = s.b[i];
    return dst;
}

/* an input a module the routine does not inline reads through it->in[p] (canon): a buffer as it is, a value into canon */
static const esig_t *aot_in(asig_t s, const esig_t *canon, uint32_t n)
{
    if (s.b)
        return s.b;
    fill((esig_t *)canon, s.u, n);
    return canon;
}

/* one summing input as render_mods sums it (its sources' buffers are current): an input with an outside source */
static asig_t aot_gsum(inst_t *it, uint32_t p, uint32_t n)
{
    uint32_t s, q, i;
    for (s = it->sum0; s < (uint32_t)it->sum0 + it->nsum; s++) {
        const sum_t *sm = &E.sum[s];
        esig_t *dst = sm->dst;
        if (dst != it->in[p])
            continue;
        for (i = 0; i < n; i++)
            dst[i] = 0;
        for (q = 0; q < sm->n; q++) {
            const esig_t *src = E.sum_src[sm->first + q];
            const int32_t w = E.sum_w[sm->first + q];
            if (w)
                for (i = 0; i < n; i++)
                    dst[i] += mul16(src[i], w);
            else
                for (i = 0; i < n; i++)
                    dst[i] += src[i];
        }
        break;
    }
    return AB(it->in[p]);
}

/* a + b into dst (the input's summing buffer) */
static asig_t aot_add(asig_t a, asig_t b, esig_t *dst, uint32_t n)
{
    uint32_t i;
    if (!a.b && !b.b)
        return AU(a.u + b.u);
    if (!b.b && !b.u)
        return a;
    if (!a.b && !a.u)
        return b;
    if (!a.b || !b.b) {
        const esig_t *x = a.b ? a.b : b.b;
        int32_t u = a.b ? b.u : a.u;
        for (i = 0; i < n; i++)
            dst[i] = x[i] + u;
    } else {
        const esig_t *x = a.b, *y = b.b;
        for (i = 0; i < n; i++)
            dst[i] = x[i] + y[i];
    }
    return AB(dst);
}

/* ---- the stateless modules (each the same arithmetic as its m_ function, sample for sample) */

static inline asig_t ag_const(const inst_t *it) { return AU(EF(it, 0)); }   /* m_const (and a Macro) */

static asig_t ag_scale(inst_t *it, asig_t in, uint32_t n)                   /* m_scale */
{
    esig_t *out = it->out[0];
    int32_t g = EF(it, SCALE_P_GAIN), o = EF(it, SCALE_P_OFFSET);
    uint32_t i;
    if (!g)
        return AU(o);
    if (!in.b)
        return AU(g == ENG_ONE ? in.u + o : mul16(in.u, g) + o);
    if (g == ENG_ONE) {
        if (!o)
            return in;
        for (i = 0; i < n; i++)
            out[i] = in.b[i] + o;
    } else
        for (i = 0; i < n; i++)
            out[i] = mul16(in.b[i], g) + o;
    return AB(out);
}

static asig_t ag_vca(inst_t *it, asig_t in, asig_t cv, uint32_t n)         /* m_vca */
{
    esig_t *out = it->out[0];
    int32_t g = EF(it, VCA_P_GAIN);
    uint32_t i;
    if (!g || (!in.b && !in.u) || (!cv.b && !cv.u))
        return AU(0);
    if (!in.b && !cv.b)
        return AU(g == ENG_ONE ? mul16(in.u, cv.u) : mul16(mul16(in.u, cv.u), g));
    if (g == ENG_ONE) {
        if (!cv.b && cv.u == ENG_ONE)
            return in;
        if (!in.b && in.u == ENG_ONE)
            return cv;
        if (!cv.b)
            for (i = 0; i < n; i++)
                out[i] = mul16(in.b[i], cv.u);
        else if (!in.b)
            for (i = 0; i < n; i++)
                out[i] = mul16(in.u, cv.b[i]);
        else
            for (i = 0; i < n; i++)
                out[i] = mul16(in.b[i], cv.b[i]);
    } else {
        if (!cv.b)
            for (i = 0; i < n; i++)
                out[i] = mul16(mul16(in.b[i], cv.u), g);
        else if (!in.b)
            for (i = 0; i < n; i++)
                out[i] = mul16(mul16(in.u, cv.b[i]), g);
        else
            for (i = 0; i < n; i++)
                out[i] = mul16(mul16(in.b[i], cv.b[i]), g);
    }
    return AB(out);
}

static inline int32_t math_y(uint32_t k, int32_t a, int32_t b)
{
    switch (k) {
    case MATH_O_ADD: return a + b;
    case MATH_O_SUB: return a - b;
    case MATH_O_MUL: return mul16(a, b);
    case MATH_O_MIN: return a < b ? a : b;
    case MATH_O_MAX: return a > b ? a : b;
    case MATH_O_ABS: return a < 0 ? -a : a;
    case MATH_O_CMP: return a > b ? ENG_ONE : 0;
    default: return bit_xor(a, b);
    }
}
static asig_t ag_math(inst_t *it, asig_t ia, asig_t ib, uint32_t k, uint32_t n)   /* m_math, output k */
{
    esig_t *dst = it->out[k];
    int32_t ka = EF(it, MATH_P_KA), kb = EF(it, MATH_P_KB), off = EF(it, MATH_P_OFF);
    uint32_t i;
    if (!ia.b && !ib.b)
        return AU(math_y(k, mul16(ia.u, ka) + off, mul16(ib.u, kb)));
#define AOT_MATH(Y) \
    if (!ib.b) { int32_t b = mul16(ib.u, kb); for (i = 0; i < n; i++) { int32_t a = mul16(ia.b[i], ka) + off; dst[i] = (Y); } } \
    else if (!ia.b) { int32_t a = mul16(ia.u, ka) + off; for (i = 0; i < n; i++) { int32_t b = mul16(ib.b[i], kb); dst[i] = (Y); } } \
    else for (i = 0; i < n; i++) { int32_t a = mul16(ia.b[i], ka) + off, b = mul16(ib.b[i], kb); dst[i] = (Y); }
    switch (k) {
    case MATH_O_ADD: AOT_MATH(a + b) break;
    case MATH_O_SUB: AOT_MATH(a - b) break;
    case MATH_O_MUL: AOT_MATH(mul16(a, b)) break;
    case MATH_O_MIN: AOT_MATH(a < b ? a : b) break;
    case MATH_O_MAX: AOT_MATH(a > b ? a : b) break;
    case MATH_O_ABS: AOT_MATH(((void)b, a < 0 ? -a : a)) break;
    case MATH_O_CMP: AOT_MATH(a > b ? ENG_ONE : 0) break;
    default: AOT_MATH(bit_xor(a, b)) break;
    }
#undef AOT_MATH
    return AB(dst);
}

static asig_t ag_mixer(inst_t *it, const asig_t *x, uint32_t n)            /* m_mixer: x[0..3] */
{
    esig_t *out = it->out[0];
    const esig_t *b[4];
    int32_t l[4], u = 0;
    uint32_t i, j, k = 0;
    for (j = 0; j < 4u; j++) {
        int32_t lv = EF(it, MIXER_P_L1 + j);
        if (!lv)
            continue;
        if (!x[j].b)
            u += mul16(x[j].u, lv);
        else {
            b[k] = x[j].b;
            l[k++] = lv;
        }
    }
    switch (k) {
    case 0:
        return AU(u);
    case 1:
        if (l[0] == ENG_ONE && !u)
            return AB(b[0]);
        for (i = 0; i < n; i++)
            out[i] = mul16(b[0][i], l[0]) + u;
        break;
    case 2: {
        const esig_t *x0 = b[0], *x1 = b[1];
        const int32_t l0 = l[0], l1 = l[1];
        for (i = 0; i < n; i++)
            out[i] = mul16(x0[i], l0) + mul16(x1[i], l1) + u;
        break;
    }
    default:
        for (i = 0; i < n; i++) {
            int32_t y = u;
            for (j = 0; j < k; j++)
                y += mul16(b[j][i], l[j]);
            out[i] = y;
        }
    }
    return AB(out);
}

static asig_t ag_xfade(inst_t *it, asig_t a, asig_t b, asig_t pos, uint32_t n)   /* m_xfade */
{
    esig_t *out = it->out[0];
    int32_t base = EF(it, XFADE_P_MIX);
    uint32_t i;
    if (!pos.b) {
        int32_t m = clampi(base + pos.u, 0, ENG_ONE);
        if (m == 0)
            return a;                    /* mul16(a, 1) + mul16(b, 0) */
        if (m == ENG_ONE)
            return b;
        if (!a.b && !b.b)
            return AU(mul16(a.u, ENG_ONE - m) + mul16(b.u, m));
    }
    for (i = 0; i < n; i++) {
        int32_t m = clampi(base + (pos.b ? pos.b[i] : pos.u), 0, ENG_ONE);
        out[i] = mul16(a.b ? a.b[i] : a.u, ENG_ONE - m) + mul16(b.b ? b.b[i] : b.u, m);
    }
    return AB(out);
}

/* a Selector's block (m_select): its position and whether it fades. Not fading: the state as m_select leaves it, the
 * chosen input returned (its outputs come from it, aot_sel_out); fading: -1, the caller runs m_select itself */
static int32_t ag_select_k(inst_t *it, asig_t pos)
{
    int32_t cnt = clampi(round_q16(EF(it, SELECT_P_COUNT)), 2, SEL_N);
    int32_t p = EF(it, SELECT_P_POS) + (pos.b ? pos.b[0] : pos.u) * (cnt - 1);
    int32_t k = clampi((p + 32768) >> 16, 1, cnt) - 1;
    uint32_t fs = (uint32_t)(((int64_t)clampi(EF(it, SELECT_P_FADE), 0, 100 << 16) * 2891317) >> 32);
    int32_t inc = fs ? (int32_t)(65536u / fs) : ENG_ONE;
    uint32_t j;
    int reset = it->s.sel.k < 0 || (k != it->s.sel.k && inc >= ENG_ONE);
    if (!reset && (k != it->s.sel.k || it->s.sel.fading))
        return -1;
    if (reset) {
        for (j = 0; j < SEL_N; j++)
            it->s.sel.w[j] = 0;
        it->s.sel.w[k] = ENG_ONE;
        it->s.sel.fading = 0;
    }
    it->s.sel.k = (int8_t)k;
    return k;
}
static asig_t aot_sel_out(inst_t *it, asig_t x, int32_t k, uint32_t n)      /* the chosen input x plus its value */
{
    esig_t *out = it->out[SELECT_O_OUT];
    int32_t v = EF(it, SELECT_P_V1 + k);
    uint32_t i;
    if (!x.b)
        return AU(x.u + v);
    if (!v)
        return x;
    for (i = 0; i < n; i++)
        out[i] = x.b[i] + v;
    return AB(out);
}

/* apply_cv and a part's flaws (render_mods' steps), their one call here (both are inlined where they are called) */
static __attribute__((noinline)) void aot_cv(const node_t *nd, inst_t *it, uint32_t n, const inst_t *prev, int32_t *means, int flaws)
{
    apply_cv(nd, it, n, prev, means);
    if (flaws)
        apply_flaws(nd, it);
}
/* the parameters of member L, once a block */
static inline void aot_prep(aot_cx_t *c, uint32_t L, int flaws)
{
    aot_cv(AOT_ND(c, L), c->it[L], c->n, 0, c->means, flaws);
    c->prep[L] = 1;
}
/* the same for a member with a parameter input cabled: as render_mods, the means of an input whose buffer is the one the
 * member's previous part read (in this lane and block) are not worked out again */
static inline void aot_prep_cv(aot_cx_t *c, uint32_t L, int flaws, uint32_t slot)
{
    aot_cv(AOT_ND(c, L), c->it[L], c->n, c->pv[slot], c->mc[slot], flaws);
    c->pv[slot] = c->it[L];
    c->prep[L] = 1;
}

static inline void aot_prepf(aot_cx_t *c, uint32_t L, uint32_t fl)   /* fl: bit 0 the flaws, bits 8..: 1 + its slot of means */
{
    if (fl >> 8)
        aot_prep_cv(c, L, (int)(fl & 1u), (fl >> 8) - 1u);
    else
        aot_prep(c, L, (int)(fl & 1u));
}

/* the parameters of member L whose parameter inputs (mask) are the signals s[] */
static __attribute__((noinline)) void aot_prep_in(aot_cx_t *c, uint32_t L, uint32_t fl, uint32_t mask, const asig_t *s)
{
    inst_t *it = c->it[L];
    const esig_t *sv[MAX_IN];
    uint32_t p;
    for (p = 0; p < MAX_IN; p++)
        if (mask >> p & 1u) {
            sv[p] = it->in[p];
            it->in[p] = aot_in(s[p], sv[p], c->n);
        }
    aot_prepf(c, L, fl);
    for (p = 0; p < MAX_IN; p++)
        if (mask >> p & 1u)
            it->in[p] = sv[p];
}

/* a member the routine does not inline: its inputs (mask) the signals s[], its parameters, process() */
static __attribute__((noinline)) void aot_blk(aot_cx_t *c, uint32_t L, uint32_t fl, uint32_t mask, const asig_t *s)
{
    inst_t *it = c->it[L];
    const esig_t *sv[MAX_IN];
    uint32_t p;
    for (p = 0; p < MAX_IN; p++)
        if (mask >> p & 1u) {
            sv[p] = it->in[p];
            it->in[p] = aot_in(s[p], sv[p], c->n);
        }
    aot_prepf(c, L, fl);
    process(&E.node[c->x->node[L]], it, c->n);
    for (p = 0; p < MAX_IN; p++)
        if (mask >> p & 1u)
            it->in[p] = sv[p];
}

/* a Selector that fades (ag_select_k -1): m_select on its inputs (mask, the signals s[]) */
static __attribute__((noinline)) void aot_sel_fade(aot_cx_t *c, uint32_t L, uint32_t mask, const asig_t *s)
{
    inst_t *it = c->it[L];
    const esig_t *sv[MAX_IN];
    uint32_t p;
    for (p = 0; p < MAX_IN; p++)
        if (mask >> p & 1u) {
            sv[p] = it->in[p];
            it->in[p] = aot_in(s[p], sv[p], c->n);
        }
    m_select(it, c->n);
    for (p = 0; p < MAX_IN; p++)
        if (mask >> p & 1u)
            it->in[p] = sv[p];
}

/* a segment's start: the lane's context for part v */
static __attribute__((noinline)) aot_cx_t *aot_begin(aot_x_t *x, uint32_t v, uint32_t n, const uint8_t *bind, uint32_t nb, uint32_t ns)
{
    aot_cx_t *c = &aot_cx[v & 1u];
    uint32_t i;
    c->x = x;
    c->v = v;
    c->n = n;
    for (i = 0; i < ns; i++)
        c->d[i] = 0;
    for (i = 0; i < AOT_MAXM; i++)
        c->prep[i] = 0;
    for (i = 0; i < nb; i++)
        aot_bind_it(c, bind[i]);
    return c;
}

/* a signal at its segment's end: mode 1 into its own buffer (the outside or the next block reads it), 2 there when it is a
 * value (a later segment reads it through it->in[], and must not write a buffer of this one) */
static asig_t aot_fin(asig_t s, esig_t *out, uint32_t mode, uint32_t n)
{
    if (mode == 1u || !s.b)
        return AB(aot_put(s, out, n));
    return s;
}

#include "aot_gen.h"

/* ---- binding (eng_load) */

/* where the device pages section starts (pages_ui.c pages_at) */
static uint32_t aot_pages_at(const uint8_t *p, uint32_t len)
{
    uint32_t at;
    if (len < 8u || !(p[6] & 32u) || !(at = eng_cables_end(p, len)))
        return 0;
    if (p[6] & 4u) at += p[2];
    if ((p[6] & 8u) && !(at = eng_routes_end(p, len, at)))
        return 0;
    if (!(at = eng_steps_end(p, len, at)))
        return 0;
    return at < len ? at : 0;
}

/* do the loaded modules mem[0..t->n) play template t exactly? */
static int aot_fits(const aot_tpl_t *t, const uint8_t *mem, uint8_t *loc, uint8_t *pos)
{
    uint32_t i, c, q, first = 255u, last = 0;
    uint8_t g[8] = {0}, seen[ENG_MAX_CABLES / 8u + 1u] = {0};
    for (i = 0; i < E.nmod; i++)
        loc[i] = 0xFFu;
    for (i = 0; i < t->n; i++) {
        const node_t *nd;
        if (mem[i] >= E.nmod || loc[mem[i]] != 0xFFu)
            return 0;
        nd = &E.node[mem[i]];
        loc[mem[i]] = (uint8_t)i;
        if (nd->type != t->type[i] || nd->disabled_inputs)
            return 0;
        for (q = 0; q < MAX_IN; q++)
            if (nd->input_map[q])
                return 0;
        if (!t->grp[i] != !nd->grp)                          /* runs once / per part as the template's */
            return 0;
        if (t->grp[i]) {                                     /* one poly group per template group, none shared */
            if (!g[t->grp[i]])
                g[t->grp[i]] = nd->grp;
            if (g[t->grp[i]] != nd->grp)
                return 0;
        }
        if (pos[mem[i]] < first) first = pos[mem[i]];
        if (pos[mem[i]] > last) last = pos[mem[i]];
    }
    for (i = 0; i < E.nmod; i++)                             /* every module of those groups is a member */
        if (E.node[i].grp && loc[i] == 0xFFu)
            for (q = 1; q < 8u; q++)
                if (g[q] == E.node[i].grp)
                    return 0;
    for (c = 0; c < E.ncab; c++) {
        uint32_t f = loc[E.from_m[c]], to = loc[E.to_m[c]], k;
        if (f == 0xFFu && to == 0xFFu)
            continue;
        if (f != 0xFFu && to != 0xFFu) {                     /* one of the template's, in the template's direction */
            for (k = 0; k < t->ncab; k++)
                if (t->cab[k].from == f && t->cab[k].fp == E.from_p[c] && t->cab[k].to == to && t->cab[k].tp == E.to_p[c] && !(seen[k >> 3] >> (k & 7u) & 1u))
                    break;
            if (k == t->ncab || (pos[E.from_m[c]] < pos[E.to_m[c]]) != t->cab[k].fwd)
                return 0;
            seen[k >> 3] |= (uint8_t)(1u << (k & 7u));
            continue;
        }
        {                                                    /* across the edge: only at a port the template exposes */
            const uint8_t *x = f != 0xFFu ? t->xout : t->xin;
            uint32_t m = f != 0xFFu ? f : to, pt = f != 0xFFu ? E.from_p[c] : E.to_p[c];
            for (; *x != 0xFFu && !(x[0] == m && x[1] == pt); x += 2)
                ;
            if (*x == 0xFFu)
                return 0;
        }
    }
    for (c = 0; c < t->ncab; c++)
        if (!(seen[c >> 3] >> (c & 7u) & 1u))
            return 0;
    for (i = first + 1u; i < last; i++) {                    /* nothing in between is cabled to a member, or a Steps track */
        uint32_t m = E.order[i];
        if (loc[m] != 0xFFu)
            continue;
        if (E.node[m].type == T_STEPS)
            return 0;
        for (c = 0; c < E.ncab; c++)
            if ((E.from_m[c] == m && loc[E.to_m[c]] != 0xFFu) || (E.to_m[c] == m && loc[E.from_m[c]] != 0xFFu))
                return 0;
    }
    return 1;
}

/* lines: the bytes eng_load's lines take of the arena's free room (from ar_lo); without room after them, no compiled assembly */
static void aot_bind(const uint8_t *p, uint32_t len, uint32_t lines)
{
    uint32_t at, cnt, d, i, k, off = (ar_lo + lines + 7u) & ~7u;
    uint8_t loc[ENG_MAX_MODULES], pos[ENG_MAX_MODULES], mem[AOT_MAXM];
    aot_nx = 0;
    if (!AOT_NTPL || !(p[7] & ENG_FLAG_EXTRAS) || !(at = aot_pages_at(p, len)) || !(at = eng_devices_end(p, len, at)) || !eng_extras_end(p, len, at))
        return;
    if (off - ar_lo + (uint32_t)sizeof(aot_mem_t) > arena_free())
        return;
    aot_m = (aot_mem_t *)(void *)((uint8_t *)eng_arena + off);
    for (i = 0; i < ENG_MAX_MODULES; i++)
        aot_slot[i] = 0;
    for (i = 0; i < E.norder; i++)
        pos[E.order[i]] = (uint8_t)i;
    cnt = p[at++];
    for (d = 0; d < cnt && aot_nx < AOT_MAXX; d++) {
        uint32_t st = (uint32_t)p[at + 1u] | (uint32_t)p[at + 2u] << 8 | (uint32_t)p[at + 3u] << 16 | (uint32_t)p[at + 4u] << 24, nm, run;
        const aot_tpl_t *t = 0;
        at += 6u + p[at + 5u];
        at += 1u + 2u * p[at];
        nm = p[at] & (uint8_t)~ENG_MEMBER_RUN;
        run = (p[at] & ENG_MEMBER_RUN) != 0u;
        for (k = 0; st && k < AOT_NTPL; k++)
            if (AOT_TPL[k]->structure == st && AOT_TPL[k]->n == nm)
                t = AOT_TPL[k];
        if (t)
            for (i = 0; i < nm; i++)
                mem[i] = run ? (uint8_t)(p[at + 1u] + i) : p[at + 1u + i];
        at += 1u + (run ? 1u : nm);
        if (t && aot_fits(t, mem, loc, pos)) {
            aot_x_t *x = &aot_x[aot_nx];
            uint32_t lo = 255u;
            x->t = t;
            x->on = 0;
            for (i = 0; i < nm; i++) {
                x->node[i] = mem[i];
                if (pos[mem[i]] < lo) lo = pos[mem[i]];
                aot_slot[pos[mem[i]]] = (uint8_t)(1u + aot_nx);
            }
            aot_slot[lo] |= 0x80u;
            aot_nx++;
        }
    }
}

/* ---- rendering */

static void aot_parts(aot_x_t *x, uint32_t s, uint32_t n, uint32_t first, uint32_t step)
{
    const node_t *lead = &E.node[x->node[x->t->seg_lead[s]]];
    uint32_t parts = cur_g_parts(lead) < lead->ninst ? cur_g_parts(lead) : lead->ninst, v;
    for (v = first; v < parts; v += step)
        if (!E.pv[E.grp[lead->grp].pv0 + v].skip)
            x->t->seg[s](x, v, n);
}
static void aot_lane1_job(uint32_t arg)              /* (on the second core) */
{
    (void)arg;
    aot_parts(aot_job.x, aot_job.seg, aot_job.n, 1u, 2u);
}

static void aot_run(aot_x_t *x, uint32_t n)
{
    uint32_t s, i;
    for (s = 0; s < x->t->nseg; s++) {
        for (i = 0; i < AOT_MAXCV; i++)
            aot_cx[0].pv[i] = aot_cx[1].pv[i] = 0;
        const node_t *lead = &E.node[x->node[x->t->seg_lead[s]]];
        if (!x->t->seg_grp[s]) {
            x->t->seg[s](x, 0u, n);
            continue;
        }
        aot_job.x = x;
        aot_job.seg = s;
        aot_job.n = n;
        if (lane_splits(lead) && lanes_awake(lead) && eng_lane_run(aot_lane1_job, 0u)) {
            aot_parts(x, s, n, 0u, 2u);
            if (eng_lane_wait() != 0)
                aot_parts(x, s, n, 1u, 2u);          /* the second core was given up: lane 1 here */
        } else
            aot_parts(x, s, n, 0u, 1u);
    }
}

/* render_split at position k of E.order: 1 when a compiled instance renders that module (its first runs them all) */
static int aot_owns(uint32_t k, uint32_t n)
{
    aot_x_t *x = &aot_x[(aot_slot[k] & 0x7Fu) - 1u];
    if (aot_slot[k] & 0x80u) {
        uint32_t i;
        x->on = aot_enabled;
        for (i = 0; x->on && i < x->t->n; i++)       /* a member bypassed: the interpreter, this block */
            if (E.node[x->node[i]].bypass)
                x->on = 0;
        if (x->on)
            aot_run(x, n);
    }
    return x->on;
}

#define AOT_OWNS(k, n) (aot_nx && aot_slot[k] && aot_owns((k), (n)))
#else
#define AOT_OWNS(k, n) 0
static void aot_bind(const uint8_t *p, uint32_t len, uint32_t lines) { (void)p; (void)len; (void)lines; }
#endif
