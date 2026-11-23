/* SPDX-License-Identifier: GPL-3.0-only */
/* The palette's preset writer (#1196; pages_ui.c pal_capture, pal_presets_into): an entry's device presets written into a
 * patch binary that is not loaded, against the panel's own PRESET turn (dp_load, then the running binary) on the same
 * patch, over the panel fixtures (D-363) and the real protocol writer for the preset's name
 * (preset_pattern_proto_bridge.c).
 *   tools/pal_preset_test.sh */
#include <stdint.h>
#define HOST_DEFAULT_PATTERN_IMPL
int host_preset_name(uint8_t *, uint32_t *, uint32_t, const char *);
int host_default_pattern(uint8_t *, uint32_t *, uint32_t, uint32_t, const uint32_t *, uint32_t, uint32_t);
#define main unused_panel_main
#include "panel_test.c"
#undef main

/* the binary walkers the separately compiled protocol writer uses (preset_pattern_proto_bridge.c) */
uint32_t host_eng_rec_head(uint32_t ver) { return eng_rec_head(ver); }
uint32_t host_eng_rec_npar(const uint8_t *p, uint32_t at) { return eng_rec_npar(p, at); }
uint32_t host_eng_rec_block(const uint8_t *p, uint32_t at) { return eng_rec_block(p, at); }
int host_eng_rec_ok(const uint8_t *p, uint32_t len, uint32_t at) { return eng_rec_ok(p, len, at); }
uint32_t host_eng_rec_size(const uint8_t *p, uint32_t at) { return eng_rec_size(p, at); }
uint32_t host_eng_cables_end(const uint8_t *p, uint32_t len) { return eng_cables_end(p, len); }
uint32_t host_eng_routes_end(const uint8_t *p, uint32_t len, uint32_t at) { return eng_routes_end(p, len, at); }

#define FX_PRESET "fx-preset"                                   /* Monolith D owning the whole master FX rack (format 55,
                                                                 * legacy_fx_fixtures.h) */
#define FX_POLY "fx-preset-poly"                                /* Expander S, its VOICES row's top 3, the rack (the same) */
#define FX_DRAWER "build/panel-fixtures/fx-drawer.m1p"          /* Monolith D with three effects in its FX drawer */
#define PLAIN "build/panel-fixtures/engine-unreached.m1p"       /* Monolith D and basic poly, no FX rack */

static uint8_t fix[M1_PATCH_MAX + 16u], buf[M1_PATCH_MAX + 16u], want[M1_PATCH_MAX];
static uint32_t fix_len, want_len;

