import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releasedFactoryHas } from '../scripts/released-factory-names';

const parse = (src: string): { name: string; bytes: number[] }[] => {
  const data = new Map<string, number[]>();
  for (const m of src.matchAll(/static const uint8_t (PRESET_\d+)\[\d+\] = \{([^}]*)\}/g)) data.set(m[1], m[2].split(',').map(Number));
  return [...src.matchAll(/\{"([^"]*)", (PRESET_\d+),/g)].map((m) => ({ name: m[1], bytes: data.get(m[2])! }));
};
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
  it('keeps old factory and user bytes, adds only new names, and still initializes an empty store', () => {
    // Compile the real boot coordinator and bank_add against an in-memory store. The saved factory has the
    // same name as today's factory, but different valid patch bytes; byte equality must not trigger replacement.
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
    const source = `
#include <assert.h>
#include <stdint.h>
#include <string.h>
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
static const struct { const char *name; const uint8_t *data; uint32_t len; } PRESET_LIST[] = {
 {"INIT", new_patch, sizeof new_patch}, {"NEW FACTORY", new_patch, sizeof new_patch}
};
static const struct { uint32_t set; uint64_t has; } RELEASED_SETS[] = {{1u, 1u}};
${planner}
typedef struct { char name[M1_NAME]; } sl_hdr_t;
static struct { sl_hdr_t h; uint8_t data[65536]; uint32_t len; } slots[M1_SLOTS];
static uint64_t bank_mask;
static uint8_t bank_fmt;
static uint32_t bank_set, cur_preset, sel;
static int boot_safe, flash_ok = 1, boot_msg_ms, migrations, factories, fallbacks, settings_writes, loads;
static uint8_t sl_sec[5];
static const char *boot_msg;
static int slot_used(uint32_t s) { return s < M1_SLOTS && (bank_mask & ((uint64_t)1 << s)); }
static int sl_head(uint32_t s, sl_hdr_t *h, int unused) { (void)unused; *h = slots[s].h; return 0; }
static int store_write(uint32_t s, const char *name, const uint8_t *data, uint32_t len) {
 if (s == SL_SETTINGS) { settings_writes++; return 0; }
 assert(s < M1_SLOTS && len <= sizeof slots[s].data);
 memcpy(slots[s].h.name, name, M1_NAME); memcpy(slots[s].data, data, len); slots[s].len = len;
 bank_mask |= (uint64_t)1 << s; return 0;
}
static void fm1_wdt_feed(void) {}
static void boot_step(const char *s) { (void)s; }
${fn('int bank_add(')}
static void gt_apply(void) {}
static void fallback_boot(void) { fallbacks++; }
static void sl_scan(void) {}
static int sl_read(uint32_t s, uint8_t *data, uint32_t *len, char *name) {
 (void)s; (void)data; (void)name; *len = SET_LEN; return 0;
}
static int settings_unpack(uint8_t *data, uint32_t len, uint32_t *slot, uint32_t *module) {
 (void)data; (void)len; *slot = 0; *module = 0; return 0;
}
static void settings_pack(uint8_t *data) { (void)data; }
static uint32_t presets_upgrade(void) { migrations++; return 1; }
static void factory_bank(void) { factories++; bank_mask = 1; }
static void leds_avail(void) {}
static void leds_octave(void) {}
static int preset_load(uint32_t s) { assert(slot_used(s)); loads++; return 0; }
static int eng_nmodules(void) { return 1; }
${fn('void patch_boot(')}
int main(void) {
 char factory_name[M1_NAME] = "INIT", user_name[M1_NAME] = "USER PATCH";
 uint8_t user_patch[sizeof new_patch];
 memcpy(user_patch, new_patch, sizeof user_patch);
 store_write(0, factory_name, old_patch, sizeof old_patch);
 store_write(1, user_name, user_patch, sizeof user_patch);
 bank_set = 1; bank_fmt = ENG_PATCH_VERSION - 1;
 patch_boot();
 assert(slots[0].len == sizeof old_patch && !memcmp(slots[0].data, old_patch, sizeof old_patch));
 assert(!strcmp(slots[0].h.name, "INIT"));
 assert(slots[1].len == sizeof user_patch && !memcmp(slots[1].data, user_patch, sizeof user_patch));
 assert(!strcmp(slots[1].h.name, "USER PATCH"));
 assert(!strcmp(slots[2].h.name, "NEW FACTORY") && slots[2].len == sizeof new_patch);
 assert(bank_mask == 7 && bank_set == FACTORY_SET_ID && bank_fmt == ENG_PATCH_VERSION);
 assert(migrations == 1 && settings_writes == 1 && loads == 1 && !factories && !fallbacks);
 patch_boot();
 assert(migrations == 1 && settings_writes == 1 && bank_mask == 7);
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
      execFileSync(process.env.CC ?? 'cc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-x', 'c', '-', '-o', binary], { input: source, stdio: ['pipe', 'pipe', 'pipe'] });
      expect(() => execFileSync(binary)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// RELEASED_SETS retains old name membership for bank_add, without changing saved slot names or bytes.
describe('released factory sets (a new factory patch after an update)', () => {
  it.each(['HERA 6', 'HERA 5', 'HERA 4'])('treats %s as the same released lineage when Hera 3 becomes the default', predecessor => {
    const savedNames = [predecessor, 'ORACLE V'];
    expect(['HERA 3', 'ORACLE V', 'VERONA DRUM 1'].filter(name => !releasedFactoryHas(savedNames, name))).toEqual(['VERONA DRUM 1']);
    expect(savedNames).toEqual([predecessor, 'ORACLE V']);
    expect(releasedFactoryHas(['HERA 3'], 'HERA 4')).toBe(true);
    expect(releasedFactoryHas(['HERA 3'], 'EXPANDER S')).toBe(false);
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
