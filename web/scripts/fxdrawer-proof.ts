// SPDX-License-Identifier: GPL-3.0-only
// Run from web/: npx vite-node scripts/fxdrawer-proof.ts [BASE] [--report PATH]
// The FX drawer migration is sound-identical (#1214): every factory patch (the shipped bank, firmware tier and factory
// region alike, the kits with their patterns, the relocated community patches the factory presets come from), every
// editor example and every community patch (src/community.json, opened as its share link) is rendered before and after:
//   before: git revision BASE (default origin/main, the last release with the master FX bus), its editor and its encoder,
//           its engines (engine.ts, and engine.c through its host_test);
//   after:  this tree, two ways: the patch as this tree opens it (its own factory build, examples, share decode), and the
//           BASE patch's JSON through validatePatch (convertLegacyBus: what opening a saved patch does).
// A patch with a master FX bus is rendered a second time with every stage on (`~fx`: BASE's setFxStageEnabled, after:
// every effect's switch on). Both engines get the same events: the transport running, a chord held then let go, the
// tails. Each render pair's largest absolute sample difference is written per engine to the report (default
// build/fxdrawer-proof.txt); any difference fails the run (exit 1). The FX runtime's switching itself (ramps, tails) is
// proven by engine-fx.test.ts and tools/fx_tail_test.sh.
// `--side base OUT`: the BASE half (this script, copied into BASE's tree, renders there).
import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Assembly from '../src/assembly';
// (both trees have these; resolved next to this file, so in BASE's tree they are BASE's)
import { relocatedPatches } from '../src/community-factory';
import { Engine } from '../src/engine';
import { DEFS, DEVICE_SR } from '../src/modules';
import { validatePatch, type Patch } from '../src/patch';
import { encodePatch } from '../src/patchbin';
import { EXAMPLE_PRESETS, factoryWithPatterns, FM1_PRESETS } from '../src/presets';
import { decodeShare } from '../src/share';

const COMMUNITY = JSON.parse(readFileSync(new URL('../src/community.json', import.meta.url), 'utf8')) as { title: string; code: string }[];

type Kind = 'factory' | 'patterns' | 'relocated' | 'example' | 'community';
/** one patch of the proof; `fx`: with every master FX stage on */
interface Case { id: string; kind: Kind; name: string; fx: boolean }
interface EngineLike { load(p: Patch): void; render(l: Float32Array, r: Float32Array): void; noteOn(n: number, v?: number, ch?: number): void; noteOff(n: number, ch?: number): void; transport(run: boolean): void }

const BLOCK = 128;
/** [frame, event, note]: the transport runs, a chord builds up, is held, let go; the tails ring out */
const EVENTS: [number, 'run' | 'on' | 'off', number][] = [
  [0, 'run', 0], [0, 'on', 48], [BLOCK * 40, 'on', 55], [BLOCK * 80, 'on', 60], [BLOCK * 120, 'on', 64],
  [BLOCK * 700, 'off', 48], [BLOCK * 700, 'off', 55], [BLOCK * 700, 'off', 60], [BLOCK * 700, 'off', 64],
];
const END = BLOCK * 1200;
const EV_TEXT = EVENTS.map(([fr, k, n]) => (k === 'run' ? `${fr} run` : k === 'on' ? `${fr} on ${n} 127 1` : `${fr} off ${n} 1`)).join('\n') + `\n${END} end\n`;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** engine.ts's output for the events, interleaved stereo */
function render(make: () => EngineLike, p: Patch): Float32Array {
  const e = make();
  e.load(p);
  const out = new Float32Array(END * 2), l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  let next = 0;
  for (let at = 0; at < END; at += BLOCK) {
    for (; next < EVENTS.length && EVENTS[next][0] <= at; next++) {
      const [, k, n] = EVENTS[next];
      if (k === 'run') e.transport(true);
      else if (k === 'on') e.noteOn(n, 1, 1);
      else e.noteOff(n, 1);
    }
    e.render(l, r);
    for (let i = 0; i < BLOCK; i++) (out[2 * (at + i)] = l[i]), (out[2 * (at + i) + 1] = r[i]);
  }
  return out;
}

