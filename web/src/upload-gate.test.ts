import { describe, expect, it } from 'vitest';
import { encodePatch } from './patchbin';
import { FM1_PRESETS } from './presets';
import { UploadGate } from './upload-gate';

describe('Live uploads only what changes the FM-1\'s patch', () => {
  const patch = () => FM1_PRESETS['Silver Box']();

  it('a comment or a move leaves the encoded patch as it is: no upload', () => {
    const p = patch();
    const g = new UploadGate();
    expect(g.needs(encodePatch(p))).toBe(true);            // (nothing known yet: the first upload)
    g.took(encodePatch(p));
    p.comments = [...(p.comments ?? []), { id: 999, x: 40, y: 40, w: 160, h: 60, text: 'a note to self' }];
    expect(g.needs(encodePatch(p))).toBe(false);
    p.comments[p.comments.length - 1].text = 'edited';
    p.comments[p.comments.length - 1].x = 400;
    p.modules[0].x += 120;                                   // (a module moved: layout only)
    expect(g.needs(encodePatch(p))).toBe(false);
  });

  it('a structural change that reaches the FM-1 needs the upload', () => {
    const p = patch();
    const g = new UploadGate();
    g.took(encodePatch(p));
    p.cables = p.cables.slice(1);
    expect(g.needs(encodePatch(p))).toBe(true);
  });

  it('after live edits, the bytes the FM-1 holds are learnt again before a comment can skip the upload', () => {
    const p = patch();
    const g = new UploadGate();
    g.took(encodePatch(p));
    const m = p.modules.find((x) => Object.keys(x.params).length > 0)!;
    const k = Object.keys(m.params)[0];
    m.params[k] = m.params[k] + 0.25;                        // a value sent live
    g.edited();
    expect(g.stale).toBe(true);
    expect(g.needs(encodePatch(p))).toBe(true);              // (not learnt yet: upload, to be safe)
    g.refresh(encodePatch(p));
    expect(g.stale).toBe(false);
    p.comments = [...(p.comments ?? []), { id: 998, x: 0, y: 0, w: 160, h: 60, text: 'after the knob' }];
    expect(g.needs(encodePatch(p))).toBe(false);
    g.forget();
    expect(g.needs(encodePatch(p))).toBe(true);
  });
});
