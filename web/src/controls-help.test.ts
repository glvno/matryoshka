// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { CONTROLS, HELP_STATES } from './controls';
import { renderFm1Help } from './controls-help';

it('the ? card\'s FM-1 section: the notes, Everywhere, then each state\'s rows (#553)', () => {
  const s = document.createElement('section');
  s.innerHTML = '<h3>On the FM-1</h3>';
  renderFm1Help(s);
  expect(s.querySelector('h3')!.textContent).toBe('On the FM-1');
  expect(s.querySelectorAll('h4').length).toBe(1 + HELP_STATES.length);
  const text = s.textContent!;
  for (const r of CONTROLS) expect(text, r.id).toContain(r.help ?? r.does);
  expect(s.querySelector('.hrow .hkeys')!.textContent).toBe('OCT- + OCT+');
  renderFm1Help(s);
  expect(s.querySelectorAll('h4').length, 'drawn again, not twice').toBe(1 + HELP_STATES.length);
});
