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

/**
 * A save writes `markdown`, and the editor shows what reopening that file
 * shows. The save alone can't tell: a break left at the end of a paragraph is
 * an empty line on screen but isn't written.
 */
function expectShowsAndSaves(ed: Editor, markdown: string): void {
  expect(editorMarkdown(ed)).toBe(markdown);
  const reopened = editorWith(markdown, 1);
  expect(ed.getJSON()).toEqual(reopened.getJSON());
}

describe('Enter beside a soft break', () => {
  it('at the end of a line: two paragraphs, no HTML', () => {
    const ed = editorWith('one\ntwo', 4);
    pressEnter(ed);
    expectShowsAndSaves(ed, 'one\n\ntwo');
  });

  it('at the start of the next line: the same', () => {
    const ed = editorWith('one\ntwo', 5);
    pressEnter(ed);
    expectShowsAndSaves(ed, 'one\n\ntwo');
  });

  it('in a list item: a new item, not a break opening it', () => {
    const ed = editorWith('- one\n  two', 6);
    pressEnter(ed);
    expectShowsAndSaves(ed, '- one\n- two');
  });

  it('away from a break, Enter splits as before', () => {
    const ed = editorWith('one\ntwo', 2);
    pressEnter(ed);
    expectShowsAndSaves(ed, 'o\n\nne\ntwo');
  });
});
