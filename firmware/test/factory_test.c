/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The factory content's two tiers (#915, firmware/src/factory.c) on the host, the region over RAM NOR (factory_host.h):
 *   - the firmware tier and today's region image (export-defs: factory_tier.h, factory_region.h) merged: every factory
 *     patch once, in its own slot, unpacked in place to presets.h's bytes; every preset's values, every drum pattern and
 *     every released set are presets.h's;
 *   - a blank region: the firmware tier alone (its patches in their own slots, no presets, no patterns, the migrations);
 *   - a region record named as a firmware-tier patch replaces it when its revision is higher, else the built-in one plays;
 *   - the link's install (FACT_BEGIN, FACT_WRITE, FACT_SUM, FACT_COMMIT) and its refusals;
 *   - a power cut after every byte the install programs, and inside every erase: the next boot finds the old content,
 *     none (the tier alone) or the whole new one, never the new one before its header's magic; the install run again from
 *     a cut finishes with the new content;
 *   - the update loader's record sweep (firmware/loader/ldr_record.h, the loop the loader runs): it leaves today's image
 *     alone and erases a sector made to look like a record, which the firmware then finds damaged; the firmware refuses
 *     to program such a page.
 *   tools/factory_test.sh */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "../src/engine.h"

/* the update loader's step 4 over a whole flash in RAM (ldr_record.h ldr_records_clear, with these hooks) */
#define LDR_REC_LO 0x93000u
#define LDR_REC_HI 0xFC000u
#define LDR_DATA_LO 0x97000u
#define LDR_DATA_HI 0xE0000u
static uint8_t whole[0x100000];
static int ldr_fread(uint32_t off, void *p, uint32_t n) { memcpy(p, whole + off, n); return 0; }
static int ldr_erase(uint32_t off) { memset(whole + off, 0xFF, 0x1000u); return 0; }

#define HOST_FR_STANDALONE
#include "factory_host.h"

/* the install's programs and erases go through here: each programmed byte is probed (the boot after a power cut right
 * after it); cut_erase cuts the next erase short (half the sector erased) and stops the writes */
static void (*probe)(void);
static int cut_erase = -1, cut_hit;
static int st_prog_probed(uint32_t off, const void *src, uint32_t n)
{
    uint32_t k;
    if (cut_hit)
        return -1;
    for (k = 0; k < n; k++) {
        (void)st_prog(off + k, (const uint8_t *)src + k, 1);
        if (probe)
            probe();
    }
    return 0;
}
static int st_erase_cut(uint32_t off)
{
    if (cut_hit)
        return -1;
    if (cut_erase == 0) {
        uint8_t *f = host_fr(off, 0x800u);
        if (f)
            memset(f, 0xFF, 0x800u);
        cut_hit = 1;
        return -1;
    }
    if (cut_erase > 0)
        cut_erase--;
    return st_erase(off);
}
#define st_prog st_prog_probed
#define st_erase st_erase_cut
#include "../src/factory.c"
#undef st_prog
#undef st_erase
#include "../src/presets.h"

static int fails;
static void check(const char *what, int ok)
{
    printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
    if (!ok)
        fails++;
}

/* sector s of the image as the flash holds it before the commit (the header's 64 bytes erased) */
static uint32_t sector_sum(const uint8_t *img, uint32_t len, uint32_t s)
{
    uint8_t b[0x1000];
    uint32_t k;
    memset(b, 0xFF, sizeof b);
    for (k = 0; k < 0x1000u && s * 0x1000u + k < len; k++)
        b[k] = (s || k >= FC_HDR) ? img[s * 0x1000u + k] : 0xFFu;
    return fc_crc16(0xFFFFu, b, sizeof b);
}
/* the editor's install of image (len bytes): FACT_BEGIN, each sector whose FACT_SUM differs written in pages, then
 * FACT_COMMIT. The status of the first step that failed, else S_OK */
