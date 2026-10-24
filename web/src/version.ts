// SPDX-License-Identifier: GPL-3.0-only
// The app's version as the About card shows it (a dev build, "1.0.0-dev", names its commit; a release only its version),
// and the firmware version Get started > Install names.
import { version } from '../package.json';

/** the commit this build was made from ('' if unknown); vite.config.ts defines __BUILD__ for the app and for vitest */
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : '';

/** "1.0.0-dev (062e77c)" for a dev version with a known commit, else the version itself */
export function versionLabel(v: string = version, build: string = BUILD): string {
  return v.endsWith('-dev') && build ? `${v} (${build})` : v;
}

/** the firmware version Get started > Install installs, as vite.config.ts found it ('' outside a Vite build) */
export const INSTALL_VERSION: string = typeof __INSTALL_VERSION__ === 'string' ? __INSTALL_VERSION__ : '';

/** the text the Install entry shows for a firmware package's version: "v1.2" for 1.2.0, "v1.2.1" for 1.2.1, a version
 *  with a suffix in full ("v1.3.0-dev"); anything else as it is */
export function shortVersion(v: string): string {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim());
  if (!m) return v.trim();
  const [, major, minor, patch, suffix] = m;
  if (suffix) return `v${major}.${minor}.${patch}${suffix}`;
  return patch === '0' ? `v${major}.${minor}` : `v${major}.${minor}.${patch}`;
}

/** Get started > Install's text: "Install v1.2", or "Install firmware" when the version is unknown */
export const installLabel = (v: string = INSTALL_VERSION): string => (v ? `Install ${shortVersion(v)}` : 'Install firmware');
