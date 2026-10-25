// SPDX-License-Identifier: GPL-3.0-only
// The update card: when it shows, and where the release notes link points.
import { describe, expect, it } from 'vitest';
import { HIGHLIGHTS, minorOf, notesUrl, shouldShow } from './whats-new';

describe('whats-new', () => {
  it('takes the minor version', () => {
    expect(minorOf('1.2.0')).toBe('1.2');
    expect(minorOf('1.2.0-dev')).toBe('1.2');
    expect(minorOf('10.11.3')).toBe('10.11');
  });
  it('shows once to a returning visitor on a newer minor version', () => {
    expect(HIGHLIGHTS['1.2']).toBeDefined();
    expect(HIGHLIGHTS['1.3']).toBeDefined();
    expect(shouldShow('1.2.2', '1.3.1', true)).toBe(true);
    expect(shouldShow(null, '1.2.0', true)).toBe(true); // used 1.1, which kept no record
    expect(shouldShow('1.1.0', '1.2.0', true)).toBe(true);
    expect(shouldShow('1.2.0-dev', '1.2.0', true)).toBe(false);
    expect(shouldShow('1.2.0', '1.2.1', true)).toBe(false); // a patch release
    expect(shouldShow('1.2.0', '1.2.0', true)).toBe(false);
  });
  it('shows nothing on a first visit or without highlights', () => {
    expect(shouldShow(null, '1.2.0', false)).toBe(false);
    expect(shouldShow('1.2.0', '1.3.0', true)).toBe(!!HIGHLIGHTS['1.3']);
    expect(shouldShow('1.9.0', '1.10.0', true)).toBe(!!HIGHLIGHTS['1.10']);
  });
  it('compares numbers, not text', () => {
    HIGHLIGHTS['1.10'] = ['x'];
    expect(shouldShow('1.9.0', '1.10.0', true)).toBe(true);
    expect(shouldShow('1.10.0', '1.9.0', true)).toBe(false);
    delete HIGHLIGHTS['1.10'];
  });
  it('links a release to its notes and a dev build to the changelog', () => {
    expect(notesUrl('1.2.0')).toBe('https://github.com/glvno/matryoshka/releases/tag/v1.2.0');
    expect(notesUrl('1.2.0-dev')).toBe('https://github.com/glvno/matryoshka/blob/main/CHANGELOG.md');
  });
});