static uint32_t install(const uint8_t *img, uint32_t len)
{
    uint32_t st, s, off, crc, sectors = (len + 0xFFFu) / 0x1000u;
    if ((st = m1_fact_begin()) != S_OK)
        return st;
    for (s = 0; s < sectors; s++) {
        if (!m1_fact_sum(s, &crc) && crc == sector_sum(img, len, s))
            continue;
        for (off = s ? 0u : FC_HDR; off < 0x1000u && s * 0x1000u + off < len; off = (off | 0xFFu) + 1u) {
            uint32_t n = 256u - (off & 0xFFu), at = s * 0x1000u + off;
            uint8_t page[256];
            if (at + n > len)
                n = len - at;
            memcpy(page, img + at, n);
            if ((off & 0xF00u) == 0xF00u && n < LDR_REC_LEN) {       /* (the record's page: written whole, 0xFF after) */
                memset(page + n, 0xFF, 256u - n);
                n = 256u;
            }
            if ((st = m1_fact_write(s, off, page, n)) != S_OK)
                return st;
        }
        if (m1_fact_sum(s, &crc) || crc != sector_sum(img, len, s))
            return S_CRC;
    }
    return m1_fact_commit(img);
}

/* the PRESET_LIST index of the name, -1 none */
static int bank_index(const char *name)
{
    uint32_t i;
    for (i = 0; i < N_PRESETS; i++)
        if (!strcmp(name, PRESET_LIST[i].name))
            return (int)i;
    return -1;
}

/* the merged patches (scanned) are factory patches: each once, in its own slot, its bytes presets.h's; the released sets
 * are presets.h's over them. How many, -1 when one is not */
static int merged_ok(void)
{
    static uint8_t buf[M1_PATCH_MAX], ref[M1_PATCH_MAX];
    char name[M1_NAME + 1u];
    uint32_t i, k, slot;
    uint64_t seen = 0;
    int b[FC_PATCHES];
    for (i = 0; i < fc_npatches(); i++) {
        name[M1_NAME] = 0;
        if (fc_patch_info(i, name, 0, &slot) || (b[i] = bank_index(name)) < 0 || slot != (uint32_t)b[i] || (seen >> b[i] & 1u) ||
            fc_patch(i, buf, sizeof buf) != PRESET_LIST[b[i]].len ||
            lz_unpack(PRESET_LIST[b[i]].lz, PRESET_LIST[b[i]].lz_len, ref, sizeof ref) != PRESET_LIST[b[i]].len ||
            memcmp(buf, ref, PRESET_LIST[b[i]].len))
            return -1;
        seen |= (uint64_t)1 << b[i];
    }
    for (k = 0; k < N_RELEASED_SETS; k++) {
        uint64_t has = 0, any, want = 0;
        for (i = 0; i < fc_npatches(); i++)
            want |= (uint64_t)(RELEASED_SETS[k].has >> b[i] & 1u) << i;
        if (!fc_released(RELEASED_SETS[k].set, &has, &any) || has != want)
            return -1;
    }
    return (int)fc_npatches();
}

/* the content (scanned) is today's: the firmware tier and the region merged, every patch, preset and pattern as presets.h
 * has them */
static int same_as_presets_h(void)
{
    static int32_t v[176];
    char pn[FC_PNAME + 1u];
    uint32_t i, k;
    fc_pattern_t p;
    if (!fc_region || merged_ok() != N_PRESETS || fc_npresets() != N_FPRESETS || fc_npatterns() != N_PRESET_PATTERNS)
        return 0;
    for (k = 0; k < N_FPRESETS; k++) {
        int32_t want[FP_MAX_VALUES];
        if (fc_preset_structure(k) != FPRESET_LIST[k].structure || fc_preset_name(k, pn) != FPRESET_LIST[k].n ||
            strncmp(pn, FPRESET_LIST[k].name, FC_PNAME) || !fc_preset_values(k, v, 176) || !fp_values(k, want, FP_MAX_VALUES) ||
            memcmp(v, want, 4u * FPRESET_LIST[k].n))
            return 0;
    }
    for (i = 0; i < N_PRESET_PATTERNS; i++)
        if (fc_pattern(i, &p) || p.identity != PRESET_PATTERNS[i].identity || p.structure != PRESET_PATTERNS[i].structure ||
            strcmp(p.name, PRESET_PATTERNS[i].name) || p.n != PRESET_PATTERNS[i].n || p.len != PRESET_PATTERNS[i].len ||
            p.rate != PRESET_PATTERNS[i].rate || p.swing != PRESET_PATTERNS[i].swing || p.dir != PRESET_PATTERNS[i].dir ||
            p.gate != PRESET_PATTERNS[i].gate || memcmp(p.notes, PRESET_PATTERNS[i].notes, 4u * p.n))
            return 0;
    return fc_set() == FACTORY_SET_ID && fc_nmig() > 0;
}

