// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { runEmulatorProcess } from './emu-process.mjs';

it('propagates an emulator failure', async () => {
  expect(await runEmulatorProcess(process.execPath, ['-e', 'process.exit(7)'], { log: () => {}, stdio: 'ignore' })).toBe(7);
});
it('stops a stalled emulator even when it ignores SIGTERM', async () => {
  const started = Date.now();
  expect(await runEmulatorProcess(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { timeoutMs: 250, killAfterMs: 100, log: () => {}, stdio: 'ignore' })).toBe(124);
  expect(Date.now() - started).toBeLessThan(3000);
});
