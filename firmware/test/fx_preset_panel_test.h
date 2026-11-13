/* SPDX-License-Identifier: GPL-3.0-only */
/* Real assembly/rack fixture; flash records, native reload, and linked-editor notifications. */
static int fx_preset_index(uint32_t d, uint32_t structure, const char *name)
{
    uint32_t k, n = dp_list(d);
    char nm[17];
    for (k = 0; k < n; k++)
        if (dp_entry(pr_list[k], nm) >= 0 && pr_structure == structure && !ps_name_cmp(name, nm)) return (int)k;
    return -1;
}

static int fx_preset_event(uint32_t mod, uint32_t par, int32_t value)
{
    uint32_t i;
    for (i = 0; i < preset_events; i++)
        if (preset_event[i].mod == mod && preset_event[i].par == par && preset_event[i].value == value) return 1;
    return 0;
}

/* Source factory values remain portable: a card with a narrower VOICES row compares the
 * sound it can actually load, without rewriting the ROM or saved preset to its local cap. */
static void fx_preset_poly_match(void)
{
    static int32_t values[PS_MAXV];
    uint32_t d, i, voice, mod, n, count, scope, factory;
    int k, current;
    char name[17];
    ct_reset();
    host_ps_init();
    check("FX poly preset: capped Expander fixture loads", !load_fixture("build/panel-fixtures/fx-preset-poly.m1p"));
    pv_gen++; pages_ensure();
    for (d = 0; d < pg_ndev && dp_fx_mask(d) != 15u; d++);
    check("FX poly preset: full rack has one owner", d < pg_ndev);
    if (d >= pg_ndev) return;
    for (voice = 0; voice < pg_dev[d].nrows; voice++)
        if (pg_dev[d].rows[2u * voice + 1u] == (POLY_ROW | ENG_POLY_PARTS)) break;
    check("FX poly preset: real VOICES binding exists", voice < pg_dev[d].nrows);
    if (voice == pg_dev[d].nrows) return;
    mod = pg_dev[d].rows[2u * voice];
    check("FX poly preset: native row exposes three voices", dev_poly_top(d, mod, POLY_ROW) == 3);
    scope = dp_structure(d);
    n = dp_values(d);
    check("FX poly preset: full scoped capture fits", n == pg_dev[d].nrows + 27u && n <= PS_MAXV);
    if (!n) return;
    memcpy(values, pr_vals, n * sizeof *values);
    for (factory = 0; factory < N_FPRESETS; factory++)
        if (FPRESET_LIST[factory].structure == pg_dev[d].structure && !ps_name_cmp(FPRESET_LIST[factory].name, "INIT")) break;
    check("FX poly preset: source factory Init is available", factory < N_FPRESETS);
    if (factory == N_FPRESETS) return;
    check("FX poly preset: source factory Init carries four voices", FPRESET_LIST[factory].n == pg_dev[d].nrows && fp_decode(FPRESET_LIST[factory].v, voice) == 4 * 65536);
    for (i = 0; i < pg_dev[d].nrows && i < FPRESET_LIST[factory].n; i++) values[i] = fp_decode(FPRESET_LIST[factory].v, i);
    check("FX poly preset: factory sound plus rack saves unchanged", !ps_put(scope, "WIDE", values, n));
    k = fx_preset_index(d, scope, "WIDE");
    check("FX poly preset: recall clamps factory voices to the exposed top", k >= 0 && !dp_load(d, (uint32_t)k) && poly_value(mod, ENG_POLY_PARTS) == 3);
    k = fx_preset_index(d, scope, "WIDE");
    check("FX poly preset: scoped source values match the loaded capped sound", k >= 0 && dp_same(d, (int)n) && pr_at[voice] == 4 * 65536);
    dp_name_set(d, ""); pages_ensure();
    count = dp_list(d);
    current = dp_current(d, count);
    check("FX poly preset: current-sound discovery finds the capped scoped sound", current >= 0 &&
          dp_entry(pr_list[current], name) == (int)n && pr_structure == scope && dp_same(d, (int)n));
    check("FX poly preset: stored and ROM voice values remain portable", !ps_read((uint32_t)ps_find(scope, "WIDE"), &i, name, &count) &&
          ps_vbuf[voice] == 4 * 65536 && fp_decode(FPRESET_LIST[factory].v, voice) == 4 * 65536);
    pr_structure = pg_dev[d].structure;
    pr_at = fp_values(factory, pr_vals, sizeof pr_vals / sizeof *pr_vals);
    check("FX poly preset: legacy factory matching uses the same voice clamp", dp_same(d, (int)FPRESET_LIST[factory].n));
    host_ps_init();
    ct_reset();
}

