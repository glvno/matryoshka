// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// Dragging a patch onto a drop target (patch-drag.ts): the release's own click is swallowed, and a drop that asks for a
// name (main.ts dropOnFm1 → name-prompt.ts) opens its prompt only after that, so the prompt's Add takes the first click,
// the one Enter makes included (the paletteEditor scenario's Enter right after the release was eaten, #1236).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askName } from './name-prompt';
import { patchDragSource, patchDropTarget } from './patch-drag';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

/** a pointer drag from the source row, released over the chip, and the click the release makes there */
function drag(press: HTMLElement, target: HTMLElement): void {
  document.elementFromPoint = () => target;
  press.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 30, bubbles: true }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 30, clientY: 30, bubbles: true }));
  target.click();
}

/** a source row and a chip that asks for a name on a drop; the names given */
function rig() {
  document.body.innerHTML = '<span id="src">Pal Test</span><div id="chip"></div>';
  const src = document.getElementById('src')!, chip = document.getElementById('chip')!;
  const named: (string | null)[] = [];
  let clicks = 0;
  chip.onclick = () => void clicks++;
  patchDragSource(src, () => ({ name: 'Pal Test', patch: () => null }));
  patchDropTarget(chip, (item) => void askName({ title: 'Name it in the palette', initial: item.name, anchor: chip }).then((n) => void named.push(n)));
  return { src, chip, named, clicks: () => clicks };
}

/** timers run one at a time until the prompt shows (the page's next tasks, in order) */
const untilPrompt = (): HTMLFormElement | null => {
  for (let i = 0; i < 5 && !document.querySelector('.name-prompt'); i++) vi.advanceTimersToNextTimer();
  return document.querySelector<HTMLFormElement>('.name-prompt');
};

describe('a drop that asks for a name', () => {
  it('the release\'s click reaches nothing; the prompt opens', () => {
    const { src, chip, clicks } = rig();
    drag(src, chip);
    expect(clicks()).toBe(0);
    expect(untilPrompt()).not.toBeNull();
  });

  it('Add pressed the moment the prompt shows takes the name', async () => {
    const { src, chip, named } = rig();
    drag(src, chip);
    untilPrompt()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await Promise.resolve();
    expect(named).toEqual(['Pal Test']);
    expect(document.querySelector('.name-prompt')).toBeNull();
  });
});
