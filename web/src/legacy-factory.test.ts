import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releasedFactoryHas } from '../scripts/released-factory-names';
import { lzPack, presetsHPatches as parse } from '../scripts/factory-lz';
import { crc32, fnv32 } from '../scripts/factory-region';

const now = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
const names = parse(now).map((p) => p.name);
const show = (rev: string): string => {
  try {
    return execFileSync('git', ['show', `${rev}:firmware/src/presets.h`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch {
    return ''; // A shallow checkout may not have the historical commit.
  }
};

describe('saved bank after a firmware update', () => {
  it('gives an untouched released copy today\'s patch, keeps user and renamed bytes, adds only new names, and still initializes an empty store', () => {
    // Compile the real boot coordinator, bank_upgrade and bank_add against an in-memory store. Slot 0 holds a released
    // copy of INIT (its fingerprint is a released copy of today's INIT): it gets today's bytes. The same bytes under
    // another name, and today's bytes under the owner's name, stay (D-887 amended 2026-11-19).
    const main = readFileSync(new URL('../../firmware/src/main.c', import.meta.url), 'utf8');
    const fn = (name: string): string => {
      const start = main.indexOf(`static ${name}`);
      if (start < 0) throw new Error(`Missing firmware function: ${name}`);
      const end = main.indexOf('\n}', start);
      if (end < 0) throw new Error(`Missing firmware function end: ${name}`);
      return main.slice(start, end + 2);
    };
    const patches = parse(now);
    const saved = parse(show('v1.1.0'))[0]?.bytes ?? patches[0].bytes;
    const current = patches.find((p) => p.bytes.join(',') !== saved.join(','))!.bytes;
    const planner = readFileSync(new URL('../../firmware/src/bank_new.h', import.meta.url), 'utf8');
    const upgrader = readFileSync(new URL('../../firmware/src/bank_upgrade.h', import.meta.url), 'utf8');
    const source = `
#include <assert.h>
#include <stdint.h>
#include <string.h>
#include "lz_unpack.h"
#define M1_NAME 16
#define M1_SLOTS 4
#define N_PRESETS 2
#define N_RELEASED_SETS 1
#define FACTORY_SET_ID 2u
#define ENG_PATCH_VERSION 55u
#define SL_SETTINGS 4
#define SL_NONE 255
#define SET_LEN 16
static const uint8_t old_patch[] = {${saved.join(',')}};
static const uint8_t new_patch[] = {${current.join(',')}};
static const uint8_t new_lz[] = {${lzPack(current).join(',')}};
static const struct { const char *name; const uint8_t *lz; uint16_t lz_len, len; } PRESET_LIST[] = {
 {"INIT", new_lz, sizeof new_lz, sizeof new_patch}, {"NEW FACTORY", new_lz, sizeof new_lz, sizeof new_patch}
};
static uint8_t bank_buf[3840];
static const struct { uint32_t set; uint64_t has; } RELEASED_SETS[] = {{1u, 1u}};
/* factory.c as main.c and bank_new.h use it (#915): the two patches above, a valid factory region, today's set */
#define FC_PATCHES 64u
#define FC_TIER_SET 0xFFFFFFu
static uint8_t fc_region = 1;
static const char *boot_msg_then;
static uint32_t fc_fnv32(uint32_t h, const uint8_t *p, uint32_t n) { while (n--) h = (h ^ *p++) * 0x01000193u; return h; }
static uint32_t fc_crc32(uint32_t c, const uint8_t *p, uint32_t n) {
 uint32_t k;
 while (n--) { c ^= *p++; for (k = 0; k < 8u; k++) c = c & 1u ? (c >> 1) ^ 0xEDB88320u : c >> 1; }
 return c;
}
/* one released copy: INIT as old_patch (length, FNV-1a and CRC-32 as export-defs writes them) */
static uint32_t fc_ncopies(void) { return 1; }
static int fc_copy(uint32_t k, uint32_t *len, uint32_t *fnv, uint32_t *crc) {
 if (k) return -1;
 *len = sizeof old_patch; *fnv = ${fnv32(saved)}u; *crc = ${crc32(saved)}u;
 return 0;
}
static void fc_scan(void) {}
static uint32_t fc_set(void) { return FACTORY_SET_ID; }
static uint32_t fc_npatches(void) { return N_PRESETS; }
static int fc_patch_info(uint32_t i, char *name, uint32_t *len, uint32_t *slot) {
 uint32_t k;
 if (i >= N_PRESETS) return -1;
 for (k = 0; k < M1_NAME; k++) name[k] = k < strlen(PRESET_LIST[i].name) ? PRESET_LIST[i].name[k] : 0;
 if (len) *len = PRESET_LIST[i].len;
 if (slot) *slot = i;
 return 0;
}
static int32_t fc_patch(uint32_t i, uint8_t *buf, uint32_t cap) { return i < N_PRESETS ? lz_unpack(PRESET_LIST[i].lz, PRESET_LIST[i].lz_len, buf, cap) : -1; }
static int fc_released(uint32_t set, uint64_t *has, uint64_t *any) {
 *any = RELEASED_SETS[0].has;
 *has = set == RELEASED_SETS[0].set ? RELEASED_SETS[0].has : *any;
 return set == RELEASED_SETS[0].set;
}
${planner}
typedef struct { char name[M1_NAME]; uint32_t len; } sl_hdr_t;
static struct { sl_hdr_t h; uint8_t data[65536]; uint32_t len; } slots[M1_SLOTS];
static uint8_t sl_buf[65536];
static uint64_t bank_mask;
static uint8_t bank_fmt;
static uint32_t bank_set, cur_preset, sel;
static int boot_safe, flash_ok = 1, boot_msg_ms, migrations, factories, fallbacks, settings_writes, loads;
static uint8_t sl_sec[5];
static const char *boot_msg;
static uint8_t font_ok = 1;              /* (font_area.c: the screen font is there, #602) */
static void fa_scan(void) {}
static uint32_t bank_slots = M1_SLOTS;   /* (slotstore.c's: the slots there are, #901) */
static int slot_used(uint32_t s) { return s < bank_slots && (bank_mask & ((uint64_t)1 << s)); }
static int sl_head(uint32_t s, sl_hdr_t *h, int check) {
 *h = slots[s].h;
 if (check) memcpy(sl_buf, slots[s].data, slots[s].len);
 return 0;
}
static int store_write(uint32_t s, const char *name, const uint8_t *data, uint32_t len) {
 if (s == SL_SETTINGS) { settings_writes++; return 0; }
 assert(s < M1_SLOTS && len <= sizeof slots[s].data);
 memcpy(slots[s].h.name, name, M1_NAME); memcpy(slots[s].data, data, len); slots[s].len = slots[s].h.len = len;
 bank_mask |= (uint64_t)1 << s; return 0;
}
static int sl_write(uint32_t s, const char *name, const uint8_t *data, uint32_t len) { return store_write(s, name, data, len); }
static void fm1_wdt_feed(void) {}
static void boot_step(const char *s) { (void)s; }
${fn('void factory_write(')}
${fn('int bank_add(')}
${upgrader}
${fn('uint64_t bank_upgrade(')}
static void gt_apply(void) {}
static void fallback_boot(void) { fallbacks++; }
static void sl_scan(void) {}
static void pt_claim(void) {}            /* (the pattern store's claim, slotstore.c: nothing to move here) */
static void settings_ext_load(void) {}   /* (the settings record's extension, main.c settings_ext.h: the master EQ, none here) */
static int sl_read(uint32_t s, uint8_t *data, uint32_t *len, char *name) {
 (void)s; (void)data; (void)name; *len = SET_LEN; return 0;
}
static int settings_unpack(uint8_t *data, uint32_t len, uint32_t *slot, uint32_t *module) {
 (void)data; (void)len; *slot = 0; *module = 0; return 0;
}
static uint32_t presets_upgrade(void) { migrations++; return 1; }
static void factory_bank(void) { factories++; bank_mask = 1; }
static void leds_avail(void) {}
static void leds_octave(void) {}
static int preset_load(uint32_t s) { assert(slot_used(s)); loads++; return 0; }
static int eng_nmodules(void) { return 1; }
static void settings_store(void) { settings_writes++; }
${fn('const char *factory_sync(')}
${fn('void patch_boot(')}
int main(void) {
 char factory_name[M1_NAME] = "INIT", user_name[M1_NAME] = "USER PATCH", renamed[M1_NAME] = "OLD COPY";
 uint8_t user_patch[sizeof new_patch];
 memcpy(user_patch, new_patch, sizeof user_patch);
 store_write(0, factory_name, old_patch, sizeof old_patch);
 store_write(1, user_name, user_patch, sizeof user_patch);
 store_write(2, renamed, old_patch, sizeof old_patch);
 bank_set = 1; bank_fmt = ENG_PATCH_VERSION - 1;
 patch_boot();
 assert(slots[0].len == sizeof new_patch && !memcmp(slots[0].data, new_patch, sizeof new_patch));
 assert(!strcmp(slots[0].h.name, "INIT"));
 assert(slots[1].len == sizeof user_patch && !memcmp(slots[1].data, user_patch, sizeof user_patch));
 assert(!strcmp(slots[1].h.name, "USER PATCH"));
 assert(slots[2].len == sizeof old_patch && !memcmp(slots[2].data, old_patch, sizeof old_patch));
 assert(!strcmp(slots[2].h.name, "OLD COPY"));
 assert(!strcmp(slots[3].h.name, "NEW FACTORY") && slots[3].len == sizeof new_patch && !memcmp(slots[3].data, new_patch, sizeof new_patch));
 assert(bank_mask == 15 && bank_set == FACTORY_SET_ID && bank_fmt == ENG_PATCH_VERSION);
 assert(boot_msg && !strcmp(boot_msg_then, "FACTORY PATCHES UPDATED"));
 assert(migrations == 1 && settings_writes == 1 && loads == 1 && !factories && !fallbacks);
 patch_boot();
 assert(migrations == 1 && settings_writes == 1 && bank_mask == 15);
 bank_mask = 0; sl_sec[SL_SETTINGS] = SL_NONE;
 /* Empty store, including after explicit reset, still takes the factory initializer. */
 patch_boot();
 assert(factories == 1 && loads == 3);
 return 0;
}
`;
    const dir = mkdtempSync(join(tmpdir(), 'fm1-bank-boot-'));
    try {
      const binary = join(dir, 'boot-test');
      execFileSync(process.env.CC ?? 'cc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-I', new URL('../../firmware/src', import.meta.url).pathname, '-x', 'c', '-', '-o', binary], { input: source, stdio: ['pipe', 'pipe', 'pipe'] });
      expect(() => execFileSync(binary)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// RELEASED_SETS retains old name membership for bank_add, without changing saved slot names or bytes.
describe('released factory sets (a new factory patch after an update)', () => {
  it.each(['HERA 3', 'HERA 5', 'HERA 4'])('treats %s as the same released lineage when Hera 6 becomes the default', predecessor => {
    const savedNames = [predecessor, 'ORACLE V'];
    expect(['HERA 6', 'ORACLE V', 'VERONA DRUM 1'].filter(name => !releasedFactoryHas(savedNames, name))).toEqual(['VERONA DRUM 1']);
    expect(savedNames).toEqual([predecessor, 'ORACLE V']);
    expect(releasedFactoryHas(['HERA 6'], 'HERA 4')).toBe(true);
    expect(releasedFactoryHas(['HERA 6'], 'EXPANDER S')).toBe(false);
  });
  const rows = [...now.matchAll(/\{0x([0-9a-f]{6})u, 0x([0-9a-f]+)ull\}/g)].map((m) => ({ set: parseInt(m[1], 16), has: BigInt('0x' + m[2]) }));
  const tags = (() => {
    try {
      return execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  })();
  it.skipIf(!tags.includes('v1.9.1'))('every release tag\'s factory set is listed with the names it had', () => {
    for (const t of tags) {
      const src = show(t);
      if (!src) continue;
      const set = parseInt(src.match(/#define FACTORY_SET_ID 0x([0-9a-f]+)u/)?.[1] ?? '0', 16);
      const row = rows.find((r) => r.set === set);
      expect(row, t).toBeDefined();
      const had = new Set(parse(src).map((p) => p.name));
      names.forEach((n, i) => { if (had.has(n)) expect((row!.has >> BigInt(i)) & 1n, `${t} ${n}`).toBe(1n); });
    }
  });
});
