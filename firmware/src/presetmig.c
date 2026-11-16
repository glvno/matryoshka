/* SPDX-License-Identifier: GPL-3.0-only */
/* User presets move when a factory engine's structure changes (#627, docs/ledger/patches-and-presets.md D-865): at the first
 * boot with factory content the bank was not brought to (main.c presets_upgrade), each preset in the store (presetstore.c)
 * whose structure is an earlier one of a factory engine is rewritten for today's structure under the same name. The
 * firmware tier's migrations section (factory.c, #915; web/src/preset-migrations.json, as the editor does it:
 * web/src/preset-migrate.ts) says which structures move and how: for each of today's rows an earlier row kept as it is, a
 * table that reads one or two earlier rows as whole numbers (Selector positions), a line (an earlier row times a factor plus
 * an offset, in Q16, picked by an earlier row read as a whole number), or the engine's Init value (its factory INIT preset:
 * a new row, or one a shorter preset lacks). A preset whose name a factory preset of today's structure has, or with more
 * values than the earlier structure has rows, stays as it is. The Init values are the factory region's: without it
 * nothing moves (the next boot with it does it).
 *
 * The section: u16 counts of the list, tables, lines, ops, table values and line values, then the list (16 bytes each: u32
 * the earlier structure, u32 today's, u16 its first op, table and line, u8 the earlier row count, u8 today's), the tables
 * (8 bytes: u8 a, b (0xFF: one row), na, nb, i8 la, lb, u16 the first of its values), the lines (6 bytes: u8 x, key (0xFF:
 * one line), n, i8 lo, u16 the first of its line values: min, max, then mul and add for each line), the line values (i32),
 * the table values (i8, at a * nb + b) and the ops (u8: an earlier row to copy 0..0xFC, 0xFD the next line, 0xFE the next
 * table, 0xFF the Init value).
 *
 * Power-cut safe: the new record is written first (ps_put replaces one of today's structure and that name: an earlier,
 * cut run's), then the earlier one is deleted. A cut in between leaves both; the settings record is written only after
 * this pass, so the next boot runs it again and ends with the moved one only. Structures are taken oldest first (the
 * list's order), so of two presets that land on one name, the newer structure's wins. Needs presetstore.c, factory.c.
 * Host test: tools/preset_test.sh. */

#define PM_OPS_LINE 0xFDu
#define PM_OPS_TABLE 0xFEu
#define PM_OPS_INIT 0xFFu

/* where each part of the migrations section starts */
typedef struct { uint32_t list, tab, line, lv, tv, ops; } pm_at_t;

static int pm_layout(pm_at_t *a)
{
    uint8_t c[12];
    if (fc_mig_rd(0, c, sizeof c))
        return -1;
    a->list = 12u;
    a->tab = a->list + 16u * fc_u16(c);
    a->line = a->tab + 8u * fc_u16(c + 2);
    a->lv = a->line + 6u * fc_u16(c + 4);
    a->tv = a->lv + 4u * fc_u16(c + 10);
    a->ops = a->tv + fc_u16(c + 8);
    return 0;
}

/* today's factory INIT preset of a structure with n values: its index, -1 none */
static int pm_init(uint32_t structure, uint32_t n)
{
    char nm[FC_PNAME + 1u];
    int k;
    for (k = fc_preset_find(structure, 0); k >= 0; k = fc_preset_find(structure, (uint32_t)k + 1u))
        if (fc_preset_name((uint32_t)k, nm) == (int)n && !ps_name_cmp(nm, "INIT"))
            return k;
    return -1;
}

/* a factory preset of the structure has the name (in any case) */
static int pm_factory_name(uint32_t structure, const char *name)
{
    char nm[FC_PNAME + 1u];
    int k;
    for (k = fc_preset_find(structure, 0); k >= 0; k = fc_preset_find(structure, (uint32_t)k + 1u))
        if (fc_preset_name((uint32_t)k, nm) >= 0 && ps_name_eq(nm, name))
            return 1;
    return 0;
}

/* a Q16 value as a whole number (round half up, as the editor's Math.round) */
static int32_t pm_whole(int32_t v) { return (v >> 16) + ((v >> 15) & 1); }

static int32_t pm_lv(const pm_at_t *a, uint32_t i)
{
    uint8_t b[4];
    return fc_mig_rd(a->lv + 4u * i, b, 4u) ? 0 : (int32_t)fc_u32(b);
}

