import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createLabelEditor } from '../../renderer/lib/editor/createEditor';
import { resolveTitleCommitValues } from '../../renderer/lib/editor/titleCommit';

/**
 * Pasting two lines into a tile, card or frame title, through the browser's
 * own paste: the title stays one line, the lines joined with a space. A title
 * is one line (Enter commits it), but a paste put a newline into the note's
 * `title:`, and the placeholder rename then named the file
 * `Chapter One--The River.md`.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

function titleEditor(content: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createLabelEditor({ element: el, content });
  editors.push(ed);
  return ed;
}

describe('pasting lines into a title', () => {
  it('plain text with a newline', () => {
    const ed = titleEditor('<p>Chapter</p>');
    ed.commands.setTextSelection(ed.state.doc.content.size - 1);
    ed.view.pasteText(' One\nThe River');
    expect(ed.state.doc.childCount).toBe(1);
    expect(resolveTitleCommitValues(ed.getText(), ed.getHTML(), 'New Tile').plain).toBe('Chapter One The River');
  });

  it('two paragraphs copied from a note', () => {
    const ed = titleEditor('<p></p>');
    ed.view.pasteHTML('<p>Chapter One</p><p>The River</p>');
    expect(ed.state.doc.childCount).toBe(1);
    const snap = resolveTitleCommitValues(ed.getText(), ed.getHTML(), 'New Tile');
    expect(snap.plain).toBe('Chapter One The River');
    expect(snap.titleHtml).toBeUndefined();
  });

  it('a heading and a list copied from a note', () => {
    const ed = titleEditor('<p></p>');
    ed.view.pasteHTML('<h2>Part <em>Two</em></h2><ul><li><p>first</p></li><li><p>second</p></li></ul>');
    expect(ed.state.doc.childCount).toBe(1);
    expect(ed.getText()).toBe('Part Two first second');
  });
});