/** a render's files: the binary (absent when it cannot be encoded, with the reason) and engine.ts's output */
function write(dir: string, id: string, p: Patch, encode: (p: Patch) => Uint8Array, make: () => EngineLike): void {
  try {
    writeFileSync(join(dir, `${id}.m1p`), encode(p));
  } catch (err) {
    writeFileSync(join(dir, `${id}.err`), (err as Error).message);
  }
  writeFileSync(join(dir, `${id}.ts.f32`), render(make, p));
}

/** the BASE half: every patch as BASE opens it, its JSON, binary and engine.ts render; the case list */
async function baseSide(out: string): Promise<void> {
  // (BASE's master FX bus: these modules are gone in this tree, so they cannot be static imports)
  const { fxBusOf } = await import(/* @vite-ignore */ '../src/fx-bus' as string) as { fxBusOf(p: Patch): { stages: unknown[] } | null };
  const { setFxStageEnabled } = await import(/* @vite-ignore */ '../src/fx-preset' as string) as { setFxStageEnabled(p: Patch, s: unknown, on: boolean): void };
  const dir = join(out, 'base');
  mkdirSync(dir, { recursive: true });
  const cases: Case[] = [];
  const add = (kind: Kind, name: string, p: Patch): void => {
    const id = `${kind}-${slug(name)}`;
    const variants: [Case, Patch][] = [[{ id, kind, name, fx: false }, p]];
    const bus = fxBusOf(p);
    if (bus) {
      const on = structuredClone(p);
      for (const s of fxBusOf(on)!.stages) setFxStageEnabled(on, s, true);
      variants.push([{ id: `${id}~fx`, kind, name, fx: true }, on]);
    }
    for (const [c, q] of variants) {
      writeFileSync(join(dir, `${c.id}.json`), JSON.stringify(q));
      write(dir, c.id, q, (x) => encodePatch(x, true), () => new Engine(DEVICE_SR));
      cases.push(c);
    }
  };
  for (const [name, make] of Object.entries(FM1_PRESETS)) {
    const p = make();
    add('factory', name, p);
    const full = factoryWithPatterns(name);
    if (JSON.stringify(full) !== JSON.stringify(p)) add('patterns', name, full);
  }
  for (const [name, make] of Object.entries(relocatedPatches)) add('relocated', name, make());
  for (const [name, make] of Object.entries(EXAMPLE_PRESETS)) add('example', name, make());
  for (const c of COMMUNITY) add('community', c.title, await decodeShare(c.code, DEFS));
  writeFileSync(join(out, 'cases.json'), JSON.stringify(cases));
}

