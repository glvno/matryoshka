/* SPDX-License-Identifier: GPL-3.0-only */
/* tools/aot_test.sh (#808): every factory patch of presets.h and the binaries named on the command line, rendered with the
 * compiled factory assemblies (aot.c) and with the interpreter alone, in one build, and compared sample for sample. The
 * same played and turned events both ways, each from a fresh process (fork: the engine keeps state across loads): notes (chords, single keys, releases), the performance controls, every
 * parameter of every module set to values across its range, a member bypassed for a while, blocks of odd lengths; then
 * Selectors switched with and without a fade, Scale and VCA gains at 0, 1/2 and 1.
 *   aot_test [-q | --files-only] [patch.m1p ...]      exit 1 when any output differs; prints which patches ran compiled */
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#define eng_lane_run test_lane_run
#include "lanes_host.h"
#undef eng_lane_run
static int eng_lane_run(void (*fn)(uint32_t), uint32_t arg);
static uint32_t fused_hits[2];
#define AOT_FUSED_HIT(c) (fused_hits[(c)->v & 1u]++)
static uint32_t pair_hits;
#define AOT_PAIR_HIT() (pair_hits++)
#define ENG_AOT 1
#include "../src/engine.c"
#include "../src/presets.h"

/* The hardware timing hook counts this group's awake voices. Both render paths must supply their own segment. */
static int eng_lane_run(void (*fn)(uint32_t), uint32_t arg)
{
    uint32_t group = fn == aot_lane1_job ? E.node[aot_job.x->node[aot_job.x->t->seg_lead[aot_job.seg]]].grp
                                        : E.node[E.order[lane_job.k0]].grp;
#if ENG_AOT_PAIR
    if (fn == aot_pair_worker) group = 0;
    else
#endif
    if (!group) { fprintf(stderr, "poly lane job has no group\n"); exit(1); }
    if (group != arg) {
        fprintf(stderr, "lane accounting group %u, expected %u\n", (unsigned)arg, (unsigned)group);
        exit(1);
    }
    return test_lane_run(fn, arg);
}

#define BLOCKS 700u
#define MAXOUT (BLOCKS * 256u)

static int32_t outl[2][MAXOUT], outr[2][MAXOUT];
static uint64_t fused_total, pair_total;

static uint32_t rnd(uint32_t *s) { *s = *s * 1664525u + 1013904223u; return *s >> 8; }

/* one run: the output into outl / outr[w], the samples rendered; *bound: compiled instances after the load */
static uint32_t run(const uint8_t *p, uint32_t len, int w, int *bound, int fuzz)
{
    static const uint32_t SIZES[5] = {128, 128, 256, 64, 100};
    uint32_t s = 0x2545f491u, b, at = 0, k, held[8] = {0}, bypassed = 0xFFFFFFFFu, bypass_until = 0;
    aot_enabled = (uint8_t)(w == 0);
    if (eng_load(p, len))
        return 0;
    *bound = aot_nx;
    if (getenv("AOT_TRANSPORT")) eng_transport(1);
    for (b = 0; b < BLOCKS; b++) {
        uint32_t n = SIZES[b % 5u];
        if (b == 2)
            for (k = 0; k < 4u; k++)
                eng_note_on(held[k] = 48u + 7u * k, 40000 + 5000 * (int32_t)k, 1);
        if (b > 2 && b % 7u == 0u) {          /* a key let go, another pressed */
            k = rnd(&s) % 8u;
            if (held[k]) {
                eng_note_off(held[k], 1);
                held[k] = 0;
            } else
                eng_note_on(held[k] = 40u + rnd(&s) % 48u, (int32_t)(rnd(&s) % 65536u), 1);
        }
        if (b % 13u == 0u)
            eng_ctl(rnd(&s) % 3u, (int32_t)(rnd(&s) % 65536u) - (b % 26u ? 0 : 32768));
        if (fuzz && b > 20u && b % 5u == 0u && eng_nmodules() > 0) {   /* a parameter anywhere, across its range */
            uint32_t m = rnd(&s) % (uint32_t)eng_nmodules();
            const def_t *d = &DEFS[eng_type(m)];
            if (d->npar && eng_type(m) != T_FM1 && eng_type(m) != T_OUTPUT) {
                uint32_t j = rnd(&s) % d->npar;
                int64_t lo = d->pmin[j], hi = d->pmax[j];
                int32_t v = (int32_t)(lo + (int64_t)(rnd(&s) % 1024u) * (hi - lo) / 1023);
                if (!DEF_FIXED(eng_type(m), j))
                    eng_set_param(m, j, v);
            }
        }
        if (fuzz == 2 && b > 20u && b % 3u == 0u && eng_nmodules() > 0) {   /* switches: a Selector's position and fade, a
                                                                          * Scale's or VCA's gain at 0 or 1 */
            uint32_t m = rnd(&s) % (uint32_t)eng_nmodules();
            if (eng_type(m) == T_SELECT) {
                static const int32_t FADE[4] = {0, 0, 2 << 16, 30 << 16};
                eng_set_param(m, SELECT_P_FADE, FADE[rnd(&s) % 4u]);
                eng_set_param(m, SELECT_P_POS, (int32_t)(1u + rnd(&s) % 3u) << 16);
            } else if (eng_type(m) == T_SCALE || eng_type(m) == T_VCA)
                eng_set_param(m, 0, (int32_t)(rnd(&s) % 3u) * 32768);
        }
        if (fuzz && b == bypass_until && bypassed != 0xFFFFFFFFu) {
            eng_set_bypass(bypassed, 0);
            bypassed = 0xFFFFFFFFu;
        }
        if (fuzz && b % 97u == 50u && bypassed == 0xFFFFFFFFu && eng_nmodules() > 0) {   /* a module off for a while */
            bypassed = rnd(&s) % (uint32_t)eng_nmodules();
            if (eng_type(bypassed) == T_FM1 || eng_type(bypassed) == T_OUTPUT)
                bypassed = 0xFFFFFFFFu;
            else {
                eng_set_bypass(bypassed, 1);
                bypass_until = b + 9u;
            }
        }
        if (b == BLOCKS - 150u)
            eng_all_notes_off();
        eng_render(outl[w] + at, outr[w] + at, n);
        at += n;
    }
    return at;
}

