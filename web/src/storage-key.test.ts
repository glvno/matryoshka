// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { renamedKey } from './storage-key';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

describe('renamedKey (modular-1.* -> matryoshka.*)', () => {
  it('moves a value saved under the old key, and keeps the old key as a backup', () => {
    mem.set('modular-1.patch', '{"p":1}');
    expect(renamedKey('matryoshka.patch', 'modular-1.patch')).toBe('matryoshka.patch');
    expect(mem.get('matryoshka.patch')).toBe('{"p":1}');
    expect(mem.get('modular-1.patch')).toBe('{"p":1}');
  });

  it('never overwrites a value already under the new key', () => {
    mem.set('modular-1.bank', 'old');
    mem.set('matryoshka.bank', 'new');
    renamedKey('matryoshka.bank', 'modular-1.bank');
    expect(mem.get('matryoshka.bank')).toBe('new');
  });

  it('does nothing when neither key holds a value, or when storage throws', () => {
    renamedKey('matryoshka.roll-h', 'modular-1.roll-h');
    expect(mem.has('matryoshka.roll-h')).toBe(false);
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('blocked'); } };
    expect(renamedKey('matryoshka.assemblies', 'modular-1.assemblies')).toBe('matryoshka.assemblies');
  });
});
