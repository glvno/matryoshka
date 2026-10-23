// SPDX-License-Identifier: GPL-3.0-only
// The firmware CI build of this checkout: the newest successful firmware run (glvno/matryoshka, firmware.yml) of the
// checked-out commit, else of a commit on its branch with the same firmware sources (a merge that touched only the web
// or the emulator gets no firmware run of its own); never an older firmware. Downloaded to build/flash/<run>, smoke
// tested there once (emu:smoke, its result kept next to it). Used by `npm run flash` and the dev server's Flash tab
// (dev/branch-firmware.ts).
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO = 'glvno/matryoshka';
const SOURCES = ['firmware', 'tools/build.py'];

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

/** a firmware CI run's matryoshka-firmware artifact in build/flash/<run> (downloaded once); its folder */
export async function download(id) {
  const dir = join(ROOT, 'build/flash', String(id));
  if (existsSync(join(dir, 'matryoshka.fwsc')) && existsSync(join(dir, 'matryoshka.json'))) return dir;
  rmSync(dir, { recursive: true, force: true }); // gh run download refuses to overwrite
  mkdirSync(dir, { recursive: true });
  const r = await run('gh', ['run', 'download', String(id), '-R', REPO, '-n', 'matryoshka-firmware', '-D', dir]);
  if (r.code !== 0 || !existsSync(join(dir, 'matryoshka.fwsc'))) throw new Error(`firmware CI run ${id}: its matryoshka-firmware artifact could not be downloaded`);
  return dir;
}

/** the smoke test of a downloaded build: 'passed', 'failed', 'running' or 'none' */
export function smokeState(dir) {
  if (existsSync(join(dir, 'smoke.passed'))) return 'passed';
  if (existsSync(join(dir, 'smoke.failed'))) return 'failed';
  if (existsSync(join(dir, 'smoke.running'))) {
    const pid = Number(readFileSync(join(dir, 'smoke.running'), 'utf8'));
    try {
      process.kill(pid, 0);
      return 'running';
    } catch {
      rmSync(join(dir, 'smoke.running'), { force: true }); // (its process is gone: the dev server stopped mid-test)
    }
  }
  return 'none';
}

/** run emu:smoke on a downloaded build (its .bin) once; resolves to true when it passed. `quiet`: the output only to
 * smoke.log (the dev server), else to the terminal too */
export function smoke(dir, quiet = false) {
  const state = smokeState(dir);
  if (state === 'passed' || state === 'failed') return Promise.resolve(state === 'passed');
  if (state === 'running')                                // (started elsewhere: wait for its result)
    return new Promise((ok) => {
      const t = setInterval(() => {
        const s = smokeState(dir);
        if (s !== 'running') {
          clearInterval(t);
          ok(s === 'passed');
        }
      }, 2000);
    });
  const bin = join(dir, existsSync(join(dir, 'matryoshka.bin')) ? 'matryoshka.bin' : 'matryoshka.fwsc');
  return new Promise((ok) => {
    const log = createWriteStream(join(dir, 'smoke.log'));
    const child = spawn('node', [join(ROOT, 'web/scripts/emu.mjs'), '--smoke', bin], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(join(dir, 'smoke.running'), String(child.pid));
    for (const s of [child.stdout, child.stderr]) {
      s.pipe(log, { end: false });
      if (!quiet) s.pipe(s === child.stdout ? process.stdout : process.stderr);
    }
    child.on('close', (code) => {
      log.end();
      rmSync(join(dir, 'smoke.running'), { force: true });
      writeFileSync(join(dir, code === 0 ? 'smoke.passed' : 'smoke.failed'), new Date().toISOString() + '\n');
      ok(code === 0);
    });
  });
}
