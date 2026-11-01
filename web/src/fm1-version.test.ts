// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { matryoshkaVersion } from './flasher/fm1pkg.js';
import { bundledVersion, runningVersion, updateOffer } from './fm1-version';

describe('Matryoshka identities (#216)', () => {
  it('reads the seven-digit form and the three-digit one from 1.0 .. 1.7', () => {
    expect(matryoshkaVersion('FM-1_7010800')).toEqual({ major: 1, minor: 8, patch: 0 });
    expect(matryoshkaVersion('FM-1_7011203')).toEqual({ major: 1, minor: 12, patch: 3 });
    expect(matryoshkaVersion('FM-1_7100000')).toEqual({ major: 10, minor: 0, patch: 0 });
    expect(matryoshkaVersion('FM-1_717')).toEqual({ major: 1, minor: 7, patch: null });
    expect(matryoshkaVersion('FM-1_7000000')).toBe('dev');
    expect(matryoshkaVersion('FM-1_700')).toBe('dev');
  });

  it('is not fooled by stock, Felucca, M-VAVE Open, loaders or other lengths', () => {
    for (const id of ['FM-1_015', 'FM-1_912', 'FM-1_8000014', 'FM-1_800', 'ota-FM-1_700', 'FM-1_70108', 'FM-1_7', '', 'FM-1_70108000'])
      expect(matryoshkaVersion(id)).toBeNull();
  });
});

describe('what the FM-1 runs and the update offer (#216)', () => {
  it('takes INFO\'s version first, else the identity', () => {
    expect(runningVersion({ firmware: { major: 1, minor: 8, patch: 2 } }, 'FM-1_717')).toEqual({ major: 1, minor: 8, patch: 2 });
    expect(runningVersion({ firmware: { major: 0, minor: 0, patch: 0 } })).toBe('dev');
    expect(runningVersion({}, 'FM-1_714')).toEqual({ major: 1, minor: 4, patch: null });
    expect(runningVersion(null, 'FM-1_7010800')).toEqual({ major: 1, minor: 8, patch: 0 });
    expect(runningVersion(null, 'FM-1_912')).toBeNull();
    expect(runningVersion(null, null)).toBeNull();
  });

  it('reads the bundled package\'s version, not a dev build', () => {
    expect(bundledVersion('v1.8.0')).toEqual({ major: 1, minor: 8, patch: 0 });
    expect(bundledVersion('1.8.1')).toEqual({ major: 1, minor: 8, patch: 1 });
    expect(bundledVersion('v1.8.0-RC1')).toEqual({ major: 1, minor: 8, patch: 0 });
    expect(bundledVersion('v1.8.0-DEV')).toBeNull();
    expect(bundledVersion('')).toBeNull();
    expect(bundledVersion('?')).toBeNull();
  });

  it('offers an update only to an older Matryoshka', () => {
    expect(updateOffer({ major: 1, minor: 7, patch: null }, 'v1.8.0')).toBe('This FM-1 runs Matryoshka 1.7. This site comes with 1.8.0.');
    expect(updateOffer({ major: 1, minor: 8, patch: 0 }, 'v1.8.1')).toBe('This FM-1 runs Matryoshka 1.8.0. This site comes with 1.8.1.');
    expect(updateOffer({ major: 1, minor: 9, patch: 0 }, 'v1.10.0')).not.toBeNull();   // 10 > 9, not "1.1" < "1.9"
    expect(updateOffer({ major: 1, minor: 8, patch: 0 }, 'v1.8.0')).toBeNull();
    expect(updateOffer({ major: 1, minor: 7, patch: null }, 'v1.7.1')).toBeNull();     // patch unknown: not older
    expect(updateOffer({ major: 2, minor: 0, patch: 0 }, 'v1.8.0')).toBeNull();
    expect(updateOffer('dev', 'v1.8.0')).toBeNull();
    expect(updateOffer(null, 'v1.8.0')).toBeNull();
    expect(updateOffer({ major: 1, minor: 7, patch: null }, 'v1.8.0-DEV')).toBeNull();
    expect(updateOffer({ major: 1, minor: 7, patch: null }, '')).toBeNull();
  });
});