/** the largest absolute difference of two float32 files, null when one is missing or their lengths differ */
function maxDiff(a: string, b: string): number | null {
  if (!existsSync(a) || !existsSync(b)) return null;
  const x = new Float32Array(new Uint8Array(readFileSync(a)).buffer), y = new Float32Array(new Uint8Array(readFileSync(b)).buffer);
  if (!x.length || x.length !== y.length) return null;
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
  return m;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const side = args.indexOf('--side');
  if (side >= 0) return baseSide(resolve(args[side + 2]));
  const reportAt = args.indexOf('--report');
  const base = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--report') ?? 'origin/main';
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const report = reportAt >= 0 ? resolve(args[reportAt + 1]) : join(root, 'build/fxdrawer-proof.txt');
  const T = join(root, 'build/fxproof'), tree = join(T, 'tree'), out = join(T, 'out');
  rmSync(T, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  const sha = execSync(`git rev-parse --verify ${base}^{commit}`, { cwd: root, encoding: 'utf8' }).trim();
  const head = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  execSync(`git archive ${sha} web firmware | tar -x -C "${tree}"`, { cwd: root, shell: '/bin/sh' });
  symlinkSync(join(root, 'web/node_modules'), join(tree, 'web/node_modules'));
  copyFileSync(fileURLToPath(import.meta.url), join(tree, 'web/scripts/fxdrawer-proof.ts'));
  const run = spawnSync('npx', ['vite-node', 'scripts/fxdrawer-proof.ts', '--side', 'base', out], { cwd: join(tree, 'web'), stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`the ${base} half failed`);

  // this tree's half
  // (this tree only: BASE's assembly.ts has no rack, and this file runs there too)
  const { assemblyById, bypassAssembly, rackOf } = await import(/* @vite-ignore */ '../src/assembly' as string) as typeof Assembly;
  const cases = JSON.parse(readFileSync(join(out, 'cases.json'), 'utf8')) as Case[];
  const opened = async (c: Case): Promise<Patch> => {
    const p = c.kind === 'factory' ? FM1_PRESETS[c.name]() : c.kind === 'patterns' ? factoryWithPatterns(c.name)
      : c.kind === 'relocated' ? relocatedPatches[c.name]() : c.kind === 'example' ? EXAMPLE_PRESETS[c.name]()
      : await decodeShare(COMMUNITY.find((x) => x.title === c.name)!.code, DEFS);
    if (c.fx) for (const e of rackOf(p).effects) {
      const a = assemblyById(p, e.asm)!;
      delete a.kept;
      bypassAssembly(p, a, false);
    }
    return p;
  };
  const after = join(out, 'after');
  mkdirSync(after, { recursive: true });
  const ways = ['opened', 'converted'] as const;
  for (const c of cases) {
    const p = { opened: await opened(c), converted: validatePatch(JSON.parse(readFileSync(join(out, 'base', `${c.id}.json`), 'utf8')), DEFS) };
    for (const w of ways) write(after, `${c.id}.${w}`, p[w], (x) => encodePatch(x, true), () => new Engine(DEVICE_SR));
  }

  // engine.c: BASE's host_test on BASE's binaries, this tree's on this tree's
  const gcc = (src: string, exe: string): void => void execSync(`gcc -O1 -w -o "${exe}" "${src}" -lm -lpthread`, { cwd: root });
  gcc(join(tree, 'firmware/test/host_test.c'), join(T, 'base_test'));
  gcc(join(root, 'firmware/test/host_test.c'), join(T, 'new_test'));
  writeFileSync(join(out, 'events.ev'), EV_TEXT);
  const host = (exe: string, stem: string): void => {
    if (!existsSync(`${stem}.m1p`)) return;
    spawnSync(join(T, exe), [`${stem}.m1p`, join(out, 'events.ev'), `${stem}.ts.f32`], { env: { ...process.env, HOST_TEST_DUMP: `${stem}.c.f32` }, stdio: 'ignore' });
  };
  const lines: string[] = [];
  let failed = 0, pairs = 0;
  const show = (d: number | null): string => (d === null ? 'missing' : d === 0 ? '0' : d.toExponential(3));
  for (const c of cases) {
    const b = join(out, 'base', c.id);
    host('base_test', b);
    for (const w of ways) {
      const a = join(after, `${c.id}.${w}`);
      host('new_test', a);
      const ts = maxDiff(`${b}.ts.f32`, `${a}.ts.f32`);
      const encodable = existsSync(`${b}.m1p`) || existsSync(`${a}.m1p`);
      const cdiff = encodable ? maxDiff(`${b}.c.f32`, `${a}.c.f32`) : 0;
      const ok = ts === 0 && cdiff === 0;
      pairs++;
      if (!ok) failed++;
      const note = encodable ? '' : ' (too big for the FM-1 in both: engine.ts only)';
      lines.push(`${ok ? 'ok  ' : 'FAIL'} ${c.kind.padEnd(9)} ${`${c.name}${c.fx ? ' ~fx' : ''}`.padEnd(34)} ${w.padEnd(9)} engine.ts ${show(ts).padEnd(9)} engine.c ${show(cdiff)}${note}`);
    }
  }
  const head1 = [
    `FX drawer migration proof (#1214): max abs sample difference, ${base} (${sha.slice(0, 10)}) vs this tree (${head.slice(0, 10)})`,
    `generated ${new Date().toISOString().slice(0, 10)} by web/scripts/fxdrawer-proof.ts; ${cases.length} patches (${cases.filter((c) => c.fx).length} of them with every FX stage on), ${pairs} pairs per engine`,
    `opened: as this tree opens the patch; converted: ${base}'s patch JSON through validatePatch (convertLegacyBus)`,
    failed ? `${failed} pairs differ` : 'every pair renders sample-identically in both engines',
    '',
  ];
  writeFileSync(report, [...head1, ...lines, ''].join('\n'));
  console.log(head1.slice(0, 4).join('\n'));
  for (const l of lines) if (!l.startsWith('ok')) console.log(l);
  console.log(`report: ${report}`);
  process.exitCode = failed ? 1 : 0;
}

await main();
