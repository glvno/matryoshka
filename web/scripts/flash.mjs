// SPDX-License-Identifier: GPL-3.0-only
// Installs a firmware package on the FM-1 over USB MIDI with tools/fm1_install.py, after the emulator smoke test on the
// same bytes. Run from web/:
//   npm run flash                       the firmware CI build of this checkout's commit (needs `gh`; none: it says so)
//   npm run flash -- --ci RUN           the matryoshka-firmware artifact of that firmware CI run
//   npm run flash -- path/to/x.fwsc     that package (the smoke test runs on x.bin next to it, else on the package)
//   npm run flash -- --info             print the connected FM-1's identity, install nothing
// --no-smoke skips the smoke test; --port NAME and --force go to fm1_install.py, which asks before it writes.
// fm1_install.py needs mido + python-rtmidi: build/venv (made with uv on the first run when it is missing).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productOf } from '../src/flasher/fm1pkg.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = 'glvno/matryoshka';
const VENV = join(ROOT, 'build/venv');
const PY = join(VENV, 'bin/python');

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return r.status ?? 1;
};
const out = (cmd, argv) => (spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim();

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const passed = [...(valueOf('--port') ? ['--port', valueOf('--port')] : []), ...(flag('--force') ? ['--force'] : [])];
const taken = new Set([valueOf('--port'), valueOf('--ci')]);
const given = args.find((a) => !a.startsWith('--') && !taken.has(a));

/** a Python with mido + python-rtmidi */
function python() {
  const ok = () => existsSync(PY) && spawnSync(PY, ['-c', 'import mido, rtmidi'], { stdio: 'ignore' }).status === 0;
  if (ok()) return PY;
  console.log('setting up build/venv (mido, python-rtmidi) with uv');
  // (homebrew's python3: uv's own pick can ask for another version)
  const base = existsSync('/opt/homebrew/bin/python3') ? ['-p', '/opt/homebrew/bin/python3'] : [];
  if (!existsSync(PY) && run('uv', ['venv', ...base, VENV]) !== 0) fail('uv venv failed (is uv installed? https://docs.astral.sh/uv/)');
  if (run('uv', ['pip', 'install', '-p', PY, 'mido', 'python-rtmidi']) !== 0 || !ok()) fail('mido / python-rtmidi could not be installed into build/venv');
  return PY;
}

/** the matryoshka-firmware artifact of a firmware CI run, downloaded to build/flash/<run> */
function download(id, what) {
  const dir = join(ROOT, 'build/flash', String(id));
  rmSync(dir, { recursive: true, force: true }); // gh run download refuses to overwrite
  mkdirSync(dir, { recursive: true });
  if (run('gh', ['run', 'download', String(id), '-R', REPO, '-n', 'matryoshka-firmware', '-D', dir]) !== 0 || !existsSync(join(dir, 'matryoshka.fwsc')))
    fail(`firmware CI run ${id}: its matryoshka-firmware artifact could not be downloaded`);
  console.log(`package: firmware CI run ${id} of ${REPO} (${what})`);
  return join(dir, 'matryoshka.fwsc');
}

/** the package to install: a path, a CI run, or the CI build of exactly this commit (never an older one) */
function packagePath() {
  if (given) return resolve(process.cwd(), given);
  if (valueOf('--ci')) return download(valueOf('--ci'), 'as asked');
  const sha = out('git', ['rev-parse', 'HEAD']);
  const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  // a successful build of a commit whose firmware sources are this commit's (a merge that touched only the web or the
  // emulator gets no firmware run of its own)
  const runs = JSON.parse(out('gh', ['run', 'list', '-R', REPO, '--workflow', 'firmware', '--branch', branch, '--status', 'success',
    '-L', '30', '--json', 'databaseId,headSha']) || '[]');
  const same = (c) => spawnSync('git', ['diff', '--quiet', c, sha, '--', 'firmware', 'tools/build.py'], { cwd: ROOT }).status === 0;
  const hit = runs.find((r) => r.headSha === sha) ?? runs.find((r) => same(r.headSha));
  if (!hit) fail(`no successful firmware CI build of this commit's firmware (${sha.slice(0, 7)} on ${branch}): push it and wait for the firmware workflow, or pass --ci RUN or a .fwsc`);
  if (out('git', ['status', '--porcelain', '--', 'firmware', 'tools/build.py'])) console.warn('warning: firmware/ has uncommitted changes; the CI build is of the commit, without them');
  return download(hit.databaseId, hit.headSha === sha ? `commit ${sha.slice(0, 7)}` : `commit ${hit.headSha.slice(0, 7)}, the same firmware as ${sha.slice(0, 7)}`);
}

if (flag('--info')) process.exit(run(python(), [join(ROOT, 'tools/fm1_install.py'), '--info', ...passed]));

const pkg = packagePath();
if (!existsSync(pkg)) fail(`${pkg} is missing`);
let product;
try {
  product = productOf(readFileSync(pkg));
} catch (e) {
  fail(`${pkg}: ${e.message}`);
}
// only our own builds here (they keep Felucca's update path); the stock V15 and the rest go through fm1_install.py itself
if (!/^FM-1_7\d\d$/.test(product)) fail(`${pkg}: identity ${product} is not a Matryoshka package (FM-1_7XY); use tools/fm1_install.py directly for others`);
const py = python();

if (!flag('--no-smoke')) {
  const bin = pkg.replace(/\.fwsc$/i, '.bin');
  const fw = existsSync(bin) ? bin : pkg;
  console.log(`\nemu:smoke on ${fw} (about two minutes; --no-smoke skips it)`);
  if (run('node', [join(ROOT, 'web/scripts/emu.mjs'), '--smoke', fw]) !== 0) fail('\nthe smoke test failed: nothing installed');
}

console.log(`\ninstalling ${pkg} (${product})`);
process.exit(run(py, [join(ROOT, 'tools/fm1_install.py'), pkg, ...passed]));
