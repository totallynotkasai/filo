import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';
import { isolateSelectedLines } from '@renderer/lib/editor/lineBlocks';
import { clearBlockTextStyle } from '@renderer/lib/editor/blockTextStyle';

/**
 * A block command on one line of soft-broken lines acts on that line alone
 * (`lineBlocks.ts`). Every command's save and reload is in the toolbar cases
 * (`helpers/toolbarCases.ts`); this covers the split itself.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function editorWith(md: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, md);
  return ed;
}

/** The position just inside `text` (after its first character). */
function inside(ed: Editor, text: string): number {
  let pos = -1;
  ed.state.doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text!.includes(text)) pos = p + n.text!.indexOf(text) + 1;
    return pos < 0;
  });
  return pos;
}

const NOTE = 'Dear Aria,\nThe ferry leaves at dawn.\nBring the letter.';

describe('block commands on one line of soft-broken lines', () => {
  it('Heading 2 on the first line makes that line alone the heading', () => {
    const ed = editorWith(NOTE);
    ed.commands.setTextSelection(inside(ed, 'Dear'));
    ed.chain().toggleHeading({ level: 2 }).run();
    expect(editorMarkdown(ed)).toBe('## Dear Aria,\n\nThe ferry leaves at dawn.\nBring the letter.');
  });

  it('Centre on the first line centres that line alone', () => {
    const ed = editorWith(NOTE);
    ed.commands.setTextSelection(inside(ed, 'Dear'));
    ed.chain().setTextAlign('center').run();
    expect(editorMarkdown(ed)).toBe('<p style="text-align: center;">Dear Aria,</p>\n\nThe ferry leaves at dawn.\nBring the letter.');
  });

  it('one undo puts the lines back together', () => {
    const ed = editorWith(NOTE);
    ed.commands.setTextSelection(inside(ed, 'The ferry'));
    ed.chain().setHeading({ level: 3 }).run();
    ed.commands.undo();
    expect(editorMarkdown(ed)).toBe(NOTE);
  });

  it('the selection keeps its text', () => {
    const ed = editorWith(NOTE);
    const from = inside(ed, 'ferry');
    ed.commands.setTextSelection({ from, to: from + 4 });
    ed.chain().setHeading({ level: 3 }).run();
    const { from: a, to: b } = ed.state.selection;
    expect(ed.state.doc.textBetween(a, b)).toBe('erry');
  });

  it('a can() check splits nothing', () => {
    const ed = editorWith(NOTE);
    ed.commands.setTextSelection(inside(ed, 'The ferry'));
    expect(ed.can().setHeading({ level: 3 })).toBe(true);
    expect(ed.can().setTextAlign('center')).toBe(true);
    expect(editorMarkdown(ed)).toBe(NOTE);
  });

  it('in a list item the lines stay one item', () => {
    const ed = editorWith('- one\n  two\n- three');
    ed.commands.setTextSelection(inside(ed, 'two'));
    ed.chain().switchList('orderedList').run();
    expect(editorMarkdown(ed)).toBe('1. one\n   two\n2. three');
  });

  it('a hard break (Shift+Enter) keeps its paragraph whole', () => {
    const ed = editorWith('one\\\ntwo');
    ed.commands.setTextSelection(inside(ed, 'two'));
    ed.chain().setTextAlign('right').run();
    expect(editorMarkdown(ed)).toBe('<p style="text-align: right;">one<br>two</p>');
  });

  it('a command that changes nothing leaves the lines joined in the file', () => {
    const ed = editorWith(NOTE);
    ed.commands.setTextSelection(inside(ed, 'The ferry'));
    ed.chain().decreaseIndent().run();
    ed.chain().setTextAlign('left').run();
    ed.chain().setParagraph().run();
    expect(editorMarkdown(ed)).toBe(NOTE);
    expect(ed.state.doc.childCount).toBe(1);
  });

  it('a command that changes the line keeps it apart, and its neighbours joined to theirs', () => {
    const ed = editorWith('one\ntwo\nthree\nfour');
    ed.commands.setTextSelection(inside(ed, 'three'));
    ed.chain().increaseIndent().run();
    expect(editorMarkdown(ed)).toBe('one\ntwo\n\n<p style="margin-left: 24px;">three</p>\n\nfour');
  });

  it("the heading dropdown's style clear leaves the other lines' sizes and colours", () => {
    const ed = editorWith('<span style="font-size: 20px">Dear</span> Aria,\nThe <span style="color: #ff0000">ferry</span> leaves.\nBring <span style="font-size: 20px">it</span>.');
    ed.commands.setTextSelection(inside(ed, 'ferry'));
    ed.chain().command(clearBlockTextStyle).setHeading({ level: 3 }).run();
    expect(editorMarkdown(ed)).toBe(
      '<span style="font-size: 20px;">Dear</span> Aria,\n\n### The ferry leaves.\n\nBring <span style="font-size: 20px;">it</span>.',
    );
  });

  it('isolateSelectedLines leaves a block with no soft break alone', () => {
    const ed = editorWith('one two');
    const tr = ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 3));
    isolateSelectedLines(tr);
    expect(tr.docChanged).toBe(false);
  });
});
