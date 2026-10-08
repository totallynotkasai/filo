import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import './helpers/mountEditor';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';

/**
 * Enter beside a soft break (a note written one line per thought) opens a new
 * empty line there, as Enter at the end or start of a paragraph does: the
 * break becomes a paragraph boundary and Enter then runs at the caret. Lines
 * stand with no gap between paragraphs, so a boundary alone shows nothing and
 * the next typing joined the following line ("SpeedEndurance"). No
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

/** Types `text` at the caret, as a key press would insert it. */
function type(ed: Editor, text: string): void {
  ed.view.dispatch(ed.state.tr.insertText(text));
}

/** The caret just after `text`'s first occurrence. */
function caretAfter(ed: Editor, text: string): number {
  let pos = -1;
  ed.state.doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text!.includes(text)) pos = p + n.text!.indexOf(text) + text.length;
    return pos < 0;
  });
  return pos;
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
  it('at the end of a line: a new empty line under it, and typing goes there', () => {
    const ed = editorWith('one\ntwo', 4);
    pressEnter(ed);
    expectShowsAndSaves(ed, 'one\n\n\ntwo');
    expect(ed.state.selection.$from.parent.content.size).toBe(0);
    type(ed, 'new');
    expectShowsAndSaves(ed, 'one\n\nnew\n\ntwo');
  });

  it('at the start of the next line: a new empty line above it, the caret stays on the line', () => {
    const ed = editorWith('one\ntwo', 5);
    pressEnter(ed);
    expectShowsAndSaves(ed, 'one\n\n\ntwo');
    type(ed, 'X');
    expectShowsAndSaves(ed, 'one\n\n\nXtwo');
  });

  it('a stat block from a note: the typed line lands between the two lines', () => {
    const ed = editorWith('Strength - raw power\nEndurance - stamina\nVitality - HP pool', 1);
    ed.commands.setTextSelection(caretAfter(ed, 'raw power'));
    pressEnter(ed);
    type(ed, 'Speed - movement');
    const saved = editorMarkdown(ed);
    expect(saved).not.toContain('SpeedEndurance');
    expectShowsAndSaves(ed, 'Strength - raw power\n\nSpeed - movement\n\nEndurance - stamina\nVitality - HP pool');
  });

  it('on an empty line between two breaks: another empty line, the caret on it', () => {
    const ed = editorWith('one<br data-filo-soft-break><br data-filo-soft-break>two', 1);
    ed.commands.setTextSelection(caretAfter(ed, 'one') + 1);
    pressEnter(ed);
    type(ed, 'mid');
    expectShowsAndSaves(ed, 'one\n\n\nmid\n\ntwo');
  });

  it('one undo puts the lines back as they were', () => {
    const ed = editorWith('one\ntwo', 4);
    pressEnter(ed);
    ed.commands.undo();
    expectShowsAndSaves(ed, 'one\ntwo');
  });

  it('in a list item: a new empty item between the two lines, which become items', () => {
    const ed = editorWith('- one\n  two', 6);
    pressEnter(ed);
    type(ed, 'mid');
    expectShowsAndSaves(ed, '- one\n- mid\n- two');
  });

  it('in a heading: the line under it is a new paragraph', () => {
    const ed = editorWith('## one<br data-filo-soft-break>two', 1);
    ed.commands.setTextSelection(caretAfter(ed, 'one'));
    pressEnter(ed);
    type(ed, 'text');
    expectShowsAndSaves(ed, '## one\n\ntext\n\n## two');
  });

  it('away from a break, Enter splits as before', () => {
    const ed = editorWith('one\ntwo', 2);
    pressEnter(ed);
    expectShowsAndSaves(ed, 'o\n\nne\ntwo');
  });
});
