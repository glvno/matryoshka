// SPDX-License-Identifier: GPL-3.0-only
// Installs a firmware package on the FM-1 over USB MIDI with tools/fm1_install.py, after the emulator smoke test on the
// same bytes. Run from web/:
//   npm run flash                       the firmware CI build of this checkout's commit (needs `gh`; none: it says so)
//   npm run flash -- --ci RUN           the matryoshka-firmware artifact of that firmware CI run
//   npm run flash -- path/to/x.fwsc     that package (the smoke test runs on x.bin or x-app.bin next to it, else on the package)
//   npm run flash -- --info             print the connected FM-1's identity, install nothing
// --no-smoke skips the smoke test; --port NAME, --force and --yes go to fm1_install.py, which asks before it writes unless
// --yes (a shell with no prompt, such as Claude Code's `!`, answers no).
// fm1_install.py needs mido + python-rtmidi: build/venv (made with uv on the first run when it is missing).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { productOf } from '../src/flasher/fm1pkg.js';
import { REPO, ROOT, download, findBuild, smoke, smokeState } from './branch-firmware.mjs';

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

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const passed = [...(valueOf('--port') ? ['--port', valueOf('--port')] : []), ...(flag('--force') ? ['--force'] : []), ...(flag('--yes') ? ['--yes'] : [])];
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

/** the package to install: a path, a CI run, or the CI build of this checkout's firmware (never an older one) */
async function packagePath() {
  if (given) return resolve(process.cwd(), given);
  const ci = valueOf('--ci');
  const b = ci ? { id: ci } : await findBuild();
  if (b.error) fail(`${b.error}; or pass --ci RUN or a .fwsc`);
  if (b.dirty) console.warn('warning: firmware/ has uncommitted changes; the CI build is of the commit, without them');
  let dir;
  try {
    dir = await download(b.id);
  } catch (e) {
    fail(e.message);
  }
  console.log(`package: firmware CI run ${b.id} of ${REPO}` + (ci ? '' : b.same ? ` (commit ${b.sha.slice(0, 7)})` : ` (commit ${b.headSha.slice(0, 7)}, the same firmware as ${b.sha.slice(0, 7)})`));
  return join(dir, 'matryoshka.fwsc');
}

if (flag('--info')) process.exit(run(python(), [join(ROOT, 'tools/fm1_install.py'), '--info', ...passed]));

const pkg = await packagePath();
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

if (!flag('--no-smoke') && given) {
  // (x.bin next to it, or a release's x-app.bin: the package itself is encrypted, the emulator cannot run it)
  const bin = [pkg.replace(/\.fwsc$/i, '.bin'), pkg.replace(/\.fwsc$/i, '-app.bin')].find((f) => existsSync(f));
  const fw = bin ?? pkg;
  console.log(`\nemu:smoke on ${fw} (about two minutes; --no-smoke skips it)`);
  if (run('node', [join(ROOT, 'web/scripts/emu.mjs'), '--smoke', fw]) !== 0) fail('\nthe smoke test failed: nothing installed');
} else if (!flag('--no-smoke')) {                          // (a CI build: its result is kept, for the Flash tab too)
  const dir = dirname(pkg);
  const cached = smokeState(dir);
  if (cached === 'passed') console.log('\nemu:smoke passed on this build before (build/flash/<run>/smoke.log)');
  else {
    console.log(`\nemu:smoke on ${dir} (about two minutes; --no-smoke skips it)`);
    if (!(await smoke(dir))) fail('\nthe smoke test failed: nothing installed (smoke.log next to the package)');
  }
}

console.log(`\ninstalling ${pkg} (${product})`);
process.exit(run(py, [join(ROOT, 'tools/fm1_install.py'), pkg, ...passed]));
