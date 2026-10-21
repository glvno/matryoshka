// SPDX-License-Identifier: GPL-3.0-only
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

// One renderer for authored prose in both the live course and the writing preview.
// HTML stays literal; markdown-it escapes text/attributes and rejects unsafe URL schemes.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false }).use(footnote);
// Repeated references keep the same number; their separate return links remain distinct.
markdown.renderer.rules.footnote_caption = (tokens, index) => `[${Number(tokens[index].meta!.id) + 1}]`;
for (const rule of ['footnote_ref', 'footnote_anchor']) {
  const render = markdown.renderer.rules[rule];
  markdown.renderer.rules[rule] = (tokens, index, options, env, renderer) => {
    const n = Number(tokens[index].meta!.id) + 1;
    const reference = Number(tokens[index].meta!.subId ?? 0) + 1;
    const label = rule === 'footnote_ref' ? `Footnote ${n}` : `Back to reference ${reference} for footnote ${n}`;
    return render(tokens, index, options, env, renderer).replace('<a ', `<a aria-label="${label}" `);
  };
}
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
// A link to `req:id[,id…]` is a requirement placed in the text: a checkbox around the author's words, ticked by the panel.
const REQ = /^req:([a-z0-9][a-z0-9-]*(?:,[a-z0-9][a-z0-9-]*)*)$/;
markdown.core.ruler.push('req', (state) => {
  for (const block of state.tokens) {
    const open: boolean[] = [];
    for (const t of block.children ?? []) {
      if (t.type === 'link_open') {
        const m = REQ.exec(String(t.attrGet('href') ?? ''));
        open.push(!!m);
        if (m) { t.type = 'req_open'; t.tag = 'span'; t.attrs = [['class', 'req'], ['data-req', m[1]]]; }
      } else if (t.type === 'link_close' && open.pop()) { t.type = 'req_close'; t.tag = 'span'; }
    }
  }
});
// Each requirement is a line of its own (#173): a paragraph that holds one splits into prose / requirement / prose
// paragraphs, the requirement's with the class req-line. A requirement nested in other markup (inside **…**) stays inline.
// The sentence is reshaped into lines: the full stop or footnote mark right after a requirement stays on its line (a comma,
// semicolon or colon that joined it to the next words goes); joining words between lines ("and", "then") go; a lead-in
// that ran into a requirement ("Cable", "Start Riff and") ends with a colon; a line or paragraph that now starts with a
// small letter gets a capital.
type Tok = ReturnType<typeof markdown.parse>[number];
type Seg = { req: boolean; toks: Tok[] };
const TAIL = /^[.,;:!?)\]"'”’…]+/;
const JOIN_START = /^(?:[\s,;:]*\b(?:and then|and|or|then)\b)?[\s,;:]*/i;
const JOIN_END = /(?:[\s,;:]*\b(?:and then|and|or|then))?[\s,;:]*$/i;
const isBreak = (t: Tok): boolean => t.type === 'softbreak' || t.type === 'hardbreak';
const isBlank = (seg: Tok[]): boolean => seg.every((t) => isBreak(t) || (t.type === 'text' && !t.content.trim()));
/** a segment without the line breaks and spaces at its ends */
function trimSegment(seg: Tok[]): Tok[] {
  while (seg.length && isBreak(seg[0])) seg.shift();
  while (seg.length && isBreak(seg[seg.length - 1])) seg.pop();
  if (seg[0]?.type === 'text') seg[0].content = seg[0].content.trimStart();
  const last = seg[seg.length - 1];
  if (last?.type === 'text') last.content = last.content.trimEnd();
  return seg;
}
/** a capital for the first letter, when the segment starts with plain text (not `code`) */
function capitalize(seg: Tok[]): void {
  const first = seg[0]?.type === 'req_open' ? seg[1] : seg[0];
  if (first?.type === 'text') first.content = first.content.replace(/^[a-z]/, (c) => c.toUpperCase());
}
/** the paragraph's inline tokens cut at its top-level requirements, each requirement with what closes it: the punctuation
 * and footnote marks right after it, and a remark in parentheses that follows it ("(every beat)") */
