// SPDX-License-Identifier: GPL-3.0-only
// Copies a firmware package into the app (public/firmware/), so the Flash tab can install it with one click. Run from web/:
//   npm run firmware                      build/matryoshka.fwsc (tools/build.py; CI builds it, .github/workflows/firmware.yml)
//   npm run firmware -- path/to/x.fwsc    that package
//   npm run firmware -- --ci [run-id]     the matryoshka-firmware artifact of that firmware CI run, else of the newest
//                                         successful one on main (needs `gh`)
// matryoshka.json gets the product read from the package itself, and the version from the package's sidecar
// (x.fwsc -> x.json, written by build.py) if there is one, else from firmware/src/modular.c with a warning.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productOf } from '../src/flasher/fm1pkg.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = 'glvno/matryoshka';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

/** the package of a firmware CI run (the newest successful one on main without an id), downloaded to build/ci-firmware */
function fromCi(runId) {
  let id = runId;
  if (!id) {
    const r = spawnSync('gh', ['run', 'list', '-R', REPO, '--workflow', 'firmware', '--branch', 'main', '--status', 'success',
      '-L', '1', '--json', 'databaseId', '--jq', '.[0].databaseId'], { encoding: 'utf8' });
    if (r.error || r.status !== 0 || !r.stdout.trim()) fail(`no successful firmware run on ${REPO}'s main found (is gh installed and logged in?)`);
    id = r.stdout.trim();
  }
  const dir = join(ROOT, 'build/ci-firmware');
  rmSync(dir, { recursive: true, force: true }); // gh run download refuses to overwrite
  mkdirSync(dir, { recursive: true });
  const d = spawnSync('gh', ['run', 'download', id, '-R', REPO, '-n', 'matryoshka-firmware', '-D', dir], { stdio: 'inherit' });
  const pkg = join(dir, 'matryoshka.fwsc');
  if (d.error || d.status !== 0 || !existsSync(pkg)) fail(`firmware CI run ${id}: its matryoshka-firmware artifact could not be downloaded`);
  console.log(`package: CI run ${id} of ${REPO}`);
  return pkg;
}

const args = process.argv.slice(2);
const ci = args.indexOf('--ci');
const src = ci >= 0
  ? fromCi(args[ci + 1] && !args[ci + 1].startsWith('--') ? args[ci + 1] : undefined)
  : args[0]
    ? resolve(process.cwd(), args[0])
    : join(ROOT, 'build/matryoshka.fwsc');
if (!existsSync(src)) fail(`${src} is missing: build it with tools/build.py (the JieLi toolchain, tools/get_toolchain.sh), pass a .fwsc, or use --ci to take the newest CI build`);

const bytes = readFileSync(src);
let product;
try {
  product = productOf(bytes);
} catch (e) {
  fail(`${src}: ${e.message}`);
}
if (!/^FM-1_7\d\d$/.test(product)) fail(`${src}: identity ${product} is not a Matryoshka package (FM-1_7XY)`);

const sidecar = src.replace(/\.fwsc$/i, '') + '.json';
let version;
if (sidecar !== src && existsSync(sidecar)) version = JSON.parse(readFileSync(sidecar, 'utf8')).version;
if (typeof version !== 'string') {
  version = /#define FELUCCA_VERSION "([^"]+)"/.exec(readFileSync(join(ROOT, 'firmware/src/modular.c'), 'utf8'))?.[1] ?? '?';
  console.warn(`warning: no version sidecar (${sidecar}); the version is this checkout's firmware/src/modular.c (${version}), which may not be the package's`);
}

const dir = new URL('../public/firmware/', import.meta.url);
mkdirSync(dir, { recursive: true });
copyFileSync(src, new URL('matryoshka.fwsc', dir));
writeFileSync(new URL('matryoshka.json', dir), JSON.stringify({ version, product, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
// the package carries three Apache-2.0 SDK files and GPL-3.0 firmware: ship both licence texts with it
copyFileSync(join(ROOT, 'LICENSE'), new URL('LICENSE-GPL-3.0.txt', dir));
copyFileSync(join(ROOT, 'LICENSES/Apache-2.0.txt'), new URL('LICENSE-Apache-2.0.txt', dir));
console.log(`public/firmware/matryoshka.fwsc: ${version}, ${product}, ${bytes.length} bytes`);
