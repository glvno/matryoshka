// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
// The snapshot sidebar (#1040): its left edge sets its width, held and remembered; its fold leaves a strip with the letter
// on screen, and a click on the strip opens it again.
import { beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_MARK, SIDE_W, SNAP_SIDE_STORE, SnapSidebar } from './snap-side';

let store: Map<string, string>;
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

beforeEach(() => {
  store = new Map();
});

function make(): { side: SnapSidebar; root: HTMLElement } {
  const root = document.createElement('div');
  root.innerHTML = '<div id="output-scope"></div><div class="snapshot-strip"></div>';
  document.body.replaceChildren(root);
  return { side: new SnapSidebar(root, storage), root };
}

describe('snapshot sidebar (#1040)', () => {
  it('a drag on its left edge sets its width, held between the narrowest and the widest, and remembered', () => {
    const { side, root } = make();
    expect(side.width).toBe(SIDE_W.default);
    expect(root.style.getPropertyValue('--snap-side-w')).toBe(`${SIDE_W.default}px`);
    const edge = root.querySelector<HTMLElement>('.snap-side-edge')!;
    edge.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 500 }));
    edge.dispatchEvent(new MouseEvent('pointermove', { clientX: 440 }));   // (anchored at its right: leftwards widens it)
    edge.dispatchEvent(new MouseEvent('pointerup'));
    expect(side.width).toBe(SIDE_W.default + 60);
    expect(make().side.width).toBe(SIDE_W.default + 60);
    side.setWidth(10);
    expect(side.width).toBe(SIDE_W.min);
    side.setWidth(10_000);
    expect(side.width).toBeLessThanOrEqual(Math.max(SIDE_W.min, innerWidth - 520));
  });

  it('folds to a strip that shows the letter on screen (• for the current patch); a click on it opens the sidebar', () => {
    const { side, root } = make();
    const mark = root.querySelector<HTMLButtonElement>('.snap-side-mark')!;
    side.setShown('C');
    expect(mark.textContent).toBe('C');
    side.setShown(null);
    expect(mark.textContent).toBe(CURRENT_MARK);
    root.querySelector<HTMLButtonElement>('.snap-side-fold')!.click();
    expect([side.folded, root.classList.contains('folded')]).toEqual([true, true]);
    expect(make().side.folded).toBe(true);   // (remembered)
    const again = make();
    again.root.querySelector<HTMLButtonElement>('.snap-side-mark')!.click();
    expect([again.side.folded, again.root.classList.contains('folded')]).toEqual([false, false]);
    expect(JSON.parse(store.get(SNAP_SIDE_STORE)!).folded).toBe(false);
  });
});
