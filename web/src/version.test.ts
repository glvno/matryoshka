// SPDX-License-Identifier: GPL-3.0-only
// The version strings agree: package.json (the web app), modular.c (the firmware) and host_ui.h (the FM-1 tab's wasm build).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { version } from '../package.json';
import { versionLabel } from './version';

const text = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const felucca = (rel: string): string => {
  const m = /#define\s+FELUCCA_VERSION\s+"([^"]+)"/.exec(text(rel));
  if (!m) throw new Error(`no FELUCCA_VERSION in ${rel}`);
  return m[1];
};

describe('version strings', () => {
  const base = version.replace(/-dev$/, '');

  it('package.json is X.Y.Z or X.Y.Z-dev', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(-dev)?$/);
  });

  it("the firmware's default and the FM-1 tab's are v<base>-DEV (a release build passes its own)", () => {
    expect(felucca('../../firmware/src/modular.c')).toBe(`v${base}-DEV`);
    expect(felucca('../../firmware/test/host_ui.h')).toBe(`v${base}-DEV`);
  });

  it('the About card names the commit on dev builds only', () => {
    expect(versionLabel('1.0.0-dev', '062e77c')).toBe('1.0.0-dev (062e77c)');
    expect(versionLabel('1.0.0-dev', '')).toBe('1.0.0-dev');
    expect(versionLabel('1.0.0', '062e77c')).toBe('1.0.0');
  });
});
