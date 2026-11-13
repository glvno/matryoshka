// SPDX-License-Identifier: GPL-3.0-only
// Membership only: no saved patch, slot name or bytes are migrated here.
const HERA_NAMES = ['HERA 6', 'HERA 5', 'HERA 4', 'HERA 3'];

export function releasedFactoryHas(names: readonly string[], currentName: string): boolean {
  return names.includes(currentName) || (HERA_NAMES.includes(currentName) && HERA_NAMES.some(was => names.includes(was)));
}
