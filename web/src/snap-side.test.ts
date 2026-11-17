// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
// The Sound design sidebar (#1040, #1048): its left edge sets its width, held and remembered; folded before the first
// candidate; the list with A, the current patch, first and the Keep · Use · ✕ buttons only on the row heard; the rail with
// the letter heard, its place among the stops and a dot per candidate; ↑ ↓ while it has the focus.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_TEXT, renderList, renderProgress, renderRail, SIDE_W, SNAP_SIDE_STORE, SnapSidebar, type SideActions, type SideView } from './snap-side';
import type { Snapshot } from './snapshots';

let store: Map<string, string>;
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

beforeEach(() => {
  store = new Map();
});

function make(): { side: SnapSidebar; root: HTMLElement; menu: HTMLElement[] } {
  const root = document.createElement('div');
  root.innerHTML = '<div id="output-scope"></div><div class="snapshot-strip"></div>';
  document.body.replaceChildren(root);
  const menu: HTMLElement[] = [];
  return { side: new SnapSidebar(root, (b) => menu.push(b), storage), root, menu };
}

const cand = (letter: string, more: Partial<Snapshot> = {}): Snapshot => ({ letter, patch: '{}', ...more });
const view = (list: Snapshot[], shown: string | null, more: Partial<SideView> = {}): SideView => ({ list, shown, edited: false, currentName: 'Monolith D', changes: () => 3, round: null, count: 4, playing: false, ...more });
function actions(): SideActions & { calls: string[] } {
  const calls: string[] = [];
  const log = (name: string) => (...args: unknown[]) => void calls.push(`${name} ${args.filter((a) => typeof a !== 'object').join(' ')}`.trim());
  return { calls, hear: log('hear'), keep: log('keep'), use: log('use'), remove: log('remove'), more: log('more'), currentMore: log('currentMore'), drag: log('drag'), step: log('step'), generate: log('generate'), play: log('play') };
}