/* run() in a child process (a fresh engine), its output back into outl / outr[w] */
static uint32_t run_fresh(const uint8_t *p, uint32_t len, int w, int *bound, int fuzz)
{
    int fd[2];
    pid_t pid;
    uint32_t hdr[4] = {0, 0, 0, 0};
    if (pipe(fd))
        return 0;
    if (!(pid = fork())) {
        int bd = 0;
        close(fd[0]);
        hdr[0] = run(p, len, w, &bd, fuzz);
        hdr[1] = (uint32_t)bd;
        hdr[2] = fused_hits[0] + fused_hits[1];
        hdr[3] = pair_hits;
        if (write(fd[1], hdr, sizeof hdr) < 0 || write(fd[1], outl[w], hdr[0] * 4u) < 0 || write(fd[1], outr[w], hdr[0] * 4u) < 0)
            _exit(1);
        _exit(0);
    }
    close(fd[1]);
    {
        FILE *in = fdopen(fd[0], "rb");
        if (fread(hdr, sizeof hdr, 1, in) != 1 || fread(outl[w], 4, hdr[0], in) != hdr[0] || fread(outr[w], 4, hdr[0], in) != hdr[0])
            hdr[0] = 0;
        fclose(in);
    }
    waitpid(pid, 0, 0);
    *bound = (int)hdr[1];
    fused_total += hdr[2];
    pair_total += hdr[3];
    return hdr[0];
}

static const char *const FUZZ[3] = {"played", "fuzzed", "switched"};

/* both ways; 0 the same */
static int compare(const char *name, const uint8_t *p, uint32_t len, int quiet, int fuzz)
{
    int b0 = 0, b1 = 0;
    uint32_t n0 = run_fresh(p, len, 0, &b0, fuzz), n1 = run_fresh(p, len, 1, &b1, fuzz), i;
    if (!n0 || n0 != n1) {
        printf("%-28s load failed\n", name);
        return 1;
    }
    for (i = 0; i < n0; i++)
        if (outl[0][i] != outl[1][i] || outr[0][i] != outr[1][i]) {
            printf("%-28s DIFFERS at sample %u (block ~%u, %s): %d %d / %d %d (%d compiled)\n", name, i, i / 128u, FUZZ[fuzz],
                   outl[0][i], outr[0][i], outl[1][i], outr[1][i], b0);
            return 1;
        }
    if (!quiet || b0)
        printf("%-28s %s, %d compiled instance%s\n", name, FUZZ[fuzz], b0, b0 == 1 ? "" : "s");
    return 0;
}

static uint8_t file_buf[65536];

int main(int argc, char **argv)
{
    static const struct { const uint8_t *p; unsigned n; } T[] = {
#define X(k) { PRESET_##k, sizeof PRESET_##k },
X(0) X(1) X(2) X(3) X(4) X(5) X(6) X(7) X(8) X(9) X(10) X(11) X(12) X(13) X(14) X(15) X(16) X(17) X(18) X(19) X(20) X(21) X(22) X(23) X(24) X(25) X(26) X(27) X(28) X(29)
    };
    int files_only = argc > 1 && !strcmp(argv[1], "--files-only");
    int quiet = files_only || (argc > 1 && !strcmp(argv[1], "-q")), fail = 0, a, f;
    unsigned t;
    if (files_only && argc < 3) return 2;
    for (f = 0; !files_only && f < 3; f++)
        for (t = 0; t < sizeof T / sizeof T[0]; t++) {
            char name[32];
            snprintf(name, sizeof name, "factory %u", t);
            fail |= compare(name, T[t].p, T[t].n, quiet, f);
        }
    for (a = 1 + quiet; a < argc; a++) {
        FILE *fp = fopen(argv[a], "rb");
        size_t n;
        const char *base = strrchr(argv[a], '/') ? strrchr(argv[a], '/') + 1 : argv[a];
        if (!fp) { printf("%s: cannot open\n", argv[a]); fail = 1; continue; }
        n = fread(file_buf, 1, sizeof file_buf, fp);
        fclose(fp);
        for (f = 0; f < 3; f++)
            fail |= compare(base, file_buf, (uint32_t)n, quiet, f);
    }
#if ENG_AOT_FUSE
    if (!fused_total) { puts("aot: fused path was never exercised"); fail = 1; }
    printf("aot: fused chains executed %llu times\n", (unsigned long long)fused_total);
#endif
    if (getenv("AOT_REQUIRE_PAIR") && !pair_total) { puts("aot: paired path was never exercised"); fail = 1; }
    printf("aot: paired jobs executed %llu times\n", (unsigned long long)pair_total);
    printf(fail ? "aot: outputs differ\n" : "aot: every output bit-identical with and without the compiled assemblies\n");
    return fail;
}
