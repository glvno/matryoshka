// SPDX-License-Identifier: GPL-3.0-only
import { createInterface } from 'node:readline';

/** One command line out, one reply back. Comments do not consume a reply. */
export class EmuChannel {
  constructor(proc, { timeoutMs = 120000, onComment = () => {} } = {}) {
    this.proc = proc;
    this.timeoutMs = timeoutMs;
    this.waiting = [];
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.startupTimer = setTimeout(() => this.fail('timed out waiting for # ready'), timeoutMs);
      proc.on('exit', (code, signal) => this.fail(`exited (${signal ?? code})`));
      proc.on('error', (error) => this.fail(error.message));
      proc.stdin.on('error', (error) => this.fail(error.message));
      proc.stdout.on('end', () => this.fail('closed its reply stream'));
      createInterface({ input: proc.stdout }).on('line', (line) => {
        if (this.error) return;
        if (line.startsWith('# ')) {
          onComment(line);
          if (line.startsWith('# ready')) { clearTimeout(this.startupTimer); resolve(); }
        } else {
          const next = this.waiting.shift();
          if (!next) return this.fail(`sent an unexpected reply: ${line}`);
          clearTimeout(next.timer);
          next.resolve(line);
        }
      });
    });
  }
  get pending() { return this.waiting.map((w) => w.line); }
  fail(reason) {
    if (this.error) return;
    this.error = new Error(`m1emu ${reason}${this.waiting.length ? `; waiting for ${this.waiting[0].line}` : ''}`);
    clearTimeout(this.startupTimer);
    this.rejectReady(this.error);
    for (const w of this.waiting.splice(0)) { clearTimeout(w.timer); w.reject(this.error); }
    this.proc.kill();
  }
  cmd(line) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(`timed out after ${this.timeoutMs} ms`), this.timeoutMs);
      this.waiting.push({ line, resolve, reject, timer });
      this.proc.stdin.write(line + '\n');
    });
  }
}
