import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { bodyToBoxText, boxTextToBody } from '@renderer/lib/tasklist/notesBoxMarkdown';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';

/**
 * The Task List notes box shows a body as plain lines; a newline typed there
 * is a line break in the note, so the rich editor reads the note back as
 * typed (not as one joined line, which opened read-only).
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
  it('two typed lines become a line break, and the rich editor reads them back as two lines', () => {
    const body = boxTextToBody('line one\nline two');
    expect(body).toBe('line one\\\nline two');
    const { ed, lossy } = load(body);
    expect(lossy).toBe(false);
    expect(ed.getJSON().content?.[0]?.content?.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text']);
    expect(editorMarkdown(ed)).toBe(body);
  });

  it('the box shows the body with its line breaks as newlines', () => {
    expect(bodyToBoxText('line one\\\nline two')).toBe('line one\nline two');
    expect(bodyToBoxText(boxTextToBody('a\nb\nc\n\nd\ne'))).toBe('a\nb\nc\n\nd\ne');
  });

  it.each([
    ['a list', '- one\n- two\n- [ ] three'],
    ['paragraphs split by a blank line', 'First\n\nSecond'],
    ['a heading over text', '# Title\nBody'],
    ['a code block', '```\nline one\nline two\n```'],
    ['a line already ending in a break', 'one\\\ntwo'],
  ])('%s is written as typed', (_name, text) => {
    expect(boxTextToBody(text)).toBe(text);
  });

  it('a paragraph inside a list item gets its breaks too', () => {
    expect(boxTextToBody('- item\n  more of it')).toBe('- item\\\n  more of it');
  });

  it('trailing spaces before a typed newline are dropped for the break mark', () => {
    expect(boxTextToBody('one   \ntwo')).toBe('one   \ntwo');
    expect(boxTextToBody('one \ntwo')).toBe('one\\\ntwo');
  });

  it('a typed backslash at a line end is kept as text', () => {
    const body = boxTextToBody('C:\\\\\nnext');
    const { ed, lossy } = load(body);
    expect(lossy).toBe(false);
    expect(ed.getText()).toContain('C:\\');
  });
});
