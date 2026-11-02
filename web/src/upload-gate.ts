// SPDX-License-Identifier: GPL-3.0-only
// Under Live, every structural change in the editor used to send the whole patch to the FM-1 again, also one that leaves
// the FM-1's patch as it was (a comment added, edited or moved, any layout change). The gate keeps the encoded patch the
// FM-1 holds (patchbin.ts) and says whether a change needs an upload: only when the encoded bytes differ.

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export class UploadGate {
  /** the encoded patch the FM-1 holds, as far as the editor knows; null: unknown */
  private held: Uint8Array | null = null;
  /** an edit went to the FM-1 live (a value, a track): `held` is behind until refresh */
  private behind = false;

  /** the FM-1 took these bytes (an upload) */
  took(bin: Uint8Array): void {
    this.held = bin;
    this.behind = false;
  }

  /** not known any more (a failed upload, a new connection, another patch loaded there) */
  forget(): void {
    this.held = null;
    this.behind = false;
  }

  /** an edit went to the FM-1 live: `held` is brought up to date by refresh */
  edited(): void {
    if (this.held) this.behind = true;
  }

  /** whether refresh has something to do */
  get stale(): boolean {
    return this.behind;
  }

  /** the editor's patch encoded, after live edits only (no structural change since): what the FM-1 now holds */
  refresh(bin: Uint8Array): void {
    if (!this.behind) return;
    this.held = bin;
    this.behind = false;
  }

  /** a structural change: whether the FM-1 needs the patch, encoded now as `bin` (when unknown or behind: yes) */
  needs(bin: Uint8Array): boolean {
    return !this.held || this.behind || !same(this.held, bin);
  }
}