/* img (len bytes) with region patch record r renamed to `name` at revision `rev`: its CRCs made again */
static void rename_record(uint8_t *img, uint32_t len, uint32_t r, const char *name, uint32_t rev)
{
    uint8_t *e = img + fc_u32(img + 32) + FC_REC * r;
    uint32_t k, c;
    for (k = 0; k < M1_NAME; k++)
        e[k] = (uint8_t)(k < strlen(name) ? name[k] : 0);
    e[32] = (uint8_t)rev;
    e[33] = (uint8_t)(rev >> 8);
    c = ~fc_crc32(0xFFFFFFFFu, img + FC_HDR, len - FC_HDR);
    for (k = 0; k < 4u; k++)
        img[16u + k] = (uint8_t)(c >> (8u * k));
    c = m1_crc16(img + 4, 58u);
    img[62] = (uint8_t)c;
    img[63] = (uint8_t)(c >> 8);
}

/* the power-cut probe: what the boot after a cut right now would find */
#define SNAPS 96
static uint32_t old_set;
static long probed, bad_state, early_new;
static uint8_t *snap[SNAPS];
static int nsnap;
static void cut_probe(void)
{
    fc_hdr_t h;
    uint32_t st = fc_check(&h);
    probed++;
    if (!(st == FC_NONE || (st == FC_OK && (h.set == FACTORY_SET_ID || h.set == old_set))))
        bad_state++;
    if (st == FC_OK && h.set == FACTORY_SET_ID)
        early_new++;                                     /* (today's content valid: only after the install's last byte) */
    if (probed % 997 == 0 && nsnap < SNAPS) {            /* (a flash to run the install again from) */
        snap[nsnap] = malloc(HOST_FR_SIZE);
        memcpy(snap[nsnap++], host_fr_flash, HOST_FR_SIZE);
    }
}

