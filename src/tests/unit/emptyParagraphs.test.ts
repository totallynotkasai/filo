import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import {
  encodeEmptyParagraphs,
  stripEmptyParagraphSentinels,
  EMPTY_PARAGRAPH_SENTINEL,
  type BlockTokenizer,
} from '../../renderer/lib/editor/emptyParagraphs';

const S = EMPTY_PARAGRAPH_SENTINEL;

function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return createTiptapEditor({ element: el, content: '' });
}

const P = (text?: string) =>
  text === undefined
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [{ type: 'text', text }] };

describe('empty paragraphs — full editor round-trip', () => {
  let editor: Editor;
  beforeEach(() => {
    editor = makeEditor();
  });
  afterEach(() => {
    editor.destroy();
  });

  // doc -> markdown(on disk) -> fresh editor -> html + markdown(stable)
  function roundTrip(doc: unknown): { disk: string; html: string; disk2: string } {
    editor.commands.setContent(doc as never, { emitUpdate: false });
    const disk = editorMarkdown(editor);

    const ed2 = makeEditor();
    loadMarkdownIntoEditor(ed2, disk);
    const html = ed2.getHTML();
    const disk2 = editorMarkdown(ed2);
    ed2.destroy();
    return { disk, html, disk2 };
  }

  it('preserves one empty paragraph as a clean extra blank line', () => {
    const r = roundTrip({ type: 'doc', content: [P('Line 1'), P(), P('Line 2')] });
    expect(r.disk).toBe('Line 1\n\n\nLine 2');
    expect(r.disk).not.toContain(S);
    expect(r.html).toBe('<p>Line 1</p><p></p><p>Line 2</p>');
    expect(r.disk2).toBe('Line 1\n\n\nLine 2');
  });

  it('preserves two empty paragraphs', () => {
    const r = roundTrip({ type: 'doc', content: [P('A'), P(), P(), P('B')] });
    expect(r.disk).toBe('A\n\n\n\nB');
    expect(r.html).toBe('<p>A</p><p></p><p></p><p>B</p>');
    expect(r.disk2).toBe('A\n\n\n\nB');
  });

  it('leaves ordinary adjacent paragraphs untouched', () => {
    const r = roundTrip({ type: 'doc', content: [P('A'), P('B')] });
    expect(r.disk).toBe('A\n\nB');
    expect(r.html).toBe('<p>A</p><p>B</p>');
  });

  it('does not write the sentinel code point to disk', () => {
    const r = roundTrip({ type: 'doc', content: [P('A'), P(), P(), P(), P('B')] });
    expect(r.disk).not.toContain(S);
    expect(r.disk).toBe('A\n\n\n\n\nB');
  });

  it('keeps blank lines typed at the end of a note (Enter, Enter after the last line)', () => {
    const r = roundTrip({ type: 'doc', content: [P('Last line'), P(), P()] });
    expect(r.disk).toBe('Last line\n\n\n\n');
    expect(r.html).toBe('<p>Last line</p><p></p><p></p>');
    expect(r.disk2).toBe('Last line\n\n\n\n');
  });

  it('keeps one blank line at the end, after a list or a heading too', () => {
    for (const block of [P('A'), { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] }]) {
      const r = roundTrip({ type: 'doc', content: [P('Intro'), block, P()] });
      expect(r.disk2).toBe(r.disk);
      expect(r.html.endsWith('<p></p>')).toBe(true);
    }
    const list = roundTrip({
      type: 'doc',
      content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [P('a')] }] }, P()],
    });
    expect(list.disk).toBe('- a\n\n\n');
    expect(list.html.endsWith('<p></p>')).toBe(true);
  });

  it("a file's own final newline, or one blank line after the text, opens with no empty line at the end", () => {
    for (const body of ['A\n', 'A\n\n', 'A\n\nB\n', 'A\n\nB\n\n']) {
      const ed = makeEditor();
      loadMarkdownIntoEditor(ed, body);
      expect(ed.getHTML()).not.toContain('<p></p>');
      ed.destroy();
    }
  });
});

