// SPDX-License-Identifier: GPL-3.0-only
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { EmuChannel } from './emu-channel.mjs';

function child() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = () => { proc.killed = true; };
  return proc;
}
// A stalled test must settle itself; the outer bound makes a missing deadline fail promptly.
const bounded = (p) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('still waiting')), 150))]);

describe('emulator command channel', () => {
  it('fails a command when the emulator exits after announcing readiness', async () => {
    const proc = child(), channel = new EmuChannel(proc, { timeoutMs: 30 });
    proc.stdout.write('# ready\n');
    await channel.ready;
    const pending = bounded(channel.cmd('wait 200'));
    proc.emit('exit', 1, null);
    await expect(pending).rejects.toThrow(/exited.*wait 200/);
  });
  it('bounds an unanswered command and rejects queued and future commands after losing synchronization', async () => {
    const proc = child(), channel = new EmuChannel(proc, { timeoutMs: 30 });
    proc.stdout.write('# ready\n');
    await channel.ready;
    const first = expect(bounded(channel.cmd('wait 200'))).rejects.toThrow(/timed out.*wait 200/);
    const second = expect(bounded(channel.cmd('ms'))).rejects.toThrow(/wait 200/);
    await Promise.all([first, second]);
    expect(proc.killed).toBe(true);
    await expect(channel.cmd('text HOME')).rejects.toThrow(/wait 200/);
  });
  it('fails startup if readiness never arrives', async () => {
    const channel = new EmuChannel(child(), { timeoutMs: 30 });
    await expect(bounded(channel.ready)).rejects.toThrow(/timed out.*ready/);
  });
  it('keeps comments out of the reply queue', async () => {
    const proc = child(), comments = [], channel = new EmuChannel(proc, { onComment: (s) => comments.push(s) });
    proc.stdout.write('# ready\n');
    await channel.ready;
    const one = channel.cmd('ms'), two = channel.cmd('text HOME');
    proc.stdout.write('# trace\nms 42\ntext 1\n');
    expect(await one).toBe('ms 42');
    expect(await two).toBe('text 1');
    expect(comments).toEqual(['# ready', '# trace']);
  });
});
