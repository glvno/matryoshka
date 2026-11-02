// SPDX-License-Identifier: GPL-3.0-only
// Comment boxes on the canvas (#518), like Max comments: free text in a resizable box, with no ports. They live in
// Patch.comments (patch.ts, checked by fixComments on load) and only the editor reads them: the engines, the binary
// format and the FM-1 never see them. No DOM here; the editor draws them (editor.ts commentBox).
import { COMMENT_MAX, COMMENT_MAX_SIZE, COMMENT_MIN_H, COMMENT_MIN_W, COMMENTS_MAX, type CommentBox, type Patch } from './patch';

/** a new comment's size (px) */
export const COMMENT_W = 200, COMMENT_H = 60;

/** the next free comment id (comments have their own series) */
export const nextCommentId = (p: Patch): number => (p.comments ?? []).reduce((m, c) => Math.max(m, c.id), 0) + 1;

/** add a comment with its top left at (x, y); throws when the patch has COMMENTS_MAX already */
export function addComment(p: Patch, x: number, y: number, text = '', w = COMMENT_W, h = COMMENT_H): CommentBox {
  const list = p.comments ?? [];
  if (list.length >= COMMENTS_MAX) throw new Error(`a patch keeps at most ${COMMENTS_MAX} comments`);
  const c: CommentBox = { id: nextCommentId(p), x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w, h, text: text.slice(0, COMMENT_MAX) };
  p.comments = [...list, c];
  return c;
}

/** remove these comments (Patch.comments goes when it is empty) */
export function removeComments(p: Patch, ids: Iterable<number>): void {
  const drop = new Set(ids);
  const left = (p.comments ?? []).filter((c) => !drop.has(c.id));
  if (left.length) p.comments = left;
  else delete p.comments;
}

/** a comment's new text, cut to COMMENT_MAX; returns whether it changed */
export function setCommentText(p: Patch, id: number, text: string): boolean {
  const c = p.comments?.find((x) => x.id === id);
  const t = text.slice(0, COMMENT_MAX);
  if (!c || c.text === t) return false;
  c.text = t;
  return true;
}

/** a comment's size, held within the limits */
export function sizeComment(c: CommentBox, w: number, h: number): void {
  c.w = Math.round(Math.min(COMMENT_MAX_SIZE, Math.max(COMMENT_MIN_W, w)));
  c.h = Math.round(Math.min(COMMENT_MAX_SIZE, Math.max(COMMENT_MIN_H, h)));
}

/** move comments by (dx, dy), none past the canvas's top or left edge */
export function moveComments(list: CommentBox[], dx: number, dy: number): void {
  for (const c of list) {
    c.x = Math.max(0, c.x + dx);
    c.y = Math.max(0, c.y + dy);
  }
}

/** copies of comments put into `p` moved by (dx, dy), with fresh ids (as many as there is room for); returns the new ids */
export function pasteComments(p: Patch, list: CommentBox[], dx: number, dy: number): number[] {
  const out: number[] = [];
  for (const c of list) {
    if ((p.comments ?? []).length >= COMMENTS_MAX) break;
    out.push(addComment(p, c.x + dx, c.y + dy, c.text, c.w, c.h).id);
  }
  return out;
}

/** what changed in the comments' text between two versions of a patch, as a line for Show changes ('' when nothing did;
 *  like the cards, a comment moved or resized is not a change there) */
export function commentChanges(a: Patch, b: Patch): string {
  const before = new Map((a.comments ?? []).map((c) => [c.id, c]));
  const after = new Map((b.comments ?? []).map((c) => [c.id, c]));
  let added = 0, removed = 0, edited = 0;
  for (const [id, c] of after) {
    const o = before.get(id);
    if (!o) added++;
    else if (o.text !== c.text) edited++;
  }
  for (const id of before.keys()) if (!after.has(id)) removed++;
  const parts = [[added, 'added'], [edited, 'edited'], [removed, 'removed']].filter(([n]) => n).map(([n, what]) => `${n} ${what}`);
  return parts.length ? `comments: ${parts.join(', ')}` : '';
}
