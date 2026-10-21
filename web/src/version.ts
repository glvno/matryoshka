// SPDX-License-Identifier: GPL-3.0-only
// The app's version as the About card shows it: a dev build ("1.0.0-dev") names its commit, a release only its version.
import { version } from '../package.json';

/** the commit this build was made from ('' if unknown); vite.config.ts defines __BUILD__ for the app and for vitest */
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : '';

/** "1.0.0-dev (062e77c)" for a dev version with a known commit, else the version itself */
export function versionLabel(v: string = version, build: string = BUILD): string {
  return v.endsWith('-dev') && build ? `${v} (${build})` : v;
}
