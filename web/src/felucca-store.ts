// SPDX-License-Identifier: GPL-3.0-only
// Installing over Felucca (glvno/matryoshka#73): our patch store and bank (firmware/src/slotstore.c: 0x97000, 0x98000,
// 0xA0000..0xDFFFF) lie inside Felucca's store (projects 0x97000.., samples 0xA0000..0xDBFFF, user presets 0xDC000..), and the first start of Matryoshka writes the factory
// patches there. The Flash tab asks for an extra confirmation when the FM-1 reports a Felucca identity.

/** a running Felucca build: FM-1_900 (dev) or FM-1_9XY (release X.Y). Not an update loader (ota-...). Matryoshka's own
 *  release builds use the same numbers until #79 gives it an identity of its own, so they are flagged too. */
export const runsFelucca = (identity: string): boolean => /^FM-1_9\d\d$/.test(identity);

export const FELUCCA_WARNING =
  'This FM-1 runs Felucca. Matryoshka keeps its patches in flash sectors that Felucca uses for its projects, samples and ' +
  'user presets (0x97000, 0x98000, 0xA0000..0xDFFFF): its first start writes the 64 factory patches there, which erases ' +
  'almost all of them, and every SAVE writes there again. Save what you want to keep with Felucca first. Going back to Felucca later does not ' +
  'bring them back. Patches stored by the official M-VAVE firmware are not affected.';
