// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT_SCOPE_KEY, OUTPUT_SCOPE_STORE, OutputScope, SCREEN_H } from './output-scope';
import { ScopeScreens } from './scope-view';
import type { HostMsg } from './worklet';

/** an IntersectionObserver that sees an element as on screen unless it or a parent is hidden or folded (jsdom has no layout) */
const observers: { cb: IntersectionObserverCallback; els: Set<Element> }[] = [];
const layout = (): void => {
  for (const o of observers) o.cb([...o.els].map((el) => ({ target: el, isIntersecting: !el.closest('[hidden], .collapsed') }) as IntersectionObserverEntry), {} as IntersectionObserver);
};

let store: Map<string, string>;
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
let sent: HostMsg[];
let draws: number;
/** animation frames asked for, run by `flush` */
let frames: FrameRequestCallback[];
const flush = (): void => {
  for (const f of frames.splice(0)) f(0);
};

beforeEach(() => {
  store = new Map();
  sent = [];
  draws = 0;
  frames = [];
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', class {
    private o: { cb: IntersectionObserverCallback; els: Set<Element> };
    constructor(cb: IntersectionObserverCallback) { observers.push((this.o = { cb, els: new Set() })); }
    observe(el: Element) { this.o.els.add(el); }
    unobserve(el: Element) { this.o.els.delete(el); }
  });
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => (draws++, null));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function make(): { scope: OutputScope; screens: ScopeScreens; root: HTMLElement } {
  const root = document.createElement('div');
  root.hidden = true;
  document.body.replaceChildren(root);
  const screens = new ScopeScreens((m) => sent.push(m), () => true);
  const scope = new OutputScope(root, screens, storage);
  layout();
  return { scope, screens, root };
}

/** a stream's frame from the audio thread (2048 samples of a sine), then the animation frame it asks for */
const frame = (screens: ScopeScreens): void => {
  screens.receive(OUTPUT_SCOPE_KEY, [{ raw: Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i / 8)) }], 48000);
  flush();
};

describe('Output scope (#1029)', () => {
  it('shows at the top of the sidebar whenever the patch view does, with or without candidates (#1048)', () => {
    const { scope, root } = make();
    expect(root.hidden).toBe(false);
    expect(scope.open).toBe(true);
    scope.update(false);
    expect(scope.visible).toBe(false);
    scope.update(true);
    expect(scope.visible).toBe(true);
  });

  it('is the Scope module’s screen with its toolbar: Wave, FFT and Gram, the window and the scale', () => {
    const { root, scope } = make();
    const tools = root.querySelector('.scope-tools')!;
    expect([...tools.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['−', '+', 'Wave', 'FFT', 'Gram', 'auto']);
    tools.querySelectorAll('button')[4].dispatchEvent(new MouseEvent('click'));
    expect(scope.m.params.mode).toBe(2);
    expect(JSON.parse(store.get(OUTPUT_SCOPE_STORE)!).params.mode).toBe(2);
    expect(make().scope.m.params.mode).toBe(2);   // (remembered in this browser)
  });

  it('the collapse button folds it to its title; the palette opens it again, and folds it', () => {
    const { scope, root } = make();
    root.querySelector<HTMLButtonElement>('.oscope-fold')!.click();
    expect(root.classList.contains('collapsed')).toBe(true);
    expect(scope.visible).toBe(true);
    expect(scope.open).toBe(false);
    expect(make().scope.open).toBe(false);   // (remembered)
    const again = make().scope;
    again.toggle();   // the palette's Output scope
    expect(again.open).toBe(true);
    again.toggle();
    expect([again.visible, again.open]).toEqual([true, false]);
  });

  it('remembers its height from a drag on the divider under it, held between the smallest and the largest', () => {
    const { scope, root } = make();
    scope.update(true);
    expect(scope.screenHeight).toBe(SCREEN_H.default);
    const divider = root.querySelector<HTMLElement>('.oscope-divider')!;
    divider.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 500 }));
    divider.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 560 }));
    divider.dispatchEvent(new MouseEvent('pointerup'));
    expect(scope.screenHeight).toBe(SCREEN_H.default + 60);
    const screen = root.querySelector<HTMLElement>('.oscope-screen')!;
    expect([screen.style.width, screen.style.height]).toEqual(['', `${SCREEN_H.default + 60}px`]);   // (as wide as the sidebar)
    const next = make().scope;
    expect(next.screenHeight).toBe(SCREEN_H.default + 60);
    next.size(10);
    expect(next.screenHeight).toBe(SCREEN_H.min);
    next.size(10_000);
    expect(next.screenHeight).toBeLessThan(innerHeight);
  });

  it('streams and draws only while it is open and on show', () => {
    const { scope, screens } = make();
    scope.update(false);
    layout();
    sent.length = 0;
    frame(screens);
    expect(sent).toEqual([]);
    expect(draws).toBe(0);
    scope.update(true);
    layout();
    expect(sent).toEqual([expect.objectContaining({ t: 'view', key: OUTPUT_SCOPE_KEY, output: true })]);
    frame(screens);
    expect(draws).toBeGreaterThan(0);
    scope.setCollapsed(true);
    layout();
    expect(sent.at(-1)).toEqual({ t: 'unview', key: OUTPUT_SCOPE_KEY });
    draws = 0;
    frame(screens);
    expect(draws).toBe(0);
    const n = sent.length;
    scope.update(false);
    layout();
    expect(sent.length).toBe(n);
  });
});
