// SPDX-License-Identifier: GPL-3.0-only
// Patches played on the real firmware in the emulator under its timing model (D-1107, D-1155), for the CPU cost table
// (scripts/cpu-costs.ts): each request is a patch, the keys held and whether the transport runs; requests made close
// together are seeded into banks of up to 48 slots (`m1emu cpu --bank`), each bank played by one emulator, as many
// emulators at once as the Mac has cores. Each slot reads the firmware's own module times (`--modtime`) and the mean of the
// whole audio interrupt. The shared emulator slot (emu-slot.mjs) is held while a round of banks plays, so other checkouts'
// emulator runs queue between rounds instead of waiting for the whole table.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encodePatch, layout } from '../src/patchbin';
import type { Patch } from '../src/patch';
// @ts-ignore: plain JavaScript module
import { acquireEmulatorSlot } from './emu-slot.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const WORK = `${ROOT}build/cpu-emu/`;
const EMU = `${ROOT}tools/emu/target/release/m1emu`;
export const TIMING = `${ROOT}tools/emu/timing.txt`;
/** the firmware: FW_DIR (holding matryoshka.bin and matryoshka.elf, CI artifacts `matryoshka-firmware` and
 * `matryoshka-elf`), else build/ */
export const FW = process.env.FW_DIR ?? `${ROOT}build`;
const SETTLE = 250;   // ms the keys are held before the window (envelopes past their attack)
const WINDOW = 120;   // ms of module times (about 41 halves: the timed emulator repeats a module's time to 0.1 %)
const PAR = Math.max(1, cpus().length);
/** each slot's result, kept by what made it (the firmware, the timing model, how it was played, the patch's bytes), so a
 * run that stops starts again where it was and a rerun on the same firmware plays only what changed */
const CACHE = `${WORK}cache/`;

/** a slot's result: each module of the patch by its editor id, its ns a half (core 0 lane + core 1 lane), and the mean
 * audio interrupt in us */
export interface EmuRun { ns: Map<number, number>; lanes: Map<number, [number, number]>; isrUs: number; halves: number }
/** a slot's row as m1emu writes it (modules by their index in the device patch) */
interface Row { modules_ns: [number, number][]; isr_us: number; halves: number }
interface Req { p: Patch; bytes: Uint8Array; key: string; keys: number[]; run: boolean; done: (r: EmuRun) => void; fail: (e: Error) => void }

let firmwareId = '';
const keyOf = (bytes: Uint8Array, keys: number[], run: boolean): string => {
  firmwareId ||= createHash('sha256').update(readFileSync(`${FW}/matryoshka.bin`)).update(readFileSync(TIMING)).update(`${SETTLE}/${WINDOW}`).digest('hex');
  return createHash('sha256').update(firmwareId).update(`${keys.join(',')}|${run}|`).update(bytes).digest('hex').slice(0, 32);
};

/** a row by the editor's module ids */
function emuRunOf(p: Patch, row: Row): EmuRun {
  const ns = new Map<number, number>(), lanes = new Map<number, [number, number]>();
  layout(p).p.modules.forEach((m, k) => {
    const c: [number, number] = row.modules_ns[k] ?? [0, 0];
    lanes.set(m.id, c);
    ns.set(m.id, c[0] + c[1]);
  });
  return { ns, lanes, isrUs: row.isr_us, halves: row.halves };
}

