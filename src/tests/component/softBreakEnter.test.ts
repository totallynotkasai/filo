import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import './helpers/mountEditor';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';

/**
 * Enter beside a soft break (a note written one line per thought) splits the
 * paragraph there: the new paragraph doesn't open with an empty line, and no
 * `<br data-filo-soft-break>` lands in a plain note.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function editorWith(markdown: string, caret: number): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  ed.commands.focus();
  ed.commands.setTextSelection(caret);
  return ed;
}

function pressEnter(ed: Editor): void {
  ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

describe('Enter beside a soft break', () => {
  it('at the end of a line: two paragraphs, no HTML', () => {
    const ed = editorWith('one\ntwo', 4);
    pressEnter(ed);
    expect(editorMarkdown(ed)).toBe('one\n\ntwo');
  });

  it('at the start of the next line: the same', () => {
    const ed = editorWith('one\ntwo', 5);
    pressEnter(ed);
    expect(editorMarkdown(ed)).toBe('one\n\ntwo');
  });

  it('in a list item: a new item, not a break opening it', () => {
    const ed = editorWith('- one\n  two', 6);
    pressEnter(ed);
    expect(editorMarkdown(ed)).toBe('- one\n- two');
  });

  it('away from a break, Enter splits as before', () => {
    const ed = editorWith('one\ntwo', 2);
    pressEnter(ed);
    expect(editorMarkdown(ed)).toBe('o\n\nne\ntwo');
  });
});
