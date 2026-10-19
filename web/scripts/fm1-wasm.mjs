// SPDX-License-Identifier: GPL-3.0-only
// Builds the FM-1's UI as WebAssembly (firmware/wasm/fm1_ui.c, #109) into public/fm1-ui.wasm (git-ignored; the Pages
// workflow builds it). Needs a clang with the wasm32 target and wasm-ld: $CLANG / $WASM_LD, Homebrew's llvm + lld, or
// a Debian / Ubuntu clang-NN + lld-NN.
//   npm run fm1-wasm [-- OUT.wasm]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2] ?? resolve(root, 'web/public/fm1-ui.wasm'));

const runs = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; } };
const usrBin = (re) => (existsSync('/usr/bin') ? readdirSync('/usr/bin').filter((f) => re.test(f)).sort().reverse().map((f) => `/usr/bin/${f}`) : []);

function findClang() {
  const c = [process.env.CLANG, '/opt/homebrew/opt/llvm/bin/clang', '/usr/local/opt/llvm/bin/clang', 'clang', ...usrBin(/^clang-\d+$/)].filter(Boolean);
  return c.find((x) => runs(x, ['--target=wasm32', '-x', 'c', '-c', '-o', '/dev/null', '-']));
}
function findWasmLd() {
  const c = [process.env.WASM_LD, '/opt/homebrew/bin/wasm-ld', '/opt/homebrew/opt/lld/bin/wasm-ld', 'wasm-ld', ...usrBin(/^wasm-ld(-\d+)?$/)].filter(Boolean);
  return c.find((x) => runs(x, ['--version']));
}

export function buildFm1Wasm(to = out) {
  const clang = findClang();
  const ld = findWasmLd();
  if (!clang || !ld) throw new Error(`fm1-wasm: needs clang with the wasm32 target (${clang ?? 'none found'}) and wasm-ld (${ld ?? 'none found'}): set CLANG / WASM_LD`);
  mkdirSync(dirname(to), { recursive: true });
  const obj = `${to}.o`;
  execFileSync(clang, [
    '--target=wasm32', '-O2', '-ffreestanding', '-nostdlib', '-fno-builtin',
    '-Wall', '-Werror', '-Wno-unused-function', '-Wno-incompatible-library-redeclaration',
    '-c', '-o', obj, resolve(root, 'firmware/wasm/fm1_ui.c'),
  ], { stdio: 'inherit' });
  execFileSync(ld, ['--no-entry', '-z', 'stack-size=262144', '-o', to, obj], { stdio: 'inherit' });
  rmSync(obj);
  return to;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`wrote ${buildFm1Wasm()}`);
}
