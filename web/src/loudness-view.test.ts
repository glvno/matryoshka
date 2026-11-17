// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The Output card's loudness readout (#940, loudness-view.ts): the integrated reading against the rule's one-key target
// (levels.ts), the numbers as shown, and reset.
import { expect, it } from 'vitest';
import { LOUDNESS, LOUDNESS_TOLERANCE } from './levels';
import { KMeter } from './loudness';
import { lufsText, OutputLoudness, ruleState } from './loudness-view';

it('says where an integrated reading sits against the one-key target and its tolerance', () => {
  expect(ruleState(-Infinity)).toBe('none');
  expect(ruleState(LOUDNESS)).toBe('on');
  expect(ruleState(LOUDNESS + LOUDNESS_TOLERANCE)).toBe('on');
  expect(ruleState(LOUDNESS - LOUDNESS_TOLERANCE - 0.1)).toBe('quiet');
  expect(ruleState(LOUDNESS + LOUDNESS_TOLERANCE + 0.1)).toBe('hot');
  expect(lufsText(-18.04)).toBe('−18.0');
  expect(lufsText(-Infinity)).toBe('–');
});

it('shows the reading on the card it made last and starts again at reset', () => {
  const sr = 48000;
  const view = new OutputLoudness();
  const el = view.element();
  document.body.append(el);
  const meter = new KMeter(sr);
  const s = Float32Array.from({ length: sr * 2 }, (_, i) => Math.pow(10, -20 / 20) * Math.sin((2 * Math.PI * 1000 * i) / sr));
  meter.push(s, s, s.length);
  view.push(meter.take());
  const int = el.querySelector<HTMLElement>('.loud-int')!;
  expect(int.textContent).toBe('−20.0');
  expect(int.dataset.rule).toBe('quiet');
  el.querySelector<HTMLButtonElement>('.loud-reset')!.click();
  expect(int.textContent).toBe('–');
  expect(int.dataset.rule).toBe('none');
});
