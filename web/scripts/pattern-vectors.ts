// SPDX-License-Identifier: GPL-3.0-only
// Cross-language vectors for the pattern store's payload (#901, src/pattern-store.ts): a few patches and, for one pattern
// of each, the payload the editor writes and the patch's layout fingerprint. export-defs.ts writes them to
// firmware/test/pattern_cases.h; the firmware's host test loads each patch in the C engine, writes the payload for that
// pattern and compares bytes and layout, then loads the payload back into a fresh load and writes it again.
import { DEFS } from '../src/modules';
import { addModule, connect, emptyPatch, type ModuleInst, type Patch } from '../src/patch';
import { encodePatch } from '../src/patchbin';
import { encodePayload, layoutOf } from '../src/pattern-store';
import { clearAllPatterns, copyPattern, doublePattern, halvePattern, nextEmptyPattern, type ResizeRefusal } from '../src/pattern-ops';
import { buildFactoryBank, selectedFactoryProfile, UNSHIPPED_PATTERNS } from '../src/factory-bank';
import { factoryWithPatterns } from '../src/presets';
import { deviceView } from '../src/poly';
import { condAB, type StepNote } from '../src/track';

const n = (at: number, len: number, note: number, vel = 100, chance?: number): StepNote => ({ at, len, note, vel, ...(chance ? { chance } : {}) });

