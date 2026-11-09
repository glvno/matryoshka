/* SPDX-License-Identifier: GPL-3.0-only */
/* Experiment: two adjacent independent mono drum assemblies share the cores. Included by aot.c.
 * No work moves across an outside module, no cable connects the pair, and their buffers are private
 * (aot_buffer_guard). The allowed processors write only their instance, outputs, and lane scratch.
 * Joining immediately after the first assembly keeps every outside reader after both results. */
static struct { aot_x_t *x; uint32_t n; } aot_pair_job;
#ifndef AOT_PAIR_HIT
#define AOT_PAIR_HIT() ((void)0)
#endif

static int aot_pair_safe(const aot_x_t *x)
{
    uint32_t i;
    if (x->t->nseg != 1u || x->t->seg_grp[0]) return 0;
    for (i = 0; i < x->t->n; i++) {
        const node_t *nd = &E.node[x->node[i]];
        if (nd->grp || nd->ninst != 1u) return 0;
        switch (nd->type) {
        case T_OSC: case T_ENV: case T_NOISE: case T_FILTER: case T_VCA: case T_SCALE: case T_MIXER: break;
        default: return 0;
        }
    }
    return 1;
}

static void aot_pair_bind(void)
{
    uint32_t a, b, i, c, used = 0;
    uint8_t first[AOT_MAXX], last[AOT_MAXX], owner[ENG_MAX_MODULES] = {0};
    for (a = 0; a < aot_nx; a++) {
        aot_m->pair[a] = 0;
        first[a] = 255; last[a] = 0;
        for (i = 0; i < aot_x[a].t->n; i++) owner[aot_x[a].node[i]] = (uint8_t)(a + 1u);
    }
    for (i = 0; i < E.norder; i++) {
        a = owner[E.order[i]];
        if (!a) continue;
        a--;
        if (first[a] == 255u) first[a] = (uint8_t)i;
        last[a] = (uint8_t)i;
    }
    for (a = 0; a < aot_nx; a++) for (b = 0; b < aot_nx; b++) {
        if (a == b || (used & ((1u << a) | (1u << b))) || first[a] >= first[b]
            || !aot_pair_safe(&aot_x[a]) || !aot_pair_safe(&aot_x[b])) continue;
        uint32_t end = last[a] > last[b] ? last[a] : last[b];
        for (i = first[a]; i <= end; i++)
            if (owner[E.order[i]] != a + 1u && owner[E.order[i]] != b + 1u) break;
        if (i <= end) continue;                       /* no outside module may be crossed */
        for (c = 0; c < E.ncab; c++) {
            uint32_t f = owner[E.from_m[c]], t = owner[E.to_m[c]];
            if ((f == a + 1u && t == b + 1u) || (f == b + 1u && t == a + 1u)) break;
        }
        if (c != E.ncab) continue;                    /* dependencies, including feedback, stay serial */
        aot_m->pair[a] = (uint8_t)(b + 1u);
        used |= (1u << a) | (1u << b);
    }
}

/* A mono instance normally uses lane 0. Give the worker lane 1's scratch and dummy outputs for this job,
 * including while the same job is rendered on core 0 after a lost hand-off. No live signal changes address. */
static void aot_pair_lane(aot_x_t *x, int worker)
{
    uint32_t i, p;
    for (i = 0; i < E.nmod; i++) aot_m->worker[i] = 0;
    for (i = 0; i < x->t->n; i++) {
        const node_t *nd = &E.node[x->node[i]];
        inst_t *it = &inst_pool[nd->inst0];
        aot_m->worker[x->node[i]] = (uint8_t)worker;
        for (p = 0; p < DEFS[nd->type].nout; p++)
            if (IS_DUMMY(it->out[p])) it->out[p] = worker ? dummy_out1 : dummy_out;
    }
    aot_worker_nodes = worker ? aot_m->worker : 0;
}

static void aot_pair_worker(uint32_t arg)
{
    (void)arg;
    uint32_t i;
    for (i = 0; i < AOT_MAXCV; i++) aot_cx[1].pv[i] = 0;
    aot_pair_job.x->t->seg[0](aot_pair_job.x, 1u, aot_pair_job.n);
}

static int aot_pair_run(aot_x_t *x, uint32_t n)
{
    uint32_t a = (uint32_t)(x - aot_x), b = aot_m->pair[a], i;
    aot_x_t *other;
    if (!b || !aot_can_run(other = &aot_x[b - 1u])) return 0;
    aot_pair_job.x = other; aot_pair_job.n = n;
    aot_pair_lane(other, 1);
    if (!eng_lane_run(aot_pair_worker, 0u)) {
        aot_pair_lane(other, 0);
        return 0;
    }
    AOT_PAIR_HIT();
    for (i = 0; i < AOT_MAXCV; i++) aot_cx[0].pv[i] = 0;
    x->t->seg[0](x, 0u, n);
    if (eng_lane_wait() != 0) aot_pair_worker(0u);
    aot_pair_lane(other, 0);
    other->on = 1;
    aot_m->done |= (uint8_t)((1u << a) | (1u << (b - 1u)));
    return 1;
}
