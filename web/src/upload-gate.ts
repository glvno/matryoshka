// SPDX-License-Identifier: GPL-3.0-only
// Under Live, every structural change in the editor used to send the whole patch to the FM-1 again, also one that leaves
// the FM-1's patch as it was (a comment added, edited or moved, any layout change). The gate keeps the encoded patch the
// FM-1 holds (patchbin.ts) and says whether a change needs an upload: only when the encoded bytes differ.

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export class UploadGate {
  /** the encoded patch the FM-1 holds, as far as the editor knows; null: unknown */
  private held: Uint8Array | null = null;
  /** the format of the FM-1's copy (its byte 1), kept while the FM-1 edits the copy itself; undefined: unknown */
  private fmt: number | undefined;
  /** an edit went to the FM-1 live (a value, a track): `held` is behind until refresh */
  private behind = false;

  /** the FM-1 took these bytes (an upload) */
  took(bin: Uint8Array): void {
    this.held = bin;
    this.fmt = bin[1];
    this.behind = false;
  }

  /** not known any more (a failed upload, a new connection, another patch loaded there) */
  forget(): void {
    this.held = null;
    this.fmt = undefined;
    this.behind = false;
  }

  /** the FM-1 edited its copy itself (a knob, a P-lock, a step there): its bytes are not known any more, its format is,
   *  as an edit there only raises it (D-1041; raised says when) */
  changedThere(): void {
    this.held = null;
    this.behind = false;
  }

  /** the FM-1 set a parameter appended in format `since` (ParamDef.since): its copy is in that format at least */
  raised(since: number): void {
    if (this.fmt !== undefined && since > this.fmt) this.fmt = since;
  }

  /** an edit went to the FM-1 live: `held` is brought up to date by refresh */
  edited(): void {
    if (this.held) this.behind = true;
  }

  /** whether refresh has something to do */
  get stale(): boolean {
    return this.behind;
  }

  /** the format of the patch the FM-1 holds (its byte 1), undefined when unknown */
  get format(): number | undefined {
    return this.fmt;
  }

  /** the editor's patch encoded, after live edits only (no structural change since): what the FM-1 now holds. Its format
   *  stays the higher one: a value set back to its default narrows the editor's bytes, never the FM-1's copy (D-1041) */
  refresh(bin: Uint8Array): void {
    if (!this.behind) return;
    this.held = bin;
    this.fmt = Math.max(this.fmt ?? 0, bin[1]);
    this.behind = false;
  }

  /** a structural change: whether the FM-1 needs the patch, encoded now as `bin` (when unknown or behind: yes) */
  needs(bin: Uint8Array): boolean {
    return !this.held || this.behind || !same(this.held, bin);
  }
}