function splitAtRequirements(children: Tok[], text: (content: string) => Tok): Seg[] {
  const segs: Seg[] = [];
  let inReq = false, tail = false, paren = false;
  const queue = [...children];
  for (let t = queue.shift(); t; t = queue.shift()) {
    if (t.type === 'req_open' && t.level === 0) { segs.push({ req: true, toks: [t] }); inReq = true; continue; }
    const cur = segs[segs.length - 1];
    if (inReq) {
      cur.toks.push(t);
      if (t.type === 'req_close' && t.level === 0) inReq = false, tail = true;
      continue;
    }
    if (tail && t.type === 'text' && /^\s*\(/.test(t.content)) paren = true;
    if (paren) {
      const close = t.type === 'text' ? t.content.indexOf(')') : -1;
      if (close < 0) { cur.toks.push(t); continue; }
      cur.toks.push(text(t.content.slice(0, close + 1)));
      paren = false;
      if (close + 1 < t.content.length) queue.unshift(text(t.content.slice(close + 1)));
      continue;
    }
    if (tail && t.type === 'footnote_ref') { cur.toks.push(t); continue; }
    if (tail && t.type === 'text') {
      const m = TAIL.exec(t.content);
      if (m) {
        const keep = m[0].replace(/[,;:]/g, '');
        if (keep) cur.toks.push(text(keep));
        t.content = t.content.slice(m[0].length);
        if (!t.content) continue;
      }
    }
    tail = false;
    if (cur && !cur.req) cur.toks.push(t);
    else segs.push({ req: false, toks: [t] });
  }
  return segs;
}
/** the prose between requirements without its joining words; a lead-in ends with a colon; '' segments are dropped */
function shapeProse(segs: Seg[], text: (content: string) => Tok): Seg[] {
  return segs.filter((seg, k) => {
    seg.toks = trimSegment(seg.toks);
    if (seg.req) { capitalize(seg.toks); return true; }
    const after = segs[k - 1]?.req, before = segs[k + 1]?.req;
    const first = seg.toks[0], last = seg.toks[seg.toks.length - 1];
    // after a requirement that ended a sentence the words start a new one ("Then rest."): they keep their joining word
    const prev = segs[k - 1]?.toks.at(-1);
    const sentence = prev?.type === 'text' && /[.!?…]$/.test(prev.content) || prev?.type === 'footnote_ref';
    if (after && !sentence && first?.type === 'text') first.content = first.content.replace(JOIN_START, '');
    if (before && last?.type === 'text') last.content = last.content.replace(JOIN_END, '');
    seg.toks = trimSegment(seg.toks.filter((t) => t.type !== 'text' || t.content));
    if (!seg.toks.length || isBlank(seg.toks)) return false;
    if (after) capitalize(seg.toks);
    const end = seg.toks[seg.toks.length - 1];
    if (before && !(end.type === 'text' && /[.!?:…)]$/.test(end.content))) seg.toks.push(text(':'));
    return true;
  });
}
markdown.core.ruler.push('req_lines', (state) => {
  const out: Tok[] = [];
  const tokens = state.tokens;
  const text = (content: string): Tok => Object.assign(new state.Token('text', '', 0), { content });
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i], inline = tokens[i + 1], close = tokens[i + 2];
    const children = inline?.children ?? [];
    if (open.type !== 'paragraph_open' || inline.type !== 'inline' || close?.type !== 'paragraph_close' || !children.some((t) => t.type === 'req_open' && t.level === 0)) {
      out.push(open);
      continue;
    }
    for (const seg of shapeProse(splitAtRequirements(children, text), text)) {
      const p = new state.Token('paragraph_open', 'p', 1);
      Object.assign(p, { map: open.map, level: open.level, block: true }); // shown even in a tight list: the lines are blocks
      if (seg.req) p.attrSet('class', 'req-line');
      const body = new state.Token('inline', '', 0);
      Object.assign(body, { map: inline.map, level: inline.level, content: '', children: seg.toks });
      const end = new state.Token('paragraph_close', 'p', -1);
      Object.assign(end, { level: close.level, block: true });
      out.push(p, body, end);
    }
    i += 2;
  }
  state.tokens = out;
});
markdown.renderer.rules.req_open = (tokens, index) =>
  `<span class="req" data-req="${markdown.utils.escapeHtml(String(tokens[index].attrGet('data-req') ?? ''))}"><span class="req-box" aria-hidden="true"></span><span class="req-text">`;
