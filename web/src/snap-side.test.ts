// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
// The Sound design sidebar (#1040, #1048): its left edge sets its width, held and remembered; the list of candidates, all
// alike, with Save preset · Add to palette · ⋯ · ✕ only on the row heard, picks by ⌘/Ctrl/Shift-click, "tweaked" with its
// revert, Recently deleted with put back; the rail with the letter heard, its place in the list and a dot per candidate;
// ↑ ↓ while it has the focus.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countText, generateText, renderList, renderProgress, renderRail, SIDE_W, SNAP_SIDE_STORE, SnapSidebar, WORKSPACE_MIN, type SideActions, type SideView } from './snap-side';
import type { Snapshot } from './snapshots';

let store: Map<string, string>;
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

beforeEach(() => {
  store = new Map();
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });   // (a window with room for a wider sidebar)
});

function make(): { side: SnapSidebar; root: HTMLElement; menu: HTMLElement[] } {
  const root = document.createElement('div');
  root.innerHTML = '<div id="output-scope"></div><div class="snapshot-strip"></div>';
  document.body.replaceChildren(root);
  const menu: HTMLElement[] = [];
  return { side: new SnapSidebar(root, (b) => menu.push(b), storage), root, menu };
}

const cand = (letter: string, more: Partial<Snapshot> = {}): Snapshot => ({ letter, patch: '{}', original: '{}', ...more });
const view = (list: Snapshot[], current: string, more: Partial<SideView> = {}): SideView => ({
  list, current, tweaked: () => false, changes: () => 3, picks: [], deleted: [], engines: 2, round: null, count: 4, playing: false, ...more,
});
function actions(): SideActions & { calls: string[] } {
  const calls: string[] = [];
  const log = (name: string) => (...args: unknown[]) => void calls.push(`${name} ${args.filter((a) => typeof a !== 'object').join(' ')}`.trim());
  return {
    calls, hear: log('hear'), pick: log('pick'), remove: log('remove'), putBack: log('putBack'), revert: log('revert'), savePreset: log('savePreset'),
    addToPalette: log('addToPalette'), paletteChoice: log('paletteChoice'), more: log('more'), drag: log('drag'), step: log('step'), generate: log('generate'), play: log('play'),
  };
}
const strip = (): HTMLElement => {
  const s = document.createElement('div');
  document.body.replaceChildren(s);
  return s;
};
const rowsOf = (s: HTMLElement): HTMLElement[] => [...s.querySelectorAll<HTMLElement>('.snap[data-letter]')];
const acts = (r: HTMLElement): string[] => [...r.querySelectorAll('.snap-acts button')].map((b) => b.textContent!);

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
    expect(side.width).toBe(1600 - WORKSPACE_MIN);   // (the canvas and the deck keep the room they need)
  });

  it('a narrower window holds it narrower for the while, so the deck and the canvas keep their room, without forgetting the width the user set', () => {
    const { side, root } = make();
    side.setWidth(600);
    Object.defineProperty(window, 'innerWidth', { value: WORKSPACE_MIN + 400, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect([side.width, root.style.getPropertyValue('--snap-side-w')]).toEqual([400, '400px']);
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(side.width).toBe(SIDE_W.min);   // (never narrower than its narrowest)
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(side.width).toBe(600);
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

  it('the list: every row alike, its name or its origin, origins, aims and "tweaked"; only the row heard has the buttons, the others their change count and a ✕', () => {
    const s = strip();
    const act = actions();
    const list = [cand('A', { from: 'opened' }), cand('B', { name: 'Warm swell', from: 'A' }), cand('C', { from: 'A+B', aim: { kind: 'pad', fits: true } }), cand('D', { from: 'copy:B', aim: { kind: 'pad', fits: false } })];
    renderList(s, view(list, 'C', { changes: (x) => (x.letter === 'D' ? 0 : 3) }), act);
    const rows = rowsOf(s);
    expect(rows.map((r) => r.querySelector('.snap-let')!.textContent)).toEqual(['A', 'B', 'C', 'D']);
    expect(rows.map((r) => r.querySelector('.snap-name')!.textContent)).toEqual(['as opened', 'Warm swell', 'bred from A × B', 'copy of B']);
    expect(rows.map((r) => r.querySelector('.snap-name')!.classList.contains('dim'))).toEqual([true, false, true, true]);
    expect(rows.map((r) => r.querySelector('.snap-meta')!.textContent)).toEqual(['', 'from A', 'sounds like a pad', 'kind of sounds like a pad']);
    expect(rows[1].querySelector('.snap-meta .src')!.textContent).toBe('from A');
    expect(rows.map((r) => r.classList.contains('shown'))).toEqual([false, false, true, false]);
    expect(s.querySelector('.current')).toBeNull();   // (no special row)
    expect(rows.filter((r) => r.querySelector('.snap-acts')).map((r) => r.dataset.letter)).toEqual(['C']);
    expect(acts(rows[2])).toEqual(['Save preset ▾', 'Add to palette', '▾', '⋯', '✕']);
    expect(rows.map((r) => r.querySelector('.snap-ch')?.textContent ?? null)).toEqual(['3', '3', null, '=']);
    expect(rows.map((r) => !!r.querySelector('.snap-x'))).toEqual([true, true, false, true]);
    for (const r of rows) expect(r.title).not.toMatch(/Keep|Use|Nominate|changed since|A, the current patch/);
    // the buttons: none of them switches or drags
    rows[2].querySelector<HTMLButtonElement>('.snap-preset')!.click();
    rows[2].querySelector<HTMLButtonElement>('.snap-palette')!.click();
    rows[2].querySelector<HTMLButtonElement>('.snap-palette-choice')!.click();
    rows[2].querySelector<HTMLButtonElement>('.snap-more')!.click();
    rows[2].querySelector<HTMLButtonElement>('.snap-remove')!.click();
    rows[3].querySelector<HTMLButtonElement>('.snap-x')!.click();
    rows[0].click();
    rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    rows[3].dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    expect(act.calls).toEqual(['savePreset', 'addToPalette', 'paletteChoice', 'more', 'remove C', 'remove D', 'hear A', 'hear B', 'more']);
  });

  it('Save preset: with one engine it opens the Store dialog (no ▾); with none it is not there', () => {
    const s = strip();
    const list = [cand('A'), cand('B')];
    renderList(s, view(list, 'B', { engines: 1 }), actions());
    expect(acts(s.querySelector('.snap.shown')!)).toEqual(['Save preset', 'Add to palette', '▾', '⋯', '✕']);
    renderList(s, view(list, 'B', { engines: 0 }), actions());
    expect(acts(s.querySelector('.snap.shown')!)).toEqual(['Add to palette', '▾', '⋯', '✕']);
  });

  it('a lone candidate cannot be deleted: one is always the current patch', () => {
    const s = strip();
    renderList(s, view([cand('A')], 'A'), actions());
    expect(s.querySelector<HTMLButtonElement>('.snap-remove')!.disabled).toBe(true);
  });

  it('⌘, Ctrl or Shift-click picks a row as a parent (a coral ring) without switching to it', () => {
    const s = strip();
    const act = actions();
    const list = [cand('A'), cand('B'), cand('C')];
    renderList(s, view(list, 'A', { picks: ['C', 'B'] }), act);
    const rows = rowsOf(s);
    expect(rows.map((r) => r.classList.contains('picked'))).toEqual([false, true, true]);
    rows[1].dispatchEvent(new MouseEvent('click', { metaKey: true, bubbles: true }));
    rows[2].dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
    rows[0].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    rows[1].click();
    expect(act.calls).toEqual(['pick B', 'pick C', 'pick A', 'hear B']);
  });

  it('a tweaked row says so, with a revert that brings back how it was made (any row, not only the one heard)', () => {
    const s = strip();
    const act = actions();
    const list = [cand('A', { from: 'opened' }), cand('B', { name: 'Glass', from: 'A' }), cand('C', { from: 'A' })];
    renderList(s, view(list, 'C', { tweaked: (x) => x.letter !== 'A' }), act);
    const rows = rowsOf(s);
    expect(rows.map((r) => r.querySelector('.snap-meta')!.textContent)).toEqual(['', 'from A · tweaked revert', 'tweaked revert']);
    const revert = rows[1].querySelector<HTMLButtonElement>('.snap-revert')!;
    expect(revert.title).toBe('Back to how it was made (Ctrl/Cmd+Z undoes it)');
    revert.click();
    rows[2].querySelector<HTMLButtonElement>('.snap-revert')!.click();
    expect(act.calls).toEqual(['revert B', 'revert C']);   // (no hear: the integrator switches, then reverts)
    expect(rows[0].querySelector('.snap-revert')).toBeNull();
  });

  it('Recently deleted under the list, newest first, each with put back; open as the user left it', () => {
    const s = strip();
    const act = actions();
    const list = [cand('A'), cand('B')];
    const deleted = [{ s: cand('D', { name: 'Fizz' }), at: 2 }, { s: cand('C', { from: 'A' }), at: 1 }];
    renderList(s, view(list, 'A'), act);
    expect(s.querySelector('.snap-deleted')).toBeNull();
    renderList(s, view(list, 'A', { deleted }), act);
    const box = s.querySelector<HTMLDetailsElement>('details.snap-deleted')!;
    expect([box.open, box.querySelector('summary')!.textContent]).toEqual([false, 'Recently deleted (2)']);
    expect([...box.querySelectorAll('.snap-deleted-item')].map((x) => x.textContent)).toEqual(['D “Fizz” · put back', 'C from A · put back']);
    box.querySelectorAll<HTMLButtonElement>('.snap-put-back')[1].click();
    expect(act.calls).toEqual(['putBack 1']);
    box.open = true;
    renderList(s, view(list, 'A', { deleted }), act);
    expect(s.querySelector<HTMLDetailsElement>('.snap-deleted')!.open).toBe(true);
  });

  it('while an aimed round renders, a row being judged and the progress line with Stop', () => {
    const s = strip();
    const line = document.createElement('div');
    line.innerHTML = '<div class="snap-progress-bar"><span></span></div><span class="snap-progress-text"></span><button>Stop</button>';
    document.body.append(line);
    const round = { found: 3, of: 4, rendered: 6, most: 16 };
    renderList(s, view([cand('A')], 'A', { round }), actions());
    const pending = s.querySelector('.snap.pending')!;
    expect(pending.textContent).toContain('listening…');
    expect(pending.textContent).toContain('candidate 7 of up to 16');
    renderProgress(line, round);
    expect([line.hidden, line.querySelector('.snap-progress-text')!.textContent]).toEqual([false, '3 of 4 found']);
    renderProgress(line, null);
    expect(line.hidden).toBe(true);
  });

  it('the rail: the letter heard, its place in the list, a dot per candidate (coral picked); PRE, PAL, ✕ and +N', () => {
    const body = document.createElement('div');
    document.body.replaceChildren(body);
    const act = actions();
    const list = [cand('A'), cand('B'), cand('C')];
    renderRail(body, view(list, 'B', { picks: ['C'], round: { found: 1, of: 4, rendered: 2, most: 16 } }), act);
    expect(body.querySelector('.snap-rail-tile')!.textContent).toBe('B');
    expect(body.querySelector('.snap-rail-tile')!.classList.contains('current')).toBe(false);
    expect(body.querySelector('.snap-rail-pos')!.textContent).toBe('2 / 3');
    const dots = [...body.querySelectorAll<HTMLElement>('.snap-dot')];
    expect(dots.map((d) => d.className.replace('snap-dot', '').trim())).toEqual(['', 'shown', 'picked', 'pending']);
    dots[2].click();
    dots[0].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    const buttons = [...body.querySelectorAll<HTMLButtonElement>('.snap-rail-btn')];
    expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([['PRE', false], ['PAL', false], ['✕', false], ['+4', false]]);
    for (const b of buttons) b.click();
    for (const b of body.querySelectorAll<HTMLButtonElement>('.snap-rail-step')) b.click();
    body.querySelector<HTMLButtonElement>('.snap-rail-play')!.click();
    expect(act.calls).toEqual(['hear C', 'pick A', 'savePreset', 'addToPalette', 'remove B', 'generate', 'step -1', 'step 1', 'play']);
    renderRail(body, view(list, 'B', { playing: true }), act);
    expect([body.querySelector('.snap-rail-play')!.textContent, body.querySelector('.snap-rail-tile')!.nextElementSibling!.nextElementSibling!.className]).toEqual(['■', 'snap-rail-play on']);
    // no engine: PRE is off; a lone candidate: ✕ is off
    renderRail(body, view([cand('A')], 'A', { engines: 0 }), act);
    expect(body.querySelector('.snap-rail-pos')!.textContent).toBe('1 / 1');
    expect([...body.querySelectorAll<HTMLButtonElement>('.snap-rail-btn')].map((b) => b.disabled)).toEqual([true, false, true, false]);
  });

  it('the footer and head texts: Generate, Generate from D, Breed B × D; N of 32', () => {
    expect([generateText([]), generateText(['D']), generateText(['B', 'D']), generateText(['B', 'D', 'F'])]).toEqual(['Generate', 'Generate from D', 'Breed B × D', 'Breed B × D × F']);
    expect([countText(1), countText(32)]).toEqual(['1 of 32', '32 of 32']);
  });

  it('↑ and ↓ step through the candidates while the open sidebar has the focus; elsewhere, folded, in a field or with a modifier they do not', () => {
    const { side, root } = make();
    const s = root.querySelector<HTMLElement>('.snapshot-strip')!;
    const act = actions();
    renderList(s, view([cand('B'), cand('C')], 'B'), act);
    const row = s.querySelector<HTMLElement>('.snap.shown')!;
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
    renderList(s, view([cand('B'), cand('C')], 'C'), act);
    expect(document.activeElement).toBe(s.querySelector('.snap[data-letter="C"]'));
    expect(root.tabIndex).toBe(-1);
    vi.restoreAllMocks();
  });
});
