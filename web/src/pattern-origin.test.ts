// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { PatternOrigins } from './pattern-origin';
const bytes = (module: number, pattern: number, identity = 0) => {
  const b = new Uint8Array(6); b[0] = module; b[1] = pattern;
  new DataView(b.buffer).setUint32(2, identity, true); return b;
};
it('commits only a complete bounded snapshot and decodes unsigned identities', () => {
  const s = new PatternOrigins();
  expect(s.receive(bytes(255, 0, 1))).toEqual({ kind: 'reset' });
  s.receive(bytes(127, 63, 0xfedcba98));
  expect(s.snapshot()).toBeNull();
  expect(s.receive(bytes(255, 1, 1))).toEqual({ kind: 'snapshot', records: [{ module: 127, pattern: 63, identity: 0xfedcba98 }] });
  expect(s.receive(bytes(127, 63, 0))).toEqual({ kind: 'change', record: { module: 127, pattern: 63, identity: 0 } });
  s.receive(bytes(255, 0));
  expect(s.snapshot()).toBeNull();
  expect(s.receive(bytes(255, 1))).toEqual({ kind: 'snapshot', records: [] });
});
it.each(['missing', 'duplicate', 'module', 'pattern', 'short', 'overflow', 'end', 'reconnect'])('discards stale ownership on %s', (fault) => {
  const s = new PatternOrigins(); s.receive(bytes(255, 0)); s.receive(bytes(255, 1));
  s.receive(bytes(1, 0, 123));
  s.receive(bytes(255, 0, 2)); s.receive(bytes(1, 0, 123));
  if (fault === 'missing') s.receive(bytes(255, 1, 2));
  if (fault === 'duplicate') s.receive(bytes(1, 0, 123));
  if (fault === 'module') s.receive(bytes(128, 0, 123));
  if (fault === 'pattern') s.receive(bytes(1, 64, 123));
  if (fault === 'short') s.receive(bytes(1, 0).slice(0, 5));
  if (fault === 'overflow') s.receive(bytes(255, 0, 1025));
  if (fault === 'end') s.receive(bytes(255, 1, 1));
  if (fault === 'reconnect') s.reset();
  expect(s.snapshot()).toBeNull();
  expect(s.receive(bytes(1, 0, 456))).toEqual({ kind: 'reset' });
});

it('invalidates an in-progress snapshot when a patch switches or upload queues', () => {
  const s = new PatternOrigins(); s.receive(bytes(255, 0, 1)); s.receive(bytes(2, 0, 123));
  s.suspend(); // queue/load boundary, before any chunk write
  expect(s.receive(bytes(255, 1, 1))).toEqual({ kind: 'reset' });
  s.receive(bytes(255, 0, 1)); s.receive(bytes(2, 0, 123)); s.receive(bytes(255, 1, 1));
  expect(s.snapshot()).toBeNull();
  s.resume(); // successful COMMIT acknowledgment; only a new complete snapshot may authorize indices
  expect(s.receive(bytes(255, 1, 1))).toEqual({ kind: 'reset' });
  s.receive(bytes(255, 0, 1)); s.receive(bytes(3, 0, 456)); s.receive(bytes(255, 1, 1));
  expect(s.snapshot()).toEqual([{ module: 3, pattern: 0, identity: 456 }]);
});
