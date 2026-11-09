// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

// flock is released by the OS when the helper exits, including after a killed runner.
// The helper watches its input while queued too: a dead parent cannot leave a waiter.
const LOCK = `
import fcntl, os, select, sys
with open(sys.argv[1], 'a+') as lock:
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if select.select([sys.stdin], [], [], 0.2)[0] and not os.read(0, 1):
                sys.exit(0)
    print('acquired', flush=True)
    sys.stdin.read()
`;

/** One heavy emulator run across all checkouts on this Mac. Release after all its children stop. */
export async function acquireEmulatorSlot({ path = join(tmpdir(), `matryoshka-emu-${process.getuid()}.lock`), log = console.log } = {}) {
  log('emulator queue: waiting for the shared slot');
  const helper = spawn('python3', ['-c', LOCK, path], { stdio: ['pipe', 'pipe', 'inherit'] });
  const stop = () => helper.kill();
  process.once('exit', stop);
  try {
    await new Promise((resolve, reject) => {
      helper.once('error', reject);
      helper.once('exit', (code, signal) => reject(new Error(`emulator queue exited (${signal ?? code})`)));
      createInterface({ input: helper.stdout }).once('line', (line) => line === 'acquired' ? resolve() : reject(new Error(line)));
    });
  } catch (error) { stop(); process.removeListener('exit', stop); throw error; }
  log('emulator queue: acquired the shared slot');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    helper.stdin.end();
    process.removeListener('exit', stop);
  };
}

export async function withDeadline(work, ms, label) {
  let timer;
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error(`${label} timed out after ${ms} ms`); error.name = 'DeadlineError'; reject(error); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