/* fixture path's bytes into fix (a name without a path: a frozen master FX bus patch, legacy_fx_fixtures.h) */
static int fixture(const char *path)
{
    FILE *f;
    uint32_t i;
    if (!strchr(path, '/')) {
        for (i = 0; i < sizeof LEGACY_FX / sizeof LEGACY_FX[0] && strcmp(LEGACY_FX[i].name, path); i++)
            ;
        if (i == sizeof LEGACY_FX / sizeof LEGACY_FX[0])
            return -1;
        memcpy(fix, LEGACY_FX[i].bin, fix_len = LEGACY_FX[i].len);
        return 0;
    }
    if (!(f = fopen(path, "rb")))
        return -1;
    fix_len = (uint32_t)fread(fix, 1, M1_PATCH_MAX, f);
    fclose(f);
    return fix_len ? 0 : -1;
}
/* fixture path running and its pages read */
static int run(const char *path)
{
    if (strchr(path, '/') ? load_fixture(path) : load_legacy(path))
        return -1;
    pv_gen++;
    pages_ensure();
    return 0;
}
/* the running patch's device with this structure, pg_ndev none */
static uint32_t dev_of(uint32_t structure)
{
    uint32_t d;
    for (d = 0; d < pg_ndev && pg_dev[d].structure != structure; d++)
        ;
    return d;
}
/* the running patch's first device with a structure that owns no rack (rack 0) or owns the whole rack (rack 1) */
static uint32_t dev_pick(int rack)
{
    uint32_t d;
    for (d = 0; d < pg_ndev; d++)
        if (pg_dev[d].structure && (rack ? dp_fx_mask(d) == 15u : !dp_fx_mask(d)))
            break;
    return d;
}
/* device d's list entry named nm in namespace structure, -1 none */
static int list_at(uint32_t d, uint32_t structure, const char *nm)
{
    uint32_t k, n = dp_list(d);
    char name[17];
    for (k = 0; k < n; k++)
        if (dp_entry(pr_list[k], name) >= 0 && pr_structure == structure && !ps_name_cmp(name, nm))
            return (int)k;
    return -1;
}
/* an entry of one device (pal_capture's layout) into e: its length */
static uint32_t entry_of(uint8_t *e, uint32_t dev, uint32_t structure, uint32_t pstructure, const char *name)
{
    uint32_t n = 0, k, nl = (uint32_t)strlen(name);
    e[n++] = 1;
    e[n++] = (uint8_t)dev;
    for (k = 0; k < 4u; k++)
        e[n++] = (uint8_t)(structure >> (8u * k));
    for (k = 0; k < 4u; k++)
        e[n++] = (uint8_t)(pstructure >> (8u * k));
    e[n++] = (uint8_t)nl;
    memcpy(e + n, name, nl);
    return n + nl;
}

/* what pal_presets_into must leave alone: the running binary, the engine's values and load, the pages, the names, the
 * edited mark, the editor */
static struct {
    uint8_t bin[sizeof pv_bin];
    uint32_t len, gen, params, ndev, edited, now;
    pdev_t dev[PG_DEVS];
    char pname[PG_DEVS][17];
    uint32_t pstructure[PG_DEVS];
} was;
static uint32_t params_hash(void)
{
    uint32_t h = 2166136261u, m, j;
    for (m = 0; m < (uint32_t)eng_nmodules(); m++)
        for (j = 0; j < DEFS[eng_type(m)].npar; j++)
            h = (h ^ (uint32_t)eng_get_param(m, j)) * 16777619u;
    return h;
}
static void keep(void)
{
    memcpy(was.bin, pv_bin, pv_len);
    was.len = pv_len;
    was.gen = eng_generation();
    was.params = params_hash();
    was.ndev = pg_ndev;
    was.edited = m1_edited;
    was.now = (uint32_t)param_now;
    memcpy(was.dev, pg_dev, sizeof was.dev);
    memcpy(was.pname, pg_pname, sizeof was.pname);
    memcpy(was.pstructure, pg_pstructure, sizeof was.pstructure);
}
static int kept(void)
{
    return pv_len == was.len && !memcmp(was.bin, pv_bin, pv_len) && eng_generation() == was.gen && params_hash() == was.params
        && pg_ndev == was.ndev && m1_edited == was.edited && (uint32_t)param_now == was.now && !memcmp(was.dev, pg_dev, sizeof was.dev)
        && !memcmp(was.pname, pg_pname, sizeof was.pname) && !memcmp(was.pstructure, pg_pstructure, sizeof was.pstructure);
}

/* the entry e (n bytes) into fix's copy in buf while `other` runs (cap: its room), the devices written; nothing else moved */
static uint32_t into(const char *other, const uint8_t *e, uint32_t n, uint32_t *len, uint32_t cap)
{
    uint32_t w;
    if (run(other))
        return 0xFFu;
    memcpy(buf, fix, fix_len);
    memset(buf + fix_len, 0xA5, sizeof buf - fix_len);
    *len = fix_len;
    keep();
    w = pal_presets_into(buf, len, cap, e, n);
    check("  nothing but the binary changes (running binary, engine, pages, names, edited mark, editor)", kept());
    return w;
}
/* the PRESET turn's binary: fixture path running, device d's entry named nm (namespace structure) loaded, into want */
static int turned(const char *path, uint32_t structure, uint32_t ns, const char *nm)
{
    uint32_t d;
    int k;
    if (run(path) || (d = dev_of(structure)) >= pg_ndev || (k = list_at(d, ns, nm)) < 0 || dp_load(d, (uint32_t)k))
        return -1;
    memcpy(want, pv_bin, pv_len);
    want_len = pv_len;
    return 0;
}
static int same_as_turned(uint32_t len) { return len == want_len && !memcmp(buf, want, len); }