/* line l's value: x times mul plus add (Q16, x * mul floored as the editor's Math.floor), held inside min .. max */
static int32_t pm_line(const pm_at_t *a, uint32_t l, const int32_t *old, uint32_t n, int32_t init)
{
    uint8_t e[6];
    uint32_t x, key, v;
    int32_t i = 0, q, lo, hi;
    if (fc_mig_rd(a->line + 6u * l, e, sizeof e))
        return init;
    x = e[0];
    key = e[1];
    v = fc_u16(e + 4);
    if (x >= n || (key != 0xFFu && key >= n))
        return init;
    if (key != 0xFFu) {
        i = pm_whole(old[key]) - (int8_t)e[3];
        i = i < 0 ? 0 : i >= (int32_t)e[2] ? (int32_t)e[2] - 1 : i;
    }
    q = (int32_t)(((int64_t)old[x] * pm_lv(a, v + 2u + 2u * (uint32_t)i)) >> 16) + pm_lv(a, v + 3u + 2u * (uint32_t)i);
    lo = pm_lv(a, v);
    hi = pm_lv(a, v + 1u);
    return q < lo ? lo : q > hi ? hi : q;
}

/* table t's value from the earlier preset's n values (old), init when its rows are past them */
static int32_t pm_table(const pm_at_t *a, uint32_t t, const int32_t *old, uint32_t n, int32_t init)
{
    uint8_t e[8], v;
    uint32_t ra, rb, na, nb;
    int32_t ia, ib = 0;
    if (fc_mig_rd(a->tab + 8u * t, e, sizeof e))
        return init;
    ra = e[0];
    rb = e[1];
    na = e[2];
    nb = e[3];
    if (ra >= n || (rb != 0xFFu && rb >= n))
        return init;
    ia = pm_whole(old[ra]) - (int8_t)e[4];
    ia = ia < 0 ? 0 : ia >= (int32_t)na ? (int32_t)na - 1 : ia;
    if (rb != 0xFFu) {
        ib = pm_whole(old[rb]) - (int8_t)e[5];
        ib = ib < 0 ? 0 : ib >= (int32_t)nb ? (int32_t)nb - 1 : ib;
    }
    if (fc_mig_rd(a->tv + fc_u16(e + 6) + (uint32_t)ia * nb + (uint32_t)ib, &v, 1u))
        return init;
    return (int32_t)(int8_t)v * 65536;
}

/* migration entry e's values of today's rows from an earlier preset's n values (old) into out, which holds today's Init
 * values when called (each row reads its own Init value before it is overwritten) */
static void pm_apply(const pm_at_t *a, const uint8_t *e, const uint8_t *op, const int32_t *old, uint32_t n, int32_t *out)
{
    uint32_t k, tab = fc_u16(e + 10), line = fc_u16(e + 12);
    for (k = 0; k < e[15]; k++) {
        uint32_t o = op[k];
        if (o == PM_OPS_LINE)
            out[k] = pm_line(a, line++, old, n, out[k]);
        else if (o == PM_OPS_TABLE)
            out[k] = pm_table(a, tab++, old, n, out[k]);
        else if (o != PM_OPS_INIT && o < n)
            out[k] = old[o];
    }
}

/* move every preset of an earlier structure to today's; work holds PS_MAXV values. How many moved */
static uint32_t pm_run(int32_t *work)
{
    static uint8_t slots[PS_SLOTS];
    uint8_t e[16], op[PS_MAXV];
    uint32_t m, moved = 0;
    pm_at_t a;
    char name[PS_NAME + 1u];
    if (!fc_nmig() || pm_layout(&a))
        return 0;
    for (m = 0; m < fc_nmig(); m++) {
        uint32_t skip = 0, from, to, nold, nnew;
        int init;
        if (fc_mig_rd(a.list + 16u * m, e, sizeof e))
            break;
        from = fc_u32(e);
        to = fc_u32(e + 4);
        nold = e[14];
        nnew = e[15];
        init = pm_init(to, nnew);
        if (init < 0 || nnew > PS_MAXV || fc_mig_rd(a.ops + fc_u16(e + 8), op, nnew))
            continue;
        for (;;) {                                      /* (each pass lists again: a store compacts while it writes) */
            uint32_t cnt = ps_list(from, slots, PS_SLOTS), st, n;
            if (cnt <= skip)
                break;
            fm1_wdt_feed();
            if (ps_read(slots[skip], &st, name, &n) || n > nold || pm_factory_name(to, name) ||
                !fc_preset_values((uint32_t)init, work, PS_MAXV)) {
                skip++;                                 /* (it stays as it is) */
                continue;
            }
            pm_apply(&a, e, op, ps_vbuf, n, work);
            if (ps_put(to, name, work, nnew)) {
                skip++;                                 /* (the store is full: it stays as it is) */
                continue;
            }
            (void)ps_del(from, name);
            moved++;
        }
    }
    return moved;
}
