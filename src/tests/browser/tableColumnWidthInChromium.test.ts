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

/**
 * The Document tab's zoom is CSS `zoom` on the page. prosemirror-tables
 * added the pointer's screen pixels to the column's own pixels, so at 150% the
 * border ran half again as fast as the pointer.
 */
describe('a table column dragged in a zoomed note', () => {
  function zoomedEditor(zoom: number): Editor {
    const page = document.createElement('div');
    page.style.zoom = String(zoom);
    page.style.width = '700px';
    document.body.appendChild(page);
    const el = document.createElement('div');
    page.appendChild(el);
    const ed = createTiptapEditor({ element: el, content: '' });
    editors.push(ed);
    loadMarkdownIntoEditor(ed, TABLE);
    dragFirstColumnTo(ed, 200);
    return ed;
  }

  function mouse(target: EventTarget, type: string, x: number, y: number, buttons: number): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons }));
  }

  /** Drags the first column's right border `dx` screen pixels; returns how far its border moved on screen. */
  function dragBorder(ed: Editor, dx: number): number {
    const cell = ed.view.dom.querySelector('th') as HTMLElement;
    const before = cell.getBoundingClientRect();
    const x = before.right - 2;
    const y = before.top + before.height / 2;
    mouse(cell, 'mousemove', x, y, 0);
    mouse(cell, 'mousedown', x, y, 1);
    mouse(window, 'mousemove', x + dx / 2, y, 1);
    mouse(window, 'mousemove', x + dx, y, 1);
    mouse(window, 'mouseup', x + dx, y, 0);
    const after = (ed.view.dom.querySelector('th') as HTMLElement).getBoundingClientRect();
    return after.right - before.right;
  }

  for (const zoom of [1, 1.5, 0.75]) {
    it(`follows the pointer at ${zoom * 100}%, and saves the width in the note's own pixels`, () => {
      const ed = zoomedEditor(zoom);
      const moved = dragBorder(ed, 60);
      expect(Math.abs(moved - 60), `the border moved ${moved} px for 60 px of pointer`).toBeLessThan(2);
      const width = columnWidths(ed)[0] as number[];
      expect(Math.abs(width[0]! - (200 + 60 / zoom))).toBeLessThan(1);
      // One width for the whole column, as the library sets it.
      expect(columnWidths(ed)[2]).toEqual(width);
    });
  }
});
