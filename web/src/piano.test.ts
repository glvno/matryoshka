// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Piano } from './piano';

const setup = (): { shift: ReturnType<typeof vi.fn>; down: HTMLButtonElement } => {
  const root = document.createElement('div');
  document.body.append(root);
  const shift = vi.fn();
  const piano = new Piano(root, { on: () => {}, off: () => {}, shift });
  document.body.append(piano.octaveControls);
  return { shift, down: piano.octaveControls.querySelector('button[aria-label="Octave down"]')! };
};

describe('the dock octave buttons (#208)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('a pointer click shifts and lets go of the focus, so Space goes to the transport', () => {
    const { shift, down } = setup();
    down.focus();
    down.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(shift).toHaveBeenCalledWith(-1);
    expect(document.activeElement).not.toBe(down);
  });

  it('a keyboard press shifts and keeps the focus', () => {
    const { shift, down } = setup();
    down.focus();
    down.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(shift).toHaveBeenCalledWith(-1);
    expect(document.activeElement).toBe(down);
  });
});
