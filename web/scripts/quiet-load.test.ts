// SPDX-License-Identifier: GPL-3.0-only
// #1086: no FM-1 factory patch, and no factory preset of any of its devices, sounds the moment it is loaded or switched
// to: with no key held and the transport stopped, its output stays under QUIET_DB for SECONDS, in the browser engine and
// in the FM-1's own engine (engine.c as wasm). A sound that should play by itself plays from its PATTERN track on PLAY.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { buildFm1EngineWasm } from './fm1-wasm.mjs';
import { auditPatch, caseLine, factoryPatches, QUIET_DB } from './quiet-load';

let wasm: WebAssembly.Module;
beforeAll(() => {
  wasm = new WebAssembly.Module(readFileSync(buildFm1EngineWasm(join(tmpdir(), `fm1-engine-quiet-${process.pid}.wasm`))));
}, 120_000);

const patches = factoryPatches();

it.each(patches.flatMap(({ name }) => (['browser', 'fm1'] as const).map((engine) => [name, engine] as const)))(
  '%s is silent at load and at every preset switch [%s engine]', (name, engine) => {
    const loud = auditPatch(name, patches.find((x) => x.name === name)!.patch, engine, wasm).filter((r) => r.peak >= QUIET_DB);
    expect(loud.map(caseLine)).toEqual([]);
  }, 60_000);