/* plain rows: a factory preset of an engine with no rack; poly rows: a user preset of the capped Expander S */
static void plain_and_poly(void)
{
    static int32_t vals[PS_MAXV];
    uint8_t e[64];
    char nm[17];
    uint32_t d, structure, n, len, k, voice, w;
    int c = -1;
    host_ps_init();
    check("plain: fixture loads", !fixture(PLAIN) && !run(PLAIN));
    d = dev_pick(0);
    check("plain: an engine with presets and no rack", d < pg_ndev);
    if (d >= pg_ndev)
        return;
    structure = pg_dev[d].structure;
    for (k = 0, n = dp_list(d); k < n; k++)              /* (a factory preset of its own structure it does not sound as now) */
        if (!(pr_list[k] & PR_USER) && (c = dp_entry(pr_list[k], nm)) > 0 && pr_structure == structure && !dp_same(d, c))
            break;
    check("plain: a factory preset that changes the sound", k < n);
    if (k >= n)
        return;
    n = entry_of(e, pg_dev[d].bin, structure, 0, nm);
    w = into(FX_POLY, e, n, &len, M1_PATCH_MAX);
    check("plain: one device written", w == 1u);
    check("plain: PRESET turn on the same patch", !turned(PLAIN, structure, structure, nm));
    check("plain: the bytes are the PRESET turn's (rows, extras name)", same_as_turned(len) && (len != fix_len || memcmp(buf, fix, len)));
    check("plain: past the binary untouched", buf[len] == 0xA5u && buf[M1_PATCH_MAX] == 0xA5u);
    check("plain: the written binary loads", !eng_load(buf, len));

    /* (no room past the binary: the rows that would grow a record and a longer name are left out) */
    w = into(FX_POLY, e, n, &len, fix_len);
    check("no room: the device is written as far as it fits", w == 1u && len <= fix_len && buf[fix_len] == 0xA5u);
    check("no room: (the PRESET turn grew the binary)", want_len > fix_len);
    check("no room: the written binary loads", !eng_load(buf, len));

    check("missing: a preset of no such name is skipped", into(FX_POLY, e, entry_of(e, pg_dev[d].bin, structure, 0, "NO SUCH SOUND"), &len, M1_PATCH_MAX) == 0u
          && len == fix_len && !memcmp(buf, fix, len));
    check("missing: a device of no such structure is skipped", into(FX_POLY, e, entry_of(e, 0, 0x12345678u, 0, nm), &len, M1_PATCH_MAX) == 0u
          && len == fix_len && !memcmp(buf, fix, len));

    check("poly: fixture loads", !fixture(FX_POLY) && !run(FX_POLY));
    d = dev_pick(1);
    check("poly: the capped Expander S owns the rack", d < pg_ndev);
    if (d >= pg_ndev)
        return;
    structure = pg_dev[d].structure;
    for (voice = 0; voice < pg_dev[d].nrows && pg_dev[d].rows[2u * voice + 1u] != (POLY_ROW | ENG_POLY_PARTS); voice++)
        ;
    check("poly: a VOICES row", voice < pg_dev[d].nrows && dp_values(d) >= pg_dev[d].nrows);
    if (voice >= pg_dev[d].nrows)
        return;
    memcpy(vals, pr_vals, pg_dev[d].nrows * sizeof *vals);
    vals[voice] = 2 * 65536;                            /* (its structure's preset, no rack: two voices) */
    for (k = 0; k < pg_dev[d].nrows; k++) {             /* (and a plain row elsewhere) */
        uint32_t m = pg_dev[d].rows[2u * k], p = pg_dev[d].rows[2u * k + 1u];
        if (m != 0xFFu && !(p & POLY_ROW) && row_ok(m, p) && !DEF_FIXED((uint32_t)eng_type(m), p)
            && DEFS[eng_type(m)].pmin[p] < DEF_TOP(&DEFS[eng_type(m)], p)) {
            vals[k] = vals[k] == DEFS[eng_type(m)].pmin[p] ? DEF_TOP(&DEFS[eng_type(m)], p) : DEFS[eng_type(m)].pmin[p];
            break;
        }
    }
    check("poly: user preset stores", !ps_put(structure, "TWO VOICES", vals, pg_dev[d].nrows));
    n = entry_of(e, pg_dev[d].bin, structure, structure, "two voices");
    w = into(PLAIN, e, n, &len, M1_PATCH_MAX);
    check("poly: one device written", w == 1u);
    check("poly: PRESET turn on the same patch", !turned(FX_POLY, structure, structure, "TWO VOICES"));
    check("poly: the PRESET turn set two voices", poly_value(pg_dev[dev_of(structure)].rows[2u * voice], ENG_POLY_PARTS) == 2);
    check("poly: the bytes are the PRESET turn's (the group record, rows, name)", same_as_turned(len));
    check("poly: the written binary loads with two voices", !eng_load(buf, len) && eng_poly_get(0, ENG_POLY_PARTS) == 2);
    host_ps_init();
}

