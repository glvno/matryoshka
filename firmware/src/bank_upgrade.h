/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* Factory updates reach untouched slots (D-887 amended 2026-11-19). When the bank meets new factory content (main.c
 * factory_sync: the first boot after an update, or a factory region installed, whenever the factory set differs from the
 * one the bank last saw), a slot that holds, byte for byte, a copy of a factory patch a release wrote, under that patch's
 * name, gets today's patch of that name: the same slot, the same name. The images list the released copies (factory.c
 * fc_copy: each one's length, FNV-1a and CRC-32, from web/scripts/released-factory.json); a slot matches a copy when its
 * length and both checksums are the copy's. These stay as they are: a slot whose bytes differ from every released copy
 * (an edit saved), a released copy under another name (the owner renamed it, or stored it from the editor as a patch of
 * their own), and a copy of a patch the factory content no longer has. A slot already holding today's patch is not written.
 * Power safe: each slot is one sl_write (slotstore.c: the new record commits before the old one goes), so a cut leaves the
 * old patch or the new one, never a broken slot; the settings record keeps the old factory set until main.c moves it after
 * this, so the next boot finishes the rest. Bounded: each slot's header is read once; for each released copy only the slots
 * of its length and name are compared (their bytes read and checksummed), and a slot is written at most once. No RAM of its
 * own: a slot's bytes in slotstore.c's sl_buf, today's patch in the caller's buffer.
 * Needs factory.c, slotstore.c, fm1_wdt_feed. Host test: firmware/test/bank_upgrade_test.c */
#define BU_FNV0 0x811C9DC5u

/* 1 when two names (M1_NAME bytes, NUL padded) are the same */
static int bu_same(const char *a, const char *b)
{
    uint32_t k;
    for (k = 0; k < M1_NAME && a[k] && a[k] == b[k]; k++)
        ;
    return k == M1_NAME || a[k] == b[k];
}

/* 1 when n bytes at p are the released copy (fnv, crc) */
static int bu_is(const uint8_t *p, uint32_t n, uint32_t fnv, uint32_t crc)
{
    return fc_fnv32(BU_FNV0, p, n) == fnv && ~fc_crc32(0xFFFFFFFFu, p, n) == crc;
}

/* the slots given today's patch (bit s); buf: cap bytes for today's patch unpacked (main.c bank_buf) */
static uint64_t bu_run(uint8_t *buf, uint32_t cap)
{
    uint16_t len[M1_SLOTS];                     /* each used slot's length (0: empty, unreadable or done) */
    char name[M1_NAME];
    sl_hdr_t h;
    uint64_t done = 0;
    uint32_t s, k, clen, fnv, crc;
    int32_t i, n;
    for (s = 0; s < M1_SLOTS; s++)
        len[s] = (uint16_t)(s < bank_slots && (bank_mask >> s & 1u) && !sl_head(s, &h, 0) ? h.len : 0u);
    for (k = 0; k < fc_ncopies(); k++) {
        if ((i = fc_copy(k, &clen, &fnv, &crc)) < 0 || !clen || fc_patch_info((uint32_t)i, name, 0, 0))
            continue;
        for (s = 0; s < bank_slots; s++) {
            if (len[s] != clen || sl_head(s, &h, 0) || !bu_same(h.name, name))
                continue;
            fm1_wdt_feed();
            if (sl_head(s, &h, 1) || h.len != clen || !bu_is(sl_buf, clen, fnv, crc))   /* (the bytes into sl_buf) */
                continue;
            len[s] = 0;
            n = fc_patch((uint32_t)i, buf, cap);
            if (n <= 0 || ((uint32_t)n == clen && bu_is(buf, clen, fnv, crc)))   /* (today's patch is this copy) */
                continue;
            fm1_wdt_feed();
            if (!sl_write(s, h.name, buf, (uint32_t)n))
                done |= (uint64_t)1 << s;
        }
    }
    return done;
}
