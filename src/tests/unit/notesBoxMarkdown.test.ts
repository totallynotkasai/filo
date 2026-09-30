import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { bodyToBoxText, boxTextToBody } from '@renderer/lib/tasklist/notesBoxMarkdown';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';

/**
 * The Task List notes box shows a body as plain lines, and a newline typed
 * there is written as a plain newline: the rich editor reads it back as a
 * line break (a soft break) and writes it back unchanged, so a note written
 * one line per thought keeps the lines nobody touched.
 */

const editors: Editor[] = [];
function load(body: string): { ed: Editor; lossy: boolean } {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return { ed, lossy: loadMarkdownIntoEditor(ed, body).lossy };
}
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

describe('notes box text ↔ note body', () => {
  it('two typed lines are written as typed, and the rich editor reads them back as two lines', () => {
    const body = boxTextToBody('line one\nline two');
    expect(body).toBe('line one\nline two');
    const { ed, lossy } = load(body);
    expect(lossy).toBe(false);
    expect(ed.getJSON().content?.[0]?.content?.map((n) => n.type)).toEqual(['text', 'softBreak', 'text']);
    expect(editorMarkdown(ed)).toBe(body);
  });

  it('a line added to a note written one line per thought leaves the other lines alone', () => {
    const body = 'Buy milk\nBuy eggs\nBuy bread';
    const draft = `${bodyToBoxText(body)}\nBuy butter`;
    expect(boxTextToBody(draft)).toBe('Buy milk\nBuy eggs\nBuy bread\nBuy butter');
  });

  it('the box shows a body with line breaks as plain newlines, and writes them back as plain newlines', () => {
    expect(bodyToBoxText('line one\\\nline two')).toBe('line one\nline two');
    expect(bodyToBoxText('line one  \nline two')).toBe('line one\nline two');
    expect(boxTextToBody(bodyToBoxText('a\\\nb\\\nc\n\nd\\\ne'))).toBe('a\nb\nc\n\nd\ne');
  });

  it.each([
    ['a list', '- one\n- two\n- [ ] three'],
    ['a heading over text', '# Title\nBody'],
  ])('%s is written as typed', (_name, text) => {
    expect(boxTextToBody(text)).toBe(text);
  });

  it.each([
    ['paragraphs split by a blank line', 'First\n\nSecond'],
    ['a code block', '```\nline one\nline two\n```'],
    ['a paragraph inside a list item', '- item\n  more of it'],
  ])('%s is written as typed and reads back unchanged', (_name, text) => {
    expect(boxTextToBody(text)).toBe(text);
    const { ed, lossy } = load(text);
    expect(lossy).toBe(false);
    expect(editorMarkdown(ed)).toBe(text);
  });

  it('a code block keeps a line ending in a backslash', () => {
    expect(bodyToBoxText('```\na\\\nb\n```')).toBe('```\na\\\nb\n```');
  });

  it('a typed backslash at a line end is kept as text', () => {
    const body = boxTextToBody('C:\\\\\nnext');
    const { ed, lossy } = load(body);
    expect(lossy).toBe(false);
    expect(ed.getText()).toContain('C:\\');
  });
});
