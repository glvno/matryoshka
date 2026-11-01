// SPDX-License-Identifier: GPL-3.0-only
// Which Matryoshka a connected FM-1 runs, and whether this site comes with a newer one (#216). Firmware from 1.8 says its
// version in INFO's last three bytes; older firmware says only its identity, FM-1_7XY (major and minor), through M-VAVE's
// identity handshake (flasher/fm1ota.js, mirror.ts identifyFm1). Dev and CI builds report 0.0.0 / FM-1_7000000 (FM-1_700
// before 1.8) and are never offered an update.

import { matryoshkaVersion } from './flasher/fm1pkg.js';
import type { Info } from './protocol';

/** a Matryoshka version; `patch` is null when only the old three-digit identity is known */
export interface FirmwareVersion { major: number; minor: number; patch: number | null }
/** what the FM-1 runs: a version, 'dev' (a dev or CI build), or null (not known, or not Matryoshka) */
export type Running = FirmwareVersion | 'dev' | null;

/** the FM-1's version from INFO (firmware from 1.8), else from its identity (FM-1_7XY or FM-1_7MMmmpp) */
export function runningVersion(info: Pick<Info, 'firmware'> | null, identity?: string | null): Running {
  const f = info?.firmware;
  if (f) return f.major || f.minor || f.patch ? { ...f } : 'dev';
  return (matryoshkaVersion(identity ?? '') as Running) ?? null;
}

/** "1.8.0", or "1.7" when the patch is not known */
export const versionText = (v: FirmwareVersion): string => [v.major, v.minor, ...(v.patch === null ? [] : [v.patch])].join('.');

/** a package's version string ("v1.8.0", "1.8.0", "v1.8.0-RC1") as a version; null for a dev build ("v1.8.0-DEV") or
 *  anything else */
export function bundledVersion(s: string | null | undefined): FirmwareVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec((s ?? '').trim());
  if (!m || (m[4] && /dev/i.test(m[4]))) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/** the FM-1 runs an older Matryoshka than this site comes with: what to tell the user, else null (the same or newer, a dev
 *  build on either side, or either not known). With only major and minor known, the same major and minor is not older. */
export function updateOffer(running: Running, bundled: string | null | undefined): string | null {
  const b = bundledVersion(bundled);
  if (!b || !running || running === 'dev') return null;
  const older = running.major !== b.major ? running.major < b.major
    : running.minor !== b.minor ? running.minor < b.minor
    : running.patch !== null && running.patch < (b.patch ?? 0);
  return older ? `This FM-1 runs Matryoshka ${versionText(running)}. This site comes with ${versionText(b)}.` : null;
}