export function buildEmu(): void {
  const cfg = execFileSync(`${ROOT}tools/emu/isa_fix.sh`, { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop()!;
  execFileSync('cargo', ['build', '--release', '--config', cfg], { cwd: `${ROOT}tools/emu`, stdio: 'inherit' });
  for (const f of ['matryoshka.bin', 'matryoshka.elf']) if (!existsSync(`${FW}/${f}`)) throw new Error(`${FW}/${f} missing (FW_DIR)`);
}

let pending: Req[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let busy: Promise<void> = Promise.resolve();
let seq = 0;
export const stats = { slots: 0, cached: 0, rounds: 0 };

/** play `p` holding `keys` (the transport running if `run`) */
export function emuRun(p: Patch, keys: number[], run = false): Promise<EmuRun> {
  const bytes = encodePatch(p, true);
  const key = keyOf(bytes, keys, run);
  if (existsSync(`${CACHE}${key}.json`)) {
    stats.cached++;
    return Promise.resolve(emuRunOf(p, JSON.parse(readFileSync(`${CACHE}${key}.json`, 'utf8'))));
  }
  const { promise, resolve, reject } = Promise.withResolvers<EmuRun>();
  pending.push({ p, bytes, key, keys, run, done: resolve, fail: reject });
  clearTimeout(timer);
  timer = setTimeout(() => { const batch = pending; pending = []; busy = busy.then(() => round(batch)); }, 50);
  return promise;
}

function playBank(reqs: Req[], keys: number[], run: boolean): Promise<void> {
  const id = seq++;
  const list = reqs.map((r, i) => {
    const f = `${WORK}k${id}-${i}.m1p`;
    writeFileSync(f, r.bytes);
    return `K${i}\t${f}`;
  });
  writeFileSync(`${WORK}bank${id}.txt`, list.join('\n') + '\n');
  const args = ['cpu', `${FW}/matryoshka.bin`, '--elf', `${FW}/matryoshka.elf`, '--no-survey', '--modtime', '--bank', `${WORK}bank${id}.txt`,
    '--keys', keys.join(','), '--settle', String(SETTLE), '--window', String(WINDOW), '--out', `${WORK}out${id}.json`, ...(run ? ['--mt-run'] : [])];
  const { promise, resolve } = Promise.withResolvers<void>();
  execFile(EMU, args, { env: { ...process.env, M1EMU_TIMING: TIMING }, maxBuffer: 1 << 26 }, (err, _o, stderr) => {
      if (err && reqs.length > 1) {
        // one patch the firmware cannot play stops the bank: play each alone, so only that one fails
        reqs.reduce((at, r) => at.then(() => playBank([r], keys, run)), Promise.resolve()).then(resolve);
        return;
      }
      if (err) { reqs.forEach((r) => r.fail(new Error(`${r.p.name}: m1emu: ${stderr.split('\n').slice(-4).join(' ')}`))); return resolve(); }
      const j = JSON.parse(readFileSync(`${WORK}out${id}.json`, 'utf8'));
      reqs.forEach((r, i) => {
        const row = j.modtime.patches[`K${i}`];
        if (!row) return r.fail(new Error(`${r.p.name}: slot K${i} not played (refused by the firmware?)`));
        writeFileSync(`${CACHE}${r.key}.json`, JSON.stringify({ modules_ns: row.modules_ns, isr_us: row.isr_us, halves: row.halves }));
        stats.slots++;
        r.done(emuRunOf(r.p, row));
      });
      resolve();
  });
  return promise;
}

async function round(batch: Req[]): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  const groups = new Map<string, Req[]>();
  for (const r of batch) {
    const k = `${r.keys.join(',')}|${r.run}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const banks: (() => Promise<void>)[] = [];
  const total = batch.length;
  // spread over every core: small banks for a small round (each bank boots once, about 9 emulated s)
  const size = Math.min(48, Math.max(4, Math.ceil(total / PAR)));
  for (const [, rs] of groups) for (let i = 0; i < rs.length; i += size) {
    const chunk = rs.slice(i, i + size);
    banks.push(() => playBank(chunk, chunk[0].keys, chunk[0].run));
  }
  const release = await acquireEmulatorSlot({ log: () => {} });
  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PAR, banks.length) }, async () => { while (next < banks.length) await banks[next++](); }));
  } finally { release(); }
  stats.rounds++;
  console.log(`emulator round ${stats.rounds}: ${total} patches in ${banks.length} banks`);
}
