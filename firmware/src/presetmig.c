/* SPDX-License-Identifier: GPL-3.0-only */
/* User presets move when a factory engine's structure changes (#627, docs/ledger/patches-and-presets.md D-865): at the first
 * boot after an update (main.c, with bank_upgrade), each preset in the store (presetstore.c) whose structure is an earlier
 * one of a factory engine is rewritten for today's structure under the same name. presets.h PMIG_LIST says which structures
 * move and how (web/src/preset-migrations.json, as the editor does it: web/src/preset-migrate.ts): for each of today's rows
 * an earlier row kept as it is, a table that reads one or two earlier rows as whole numbers (Selector positions), a line
 * (an earlier row times a factor plus an offset, in Q16, picked by an earlier row read as a whole number), or the
 * engine's Init value (FPRESET_LIST: a new row, or one a shorter preset lacks). A preset whose name a factory preset of
 * today's structure has, or with more values than the earlier structure has rows, stays as it is.
 *
 * Power-cut safe: the new record is written first (ps_put replaces one of today's structure and that name: an earlier,
 * cut run's), then the earlier one is deleted. A cut in between leaves both; the settings record is written only after
 * this pass, so the next boot runs it again and ends with the moved one only. Structures are taken oldest first (the
 * table's order), so of two presets that land on one name, the newer structure's wins. Needs presetstore.c, presets.h.
 * Host test: tools/preset_test.sh. */

/* today's Init values of a structure (FPRESET_LIST), 0 none */
static const int32_t *pm_init(uint32_t structure, uint32_t n)
{
    uint32_t k;
    for (k = 0; k < N_FPRESETS; k++)
        if (FPRESET_LIST[k].structure == structure && FPRESET_LIST[k].n == n && !ps_name_cmp(FPRESET_LIST[k].name, "INIT"))
            return FPRESET_LIST[k].v;
    return 0;
}

/* a factory preset of the structure has the name (in any case) */
static int pm_factory_name(uint32_t structure, const char *name)
{
    uint32_t k, i;
    char nm[PS_NAME];
    for (k = 0; k < N_FPRESETS; k++) {
        if (FPRESET_LIST[k].structure != structure)
            continue;
        for (i = 0; i < PS_NAME; i++)
            nm[i] = 0;
        for (i = 0; i < PS_NAME && FPRESET_LIST[k].name[i]; i++)
            nm[i] = FPRESET_LIST[k].name[i];
        if (ps_name_eq(nm, name))
            return 1;
    }
    return 0;
}

/* a Q16 value as a whole number (round half up, as the editor's Math.round) */
static int32_t pm_whole(int32_t v) { return (v >> 16) + ((v >> 15) & 1); }

/* a line's value: x times mul plus add (Q16, x * mul floored as the editor's Math.floor), held inside min .. max */
static int32_t pm_line(uint32_t l, const int32_t *old, uint32_t n, int32_t init)
{
    const int32_t *v = PMIG_LV + PMIG_LINE[l].v;
    const uint32_t x = PMIG_LINE[l].x, key = PMIG_LINE[l].key;
    int32_t i = 0, q;
    if (x >= n || (key != 0xFFu && key >= n))
        return init;
    if (key != 0xFFu) {
        i = pm_whole(old[key]) - PMIG_LINE[l].lo;
        i = i < 0 ? 0 : i >= (int32_t)PMIG_LINE[l].n ? (int32_t)PMIG_LINE[l].n - 1 : i;
    }
    q = (int32_t)(((int64_t)old[x] * v[2 + 2 * i]) >> 16) + v[3 + 2 * i];
    return q < v[0] ? v[0] : q > v[1] ? v[1] : q;
}

/* migration m's values of today's rows from an earlier preset's n values (old) into out; init: today's Init values */
static void pm_apply(uint32_t m, const int32_t *old, uint32_t n, const int32_t *init, int32_t *out)
{
    uint32_t k, tab = PMIG_LIST[m].tab, line = PMIG_LIST[m].line;
    const uint8_t *op = PMIG_OPS + PMIG_LIST[m].ops;
    for (k = 0; k < PMIG_LIST[m].nnew; k++) {
        uint32_t o = op[k];
        if (o == 0xFFu)
            out[k] = init[k];
        else if (o == 0xFDu)
            out[k] = pm_line(line++, old, n, init[k]);
        else if (o != 0xFEu)
            out[k] = o < n ? old[o] : init[k];
        else {
            const uint32_t t = tab++;
            const uint32_t a = PMIG_TAB[t].a, b = PMIG_TAB[t].b;
            int32_t ia, ib = 0;
            if (a >= n || (b != 0xFFu && b >= n)) {
                out[k] = init[k];
                continue;
            }
            ia = pm_whole(old[a]) - PMIG_TAB[t].la;
            ia = ia < 0 ? 0 : ia >= (int32_t)PMIG_TAB[t].na ? (int32_t)PMIG_TAB[t].na - 1 : ia;
            if (b != 0xFFu) {
                ib = pm_whole(old[b]) - PMIG_TAB[t].lb;
                ib = ib < 0 ? 0 : ib >= (int32_t)PMIG_TAB[t].nb ? (int32_t)PMIG_TAB[t].nb - 1 : ib;
            }
            out[k] = (int32_t)PMIG_TV[PMIG_TAB[t].v + (uint32_t)ia * PMIG_TAB[t].nb + (uint32_t)ib] * 65536;
        }
    }
}

/* move every preset of an earlier structure to today's; work holds PS_MAXV values. How many moved */
static uint32_t pm_run(int32_t *work)
{
    static uint8_t slots[PS_SLOTS];
    uint32_t m, moved = 0;
    char name[PS_NAME + 1u];
    for (m = 0; m < N_PMIG; m++) {
        const int32_t *init = pm_init(PMIG_LIST[m].to, PMIG_LIST[m].nnew);
        uint32_t skip = 0;
        if (!init || PMIG_LIST[m].nnew > PS_MAXV)
            continue;
        for (;;) {                                      /* (each pass lists again: a store compacts while it writes) */
            uint32_t cnt = ps_list(PMIG_LIST[m].from, slots, PS_SLOTS), st, n;
            if (cnt <= skip)
                break;
            fm1_wdt_feed();
            if (ps_read(slots[skip], &st, name, &n) || n > PMIG_LIST[m].nold || pm_factory_name(PMIG_LIST[m].to, name)) {
                skip++;                                 /* (it stays as it is) */
                continue;
            }
            pm_apply(m, ps_vbuf, n, init, work);
            if (ps_put(PMIG_LIST[m].to, name, work, PMIG_LIST[m].nnew)) {
                skip++;                                 /* (the store is full: it stays as it is) */
                continue;
            }
            (void)ps_del(PMIG_LIST[m].from, name);
            moved++;
        }
    }
    return moved;
}