/* FX-scoped rows: a user preset of Monolith D and its whole rack (pages_ui.c dp_fx_*), then the name rule and the capture */
static void scoped(void)
{
    static int32_t vals[PS_MAXV];
    static const int32_t tail[23] = {                   /* (the rack's enables and controls: fx_preset_panel_test.h's) */
        65536, 3 * 65536, 65536, 45000, -16384,
        0, 90000, 42000, 18000,
        65536, 180 * 65536, 31000, 22000, 65536, 65536, 3 * 65536,
        65536, 47000, 28000, 15000, 12 * 65536, 34000, 65536
    };
    uint8_t e[64], cap[1u + PAL_DEVS * PAL_DEV_MAX];
    uint32_t d, structure, scope, rows, n, len, k, w, named, at;
    host_ps_init();
    check("scoped: fixture loads", !fixture(FX_PRESET) && !run(FX_PRESET));
    d = dev_pick(1);
    check("scoped: Monolith D owns the whole rack", d < pg_ndev);
    if (d >= pg_ndev)
        return;
    structure = pg_dev[d].structure;
    scope = dp_structure(d);
    rows = pg_dev[d].nrows;
    n = dp_values(d);
    check("scoped: its capture is the rows and the rack", n == rows + 27u && scope != structure);
    if (n != rows + 27u)
        return;
    memcpy(vals, pr_vals, n * sizeof *vals);
    memcpy(vals + rows, tail, sizeof tail);
    for (k = 0; k < rows; k++) {                        /* (a synth row away from the fixture's too) */
        uint32_t m = pg_dev[d].rows[2u * k], p = pg_dev[d].rows[2u * k + 1u];
        if (m != 0xFFu && !(p & POLY_ROW) && row_ok(m, p) && !DEF_FIXED((uint32_t)eng_type(m), p)
            && DEFS[eng_type(m)].pmin[p] < DEF_TOP(&DEFS[eng_type(m)], p)) {
            vals[k] = vals[k] == DEFS[eng_type(m)].pmin[p] ? DEF_TOP(&DEFS[eng_type(m)], p) : DEFS[eng_type(m)].pmin[p];
            break;
        }
    }
    check("scoped: user preset stores in the rack's namespace", !ps_put(scope, "RACK", vals, n));
    n = entry_of(e, pg_dev[d].bin, structure, scope, "RACK");
    w = into(PLAIN, e, n, &len, M1_PATCH_MAX);
    check("scoped: one device written", w == 1u);
    check("scoped: PRESET turn on the same patch", !turned(FX_PRESET, structure, scope, "RACK"));
    check("scoped: the bytes are the PRESET turn's (rows, rack controls, bypass, name)", same_as_turned(len) && memcmp(buf, fix, fix_len));
    w = into(PLAIN, e, entry_of(e, pg_dev[dev_of(structure)].bin, structure, 0, "rack"), &len, M1_PATCH_MAX);
    check("scoped: an unknown namespace finds it by name (the device's, then its rack's)", w == 1u && same_as_turned(len));
    check("scoped: the written binary loads with the rack's enables", !eng_load(buf, len) && !eng_fx_on(dp_fx_stage(ENG_FX_CHORUS))
          && eng_fx_on(dp_fx_stage(ENG_FX_REVERB)));

    /* the slot already names that preset (in any case): nothing is written */
    memcpy(fix, want, want_len);
    fix_len = want_len;
    check("same name: nothing written, in any case", into(PLAIN, e, entry_of(e, 0, structure, scope, "rack"), &len, M1_PATCH_MAX) == 0u
          && len == fix_len && !memcmp(buf, fix, len));
    check("scoped: a 16-character name stores", !ps_put(scope, "LONGER NAME 16CH", vals, rows + 27u));
    check("long name: PRESET turn keeps 12 characters", !turned(FX_PRESET, structure, scope, "LONGER NAME 16CH"));
    memcpy(fix, want, want_len);
    fix_len = want_len;
    check("long name: the first 12 characters name it, nothing written",
          into(PLAIN, e, entry_of(e, 0, structure, scope, "Longer Name 16ch"), &len, M1_PATCH_MAX) == 0u && len == fix_len && !memcmp(buf, fix, len));

    /* pal_capture after the PRESET turn: the named devices, each {dev, structure, pstructure, nl, name} */
    check("capture: PRESET turn to RACK", !turned(FX_PRESET, structure, scope, "RACK"));
    w = pal_capture(cap, sizeof cap);
    for (named = 0, d = 0; d < pg_ndev; d++)
        named += pg_dev[d].structure && pg_pname[d][0];
    check("capture: one record per named device", cap[0] == named && named >= 1u && named <= PAL_DEVS);
    for (at = 1, k = 0, d = 0; d < pg_ndev && k < cap[0]; d++) {
        uint32_t nl;
        if (!pg_dev[d].structure || !pg_pname[d][0])
            continue;
        nl = (uint32_t)strlen(pg_pname[d]);
        check("capture: dev, structure LE, pstructure LE, nl, name", cap[at] == pg_dev[d].bin && (uint32_t)rd32(cap + at + 1u) == pg_dev[d].structure
              && (uint32_t)rd32(cap + at + 5u) == pg_pstructure[d] && cap[at + 9u] == nl && !memcmp(cap + at + 10u, pg_pname[d], nl));
        if (pg_dev[d].structure == structure)
            check("capture: the rack owner's namespace and name", (uint32_t)rd32(cap + at + 5u) == scope && nl == 4u && !memcmp(cap + at + 10u, "RACK", 4));
        at += 10u + nl;
        k++;
    }
    check("capture: the bytes written", w == at);
    check("capture: no room for a record leaves it out", pal_capture(cap, 10u + 4u) == 1u && cap[0] == 0u);
    check("capture: no room at all writes nothing", pal_capture(cap, 0) == 0u);
    check("capture: back into the fixture gives the PRESET turn's bytes", pal_capture(cap, sizeof cap) == w && !fixture(FX_PRESET)
          && into(PLAIN, cap, w, &len, M1_PATCH_MAX) == named && same_as_turned(len));
    memcpy(pv_bin, want, want_len);                     /* (the PRESET turn's binary loaded afresh: its names from its extras) */
    pv_len = want_len;
    check("capture: the turned binary loads afresh", !eng_load(pv_bin, pv_len));
    pv_gen++;
    pages_ensure();
    d = dev_of(structure);
    check("capture: a patch just loaded carries the name, its namespace unknown", d < pg_ndev && !strcmp(pg_pname[d], "RACK") && !pg_pstructure[d]);
    w = pal_capture(cap, sizeof cap);
    for (at = 1, k = 0; k < cap[0] && (uint32_t)rd32(cap + at + 1u) != structure; k++)
        at += 10u + cap[at + 9u];
    check("capture: the namespace of the name a patch carries is resolved", k < cap[0] && pg_pstructure[d] == scope
          && (uint32_t)rd32(cap + at + 5u) == scope && at + 14u <= w);
    host_ps_init();
}

