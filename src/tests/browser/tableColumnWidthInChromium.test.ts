import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * A table column dragged to a width keeps it after a save and reopen. A
 * Markdown table has no widths, and the table was saved as one: the width
 * was gone on reopen, with nothing to say so. Such a table is now written as
 * HTML; one with no widths stays Markdown.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

function editorWith(markdown: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  return ed;
}

const TABLE = '| Name | Role |\n| --- | --- |\n| Aria | Scout |';

/** What dragging the first column's border does: a width on every cell of the column. */
function dragFirstColumnTo(ed: Editor, width: number): void {
  const tr = ed.state.tr;
  ed.state.doc.descendants((node, pos, parent) => {
    if ((node.type.name === 'tableCell' || node.type.name === 'tableHeader') && parent?.firstChild === node) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: [width] });
    }
    return true;
  });
  ed.view.dispatch(tr);
}

function columnWidths(ed: Editor): unknown[] {
  const widths: unknown[] = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') widths.push(node.attrs.colwidth);
    return true;
  });
  return widths;
}

describe('a table column dragged to a width', () => {
  it('keeps the width after a save and reopen, and the note reopens editable', () => {
    const ed = editorWith(TABLE);
    dragFirstColumnTo(ed, 320);
    const disk = editorMarkdown(ed);
    expect(disk).toMatch(/^<table/);
    expect(disk).toContain('colwidth="320"');

    const reopened = editorWith(disk);
    expect(columnWidths(reopened)).toEqual([[320], null, [320], null]);
    expect(editorMarkdown(reopened)).toBe(disk);
    const { lossy } = loadMarkdownIntoEditor(editorWith(''), disk);
    expect(lossy).toBe(false);
  });

  it('shows the width in the reopened table', () => {
    const ed = editorWith(TABLE);
    dragFirstColumnTo(ed, 300);
    const reopened = editorWith(editorMarkdown(ed));
    const col = reopened.view.dom.querySelector('colgroup col');
    expect((col as HTMLElement | null)?.style.width).toBe('300px');
  });

  it('a table with no widths is still written as Markdown', () => {
    const ed = editorWith(TABLE);
    const disk = editorMarkdown(ed);
    expect(disk).not.toMatch(/<table/);
    expect(disk.split('\n')[0]).toBe('| Name | Role |');
  });
});