describe('Sound design sidebar (#1040, #1048)', () => {
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

  it('a narrower window holds it narrower for the while, without forgetting the width the user set', () => {
    const wide = innerWidth;
    const { side, root } = make();
    side.setWidth(400);
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect([side.width, root.style.getPropertyValue('--snap-side-w')]).toEqual([280, '280px']);   // (800 less the 520 the window keeps)
    Object.defineProperty(window, 'innerWidth', { value: wide, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(side.width).toBe(Math.min(400, Math.max(SIDE_W.min, wide - 520)));
  });

  it('its head says Sound design, with the ⋯ menu and the fold', () => {
    const { root, menu } = make();
    expect(root.querySelector('.snap-side-title')!.textContent).toBe('Sound design');
    root.querySelector<HTMLButtonElement>('.snap-side-menu')!.click();
    expect(menu).toEqual([root.querySelector('.snap-side-menu')]);
  });

  it('opens at its narrowest width at first; the user\u2019s fold is remembered', () => {
    const { side, root } = make();
    expect([side.folded, root.classList.contains('folded'), side.width]).toEqual([false, false, SIDE_W.min]);
    root.querySelector<HTMLButtonElement>('.snap-side-fold')!.click();
    expect([side.folded, root.classList.contains('folded'), JSON.parse(store.get(SNAP_SIDE_STORE)!).folded]).toEqual([true, true, true]);
    expect(make().side.folded).toBe(true);
    const again = make();
    again.root.querySelector<HTMLButtonElement>('.snap-rail-open')!.click();
    expect([again.side.folded, make().side.folded]).toEqual([false, false]);
  });

  it('the list: A, the current patch, first; the row heard is the only one with Keep · Use · ✕; origins, aims and keeps on the rows', () => {
    const strip = document.createElement('div');
    document.body.replaceChildren(strip);
    const act = actions();
    const list = [cand('B', { name: 'Warm swell', mark: 'keep' }), cand('C', { from: 'B' }), cand('D', { from: 'B+C', aim: { kind: 'pad', fits: true } }), cand('E', { from: 'A', aim: { kind: 'pad', fits: false } })];
    renderList(strip, view(list, 'D', { edited: true }), act);
    const rows = [...strip.querySelectorAll<HTMLElement>('.snap')];
    expect(rows.map((r) => r.querySelector('.snap-let')!.textContent)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(rows[0].classList.contains('current')).toBe(true);
    expect(rows[0].dataset.letter).toBeUndefined();   // (A is never dragged)
    expect(rows[0].querySelector('.snap-name')!.textContent).toBe('Monolith D');
    expect(rows.map((r) => r.querySelector('.snap-meta')!.textContent)).toEqual([
      'the current patch, your latest edits', 'taken by hand', 'from B', 'from B and C · sounds like a pad · changed since', 'from A · kind of sounds like a pad',
    ]);
    expect(rows.map((r) => r.querySelector('.snap-name')!.textContent)).toEqual(['Monolith D', 'Warm swell', 'unnamed', 'unnamed', 'unnamed']);
    expect(rows.filter((r) => r.querySelector('.snap-acts')).map((r) => r.dataset.letter)).toEqual(['D']);
    expect([...rows[3].querySelectorAll('.snap-acts button')].map((b) => b.textContent)).toEqual(['Keep', 'Use', '✕']);
    expect(rows.map((r) => [...r.classList].filter((c) => ['shown', 'kept', 'edited'].includes(c)).join())).toEqual(['', 'kept', '', 'shown,edited', '']);
    rows[3].querySelector<HTMLButtonElement>('.snap-use')!.click();
    rows[3].querySelector<HTMLButtonElement>('.snap-keep-b')!.click();
    rows[1].querySelector<HTMLButtonElement>('.snap-tick')!.click();   // (a tick keeps without a switch)
    rows[2].click();
    rows[0].click();
    expect(act.calls).toEqual(['use D', 'keep D true', 'keep B false', 'hear C', 'hear']);
    // hearing A: no row has the buttons (A is never kept, used or removed)
    renderList(strip, view(list, null), act);
    expect(strip.querySelector('.snap-acts')).toBeNull();
    expect(strip.querySelector('.snap.current')!.classList.contains('shown')).toBe(true);
  });

  it('empty: the sentence under A; while an aimed round renders, a row being judged and the progress line with Stop', () => {
    const strip = document.createElement('div');
    const line = document.createElement('div');
    line.innerHTML = '<div class="snap-progress-bar"><span></span></div><span class="snap-progress-text"></span><button>Stop</button>';
    document.body.replaceChildren(strip, line);
    renderList(strip, view([], null), actions());
    expect([...strip.children].map((c) => c.textContent)).toEqual([expect.stringContaining('A'), EMPTY_TEXT]);
    const round = { found: 3, of: 4, rendered: 6, most: 16 };
    renderList(strip, view([cand('B')], 'B', { round }), actions());
    const pending = strip.querySelector('.snap.pending')!;
    expect(pending.textContent).toContain('candidate 7 of up to 16');
    renderProgress(line, round);
    expect([line.hidden, line.querySelector('.snap-progress-text')!.textContent]).toEqual([false, '3 of 4 found']);
    renderProgress(line, null);
    expect(line.hidden).toBe(true);
  });

  it('the rail shows the letter heard, its place among the stops and a dot per candidate (A a square); a click on a dot plays it', () => {
    const body = document.createElement('div');
    document.body.replaceChildren(body);
    const act = actions();
    const list = [cand('B'), cand('C', { mark: 'keep' }), cand('D')];
    renderRail(body, view(list, 'C', { round: { found: 1, of: 4, rendered: 2, most: 16 } }), act);
    expect(body.querySelector('.snap-rail-tile')!.textContent).toBe('C');
    expect(body.querySelector('.snap-rail-pos')!.textContent).toBe('3 / 4');
    const dots = [...body.querySelectorAll<HTMLElement>('.snap-dot')];
    expect(dots.map((d) => d.className.replace('snap-dot', '').trim())).toEqual(['current', '', 'kept shown', '', 'pending']);
    dots[3].click();
    dots[0].click();
    const buttons = [...body.querySelectorAll<HTMLButtonElement>('.snap-rail-btn')];
    expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([['✓', false], ['✕', false], ['+4', false]]);
    buttons[0].click();
    buttons[2].click();
    for (const b of body.querySelectorAll<HTMLButtonElement>('.snap-rail-step')) b.click();
    body.querySelector<HTMLButtonElement>('.snap-rail-play')!.click();   // (play, under the letter)
    expect(act.calls).toEqual(['hear D', 'hear', 'keep C false', 'generate', 'step -1', 'step 1', 'play']);
    renderRail(body, view(list, 'C', { playing: true }), act);
    expect([body.querySelector('.snap-rail-play')!.textContent, body.querySelector('.snap-rail-tile')!.nextElementSibling!.nextElementSibling!.className]).toEqual(['■', 'snap-rail-play on']);
    // hearing A: the tile shows A, Keep and ✕ are off
    renderRail(body, view(list, null), act);
    expect([body.querySelector('.snap-rail-tile')!.textContent, body.querySelector('.snap-rail-tile')!.classList.contains('current'), body.querySelector('.snap-rail-pos')!.textContent]).toEqual(['A', true, '1 / 4']);
    expect([...body.querySelectorAll<HTMLButtonElement>('.snap-rail-btn')].map((b) => b.disabled)).toEqual([true, true, false]);
  });

  it('↑ and ↓ step through the candidates while the open sidebar has the focus; elsewhere, folded, in a field or with a modifier they do not', () => {
    const { side, root } = make();
    const strip = root.querySelector<HTMLElement>('.snapshot-strip')!;
    const act = actions();
    renderList(strip, view([cand('B'), cand('C')], 'B'), act);
    const row = strip.querySelector<HTMLElement>('.snap.shown')!;
    const key = (target: EventTarget, key: string, mods: Partial<KeyboardEvent> = {}) => side.arrowStep({ key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, target, ...mods });
    expect([key(row, 'ArrowUp'), key(row, 'ArrowDown'), key(root, 'ArrowDown')]).toEqual([-1, 1, 1]);
    expect([key(row, 'ArrowLeft'), key(row, 'ArrowRight'), key(row, 'ArrowDown', { shiftKey: true }), key(row, 'ArrowDown', { altKey: true })]).toEqual([null, null, null, null]);
    expect(key(document.body, 'ArrowDown')).toBeNull();   // (the canvas: arrows nudge as before)
    const field = document.createElement('input');
    root.append(field);
    expect(key(field, 'ArrowDown')).toBeNull();
    side.setFolded(true);
    expect(key(row, 'ArrowDown')).toBeNull();
    // a row clicked has the focus; after the list is drawn again the row heard takes it, so the keys stay in the sidebar
    side.setFolded(false);
    row.focus();
    renderList(strip, view([cand('B'), cand('C')], 'C'), act);
    expect(document.activeElement).toBe(strip.querySelector('.snap[data-letter="C"]'));
    expect(root.tabIndex).toBe(-1);
    vi.restoreAllMocks();
  });
});
