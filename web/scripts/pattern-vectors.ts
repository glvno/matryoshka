// SPDX-License-Identifier: GPL-3.0-only
// Cross-language vectors for the pattern store's payload (#901, src/pattern-store.ts): a few patches and, for one pattern
// of each, the payload the editor writes and the patch's layout fingerprint. export-defs.ts writes them to
// firmware/test/pattern_cases.h; the firmware's host test loads each patch in the C engine, writes the payload for that
// pattern and compares bytes and layout, then loads the payload back into a fresh load and writes it again.
import { reconcileAll } from '../src/assembly';
import { DEMO_SET_PATCHES, applyDemoSet, demoSetHash, demoSetRecord } from '../src/demo-sets';
import { DEFS } from '../src/modules';
import { addModule, connect, emptyPatch, removeModule, type ModuleInst, type Patch } from '../src/patch';
import { encodePatch } from '../src/patchbin';
import { encodePayload, layoutOf } from '../src/pattern-store';
import { clearAllPatterns, copyPattern, nextEmptyPattern } from '../src/pattern-ops';
import { demoSetFor, factoryWithDemoSet, FM1_PRESETS } from '../src/presets';
import { deviceView } from '../src/poly';
import type { StepNote } from '../src/track';

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
  return out;
}

/** the pattern commands (#1177, #1178) on a case's patch as the editor runs them: its pattern copied to the first empty
 *  number after it and selected, and everything cleared */
export function patternOps(c: PatternCase): { to: number; copied: Patch; cleared: Patch } {
  const copied = structuredClone(c.patch), cleared = structuredClone(c.patch);
  const to = nextEmptyPattern(copied, c.pattern);
  copyPattern(copied, c.pattern, to);
  const main = copied.modules.find((m) => m.type === 'fm1')!;
  main.seq = { ...(main.seq ?? {}), pattern: to };
  clearAllPatterns(cleared);
  return { to, copied, cleared };
}

/** a patch as the FM-1 gets it (export-defs.ts's factory binaries) */
const fm1Bin = (p: Patch): Uint8Array => encodePatch(p, true, 0, 1);
/** the demo set loaded as the editor loads it (#1179), its binary; undefined when the patch has none */
function editorDemo(p: Patch): Uint8Array | undefined {
  const set = demoSetFor(p);
  if (!set) return undefined;
  const q = structuredClone(p);
  applyDemoSet(q, set);
  return fm1Bin(q);
}

/** the demo-set cases (#1179): each patch with a demo set as it ships, then copies of the 808 Kit renamed, with a parameter
 *  changed (both find the set), with a module more and with one less (neither does); for each the binary after the editor
 *  loads its demo set (none: no set), and the set's hash */
export function demoCases(): { name: string; patch: Uint8Array; loaded?: Uint8Array; hash: number }[] {
  const hash = new Map(DEMO_SET_PATCHES.map((n) => [n, demoSetHash(demoSetRecord(factoryWithDemoSet(n)))]));
  const kit = (): Patch => FM1_PRESETS['808 Kit']();
  const renamed = kit(), edited = kit(), more = kit(), less = kit();
  renamed.name = 'MY KIT';
  const out = edited.modules.find((m) => m.type === 'output')!;
  out.params.level = out.params.level === 0.5 ? 0.25 : 0.5;
  {   // (a Bitcrusher before the Output: a module the FM-1 runs; one with no cables it leaves out)
    const output = more.modules.find((m) => m.type === 'output')!, into = more.cables.find((c) => c.to.module === output.id)!;
    const crush = addModule(more, DEFS.crush, 0, 0);
    more.cables = more.cables.filter((c) => c !== into);
    connect(more, DEFS, into.from, { module: crush.id, port: 'in' });
    connect(more, DEFS, { module: crush.id, port: 'out' }, into.to);
  }
  removeModule(less, less.modules.find((m) => m.type === 'steps')!.id);
  reconcileAll(less, DEFS);   // (DRUMS is a member of the kit card, K2)
  return [...DEMO_SET_PATCHES.map((n) => ({ name: n, p: FM1_PRESETS[n]() })), { name: 'MY KIT', p: renamed }, { name: '808 PARAM', p: edited },
    { name: '808 MODULE MORE', p: more }, { name: '808 MODULE LESS', p: less }].map(({ name, p }) => {
    const set = demoSetFor(p);
    return { name, patch: fm1Bin(p), loaded: editorDemo(p), hash: set ? hash.get(set.name)! : 0 };
  });
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
  const ops = cases.map((c, i) => {
    const { to, copied, cleared } = patternOps(c);
    const a = encodePatch(copied, true), b = encodePatch(cleared, true);
    L.push(`static const uint8_t PTC_COPIED_${i}[${a.length}] = {${a.join(',')}};`);
    L.push(`static const uint8_t PTC_CLEARED_${i}[${b.length}] = {${b.join(',')}};`);
    return `    {${c.pattern}, ${to}, PTC_COPIED_${i}, ${a.length}, PTC_CLEARED_${i}, ${b.length}},`;
  });
  L.push('static const struct { uint32_t from, to; const uint8_t *copied; uint32_t copied_len; const uint8_t *cleared; uint32_t cleared_len; } PATTERN_OPS[N_PATTERN_CASES] = {');
  L.push(...ops, '};', '');
  // the demo sets (#1179): the FM-1 loading one (patlink.c pl_demo_set, from the factory region) must give the binary the
  // editor gives (firmware/test/patlink_test.c demo_sets)
  const demo = demoCases().map((c, i) => {
    L.push(`static const uint8_t PTC_DEMO_${i}[${c.patch.length}] = {${c.patch.join(',')}};`);
    if (c.loaded) L.push(`static const uint8_t PTC_DEMO_LOADED_${i}[${c.loaded.length}] = {${c.loaded.join(',')}};`);
    return `    {"${c.name}", PTC_DEMO_${i}, ${c.patch.length}, ${c.loaded ? `PTC_DEMO_LOADED_${i}` : '0'}, ${c.loaded?.length ?? 0}, 0x${c.hash.toString(16).padStart(8, '0')}u},`;
  });
  L.push(`#define N_DEMO_CASES ${demo.length}`);
  L.push('static const struct { const char *name; const uint8_t *patch; uint32_t patch_len; const uint8_t *loaded; uint32_t loaded_len; uint32_t hash; } DEMO_CASES[N_DEMO_CASES] = {');
  L.push(...demo, '};', '');
  return L.join('\n');
}
