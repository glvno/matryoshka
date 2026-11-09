// SPDX-License-Identifier: GPL-3.0-only
// The firmware CI build of this checkout: the newest successful firmware run (glvno/matryoshka, firmware.yml) of the
// checked-out commit, else of a commit on its branch with the same firmware sources (a merge that touched only the web
// or the emulator gets no firmware run of its own); never an older firmware. Downloaded to build/flash/<run>, smoke
// tested there once (emu:smoke, its result kept next to it). Used by `npm run flash` and the dev server's Flash tab
// (dev/branch-firmware.ts), which install on any FM-1 and so take only emu:smoke, and by `npm run device:scenarios --
// --install RUN`, the test rig's install, which takes the boot check (D-123; --gate full for emu:smoke and the scenarios).
import { execFile, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO = 'glvno/matryoshka';
const SOURCES = ['firmware', 'tools/build.py'];

/** build/venv, the Python with mido + python-rtmidi that tools/fm1_install.py and tools/m1_link.py need: this checkout's,
 *  else (a fresh git worktree has none) the main checkout's, found through `git rev-parse --git-common-dir`; undefined
 *  when neither exists. Says in one line when it takes the main checkout's. */
export function venvPython() {
  const own = join(ROOT, 'build/venv/bin/python');
  if (existsSync(own)) return own;
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' });
  const main = r.status === 0 ? join(dirname(r.stdout.trim()), 'build/venv/bin/python') : undefined;
  if (main && main !== own && existsSync(main)) {
    console.log(`using the main checkout's venv: ${dirname(dirname(main))}`);
    return main;
  }
  return undefined;
}

const run = (cmd, args) => new Promise((ok) => {
  execFile(cmd, args, { cwd: ROOT, maxBuffer: 16 << 20 }, (err, stdout) => ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout).trim() }));
});

/** the CI build of this checkout's firmware: { id, headSha, sha, branch, same, dirty } or { error } */
export async function findBuild() {
  const sha = (await run('git', ['rev-parse', 'HEAD'])).out;
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  const dirty = !!(await run('git', ['status', '--porcelain', '--', ...SOURCES])).out;
  const list = await run('gh', ['run', 'list', '-R', REPO, '--workflow', 'firmware', '--branch', branch, '--status', 'success',
    '-L', '30', '--json', 'databaseId,headSha']);
  if (list.code !== 0) return { error: 'gh could not list the firmware CI runs (is gh installed and logged in?)', sha, branch, dirty };
  const runs = JSON.parse(list.out || '[]');
  let hit = runs.find((r) => r.headSha === sha);
  for (const r of hit ? [] : runs) {
    if ((await run('git', ['diff', '--quiet', r.headSha, sha, '--', ...SOURCES])).code === 0) {
      hit = r;
      break;
    }
  }
  if (!hit) return { error: `no successful firmware CI build of this commit's firmware (${sha.slice(0, 7)} on ${branch}) yet: push it and wait for the firmware workflow`, sha, branch, dirty };
  return { id: String(hit.databaseId), headSha: hit.headSha, sha, branch, same: hit.headSha === sha, dirty };
}

/** a firmware CI run's matryoshka-firmware artifact in build/flash/<run> (downloaded once); its folder. A run of release.yml
 *  has the release package instead (matryoshka-release-X.Y.Z, #783): its package, sidecar and app are copied to the names a
 *  CI build has (matryoshka.fwsc, .json, .bin), so the gates and the installer take release bytes as they take a CI build */
export async function download(id) {
  const dir = join(ROOT, 'build/flash', String(id));
  if (existsSync(join(dir, 'matryoshka.fwsc')) && existsSync(join(dir, 'matryoshka.json'))) return dir;
  rmSync(dir, { recursive: true, force: true }); // gh run download refuses to overwrite
  mkdirSync(dir, { recursive: true });
  const r = await run('gh', ['run', 'download', String(id), '-R', REPO, '-n', 'matryoshka-firmware', '-D', dir]);
  if (r.code === 0 && existsSync(join(dir, 'matryoshka.fwsc'))) return dir;
  const names = await run('gh', ['api', `repos/${REPO}/actions/runs/${id}/artifacts`, '--jq', '.artifacts[].name']);
  const rel = names.out.split('\n').find((n) => /^matryoshka-release-\d/.test(n));
  if (rel) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const v = rel.slice('matryoshka-release-'.length);
    const got = await run('gh', ['run', 'download', String(id), '-R', REPO, '-n', rel, '-D', dir]);
    const [pkg, side, app] = [`matryoshka-${v}.fwsc`, `matryoshka-${v}.json`, `matryoshka-${v}-app.bin`].map((f) => join(dir, f));
    if (got.code === 0 && existsSync(pkg) && existsSync(side)) {
      copyFileSync(pkg, join(dir, 'matryoshka.fwsc'));
      copyFileSync(side, join(dir, 'matryoshka.json'));
      if (existsSync(app)) copyFileSync(app, join(dir, 'matryoshka.bin'));
      console.log(`run ${id} is release ${v}: its package, as built (${rel})`);
      return dir;
    }
  }
  throw new Error(`firmware CI run ${id}: neither its matryoshka-firmware artifact nor a release package could be downloaded`);
}

