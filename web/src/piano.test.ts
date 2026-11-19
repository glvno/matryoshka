// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  // jsdom has no Element.scrollTo; the piano calls it from an animation frame to bring the lettered keys into view
  beforeAll(() => {
    HTMLElement.prototype.scrollTo ??= () => {};
  });
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

describe('the keys after a resize (#1116)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  // jsdom lays nothing out, so this reads the rule: the keys' strip has no height of its own (container-type: size), and
  // Chrome left it only its scrollbar's height when the deck's row was sized from its content and then stretched (a load
  // or a resize that made the strip scroll). The row must take the deck's height as a fixed track instead.
  it('the deck row is a fixed track, not one stretched from its content', () => {
    const css = readFileSync(join(process.cwd(), 'src/style.css'), 'utf8'); // (vitest runs in web/; jsdom's import.meta.url is no file URL)
    const rule = /(?:^|\n)\.deck-row \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/grid-template-rows: 100%;/);
    expect(css).toMatch(/\.piano-keys \{[^}]*container-type: size;/);
  });

  it('a change of the strip\'s width brings the lettered keys back to the middle', () => {
    let fire = (): void => {};
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { fire = cb; } observe(): void {} disconnect(): void {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const root = document.createElement('div');
    document.body.append(root);
    new Piano(root, { on: () => {}, off: () => {}, shift: () => {} });
    const strip = root.querySelector<HTMLElement>('.piano-keys')!;
    let width = 1600;
    Object.defineProperty(strip, 'clientWidth', { get: () => width });
    const scrollTo = vi.fn();
    strip.scrollTo = scrollTo;
    fire();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    fire();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    width = 525;
    fire();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: expect.any(Number), behavior: 'auto' });
    // folded away (no width): nothing to centre
    width = 0;
    fire();
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