describe('empty paragraphs — encodeEmptyParagraphs (real markdown-it)', () => {
  // Pull the real markdown-it instance the editor parses with.
  let md: BlockTokenizer;
  let editor: Editor;
  beforeEach(() => {
    editor = makeEditor();
    const markdown = (editor.storage as { markdown?: { parser: { md: BlockTokenizer } } }).markdown;
    if (!markdown) throw new Error('the editor has no markdown storage');
    md = markdown.parser.md;
  });
  afterEach(() => editor.destroy());

  it('injects one sentinel paragraph per extra blank line between top-level blocks', () => {
    expect(encodeEmptyParagraphs('A\n\n\nB', md)).toBe(`A\n\n${S}\n\nB`);
    expect(encodeEmptyParagraphs('A\n\n\n\nB', md)).toBe(`A\n\n${S}\n\n${S}\n\nB`);
  });

  it('leaves a single blank-line separator unchanged', () => {
    expect(encodeEmptyParagraphs('A\n\nB', md)).toBe('A\n\nB');
  });

  it('never splits blank lines inside a fenced code block', () => {
    const body = '```js\nconst a = 1;\n\n\nconst b = 2;\n```';
    expect(encodeEmptyParagraphs(body, md)).toBe(body);
  });

  it('reconstructs spacing around a fenced code block without touching its body', () => {
    const body = 'Intro\n\n\n```js\nx\n```\n\n\nOutro';
    expect(encodeEmptyParagraphs(body, md)).toBe(
      `Intro\n\n${S}\n\n\`\`\`js\nx\n\`\`\`\n\n${S}\n\nOutro`,
    );
  });

  it('does not split multiple blank lines inside a single list', () => {
    const body = '- item 1\n\n\n- item 2';
    expect(encodeEmptyParagraphs(body, md)).toBe(body);
  });

  it('returns short / single-block bodies unchanged', () => {
    expect(encodeEmptyParagraphs('', md)).toBe('');
    expect(encodeEmptyParagraphs('only one paragraph', md)).toBe('only one paragraph');
    expect(encodeEmptyParagraphs('only one paragraph\n\n', md)).toBe('only one paragraph\n\n');
  });

  it('injects one sentinel paragraph per blank line after the last block, less one', () => {
    expect(encodeEmptyParagraphs('A\n\n\n', md)).toBe(`A\n\n${S}`);
    expect(encodeEmptyParagraphs('A\n\n\n\n', md)).toBe(`A\n\n${S}\n\n${S}`);
    expect(encodeEmptyParagraphs('A\n\nB\n\n\n', md)).toBe(`A\n\nB\n\n${S}`);
    expect(encodeEmptyParagraphs('- a\n- b\n\n\n', md)).toBe(`- a\n- b\n\n${S}`);
    expect(encodeEmptyParagraphs('```\nx\n```\n\n\n', md)).toBe(`\`\`\`\nx\n\`\`\`\n\n${S}`);
    // Blank is Markdown's: a CRLF file's `\r` lines are blank too.
    expect(encodeEmptyParagraphs('A\r\n\r\n\r\n', md)).toBe(`A\r\n\n${S}`);
  });

  it('keeps a link reference definition above a lone block', () => {
    expect(encodeEmptyParagraphs('[x]: https://example.com\n\nSee [x].\n\n\n', md)).toBe(
      `[x]: https://example.com\n\nSee [x].\n\n${S}`,
    );
  });

  it('leaves the end as written when a line no block holds follows the last block', () => {
    const body = 'See [x].\n\n[x]: https://example.com\n\n\n';
    expect(encodeEmptyParagraphs(body, md)).toBe(body);
  });

  it('never puts a sentinel inside a code fence left open to the end', () => {
    const body = '```\ncode\n\n\n';
    expect(encodeEmptyParagraphs(body, md)).toBe(body);
    expect(encodeEmptyParagraphs('Intro\n\n\n```\ncode\n\n\n', md)).toBe(`Intro\n\n${S}\n\n\`\`\`\ncode`);
  });

  it('leaves blank lines at the start alone (under frontmatter, one is the usual gap)', () => {
    expect(encodeEmptyParagraphs('\n\nA', md)).toBe('\n\nA');
  });
});

describe('empty paragraphs — sentinel safety', () => {
  it('a body already containing the sentinel is loaded verbatim (not corrupted)', () => {
    const ed = makeEditor();
    // Pre-existing sentinel inside real text; loadMarkdownIntoEditor must skip
    // reconstruction so the strip can't eat the user's character.
    loadMarkdownIntoEditor(ed, `before ${S} after`);
    expect(ed.getText()).toContain(S);
    ed.destroy();
  });

  it('stripEmptyParagraphSentinels no-ops on a stub editor without a live view', () => {
    const stub = { state: {}, view: {} } as unknown as Editor;
    expect(() => stripEmptyParagraphSentinels(stub)).not.toThrow();
  });
});
