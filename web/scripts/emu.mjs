// SPDX-License-Identifier: GPL-3.0-only
// Our firmware on the emulated FM-1 (fm1-emu by Joakim Eriksson, MIT, pinned in tools/emu/Cargo.toml).
//   npm run emu [-- FIRMWARE]          the panel in a window: LCD, keys, knobs, sound, MIDI in (fm1-live)
//   npm run emu:smoke [-- FIRMWARE]    the scripted smoke test (tools/emu_smoke.sh)
//   npm run emu:boot [-- FIRMWARE] [--link EMU_BIN]   the boot check (m1emu boot, about 30 s): boot, screen, sound,
//                                      update mode; with the same commit's M1_EMU_MIDI=1 build (EMU_BIN, else
//                                      matryoshka-emu.bin or emu-midi/matryoshka-emu.bin next to FIRMWARE, else the CI
//                                      run's matryoshka-emu-midi artifact) also HELLO / INFO and the update handshake
// FIRMWARE: a matryoshka.bin or a .fwsc. Without one: build/matryoshka.bin, else the latest firmware CI artifact of
// glvno/matryoshka's main (needs `gh`), else web/public/firmware/matryoshka.fwsc.
// fm1-live lists its keys when it starts; every MIDI input plays (TRS MIDI IN; USB is not emulated).
// The window runs fm1-emu's interpreter at 120 MHz (about 1.4x real time on an M1; the firmware needs ~12 % of
// 240 MHz): its AArch64 JIT renders our engine wrong. M1EMU_JIT=1 uses the JIT at 240 MHz anyway.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireEmulatorSlot } from './emu-slot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EMU = join(ROOT, 'tools/emu');
const OUT = join(ROOT, 'build/emu');
const REPO = 'glvno/matryoshka';

const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const boot = args.includes('--boot');
const linkAt = args.indexOf('--link');
const linkGiven = linkAt >= 0 ? args[linkAt + 1] : undefined;
const given = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--link');
let ciRun = null;   // the firmware CI run the firmware came from, if it was downloaded

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r.status ?? 1;
}

function firmware() {
  if (given) return resolve(process.cwd(), given);
  const local = join(ROOT, 'build/matryoshka.bin');
  if (existsSync(local)) return local;
  const ci = join(OUT, 'ci');
  // the CI build of this checkout's commit, else the newest of its branch, else the newest of main
  const git = (a) => (spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim();
  const tries = [['--commit', git(['rev-parse', 'HEAD'])], ['--branch', git(['rev-parse', '--abbrev-ref', 'HEAD'])], ['--branch', 'main']]
    .filter(([, v]) => v && v !== 'HEAD');
  for (const [flag, value] of tries) {
    const id = spawnSync('gh', ['run', 'list', '-R', REPO, '--workflow', 'firmware', flag, value, '--status', 'success',
      '-L', '1', '--json', 'databaseId', '--jq', '.[0].databaseId'], { encoding: 'utf8' });
    if (id.status !== 0 || !id.stdout.trim()) continue;
    rmSync(ci, { recursive: true, force: true });  // gh run download refuses to overwrite
    mkdirSync(ci, { recursive: true });
    spawnSync('gh', ['run', 'download', id.stdout.trim(), '-R', REPO, '-n', 'matryoshka-firmware', '-D', ci], { stdio: 'inherit' });
    if (existsSync(join(ci, 'matryoshka.bin'))) {
      ciRun = id.stdout.trim();
      console.log(`firmware: CI run ${id.stdout.trim()} of ${REPO} (${flag.slice(2)} ${value})`);
      return join(ci, 'matryoshka.bin');
    }
  }
  const bundled = join(ROOT, 'web/public/firmware/matryoshka.fwsc');
  if (existsSync(bundled)) {
    console.log('firmware: web/public/firmware/matryoshka.fwsc (the package the app bundles; may be old)');
    return bundled;
  }
  throw new Error('no firmware: build one (tools/build.py), install gh, or pass a matryoshka.bin / .fwsc');
}

if (smoke || boot) await acquireEmulatorSlot();
const fw = firmware();
console.log(`firmware: ${fw}`);
mkdirSync(OUT, { recursive: true });
if (smoke) process.exit(run('sh', [join(ROOT, 'tools/emu_smoke.sh'), fw]));

// fm1-emu's decoder misses long forward test-and-branch jumps; tools/emu/isa_fix.sh patches its fm1-isa crate
const isa = execFileSync(join(ROOT, 'tools/emu/isa_fix.sh'), { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
if (run('cargo', ['build', '--release', '--quiet', '--manifest-path', join(EMU, 'Cargo.toml'), '--config', isa]) !== 0) process.exit(1);

if (boot) {
  /** the same commit's M1_EMU_MIDI=1 build, for the link checks: given, next to the firmware, else the CI run's */
  const link = (() => {
    if (linkGiven) return resolve(process.cwd(), linkGiven);
    const near = [join(dirname(fw), 'matryoshka-emu.bin'), join(dirname(fw), 'emu-midi/matryoshka-emu.bin')].find((f) => existsSync(f));
    if (near) return near;
    if (!ciRun) return undefined;
    const dir = join(OUT, 'ci/emu-midi');
    mkdirSync(dir, { recursive: true });
    spawnSync('gh', ['run', 'download', ciRun, '-R', REPO, '-n', 'matryoshka-emu-midi', '-D', dir], { stdio: 'inherit' });
    return existsSync(join(dir, 'matryoshka-emu.bin')) ? join(dir, 'matryoshka-emu.bin') : undefined;
  })();
  console.log(link ? `link build: ${link}` : 'link build: none (no M1_EMU_MIDI=1 build found: HELLO / INFO and the update handshake are not checked; pass --link)');
  const out = join(OUT, 'boot');
  rmSync(out, { recursive: true, force: true });
  process.exit(run(join(EMU, 'target/release/m1emu'), ['boot', fw, ...(link ? ['--link', link] : []), '--out', out]));
}
const live = join(EMU, 'live/bin', process.platform === 'win32' ? 'fm1-live.exe' : 'fm1-live');
// (built from a patched copy of fm1-emu, tools/emu/live_build.sh: a cargo patch does not reach it. Builds made before
// that, marked .isa-fixed / .isa-fixed-2 / .isa-fixed-3, ran a decoder without one of the fixes; they are rebuilt)
const liveFixed = join(EMU, 'live/.isa-fixed-4');
if (!existsSync(live) || !existsSync(liveFixed)) {
  console.log('building fm1-live (once)...');
  if (run('sh', [join(ROOT, 'tools/emu/live_build.sh')]) !== 0) process.exit(1);
  writeFileSync(liveFixed, '');
}
const xip = join(OUT, 'xip.bin');
if (run(join(EMU, 'target/release/m1emu'), ['xip', fw, xip]) !== 0) process.exit(1);
const jit = !!process.env.M1EMU_JIT;
const env = { ...process.env };
if (!jit) env.FM1_NO_JIT = '1';
console.log(`fm1-live: ${jit ? 'JIT, 240 MHz' : 'interpreter, 120 MHz'}; buttons 1..0 = FX SEL ENV LFO EDIT GLO HOME SAVE ARP SEQ`);
process.exit(run(live, ['--bin', xip, '--entry', '0x02000120', '--mhz', jit ? '240' : '120'], { env }));