/* FXD1: a user preset of Monolith D with its FX drawer (the instrument's rows, each effect's on/off and rows) written into
 * a binary that is not loaded, as the PRESET turn writes it: rows, the effects' rows, their targets' bypass, the name */
static void drawer(void)
{
    static int32_t vals[PS_MAXV];
    uint8_t e[64];
    uint32_t d, structure, scope, rows, n, len, w, first = 0, cnt = 0, ed, i;
    host_ps_init();
    check("drawer: fixture loads", !fixture(FX_DRAWER) && !run(FX_DRAWER));
    for (d = 0; d < pg_ndev && !dp_drawer(d, &first, &cnt); d++)
        ;
    check("drawer: Monolith D owns a drawer of three effects", d < pg_ndev && cnt == 3u);
    if (d >= pg_ndev || cnt != 3u)
        return;
    structure = pg_dev[d].structure;
    scope = dp_structure(d);
    rows = pg_dev[d].nrows;
    n = dp_values(d);
    check("drawer: its capture is FX-scoped", n > rows + 4u && scope != structure);
    if (n <= rows + 4u)
        return;
    memcpy(vals, pr_vals, n * sizeof *vals);
    ed = pages_dev_of(eng_fx_device(first));
    vals[rows + 1u + pg_dev[ed].nrows] = 0;             /* (the second effect off) */
    for (i = 0; i < pg_dev[ed].nrows; i++) {            /* (a row of the first effect moved) */
        uint32_t m = pg_dev[ed].rows[2u * i], p = pg_dev[ed].rows[2u * i + 1u];
        if (m != 0xFFu && !(p & POLY_ROW) && row_ok(m, p) && !DEF_FIXED((uint32_t)eng_type(m), p)
            && DEFS[eng_type(m)].pmin[p] < DEF_TOP(&DEFS[eng_type(m)], p)) {
            vals[rows + 1u + i] = vals[rows + 1u + i] == DEFS[eng_type(m)].pmin[p] ? DEF_TOP(&DEFS[eng_type(m)], p) : DEFS[eng_type(m)].pmin[p];
            break;
        }
    }
    check("drawer: the user preset stores in the drawer's namespace", !ps_put(scope, "DRAWER", vals, n));
    w = into(PLAIN, e, entry_of(e, pg_dev[d].bin, structure, scope, "DRAWER"), &len, M1_PATCH_MAX);
    check("drawer: one device written", w == 1u);
    check("drawer: PRESET turn on the same patch", !turned(FX_DRAWER, structure, scope, "DRAWER"));
    check("drawer: the bytes are the PRESET turn's (rows, the effects' rows, their bypass, the name)", same_as_turned(len)
          && memcmp(buf, fix, fix_len));
    check("drawer: the written binary loads with the second effect off", !eng_load(buf, len) && eng_fx_on(first)
          && !eng_fx_on(first + 1u) && eng_fx_on(first + 2u));
    host_ps_init();
}

int main(void)
{
    plain_and_poly();
    scoped();
    drawer();
    if (failed) {
        printf("%d FAILED\n", failed);
        return 1;
    }
    printf("pal preset test passed\n");
    return 0;
}