/** Main, an output, `tracks` Steps tracks (each into the output) and a Constant (a lock target), named `name` */
function rig(name: string, tracks: number): { p: Patch; st: ModuleInst[]; k: ModuleInst } {
  const p = emptyPatch(name);
  addModule(p, DEFS.fm1, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  const st = Array.from({ length: tracks }, (_, i) => {
    const m = addModule(p, DEFS.steps, 0, 0);
    m.params.len = 16;
    connect(p, DEFS, { module: m.id, port: 'pitch' }, { module: out.id, port: i % 2 ? 'r' : 'l' });
    return m;
  });
  const k = addModule(p, DEFS.const, 0, 0);
  connect(p, DEFS, { module: k.id, port: 'out' }, { module: out.id, port: 'l' });
  return { p, st, k };
}

export interface PatternCase { name: string; patch: Patch; pattern: number }

/** the cases: short words and an absent track, long words with an own length and rate, pattern 1, a first track without
 * the pattern, and P-locks (on pattern 1 and on pattern 2) */
export function patternCases(): PatternCase[] {
  const out: PatternCase[] = [];
  {
    const { p, st } = rig('SHORT WORDS', 2);
    st[0].notes = [n(0, 1, 36), n(4, 1, 38, 127)];
    st[0].patterns = [{ notes: [n(0, 2, 36), n(2, 1, 42, 127), n(8, 4, 40), n(15, 16, 45)] }];
    st[1].notes = [n(0, 1, 50)];
    out.push({ name: 'SHORT WORDS', patch: p, pattern: 1 });
  }
  {
    const { p, st } = rig('LONG WORDS', 2);
    st[0].patterns = [null, { notes: [n(0, 1, 60, 90), n(3, 2, 64, 100, 50), n(17, 3, 67, 127), n(20, 20, 72)], len: 24, rate: 5 }];
    st[1].patterns = [{ notes: [n(0, 1, 48)] }, { notes: [n(1, 1, 49), n(9, 1, 51, 127)], len: 12 }];
    out.push({ name: 'LONG WORDS', patch: p, pattern: 2 });
  }
  {
    const { p, st } = rig('PATTERN ONE', 3);
    st[0].notes = [n(0, 1, 36), n(2, 1, 36, 127), n(4, 64, 40)];
    st[0].notes[2].wrap = true;
    st[2].notes = [n(1, 1, 70, 64), n(3, 2, 72)];
    st[1].patterns = [{ notes: [n(0, 1, 50)] }];
    out.push({ name: 'PATTERN ONE', patch: p, pattern: 0 });
  }
  {
    const { p, st } = rig('FIRST ABSENT', 3);
    st[1].patterns = [{ notes: [], len: 8 }];
    st[2].patterns = [{ notes: [n(5, 1, 62)], rate: 2 }];
    out.push({ name: 'FIRST ABSENT', patch: p, pattern: 1 });
  }
  for (const pattern of [0, 1]) {
    const { p, st, k } = rig(pattern ? 'LOCKS P2' : 'LOCKS P1', 2);
    st[0].notes = [0, 1, 2, 3].map((at) => n(at, 1, 60));
    st[0].locks = [{ at: 1, module: k.id, param: 'value', value: 0.25 }, { at: 3, module: k.id, param: 'value', value: -0.5 }];
    st[1].patterns = [{ notes: [n(0, 1, 40), n(7, 1, 43)], locks: [{ at: 0, module: k.id, param: 'value', value: 0.75 }, { at: 7, module: k.id, param: 'value', value: 1 }] }];
    st[0].patterns = [{ notes: [n(2, 1, 61)], locks: [{ at: 2, module: k.id, param: 'value', value: 0.125 }] }];
    out.push({ name: pattern ? 'LOCKS P2' : 'LOCKS P1', patch: p, pattern });
  }
  {   // (for the pattern commands: songs, a link, a pattern origin and the selected pattern, which clear all clears)
    const { p, st, k } = rig('SONGS LINKS', 2);
    st[0].notes = [n(0, 1, 36), n(8, 1, 38)];
    st[0].factoryPatterns = { version: 1, ids: ['0000abcd'] };
    st[0].patterns = [{ notes: [n(4, 1, 40)], locks: [{ at: 4, module: k.id, param: 'value', value: 0.5 }] }, null, { notes: [n(1, 1, 43)], len: 7 }];
    st[1].patterns = [{ notes: [n(0, 1, 50), n(3, 1, 52, 127)], rate: 3 }];
    p.modules.find((m) => m.type === 'fm1')!.seq = { pattern: 1, songs: [[{ pat: 0, shift: 0 }, { pat: 1, shift: 2 }], [], [{ pat: 3, shift: -1 }]], links: { 3: { id: 7, hash: 1 } } };
    out.push({ name: 'SONGS LINKS', patch: p, pattern: 1 });
  }
  {   // (for the double, D-838: every note attribute and P-locks on an own length of 12, a track on the track's length with a
      // drone, and a track of 8 steps without pattern 2, which gets it from its pattern 1; notes and a lock past the length)
    const { p, st, k } = rig('DOUBLE ALL', 3);
    st[0].patterns = [{ len: 12, notes: [n(0, 1, 36, 100, 50), { at: 2, len: 3, note: 40, vel: 90, cond: condAB(1, 2) }, { at: 4, len: 1, note: 42, vel: 100, ratchet: 3, micro: 5 },
      { at: 6, len: 1, note: 44, vel: 127, micro: -4 }, { at: 9, len: 5, note: 49, vel: 100, wrap: true }, n(10, 6, 47), n(14, 1, 50), n(30, 1, 51)],
    locks: [{ at: 0, module: k.id, param: 'value', value: 0.25 }, { at: 10, module: k.id, param: 'value', value: -0.5 }, { at: 13, module: k.id, param: 'value', value: 0.75 }] }];
    st[1].notes = [n(2, 1, 30)];
    st[1].patterns = [{ notes: [n(0, 1, 48), { at: 3, len: 64, note: 55, vel: 100, wrap: true }, n(8, 2, 50, 127)] }];
    st[2].params.len = 8;
    st[2].notes = [n(1, 1, 60), n(5, 1, 62, 127)];
    st[2].locks = [{ at: 5, module: k.id, param: 'value', value: 1 }];
    out.push({ name: 'DOUBLE ALL', patch: p, pattern: 1 });
  }
  {   // (the double of pattern 1: the track's length doubles, pattern 2 on the track's length keeps it as its own, pattern 3's
      // own stays; a track of 32 steps to 64 with a note tied across the loop point)
    const { p, st, k } = rig('DOUBLE ONE', 2);
    st[0].notes = [n(0, 1, 36), n(12, 8, 40)];
    st[0].locks = [{ at: 3, module: k.id, param: 'value', value: 0.5 }];
    st[0].patterns = [{ notes: [n(0, 1, 37)] }, { notes: [n(1, 1, 38)], len: 10 }];
    st[1].params.len = 32;
    st[1].notes = [n(20, 1, 45), { at: 31, len: 4, note: 47, vel: 100, wrap: true }];
    out.push({ name: 'DOUBLE ONE', patch: p, pattern: 0 });
  }
  {   // (for the halve, D-841: an own length of 15 to 7 with a rate, a note across the new end, notes and a lock past it; a
      // track without pattern 2, which gets a copy of its pattern 1 with its P-locks; a pattern on the track's odd length)
    const { p, st, k } = rig('HALVE ODD', 3);
    st[0].patterns = [{ len: 15, rate: 3, notes: [n(0, 1, 36), n(5, 4, 40), n(9, 1, 42, 127), n(14, 1, 44)],
      locks: [{ at: 2, module: k.id, param: 'value', value: 0.25 }, { at: 10, module: k.id, param: 'value', value: -0.5 }] }];
    st[1].notes = [n(1, 1, 30), n(11, 2, 33)];
    st[1].locks = [{ at: 11, module: k.id, param: 'value', value: 1 }];
    st[2].params.len = 9;
    st[2].patterns = [{ notes: [n(0, 1, 60), n(8, 1, 62)] }];
    out.push({ name: 'HALVE ODD', patch: p, pattern: 1 });
  }
  return out;
}

/** the pattern commands (#1177, #1178, D-838, D-841) on a case's patch as the editor runs them: its pattern copied to the
 *  first empty number after it and selected, everything cleared, and its pattern doubled and halved (`refused`, `halveRefused`:
 *  why not) */
export function patternOps(c: PatternCase): { to: number; copied: Patch; cleared: Patch; doubled: Patch; refused?: ResizeRefusal; halved: Patch; halveRefused?: ResizeRefusal } {
  const copied = structuredClone(c.patch), cleared = structuredClone(c.patch), doubled = structuredClone(c.patch), halved = structuredClone(c.patch);
  const to = nextEmptyPattern(copied, c.pattern);
  copyPattern(copied, c.pattern, to);
  const main = copied.modules.find((m) => m.type === 'fm1')!;
  main.seq = { ...(main.seq ?? {}), pattern: to };
  clearAllPatterns(cleared);
  const r = doublePattern(doubled, c.pattern), h = halvePattern(halved, c.pattern);
  return { to, copied, cleared, doubled, ...('refused' in r ? { refused: r.refused } : {}), halved, ...('refused' in h ? { halveRefused: h.refused } : {}) };
}

/** the cases as a C header for the firmware's host test (the layout is the patch's fingerprint, whether or not the
 * payload carries it) */
export function patternCasesHeader(cases: PatternCase[] = patternCases()): string {
  const L = ['/* SPDX-License-Identifier: GPL-3.0-only */', '/* Generated by web/scripts/export-defs.ts (pattern-vectors.ts). Do not edit. Patches and, for one pattern of each, the', '   stored pattern payload the editor writes (web/src/pattern-store.ts, #901) and the patch\'s layout fingerprint: the FM-1', '   must write the same bytes and fingerprint, and read the payload back into the same pattern. */', '#pragma once', '#include <stdint.h>', ''];
  const rows = cases.map((c, i) => {
    const patch = encodePatch(c.patch, true), dev = deviceView(c.patch, true).patch;
    const payload = encodePayload(c.patch, c.pattern, dev);
    L.push(`static const uint8_t PTC_PATCH_${i}[${patch.length}] = {${patch.join(',')}};`);
    L.push(`static const uint8_t PTC_PAYLOAD_${i}[${payload.length}] = {${payload.join(',')}};`);
    return `    {"${c.name}", PTC_PATCH_${i}, ${patch.length}, ${c.pattern}, PTC_PAYLOAD_${i}, ${payload.length}, 0x${layoutOf(dev).toString(16).padStart(8, '0')}u},`;
  });
  L.push(`#define N_PATTERN_CASES ${cases.length}`);
  L.push('static const struct { const char *name; const uint8_t *patch; uint32_t patch_len; uint32_t pattern; const uint8_t *payload; uint32_t payload_len; uint32_t layout; } PATTERN_CASES[N_PATTERN_CASES] = {');
  L.push(...rows, '};', '');
  // the pattern commands as the editor runs them (pattern-ops.ts): the FM-1 running them on the same patch must hold the
  // same patterns, songs, P-locks, links and origins (firmware/test/patlink_test.c ops)
  const rcOf = (why?: ResizeRefusal): number => (why ? -1 - ['steps', 'notes', 'locks'].indexOf(why) : 0);
  const ops = cases.map((c, i) => {
    const { to, copied, cleared, doubled, refused, halved, halveRefused } = patternOps(c);
    const a = encodePatch(copied, true), b = encodePatch(cleared, true), d = encodePatch(doubled, true), h = encodePatch(halved, true);
    L.push(`static const uint8_t PTC_COPIED_${i}[${a.length}] = {${a.join(',')}};`);
    L.push(`static const uint8_t PTC_CLEARED_${i}[${b.length}] = {${b.join(',')}};`);
    L.push(`static const uint8_t PTC_DOUBLED_${i}[${d.length}] = {${d.join(',')}};`);
    L.push(`static const uint8_t PTC_HALVED_${i}[${h.length}] = {${h.join(',')}};`);
    return `    {${c.pattern}, ${to}, PTC_COPIED_${i}, ${a.length}, PTC_CLEARED_${i}, ${b.length}, PTC_DOUBLED_${i}, ${d.length}, ${rcOf(refused)}, PTC_HALVED_${i}, ${h.length}, ${rcOf(halveRefused)}},`;
  });
  L.push('static const struct { uint32_t from, to; const uint8_t *copied; uint32_t copied_len; const uint8_t *cleared; uint32_t cleared_len; const uint8_t *doubled; uint32_t doubled_len; int doubled_rc; const uint8_t *halved; uint32_t halved_len; int halved_rc; } PATTERN_OPS[N_PATTERN_CASES] = {');
  L.push(...ops, '};', '');
  // the factory patches of UNSHIPPED_PATTERNS with the patterns and songs they shipped with up to 1.24.1, as the FM-1 gets
  // them from the editor (test material: firmware tests that play their patterns); a kit given an FX drawer since (the 909
  // Kit, D-1055) as 1.25 saved it, without the drawer: with it and the patterns it is past the FM-1's 3,840 bytes
  const plain = buildFactoryBank();
  const patterned = UNSHIPPED_PATTERNS.map((name, i) => {
    const p = selectedFactoryProfile[name]?.drawer ? plain.find((c) => c.name === name)!.patch : factoryWithPatterns(name);
    const bin = encodePatch(p, true, 0, 1);
    L.push(`static const uint8_t PTC_PATTERNED_${i}[${bin.length}] = {${bin.join(',')}};`);
    return `    {"${name}", PTC_PATTERNED_${i}, ${bin.length}},`;
  });
  L.push(`#define N_PATTERNED_CASES ${patterned.length}`);
  L.push('static const struct { const char *name; const uint8_t *patch; uint32_t patch_len; } PATTERNED_CASES[N_PATTERNED_CASES] = {');
  L.push(...patterned, '};', '');
  return L.join('\n');
}
