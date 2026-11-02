// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, COMMENT_MAX, COMMENTS_MAX, connect, emptyPatch, fixComments, validatePatch, type Patch } from './patch';
import { encodePatch } from './patchbin';
import { addComment, commentChanges, moveComments, pasteComments, removeComments, setCommentText, sizeComment } from './comments';
import { decodeShare, encodeShare } from './share';
import { diffLines, diffPatches } from './diff';
import { flipPlan } from './ab';
import { clipText, copyItems, parseClip, pasteClip } from './clipboard';

/** Main -> osc -> output */
function base(): Patch {
  const p = emptyPatch('c');
  const kb = addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 300, 0);
  const out = addModule(p, DEFS.output, 600, 0);
  connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
  connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
  return p;
}

describe('comment boxes (#518)', () => {
  it('are added with their own ids, edited, sized, moved and removed', () => {
    const p = base();
    const a = addComment(p, 10, 20, 'hello');
    const b = addComment(p, -5, 40);
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(b.x).toBe(0);
    expect(setCommentText(p, a.id, 'x'.repeat(COMMENT_MAX + 10))).toBe(true);
    expect(p.comments![0].text).toHaveLength(COMMENT_MAX);
    expect(setCommentText(p, a.id, p.comments![0].text)).toBe(false);
    sizeComment(a, 1, 99999);
    expect([a.w, a.h]).toEqual([80, 2000]);
    moveComments([a], -100, 5);
    expect([a.x, a.y]).toEqual([0, 25]);
    removeComments(p, [a.id, b.id]);
    expect(p.comments).toBeUndefined();
  });

  it('a patch keeps at most COMMENTS_MAX of them', () => {
    const p = base();
    for (let i = 0; i < COMMENTS_MAX; i++) addComment(p, i, i, 'n');
    expect(() => addComment(p, 0, 0)).toThrow();
    expect(pasteComments(p, [p.comments![0]], 10, 10)).toEqual([]);
  });

  it('load checked: bad entries dropped, text cut, sizes held, ids unique', () => {
    const got = fixComments([
      { id: 1, x: 5, y: 6, w: 10, h: 99999, text: 'a' },
      { id: 1, x: 0, y: 0, w: 100, h: 50, text: 'duplicate id' },
      { id: 2.5, x: 0, y: 0, w: 100, h: 50, text: 'not a whole id' },
      { id: 3, x: 'no', y: -4, text: 'y'.repeat(COMMENT_MAX + 1) },
      { id: 4, x: 0, y: 0, w: 100, h: 50, text: 7 },
      null,
      'text',
    ]);
    expect(got).toEqual([
      { id: 1, x: 5, y: 6, w: 80, h: 2000, text: 'a' },
      { id: 3, x: 0, y: 0, w: 200, h: 60, text: 'y'.repeat(COMMENT_MAX) },
    ]);
    expect(fixComments('nope')).toEqual([]);
  });

  it('are kept by validatePatch and dropped when there are none', () => {
    const p = base();
    addComment(p, 10, 10, 'the filter goes here');
    const back = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(back.comments).toEqual(p.comments);
    const none = JSON.parse(JSON.stringify(base()));
    none.comments = [];
    expect('comments' in validatePatch(none, DEFS)).toBe(false);
  });

  it('never reach the FM-1: the binary is the same with or without them', () => {
    const p = base();
    const before = encodePatch(p);
    addComment(p, 10, 10, 'editor only');
    expect(encodePatch(p)).toEqual(before);
  });

  it('travel in a share link with the layout; one without it leaves them out but keeps the notes', async () => {
    const p = base();
    p.notes = 'a darker bass';
    addComment(p, 40, 50, 'turn the cutoff down for a darker bass\nsecond line <b>not markup</b>');
    const full = await decodeShare((await encodeShare(p, { base: 'https://example.test/', layout: true })).code, DEFS);
    expect(full.comments).toEqual(p.comments);
    const lean = await decodeShare((await encodeShare(p, { base: 'https://example.test/', layout: false })).code, DEFS);
    expect(lean.comments).toBeUndefined();
    expect(lean.notes).toBe('a darker bass');
  });

  it('show in Show changes as a line', () => {
    const a = base();
    addComment(a, 0, 0, 'one');
    addComment(a, 0, 0, 'two');
    const b: Patch = JSON.parse(JSON.stringify(a));
    setCommentText(b, 2, 'two!');
    removeComments(b, [1]);
    addComment(b, 5, 5, 'three');
    b.comments![0].x = 99; // a move alone is no change, as for the cards
    expect(commentChanges(a, b)).toBe('comments: 1 added, 1 edited, 1 removed');
    expect(diffLines(diffPatches(a, b, DEFS))).toContain('comments: 1 added, 1 edited, 1 removed');
    const moved: Patch = JSON.parse(JSON.stringify(a));
    moved.comments![0].x = 99;
    expect(commentChanges(a, moved)).toBe('');
  });

  it('follow the target in an A/B flip without a reload', () => {
    const a = base();
    const b: Patch = JSON.parse(JSON.stringify(a));
    addComment(b, 0, 0, 'B side');
    const plan = flipPlan(a, b);
    expect(plan.reload).toBe(false);
    expect(plan.patch.comments).toEqual(b.comments);
    expect(flipPlan(b, a).patch.comments).toBeUndefined();
  });

  it('copy and paste: alone, or with modules, offset like them and with fresh ids', () => {
    const p = base();
    const osc = p.modules[1];
    const c = addComment(p, 350, 120, 'osc note');
    // a comment alone
    const only = copyItems(p, [], [], [c.id])!;
    expect(only.def).toBeUndefined();
    expect([only.x, only.y]).toEqual([350, 120]);
    const parsed = parseClip(clipText(only), DEFS)!;
    expect(parsed.comments).toEqual([c]);
    const got = pasteClip(p, DEFS, parsed, 390, 160);
    expect(got).toEqual({ modules: [], assemblies: [], comments: [2] });
    expect(p.comments![1]).toMatchObject({ x: 390, y: 160, text: 'osc note' });
    // with a module: the comment keeps its place relative to the card
    const both = copyItems(p, [osc.id], [], [c.id])!;
    expect(both.def!.modules).toHaveLength(1);
    const pasted = pasteClip(p, DEFS, parseClip(clipText(both), DEFS)!, both.x + 40, both.y + 40);
    expect(pasted.modules).toHaveLength(1);
    const m = p.modules.find((x) => x.id === pasted.modules[0])!;
    const n = p.comments!.find((x) => x.id === pasted.comments[0])!;
    expect([n.x - m.x, n.y - m.y]).toEqual([c.x - osc.x, c.y - osc.y]);
    // nothing selected: nothing to copy; a clip with neither modules nor comments is not one
    expect(copyItems(p, [], [], [])).toBeNull();
    expect(parseClip(JSON.stringify({ format: 'matryoshka-clip', version: 1, x: 0, y: 0 }), DEFS)).toBeNull();
  });
});