markdown.renderer.rules.req_close = () => '</span></span>';

/** the requirement ids the text places, one list per checkbox, in reading order */
export function placedRequirements(source: string): string[][] {
  const out: string[][] = [];
  const walk = (tokens: ReturnType<typeof markdown.parse>) => {
    for (const t of tokens) {
      if (t.type === 'req_open') out.push(String(t.attrGet('data-req') ?? '').split(','));
      if (t.children) walk(t.children);
    }
  };
  walk(markdown.parse(source, {}));
  return out;
}

/**
 * Tick the placed requirements under `root`: a box is done when all its ids are met (every box when `met` is null: the
 * step is done); the first unticked box, or the one whose ids are `pick` while it is unticked, is marked next.
 */
export function tickRequirements(root: ParentNode, met: Record<string, boolean> | null, pick: string | null = null): HTMLElement[] {
  const boxes = [...root.querySelectorAll<HTMLElement>('.req')];
  if (pick && !boxes.some((b) => b.dataset.req === pick && !(b.dataset.req ?? '').split(',').every((id) => met?.[id]))) pick = null;
  let next = false;
  for (const box of boxes) {
    const done = !met || (box.dataset.req ?? '').split(',').every((id) => met[id]);
    box.classList.toggle('done', done);
    box.setAttribute('role', 'checkbox'); box.setAttribute('aria-checked', String(done));
    const isNext = !done && !next && (!pick || pick === box.dataset.req);
    box.classList.toggle('next', isNext);
    if (isNext) next = true;
  }
  return boxes;
}

// The lesson title is h2; prose headings start below it, even when written as #.
for (const rule of ['heading_open', 'heading_close']) {
  markdown.renderer.rules[rule] = (tokens, index, options, _env, renderer) => {
    tokens[index].tag = `h${Math.min(6, Number(tokens[index].tag.slice(1)) + 2)}`;
    return renderer.renderToken(tokens, index, options);
  };
}

let proseId = 0;
export function renderLessonMarkdown(source: string): string {
  // Instructions, Why and challenges can coexist and each may contain [^1].
  // IDs never include authored labels, and no two rendered fields share an anchor.
  return markdown.render(source, { docId: `lesson-${++proseId}` });
}

export function lessonProse(source: string): HTMLDivElement {
  const prose = document.createElement('div');
  prose.className = 'tutorial-prose';
  // Only parser-generated HTML reaches this sink. Raw HTML is disabled above.
  prose.innerHTML = renderLessonMarkdown(source);
  prose.querySelector('.footnotes')?.setAttribute('aria-label', 'Footnotes');
  prose.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.footnote-ref a, a.footnote-backref') : null;
    if (!link) return;
    // The app uses URL fragments for patches and tabs. Footnotes navigate only inside this field.
    event.preventDefault();
    const target = prose.ownerDocument.getElementById(link.hash.slice(1));
    if (!target || !prose.contains(target)) return;
    if (!target.matches('a[href]')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  // Keep wide tables usable without widening or scrolling the whole lesson card.
  for (const table of prose.querySelectorAll('table')) {
    const scroll = document.createElement('div');
    scroll.className = 'tutorial-table'; scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Scrollable table');
    table.replaceWith(scroll); scroll.append(table);
  }
  for (const img of prose.querySelectorAll('img')) { img.loading = 'lazy'; img.decoding = 'async'; }
  return prose;
}

export function lessonChallenge(source: string): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'tutorial-challenge';
  const label = document.createElement('strong'); label.textContent = 'Optional challenge';
  section.append(label, lessonProse(source));
  return section;
}
