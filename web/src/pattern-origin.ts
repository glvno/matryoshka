// SPDX-License-Identifier: GPL-3.0-only
/** Format 54 / INFO bit 23. A snapshot is complete only after a valid begin and end,
 * even when empty. Interrupted or malformed snapshots never leave usable ownership. */
export const FEATURE_PATTERN_ORIGINS = 1 << 23;
export interface PatternOrigin { module: number; pattern: number; identity: number }
export type OriginUpdate = { kind: 'reset' } | { kind: 'snapshot'; records: PatternOrigin[] } | { kind: 'change'; record: PatternOrigin };
export class PatternOrigins {
  private blocked = false;
  private expected = 0;
  private pending: Map<number, PatternOrigin> | null = null;
  private current: Map<number, PatternOrigin> | null = null;
  reset(): void { this.pending = this.current = null; }
  suspend(): void { this.reset(); this.blocked = true; }
  resume(): void { this.reset(); this.blocked = false; }
  snapshot(): PatternOrigin[] | null { return this.current ? [...this.current.values()] : null; }
  receive(bytes: Uint8Array): OriginUpdate {
    const invalid = (): OriginUpdate => { this.reset(); return { kind: 'reset' }; };
    if (this.blocked) return invalid();
    if (bytes.length !== 6) return invalid();
    const module = bytes[0], pattern = bytes[1], identity = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
    if (module === 255) {
      if (identity > 16 * 64 || pattern > 1) return invalid();
      if (pattern === 0) { this.reset(); this.pending = new Map(); this.expected = identity; return { kind: 'reset' }; }
      if (!this.pending || identity !== this.expected || this.pending.size !== this.expected) return invalid();
      this.current = this.pending; this.pending = null;
      return { kind: 'snapshot', records: this.snapshot()! };
    }
    if (module >= 128 || pattern >= 64) return invalid();
    const record = { module, pattern, identity }, key = module * 64 + pattern;
    if (this.pending) {
      if (this.pending.has(key) || this.pending.size >= 16 * 64) return invalid();
      this.pending.set(key, record);
      return { kind: 'reset' }; // pending rows convey no usable ownership
    }
    if (!this.current) return invalid();
    this.current.set(key, record);
    return { kind: 'change', record };
  }
}
