// SPDX-License-Identifier: GPL-3.0-only
// The colours of a poly assembly's voices (V1, V2, ...): the Scope module's per-voice traces (scope-view.ts) and the
// swatches of the voices panel (flaws-panel.ts). Tokens `--voice1` .. `--voice8` in style.css (the knob hues, then rose
// and blue, each with its light and dark value); voices past the eighth reuse them in order.

/** how many distinct voice colours there are */
export const VOICE_COLORS = 8;

/** the custom property of voice i (0-based) */
export const voiceToken = (i: number): string => `--voice${(((i % VOICE_COLORS) + VOICE_COLORS) % VOICE_COLORS) + 1}`;

/** the CSS colour of voice i, for styles */
export const voiceColor = (i: number): string => `var(${voiceToken(i)})`;