/** a run's matryoshka-emu-midi artifact (the M1_EMU_MIDI=1 build of the same commit) in <dir>/emu-midi (downloaded
 * once); its matryoshka-emu.bin, or null when there is none. A release run from before #783 has none: then the one of the
 * firmware CI run of the same commit, the same sources */
export async function downloadEmuMidi(id, dir) {
  const emuDir = join(dir, 'emu-midi');
  const bin = join(emuDir, 'matryoshka-emu.bin');
  if (existsSync(bin)) return bin;
  const fetch = async (from) => {
    rmSync(emuDir, { recursive: true, force: true });
    mkdirSync(emuDir, { recursive: true });
    await run('gh', ['run', 'download', String(from), '-R', REPO, '-n', 'matryoshka-emu-midi', '-D', emuDir]);
    return existsSync(bin);
  };
  if (await fetch(id)) return bin;
  const sha = (await run('gh', ['run', 'view', String(id), '-R', REPO, '--json', 'headSha', '--jq', '.headSha'])).out;
  const ci = sha ? (await run('gh', ['run', 'list', '-R', REPO, '--workflow', 'firmware', '--commit', sha, '--status', 'success', '-L', '1',
    '--json', 'databaseId', '--jq', '.[0].databaseId'])).out : '';
  if (ci && ci !== String(id) && (await fetch(ci))) {
    writeFileSync(join(emuDir, 'from-run'), `${ci}\n`);
    console.log(`run ${id} has no matryoshka-emu-midi artifact: the one of firmware CI run ${ci} (the same commit, ${sha.slice(0, 7)})`);
    return bin;
  }
  rmSync(emuDir, { recursive: true, force: true }); // (an empty folder would read as a failed download later)
  return null;
}

/** A gate's state on a downloaded build: 'passed', 'failed', 'running' or 'none'. `gate`: 'smoke' (emu:smoke, the full
 * smoke test) or 'boot' (emu:boot, the boot check; D-123: enough for the test rig only). Kept as files next to the
 * package: <gate>.passed, <gate>.failed, <gate>.running (the pid), <gate>.log */
export function gateState(dir, gate = 'smoke') {
  if (existsSync(join(dir, `${gate}.passed`))) return 'passed';
  if (existsSync(join(dir, `${gate}.failed`))) return 'failed';
  if (existsSync(join(dir, `${gate}.running`))) {
    const pid = Number(readFileSync(join(dir, `${gate}.running`), 'utf8'));
    try {
      process.kill(pid, 0);
      return 'running';
    } catch {
      rmSync(join(dir, `${gate}.running`), { force: true }); // (its process is gone: the dev server stopped mid-test)
    }
  }
  return 'none';
}

/** the smoke test of a downloaded build: 'passed', 'failed', 'running' or 'none' */
export const smokeState = (dir) => gateState(dir, 'smoke');

/** run a gate (emu:smoke or emu:boot) on a downloaded build (its .bin) once; resolves to true when it passed. `quiet`: the
 * output only to <gate>.log (the dev server), else to the terminal too. emu:boot takes the run's M1_EMU_MIDI=1 build
 * (downloadEmuMidi) for its link checks and fails without it. */
async function runGate(dir, gate, quiet) {
  const state = gateState(dir, gate);
  if (state === 'passed' || state === 'failed') return state === 'passed';
  if (state === 'running')                                // (started elsewhere: wait for its result)
    return new Promise((ok) => {
      const t = setInterval(() => {
        const s = gateState(dir, gate);
        if (s !== 'running') {
          clearInterval(t);
          ok(s === 'passed');
        }
      }, 2000);
    });
  const bin = join(dir, existsSync(join(dir, 'matryoshka.bin')) ? 'matryoshka.bin' : 'matryoshka.fwsc');
  let extra = [];
  if (gate === 'boot') {
    const link = await downloadEmuMidi(basename(dir), dir);
    if (!link) {
      writeFileSync(join(dir, 'boot.log'), `run ${basename(dir)} has no matryoshka-emu-midi artifact: the boot check needs it\n`);
      return false;                                       // (no .failed marker: a later download may find it)
    }
    extra = ['--link', link];
  }
  return new Promise((ok) => {
    const log = createWriteStream(join(dir, `${gate}.log`));
    const child = spawn('node', [join(ROOT, 'web/scripts/emu.mjs'), `--${gate}`, bin, ...extra], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(join(dir, `${gate}.running`), String(child.pid));
    for (const s of [child.stdout, child.stderr]) {
      s.pipe(log, { end: false });
      if (!quiet) s.pipe(s === child.stdout ? process.stdout : process.stderr);
    }
    child.on('close', (code) => {
      log.end();
      rmSync(join(dir, `${gate}.running`), { force: true });
      writeFileSync(join(dir, code === 0 ? `${gate}.passed` : `${gate}.failed`), new Date().toISOString() + '\n');
      ok(code === 0);
    });
  });
}

/** run emu:smoke on a downloaded build once; true when it passed */
export const smoke = (dir, quiet = false) => runGate(dir, 'smoke', quiet);

/** run emu:boot (the boot check) on a downloaded build once; true when it passed */
export const boot = (dir, quiet = false) => runGate(dir, 'boot', quiet);