static void fx_preset_suite(void)
{
    static int32_t expected[PS_MAXV], old[PS_MAXV], bad[PS_MAXV];
    static uint8_t binary[sizeof pv_bin];
    static const int32_t tail[23] = {
        65536, 3 * 65536, 65536, 45000, -16384,
        0, 90000, 42000, 18000,
        65536, 180 * 65536, 31000, 22000, 65536, 65536, 3 * 65536,
        65536, 47000, 28000, 15000, 12 * 65536, 34000, 65536
    };
    uint32_t d, bus, n, rows, base, scope, kind, c, t, m, p, at, len, i, notified, saved;
    char remembered[17];
    int k, ok;
    ct_reset();
    host_ps_init();
    check("FX preset: real Monolith assembly and complete rack load", !load_fixture("build/panel-fixtures/fx-preset.m1p"));
    pv_gen++;
    pages_ensure();
    for (d = 0; d < pg_ndev && dp_fx_mask(d) != 15u; d++);
    check("FX preset: exactly one instrument owns the full rack", d < pg_ndev && eng_fx_count() == 4u);
    if (d >= pg_ndev) return;
    base = pg_dev[d].structure;
    scope = dp_structure(d);
    rows = pg_dev[d].nrows;
    n = dp_values(d);
    check("FX preset: capture has all synth rows, 19 controls, 4 enables, and 4 footer words", n == rows + 27u && n <= PS_MAXV && scope != base);
    if (!n || n != rows + 27u) return;
    memcpy(old, pr_vals, n * sizeof *old);
    memcpy(expected, old, n * sizeof *expected);
    memcpy(expected + rows, tail, sizeof tail);
    check("FX preset: signed-word footer survives Q16 transport", expected[n - 4u] == (int32_t)(int16_t)base * 65536 &&
          expected[n - 3u] == (int32_t)(int16_t)(base >> 16) * 65536 && expected[n - 2u] == 15 * 65536 && expected[n - 1u] == 23118 * 65536);
    check("FX preset: scoped record stores in existing flash layout", !ps_put(scope, "RACK", expected, n));
    check("FX preset: legacy same-name user record remains stored", !ps_put(base, "RACK", old, rows));
    check("FX preset: both namespaces remain listed", fx_preset_index(d, base, "RACK") >= 0 && fx_preset_index(d, scope, "RACK") >= 0);
    /* Force a synth row away from the saved sound before recalling the scoped record. */
    for (i = 0; i < rows; i++) {
        m = pg_dev[d].rows[2u * i]; p = pg_dev[d].rows[2u * i + 1u];
        if (m != 0xFFu && !(p & POLY_ROW) && row_ok(m, p) && !eng_tempo_row(m, p) && !DEF_FIXED((uint32_t)eng_type(m), p) &&
            DEFS[eng_type(m)].pmin[p] < DEF_TOP(&DEFS[eng_type(m)], p)) {
            int32_t value = expected[i] == DEFS[eng_type(m)].pmin[p] ? DEF_TOP(&DEFS[eng_type(m)], p) : DEFS[eng_type(m)].pmin[p];
            eng_set_param(m, p, value); m1_patch_param(m, p, value);
            pages_ensure();
            break;
        }
    }
    check("FX preset: synth differs before scoped recall", i < rows && dp_row_value(d, i) != expected[i]);
    k = fx_preset_index(d, scope, "RACK");
    host_pages_capacity = pv_len;
    len = pv_len; memcpy(binary, pv_bin, len);
    memcpy(remembered, pg_pname[d], sizeof remembered);
    (void)dp_values(d); memcpy(bad, pr_vals, n * sizeof *bad);
    saved = ct_params(); preset_record = 1; preset_events = 0;
    check("FX preset: full native buffer rejects before synth/FX/name/editor mutation", k >= 0 && dp_load(d, (uint32_t)k) < 0 &&
          ct_params() == saved && pv_len == len && !memcmp(binary, pv_bin, len) && !preset_events &&
          !strcmp(remembered, pg_pname[d]) && dp_values(d) == n && !memcmp(pr_vals, bad, n * sizeof *bad));
    host_pages_capacity = sizeof pv_bin;
    preset_record = 1; preset_events = 0;
    check("FX preset: scoped recall succeeds", k >= 0 && !dp_load(d, (uint32_t)k));
    notified = preset_events;
    preset_record = 0;
    check("FX preset: consumer-visible state recaptures exactly", dp_values(d) == n && !memcmp(pr_vals, expected, n * sizeof *expected));
    check("FX preset: complete scoped sound matches", dp_same(d, (int)n));
    eng_fx_set(dp_fx_stage(ENG_FX_DELAY), 0);
    check("FX preset: desired bypass alone breaks matching", !dp_same(d, (int)n));
    eng_fx_set(dp_fx_stage(ENG_FX_DELAY), 1);
    if (dp_fx_binding(dp_fx_stage(ENG_FX_REVERB), 5, 0, &m, &p)) {
        eng_set_param(m, p, 0);
        check("FX preset: a second-page control alone breaks matching", !dp_same(d, (int)n));
        eng_set_param(m, p, 65536);
    } else check("FX preset: second-page binding exists", 0);
    ok = 1; at = rows;
    for (kind = 0; kind < 4u; kind++) {
        uint32_t stage = dp_fx_stage(kind);
        int32_t on = expected[at++];
        const uint8_t *targets;
        uint32_t count = eng_fx_targets(stage, &targets);
        for (c = 0; c < DP_FX_N[kind]; c++, at++)
            for (t = 0; t < count; t++) {
                ok &= dp_fx_binding(stage, c, t, &m, &p);
                ok &= fx_preset_event(m, p, expected[at]);
            }
        for (t = 0; t < count; t++) ok &= fx_preset_event(targets[t], 0xFFu, on ? 0 : 65536);
        if (kind == ENG_FX_REVERB) ok &= eng_get_param(targets[0], REVERB_P_MIX) == 65536;
    }
    check("FX preset: every stereo control and desired enable reaches linked editor; reverb kernel stays wet", ok && notified > 23u);
    ok = 1;
    for (i = 0; i < preset_events; i++) if (preset_event[i].par == 0xFFu) break;
    for (; i < preset_events; i++) ok &= preset_event[i].par == 0xFFu;
    check("FX preset: all values are reported before bypass states", ok);
    check("FX preset: native binary reload preserves complete sound", !eng_load(pv_bin, pv_len));
    pv_gen++; pages_ensure();
    check("FX preset: reloaded binary captures all 19 controls and enables", dp_values(d) == n && !memcmp(pr_vals, expected, n * sizeof *expected));

    /* Reordering/renaming the visible rows must not change canonical capture (especially the second pages). */
    for (bus = 0; bus < pg_ndev && pg_dev[bus].bin != eng_fx_device(0); bus++);
    if (bus < pg_ndev && pg_dev[bus].npg > 1u) {
        uint32_t first = pg_dev[bus].pg0, last = first + pg_dev[bus].npg - 1u;
        ppage_t before = pg_page[first];
        pg_page[first] = pg_page[last]; pg_page[last] = before;
        pg_page[first].lab[0] = "renamed"; pg_page[first].llen[0] = 7;
        check("FX preset: labels and page ordering cannot change capture", dp_values(d) == n && !memcmp(pr_vals, expected, n * sizeof *expected));
        pg_built_at = 0xFFFFFFFFu; pages_ensure();
    }

    dp_name_set(d, "RACK"); pages_ensure();
    k = dp_current(d, dp_list(d));
    check("FX preset: reloaded duplicate display name prefers the scoped exact sound", k >= 0 && dp_entry(pr_list[k], (char[17]){0}) == (int)n && pr_structure == scope);
    dp_remember_names();
    check("FX preset: deleting legacy namesake keeps scoped remembered name", !ps_del(base, "RACK"));
    dp_deleted(base, "RACK");
    check("FX preset: remembered identity survives other namespace deletion", pg_pname[d][0] && pg_pstructure[d] == scope);
    check("FX preset: legacy namesake can be restored", !ps_put(base, "RACK", old, rows));

    /* Base records, including old short captures, do not touch FX at all. */
    k = fx_preset_index(d, base, "RACK");
    preset_record = 1; preset_events = 0;
    check("FX preset: saved unscoped preset still loads", k >= 0 && !dp_load(d, (uint32_t)k));
    preset_record = 0;
    ok = dp_values(d) == n && !memcmp(pr_vals + rows, expected + rows, 27u * sizeof *expected);
    for (i = 0; i < preset_events; i++) ok &= preset_event[i].par != 0xFFu;
    check("FX preset: legacy recall preserves complete rack and emits no bypass changes", ok);
    check("FX preset: old shortened user record still stores", !ps_put(base, "SHORT", old, rows - 1u));
    k = fx_preset_index(d, base, "SHORT");
    check("FX preset: shortened legacy recall is compatible and leaves rack alone", k >= 0 && !dp_load(d, (uint32_t)k) && dp_short &&
          dp_values(d) == n && !memcmp(pr_vals + rows, expected + rows, 27u * sizeof *expected));

    /* Each invalid envelope must reject before parameters, names, binary bytes, or editor events change. */
    for (i = 0; i < 7u; i++) {
        uint32_t count = n;
        memcpy(bad, expected, n * sizeof *bad);
        if (i == 0u) count--;
        if (i == 1u) bad[n - 4u] ^= 65536;
        if (i == 2u) bad[n - 1u] = 0;
        if (i == 3u) bad[n - 2u] = 7 * 65536;
        if (i == 4u) bad[rows] = 32768;
        if (i == 5u) bad[n - 5u] = 2 * 65536;
        if (i == 6u) bad[rows + 1u] = 0;
        check("FX preset: malformed record can be received without changing running sound", !ps_put(scope, "BAD", bad, count));
        k = fx_preset_index(d, scope, "BAD");
        len = pv_len; memcpy(binary, pv_bin, len);
        memcpy(remembered, pg_pname[d], sizeof remembered);
        saved = ct_params(); preset_events = 0; preset_record = 1;
        check("FX preset: malformed scoped recall rejects without partial synth/FX/binary/editor mutation", k >= 0 && dp_load(d, (uint32_t)k) < 0 &&
              ct_params() == saved && pv_len == len && !memcmp(binary, pv_bin, len) && !preset_events &&
              !strcmp(remembered, pg_pname[d]) && dp_values(d) == n && !memcmp(pr_vals, expected, n * sizeof *expected));
        preset_record = 0;
    }
    check("FX preset: incompatible rack namespace can be retained in storage", !ps_put(dp_fx_hash(base, 7), "OTHER RACK", expected, n));
    check("FX preset: incompatible rack is not offered for this instrument", fx_preset_index(d, dp_fx_hash(base, 7), "OTHER RACK") < 0);

    pages_ensure();
    saved = pg_dev[d].nrows; pg_dev[d].nrows = 150;
    check("FX preset: 177-value capture refuses rather than truncating", !dp_values(d));
    pg_dev[d].nrows = (uint8_t)saved;
    for (i = 0; i < pg_ndev; i++) if (i != d && i != bus) break;
    if (i < pg_ndev) {
        uint32_t structure = pg_dev[i].structure;
        pg_dev[i].structure = 1;
        check("FX preset: multiple structure-bearing devices have no implicit rack owner", !dp_fx_mask(d) && dp_structure(d) == base && dp_values(d) == rows);
        pg_dev[i].structure = structure;
    }
    k = fx_preset_index(d, scope, "RACK");
    check("FX preset: scoped record remains loadable after incompatible records", k >= 0 && !dp_load(d, (uint32_t)k));
    dp_store(d);
    check("FX preset: new store and notification use scoped identity", pg_pstructure[d] == scope && host_preset_structure == scope && ps_find(scope, pg_pname[d]) >= 0);
    dp_remember_names();
    check("FX preset: delete selected namespace", !ps_del(scope, pg_pname[d]));
    dp_deleted(scope, "RACK");
    check("FX preset: deleting selected identity clears name, keeps sound", !pg_pname[d][0] && dp_values(d) == n && !memcmp(pr_vals, expected, n * sizeof *expected));
    host_ps_init();
    fx_preset_poly_match();
    ct_reset();
}