int main(void)
{
    static uint8_t img[HOST_FR_SIZE], old[HOST_FR_SIZE];
    uint32_t len = sizeof FACTORY_REGION_IMG, s;
    uint8_t info[32];
    printf("factory content: the firmware tier and the factory region (#915)\n");
    memcpy(img, FACTORY_REGION_IMG, len);

    /* today's image */
    host_fr_load();
    fc_scan();
    check("the firmware tier and today's region: valid, the content presets.h has (each patch once, in its own slot, "
          "unpacked in place; presets, patterns, released sets)", fc_state == FC_OK && same_as_presets_h());
    printf("        (the region: %u of %u bytes, %u patches; the firmware tier: %u bytes, %u patches)\n", (unsigned)len,
           (unsigned)FC_SIZE, (unsigned)fr.npatch, (unsigned)sizeof FC_TIER, (unsigned)ft.npatch);
    check("  it fits the region with the header", len <= FC_SIZE && fr.len + FC_HDR == len);
    check("  the tier carries the migrations, no presets, no patterns; the region no migrations",
          ft.nmig > 0 && !ft.npreset && !ft.npattern && ft.kind == FC_KIND_TIER && !fr.nmig && fr.kind == FC_KIND_REGION);
    {
        int clear = 1;
        for (s = 0; s * 0x1000u + 0xF00u + LDR_REC_LEN <= len; s++)
            clear &= !ldr_is_record(img + s * 0x1000u + 0xF00u);
        check("  no sector of it looks like an update record", clear);
    }

    /* the firmware tier alone */
    host_fr_blank();
    fc_scan();
    {
        uint32_t i;
        int mo = 0;
        for (i = 0; i < fc_npatches(); i++) {
            char nm[M1_NAME + 1u];
            nm[M1_NAME] = 0;
            mo |= !fc_patch_info(i, nm, 0, 0) && !strcmp(nm, "MONOLITH D");
        }
        check("a blank region: the firmware tier alone, each patch a factory patch in its own slot, its bytes, the released "
              "sets over it", !fc_region && fc_state == FC_NONE && fc_set() == FC_TIER_SET && merged_ok() == (int)ft.npatch &&
              ft.npatch > 0 && ft.npatch < N_PRESETS && mo);
        check("  no factory presets, no drum patterns; the migrations", !fc_npresets() && !fc_npatterns() && fc_nmig() > 0 &&
              fc_preset_find(FPRESET_LIST[0].structure, 0) < 0);
    }

    /* a region record named as a firmware-tier patch (a content-only fix of it) */
    {
        static uint8_t fix[HOST_FR_SIZE], buf[M1_PATCH_MAX], ref[M1_PATCH_MAX];
        char tier0[M1_NAME + 1u], nm[M1_NAME + 1u];
        uint32_t slot, r0 = 0;
        int b;
        host_fr_blank();
        fc_scan();
        tier0[M1_NAME] = nm[M1_NAME] = 0;
        (void)fc_patch_info(0, tier0, 0, 0);
        memcpy(fix, img, len);
        rename_record(fix, len, r0, tier0, ft.version + 1u);
        host_fr_blank();
        memcpy(host_fr_flash, img, len);
        fc_scan();
        b = fc_patch_info(ft.npatch, nm, 0, 0) ? -1 : bank_index(nm);      /* (region record 0: the first after the tier's) */
        memcpy(host_fr_flash, fix, len);
        fc_scan();
        check("a newer region copy of a firmware-tier patch: valid, one patch fewer in all, played in the tier patch's place",
              fc_region && fc_npatches() == N_PRESETS - 1u && fc_patch_region(0) && b >= 0);
        check("  its bytes and slot are the region record's",
              b >= 0 && !fc_patch_info(0, nm, 0, &slot) && !strcmp(nm, tier0) && slot == (uint32_t)b &&
              fc_patch(0, buf, sizeof buf) == PRESET_LIST[b].len &&
              lz_unpack(PRESET_LIST[b].lz, PRESET_LIST[b].lz_len, ref, sizeof ref) == PRESET_LIST[b].len && !memcmp(buf, ref, PRESET_LIST[b].len));
        memcpy(fix, img, len);
        rename_record(fix, len, r0, tier0, ft.version);
        memcpy(host_fr_flash, fix, len);
        fc_scan();
        check("  a region copy not newer than the built-in one: the built-in one plays", fc_region &&
              fc_npatches() == N_PRESETS - 1u && !fc_patch_region(0) && !fc_patch_info(0, nm, 0, &slot) && !strcmp(nm, tier0) &&
              slot == (uint32_t)bank_index(tier0));
    }

    /* the install over the link, and its refusals */
    host_fr_blank();
    fc_scan();
    check("FACT_WRITE before FACT_BEGIN: refused (S_NONE)", m1_fact_write(1, 0, img, 16) == S_NONE);
    check("FACT_COMMIT before FACT_BEGIN: refused (S_RANGE)", m1_fact_commit(img) == S_RANGE);
    check("FACT_BEGIN: S_OK, the firmware tier alone plays", m1_fact_begin() == S_OK && fc_writing && !fc_region &&
          fc_npatches() == ft.npatch);
    check("FACT_COMMIT of the firmware tier's image: refused (S_RANGE)", m1_fact_commit(FC_TIER) == S_RANGE);
    check("FACT_WRITE into the header's 64 bytes: refused", m1_fact_write(0, 0, img, 16) == S_RANGE && m1_fact_write(0, 60, img, 8) == S_RANGE);
    check("FACT_WRITE across a page: refused", m1_fact_write(1, 250, img, 16) == S_RANGE);
    check("FACT_WRITE past the region: refused", m1_fact_write(FC_SECTORS, 0, img, 16) == S_RANGE);
    check("FACT_WRITE into a record's page but not whole: refused", m1_fact_write(2, 0xF10, img, 16) == S_RANGE && m1_fact_write(2, 0xF00, img, 40) == S_RANGE);
    {
        uint8_t rec[256];
        memset(rec, 0xFF, sizeof rec);
        memset(rec, 0x11, LDR_REC_LEN);
        rec[6] = 0x41;
        rec[7] = 0x54;
        s = ldr_rec_crc16(rec + 2, LDR_REC_LEN - 2u);
        rec[0] = (uint8_t)s;
        rec[1] = (uint8_t)(s >> 8);
        check("(a page made to look like an update record is one by the loader's rule)", ldr_is_record(rec));
        check("FACT_WRITE of such a page at 0xF00: refused", m1_fact_write(3, 0xF00, rec, 256) == S_RANGE);
    }
    {
        uint8_t bad[FC_HDR];
        memcpy(bad, img, FC_HDR);
        bad[5] = ENG_PATCH_VERSION + 1u;                         /* (a newer format: the header's CRC made again) */
        s = m1_crc16(bad + 4, 58u);
        bad[62] = (uint8_t)s;
        bad[63] = (uint8_t)(s >> 8);
        check("FACT_COMMIT of content in a newer patch format: refused (S_LOAD)", m1_fact_commit(bad) == S_LOAD);
    }
    check("FACT_COMMIT before the body is written: its CRC-32 fails (S_CRC)", m1_fact_commit(img) == S_CRC);
    host_fr_blank();
    fc_scan();
    fc_sync_due = 0;
    check("the install into a blank region: S_OK", install(img, len) == S_OK);
    check("  the content is today's, and main.c is told to bring the bank to it", fc_state == FC_OK && same_as_presets_h() && fc_sync_due);
    check("  the bytes are the image's", !memcmp(host_fr_flash, img, len));
    check("FACT_COMMIT again without FACT_BEGIN: refused, the content stays", m1_fact_commit(img) == S_RANGE && fc_region);
    check("FACT_INFO: valid, layout 1, the set, the length, the region's patches, not writing, the region's size, the "
          "format this firmware plays, the tier's version and patches, the patches in all",
          m1_fact_info(info) == 26u && info[0] == FC_OK && info[1] == FC_LAYOUT && info[2] == FC_LAYOUT &&
          fc_u32(info + 6) == FACTORY_SET_ID && fc_u32(info + 10) == len - FC_HDR && fc_u16(info + 14) == fr.npatch &&
          info[16] == 0 && fc_u32(info + 17) == FC_SIZE && info[21] == ENG_PATCH_VERSION && fc_u16(info + 22) == ft.version &&
          info[24] == ft.npatch && info[25] == N_PRESETS);
    {
        uint8_t got[128];
        check("FACT_READ: the bytes; nothing past the region", !m1_fact_read(1000, got, 128) && !memcmp(got, img + 1000, 128) &&
              m1_fact_read(FC_SIZE - 4u, got, 8) == -1);
    }
    check("the install over today's content: S_OK (only sector 0 and the header written again)", install(img, len) == S_OK && fc_region);

    /* a power cut after every byte and inside every erase, from an older content (another factory set) to today's */
    {
        int e, erases, i, resumed = 0;
        memcpy(old, img, len);
        for (s = FC_HDR; s < len; s++)                          /* (other bytes in every sector, its CRC-32 made again; */
            if ((s & 0xFFFu) < 0xF00u || (s & 0xFFFu) >= 0xF50u)   /* the record's bytes kept clear of the loader's rule) */
                old[s] ^= 0xA5u;
        {
            uint32_t c = fc_crc32(0xFFFFFFFFu, old + FC_HDR, len - FC_HDR);
            c = ~c;
            old[16] = (uint8_t)c;
            old[17] = (uint8_t)(c >> 8);
            old[18] = (uint8_t)(c >> 16);
            old[19] = (uint8_t)(c >> 24);
        }
        old[8] ^= 0x5A;                                          /* (another factory set: the header's CRC made again) */
        s = m1_crc16(old + 4, 58u);
        old[62] = (uint8_t)s;
        old[63] = (uint8_t)(s >> 8);
        old_set = (FACTORY_SET_ID ^ 0x5Au) & 0xFFFFFFu;
        host_fr_blank();
        memcpy(host_fr_flash, old, len);
        fc_scan();
        check("(the older content is valid on its own)", fc_state == FC_OK && fr.set == old_set);
        cut_erase = 0x7FFF;
        probe = cut_probe;
        check("(the install from it, every byte probed)", install(img, len) == S_OK && same_as_presets_h());
        probe = 0;
        erases = 0x7FFF - cut_erase;
        cut_erase = -1;
        for (i = 0; i < nsnap; i++) {                            /* the install again from a cut */
            memcpy(host_fr_flash, snap[i], HOST_FR_SIZE);
            fc_scan();
            fc_writing = 0;
            resumed += install(img, len) == S_OK && same_as_presets_h();
            free(snap[i]);
        }
        for (e = 0; e < erases; e++) {                           /* an erase cut short, the boot, the install again */
            host_fr_blank();
            memcpy(host_fr_flash, old, len);
            fc_scan();
            cut_erase = e;
            cut_hit = 0;
            (void)install(img, len);
            cut_erase = -1;
            cut_hit = 0;
            fc_scan();
            if (!(fc_state == FC_NONE || (fc_state == FC_OK && fr.set == old_set)))
                bad_state++;
            fc_writing = 0;
            if (install(img, len) != S_OK || !same_as_presets_h())
                bad_state++;
        }
        printf("        (%ld bytes programmed, each probed; %d erases cut short; the install run again from %d cuts)\n", probed, erases, nsnap);
        check("a power cut after any byte or inside any erase: the old content, none (the tier alone), or the whole new one",
              bad_state == 0 && probed > (long)len - 2 * (long)FC_HDR);
        check("  the new content is valid only after the install's last byte (its header's magic, programmed last)", early_new == 1);
        check("  the install run again from a cut finishes it", resumed == nsnap && nsnap > 0);
    }

    /* the update loader's step 4 over a flash holding today's image */
    {
        uint8_t rec[LDR_REC_LEN];
        int erased = 1, rest = 1;
        memset(whole, 0xFF, sizeof whole);
        memcpy(whole + FC_BASE, img, len);
        ldr_records_clear();
        check("the loader's record sweep leaves today's image as it is", !memcmp(whole + FC_BASE, img, len));
        memset(rec, 0x22, sizeof rec);
        rec[6] = 0x41;
        rec[7] = 0x54;
        s = ldr_rec_crc16(rec + 2, LDR_REC_LEN - 2u);
        rec[0] = (uint8_t)s;
        rec[1] = (uint8_t)(s >> 8);
        memcpy(whole + FC_BASE + 5u * 0x1000u + 0xF00u, rec, sizeof rec);
        ldr_records_clear();
        for (s = 0; s < 0x1000u; s++)
            erased &= whole[FC_BASE + 5u * 0x1000u + s] == 0xFFu;
        for (s = 0; s < len; s++)
            if (s / 0x1000u != 5u)
                rest &= whole[FC_BASE + s] == img[s];
        check("  a region sector whose last 256 bytes look like a record is erased, and only that one", erased && rest);
        memcpy(host_fr_flash, whole + FC_BASE, HOST_FR_SIZE);
        fc_scan();
        check("  the firmware then finds the content damaged and plays the firmware tier alone", fc_state == FC_DAMAGED && !fc_region);
    }
    printf(fails ? "factory region: %d FAILED\n" : "factory region: all passed\n", fails);
    return fails ? 1 : 0;
}
