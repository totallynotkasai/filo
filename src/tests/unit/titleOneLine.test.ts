import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import type { Slice } from '@tiptap/pm/model';
import { createLabelEditor } from '@renderer/lib/editor/createEditor';
import { resolveTitleCommitValues } from '@renderer/lib/editor/titleCommit';

/**
 * A title (a tile's, a card's, a frame's) and a connection label are one line:
 * a pasted line break or paragraph is a space, so `title:` never holds a
 * newline and a placeholder rename never names a file `Chapter One--The River.md`.
 * The real paste, with the browser's clipboard events, is in
 * `titlePasteInChromium.test.ts`.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function labelEditor(content: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createLabelEditor({ element: el, content });
  editors.push(ed);
  return ed;
}

/** What the editor's paste transform makes of `html` (the slice a paste of it would insert). */
function pasted(ed: Editor, html: string): Slice {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  let slice = ProseMirrorDOMParser.fromSchema(ed.schema).parseSlice(holder);
  ed.view.someProp('transformPasted', (f) => {
    slice = f(slice, ed.view, false);
  });
  return slice;
}

describe('a title is one line', () => {
  it('the commit joins lines with a space', () => {
    expect(resolveTitleCommitValues('Chapter One\n\nThe River', '<p>Chapter One</p>', 'New Tile').plain).toBe('Chapter One The River');
    expect(resolveTitleCommitValues('  A \r\n B  ', '<p>A B</p>', 'New Tile').plain).toBe('A B');
  });

  it('the commit keeps spaces the title was typed with', () => {
    expect(resolveTitleCommitValues('A  B', '<p>A  B</p>', 'New Tile').plain).toBe('A  B');
  });

  it('a title saved over two paragraphs opens as one line, losing no words', () => {
    const ed = labelEditor('<p>Chapter One</p><p>The River</p>');
    expect(ed.state.doc.childCount).toBe(1);
    expect(ed.getText()).toBe('Chapter One The River');
  });

  it('a line break in a saved title opens as a space', () => {
    const ed = labelEditor('<p>Chapter<br>One</p>');
    expect(ed.getText()).toBe('Chapter One');
  });

  it('a pasted pair of paragraphs becomes one line, its formatting kept', () => {
    const ed = labelEditor('<p></p>');
    const slice = pasted(ed, '<p>Chapter <strong>One</strong></p><p>The River</p>');
    expect(slice.content.childCount).toBe(1);
    expect(slice.content.firstChild!.textContent).toBe('Chapter One The River');
    const bold = slice.content.firstChild!.child(1);
    expect(bold.marks.map((m) => m.type.name)).toEqual(['bold']);
  });

  it('a pasted line break becomes a space', () => {
    const ed = labelEditor('<p></p>');
    const { content } = pasted(ed, 'Chapter<br>One');
    expect(content.textBetween(0, content.size)).toBe('Chapter One');
  });

  it('a pasted single line is left as it is', () => {
    const ed = labelEditor('<p></p>');
    const { content } = pasted(ed, '<p>Just <em>one</em></p>');
    expect(content.childCount).toBe(1);
    expect(content.firstChild!.textContent).toBe('Just one');
    expect(content.firstChild!.child(1).marks.map((m) => m.type.name)).toEqual(['italic']);
  });
});
