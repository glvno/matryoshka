// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ensureRigIgnored, RigIsolationError } from './rig-link.mjs';

const B = { glo: 7 };
const ENC = { algo: 1, k1: 2 };
function target({ supported = true, ignored = false, menu = true, applies = true } = {}) {
  return {
    ignored, saved: false, writes: [], tab: 0, open: false,
    async info() { return { features: supported ? 1 << 19 : 0, editorIgnored: this.ignored }; },
    async home() { this.open = false; return true; },
    async tap() { this.open = !this.open; },
    async elapse() {},
    async waitText() { return this.open; },
    async turn(enc) {
      this.writes.push(enc);
      if (enc === ENC.algo) this.tab = (this.tab + 1) % 6;
      if (enc === ENC.k1 && applies && this.open && this.tab === 3) this.ignored = true;
    },
    async screen() {
      return { texts: this.open && menu && this.tab === 3
        ? [{ s: 'SYSTEM 2/2' }, { s: 'EDITOR' }, { s: this.ignored ? 'IGNORE' : 'ALLOW' }]
        : [{ s: 'FROM EDITOR' }] };
    },
    async diag(n) { if (n !== 129) throw new Error('unexpected diagnostic'); this.saved = this.ignored; },
  };
}

describe('rig editor isolation', () => {
  it('changes ALLOW to IGNORE, saves settings, and restores IGNORE after a reset', async () => {
    const rig = target();
    await ensureRigIgnored(rig, B, ENC);
    expect(rig.ignored).toBe(true);
    expect(rig.saved).toBe(true);
    expect(rig.open).toBe(false);
    rig.ignored = rig.saved = false;
    await ensureRigIgnored(rig, B, ENC);
    expect(rig.ignored).toBe(true);
    expect(rig.saved).toBe(true);
  });
  it('leaves an already ignored rig and its panel state alone', async () => {
    const rig = target({ ignored: true });
    rig.open = true;
    await ensureRigIgnored(rig, B, ENC);
    expect(rig.open).toBe(true);
    expect(rig.writes).toEqual([]);
  });
  it('persists an already ignored rig before an install or a new run', async () => {
    const rig = target({ ignored: true });
    await ensureRigIgnored(rig, B, ENC, true);
    expect(rig.saved).toBe(true);
    expect(rig.writes).toEqual([]);
  });
  it('refuses unsupported firmware before touching the panel', async () => {
    const rig = target({ supported: false });
    await expect(ensureRigIgnored(rig, B, ENC)).rejects.toBeInstanceOf(RigIsolationError);
    expect(rig.writes).toEqual([]);
  });
  it('never turns a settings knob when only the FROM EDITOR footer matches', async () => {
    const rig = target({ menu: false });
    await expect(ensureRigIgnored(rig, B, ENC)).rejects.toThrow(/EDITOR row/);
    expect(rig.writes).not.toContain(ENC.k1);
    expect(rig.saved).toBe(false);
  });
  it('refuses to proceed when INFO still reports ALLOW after turning the setting', async () => {
    const rig = target({ applies: false });
    await expect(ensureRigIgnored(rig, B, ENC)).rejects.toThrow(/INFO/);
    expect(rig.saved).toBe(false);
    expect(rig.open).toBe(false);
  });
  it('treats a lost device as a fatal isolation failure', async () => {
    const rig = target();
    rig.info = async () => { throw new Error('the rig did not answer'); };
    await expect(ensureRigIgnored(rig, B, ENC)).rejects.toBeInstanceOf(RigIsolationError);
  });
});
