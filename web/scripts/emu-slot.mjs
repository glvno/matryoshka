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
  let awake;
  const stop = () => { helper.kill(); awake?.kill(); };
  process.once('exit', stop);
  try {
    await new Promise((resolve, reject) => {
      helper.once('error', reject);
      helper.once('exit', (code, signal) => reject(new Error(`emulator queue exited (${signal ?? code})`)));
      createInterface({ input: helper.stdout }).once('line', (line) => line === 'acquired' ? resolve() : reject(new Error(line)));
    });
  } catch (error) { stop(); process.removeListener('exit', stop); throw error; }
  log('emulator queue: acquired the shared slot');
  if (process.platform === 'darwin') {
    // Keep idle sleep from interrupting MIDI and wall-clock deadlines. The display may sleep; closing the lid can
    // still suspend the Mac. -w also releases the assertion if the runner is killed without running its exit handlers.
    awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    awake.once('error', (error) => log(`emulator queue: could not inhibit idle sleep: ${error.message}`));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    helper.stdin.end();
    awake?.kill();
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
