// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from 'node:child_process';

/** Bound a smoke/boot process and stop its process group before releasing the emulator slot. */
export function runEmulatorProcess(command, args, { cwd, timeoutMs = 1800000, killAfterMs = 5000, log = console.log, stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio, detached: true });
    let stopping = false, stoppedStatus = 1, force;
    const kill = (signal) => { if (child.pid) try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const stop = (status) => {
      if (stopping) return;
      stopping = true;
      stoppedStatus = status;
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), killAfterMs);
    };
    const onSignal = () => stop(130), onExit = () => kill('SIGKILL');
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.once(signal, onSignal);
    process.once('exit', onExit);
    const started = Date.now();
    const heartbeat = setInterval(() => log(`emulator task: ${Math.round((Date.now() - started) / 1000)}s elapsed`), 30000);
    const deadline = setTimeout(() => { log(`emulator task timed out after ${timeoutMs} ms`); stop(124); }, timeoutMs);
    const cleanup = () => {
      clearInterval(heartbeat); clearTimeout(deadline); clearTimeout(force);
      for (const signal of signals) process.removeListener(signal, onSignal);
      process.removeListener('exit', onExit);
      kill('SIGKILL'); // Any descendant left after the command ended must not retain the slot's work.
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code) => { cleanup(); resolve(stopping ? stoppedStatus : code ?? 1); });
  });
}
