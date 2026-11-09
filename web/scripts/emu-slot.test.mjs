// SPDX-License-Identifier: GPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { acquireEmulatorSlot, withDeadline } from './emu-slot.mjs';

describe('emulator scheduling', () => {
  it('queues another checkout and releases the slot when its owner is killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emu-slot-test-')), path = join(dir, 'slot');
    const source = `import { acquireEmulatorSlot } from ${JSON.stringify(new URL('./emu-slot.mjs', import.meta.url).href)};
      await acquireEmulatorSlot({path: ${JSON.stringify(path)}, log: () => {}}); console.log('ready');`;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
    let release;
    try {
      await withDeadline(() => once(owner.stdout, 'data'), 5000, 'owner readiness');
      let acquired = false;
      const next = acquireEmulatorSlot({ path, log: () => {} }).then((r) => { acquired = true; return r; });
      await new Promise((r) => setTimeout(r, 100));
      expect(acquired).toBe(false);
      owner.kill('SIGKILL');
      release = await withDeadline(() => next, 5000, 'queued runner');
      expect(acquired).toBe(true);
    } finally { owner.kill(); release?.(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('bounds a scenario that never resolves', async () => {
    await expect(withDeadline(() => new Promise(() => {}), 20, 'recCountIn')).rejects.toThrow('recCountIn timed out');
  });
});
