import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Audit 2.5 + 2.6 — `tiptap-markdown` runs in `html: true` mode, so the editor
 * serialises formatting it has no Markdown token for (underline, text colour,
 * highlight, font family / size) and non-GFM tables (merged or multi-paragraph
 * cells) as inline HTML, and parses that HTML back on load. The formatting
 * round-trips instead of being silently stripped on the next save (2.6) or
 * written as the literal sentinel `[table]` that destroys every cell's contents
 * (2.5 — see `tiptap-markdown` `HTMLNode` / `Table` serialisers).
 *
 * These exercise a *real* TipTap instance (the same factory the app uses)
 * through a disk → fresh-editor → disk cycle, mirroring `emptyParagraphs.test.ts`.
 */

function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return createTiptapEditor({ element: el, content: '' });
}

interface RoundTrip {
  /** Markdown the editor would persist for `doc`. */
  disk: string;
  /** HTML after that markdown is loaded into a fresh editor. */
  html: string;
  /** Markdown re-serialised from the fresh editor (must be stable). */
  disk2: string;
}

let editor: Editor;
beforeEach(() => {
  editor = makeEditor();
});
afterEach(() => {
  editor.destroy();
});

// doc -> markdown(on disk) -> fresh editor -> html + markdown(stable)
function roundTrip(doc: unknown): RoundTrip {
  editor.commands.setContent(doc as never, { emitUpdate: false });
  const disk = editorMarkdown(editor);

  const ed2 = makeEditor();
  loadMarkdownIntoEditor(ed2, disk);
  const html = ed2.getHTML();
  const disk2 = editorMarkdown(ed2);
  ed2.destroy();
  return { disk, html, disk2 };
}

const para = (content: unknown[]): unknown => ({ type: 'paragraph', content });
const text = (t: string, marks?: unknown[]): unknown =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };

describe('markdown rich-formatting round-trip (audit 2.6)', () => {
  it('underline survives save + reload as inline HTML', () => {
    const r = roundTrip({
      type: 'doc',
      content: [para([text('plain '), text('under', [{ type: 'underline' }])])],
    });
    expect(r.disk).toContain('<u>');
    expect(r.disk).toContain('under');
    expect(r.html).toContain('<u>');
    // Stable across a second load → serialise cycle (no drift, no re-flag).
    expect(r.disk2).toContain('<u>');
  });

  it('highlight survives save + reload', () => {
    const r = roundTrip({
      type: 'doc',
      content: [para([text('hot', [{ type: 'highlight', attrs: { color: '#ffcc00' } }])])],
    });
    expect(r.disk).toContain('<mark');
    expect(r.html).toContain('<mark');
  });

  it('text colour survives save + reload', () => {
    const r = roundTrip({
      type: 'doc',
      content: [para([text('red', [{ type: 'textStyle', attrs: { color: '#ff0000' } }])])],
    });
    // The DOM (jsdom here, Chromium in production) normalises an inline-style
    // hex colour to its `rgb(...)` form, so accept either spelling — the point
    // is that the colour survives instead of being stripped to plain "red".
    const RED = /color:\s*(#ff0000|rgb\(255,\s*0,\s*0\))/i;
    expect(r.disk).toMatch(RED);
    expect(r.html).toMatch(RED);
  });

  it('font family + font size survive save + reload', () => {
    const r = roundTrip({
      type: 'doc',
      content: [
        para([text('big', [{ type: 'textStyle', attrs: { fontSize: '24px' } }])]),
        para([text('serif', [{ type: 'textStyle', attrs: { fontFamily: 'Georgia' } }])]),
      ],
    });
    expect(r.disk).toContain('24px');
    expect(r.disk).toContain('Georgia');
    expect(r.html).toContain('24px');
    expect(r.html).toContain('Georgia');
  });
});

describe('non-GFM table round-trip (audit 2.5)', () => {
  it('a multi-paragraph cell serialises as HTML, not the literal [table]', () => {
    const r = roundTrip({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [para([text('Head')])] }] },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  // childCount > 1 → not GFM-serialisable → HTML fallback.
                  content: [para([text('para one')]), para([text('para two')])],
                },
              ],
            },
          ],
        },
      ],
    });
    // The bug (html:false): the whole table serialises to the sentinel
    // `[table]`, so the next 300ms write destroys every cell's content.
    expect(r.disk).not.toContain('[table]');
    expect(r.disk).toContain('<table');
    expect(r.disk).toContain('para one');
    expect(r.disk).toContain('para two');
    // …and it survives a reload (the HTML is parsed back into a real table).
    expect(r.html).toContain('<table');
    expect(r.html).toContain('para one');
    expect(r.html).toContain('para two');
  });
});

describe('plain Markdown is unaffected by html mode (regression guard)', () => {
  it('headings, emphasis and lists round-trip without HTML noise', () => {
    const body = '# Title\n\n**bold** and *italic*\n\n- one\n- two';
    const ed2 = makeEditor();
    loadMarkdownIntoEditor(ed2, body);
    const out = editorMarkdown(ed2);
    ed2.destroy();
    expect(out).toContain('# Title');
    expect(out).toContain('**bold**');
    expect(out).toContain('*italic*');
    expect(out).toContain('- one');
    // A plain file must NOT pick up HTML wrappers just because html mode is on.
    expect(out).not.toContain('<p>');
    expect(out).not.toContain('<strong>');
  });
});

describe('known limitation — block indent is not serialised (accepted scope)', () => {
  // The `html: true` switch (audit 2.5/2.6) round-trips every *mark* without a
  // Markdown token and non-GFM *nodes* via inline HTML. Paragraph / heading
  // *indent* is a global attribute on nodes that DO have a Markdown serialiser
  // (the GFM paragraph/heading writers), so it never reaches the HTML fallback
  // and is still dropped on save. Pinned here so the residual is explicit
  // rather than silent; revisit if block indent ever needs to persist.
  it('paragraph indent does not survive a round-trip', () => {
    const r = roundTrip({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { indent: 2 }, content: [text('indented')] }],
    });
    expect(r.disk).not.toContain('margin-left');
    expect(r.html).not.toContain('margin-left');
  });
});
