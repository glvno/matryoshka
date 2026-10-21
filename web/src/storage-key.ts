// SPDX-License-Identifier: GPL-3.0-only
// localStorage keys that were renamed from the upstream name (modular-1.*) to matryoshka.*: the first read under the
// new key takes over what the old one held, so a patch, bank or library saved before the rename is not lost.

/** `key`, after moving `legacy`'s value to it when only the legacy key holds one (the legacy key is kept, as a backup) */
export function renamedKey(key: string, legacy: string): string {
  try {
    if (typeof localStorage === 'undefined' || localStorage.getItem(key) !== null) return key;
    const v = localStorage.getItem(legacy);
    if (v !== null) localStorage.setItem(key, v);
  } catch {
    // storage blocked (private mode, a test without it): nothing to move
  }
  return key;
}
