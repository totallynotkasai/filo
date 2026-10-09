import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * A block marker typed at the start of a line joined to the one above by a
 * soft break (a note from Keep, a plain-text paste, an agent) starts that
 * block on that line alone, as the toolbar acts on one line. Typed through
 * the editor's text-input handlers, so the input rules run as for a user.
 */

const editors: Editor[] = [];
function makeEditor(md: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, md);
  return ed;
}
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

function type(ed: Editor, text: string): void {
  const view = ed.view;
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

/** Where each line break of the note is, in order. */
function breaks(ed: Editor, name = 'softBreak'): number[] {
  const out: number[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === name) out.push(pos);
  });
  return out;
}

/** The caret at the start of the note's line `n` (from 1), after its `n - 1`th break. */
function caretAtLine(ed: Editor, n: number, name = 'softBreak'): void {
  ed.commands.setTextSelection(breaks(ed, name)[n - 2]! + 1);
}

/** The note's blocks, by type and text. */
function blocks(ed: Editor): string[] {
  const out: string[] = [];
  ed.state.doc.forEach((node) => out.push(`${node.type.name}: ${node.textContent}`));
  return out;
}

function expectReadsBack(md: string): void {
  const again = makeEditor(md);
  expect(loadMarkdownIntoEditor(again, md).lossy).toBe(false);
  expect(editorMarkdown(again)).toBe(md);
}

const KEEP_NOTE = 'L1\nL2\nL3';

describe('a marker typed at the start of a soft-broken line', () => {
  const MARKERS: { typed: string; block: string; saved: string }[] = [
    { typed: '- ', block: 'bulletList', saved: '- L2' },
    { typed: '* ', block: 'bulletList', saved: '- L2' },
    { typed: '+ ', block: 'bulletList', saved: '- L2' },
    { typed: '1. ', block: 'orderedList', saved: '1. L2' },
    { typed: '3. ', block: 'orderedList', saved: '3. L2' },
    { typed: '[ ] ', block: 'taskList', saved: '- [ ] L2' },
    { typed: '[x] ', block: 'taskList', saved: '- [x] L2' },
    { typed: '> ', block: 'blockquote', saved: '> L2' },
    { typed: '# ', block: 'heading', saved: '# L2' },
    { typed: '### ', block: 'heading', saved: '### L2' },
    { typed: '###### ', block: 'heading', saved: '###### L2' },
  ];
  for (const m of MARKERS) {
    it(`${JSON.stringify(m.typed)} makes that line a ${m.block}, and the lines around it stay text`, () => {
      const ed = makeEditor(KEEP_NOTE);
      caretAtLine(ed, 2);
      type(ed, m.typed);
      expect(blocks(ed)).toEqual(['paragraph: L1', `${m.block}: L2`, 'paragraph: L3']);
      const md = editorMarkdown(ed);
      expect(md).toBe(`L1\n\n${m.saved}\n\nL3`);
      expectReadsBack(md);
    });
  }

  it('only the caret\'s line: the lines below stay joined', () => {
    const ed = makeEditor('L1\nL2\nL3\nL4');
    caretAtLine(ed, 2);
    type(ed, '- ');
    expect(blocks(ed)).toEqual(['paragraph: L1', 'bulletList: L2', 'paragraph: L3L4']);
    expect(breaks(ed)).toHaveLength(1);
    expect(editorMarkdown(ed)).toBe('L1\n\n- L2\n\nL3\nL4');
  });

  it('on the last line, and on a line after an empty one', () => {
    const last = makeEditor(KEEP_NOTE);
    caretAtLine(last, 3);
    type(last, '- ');
    expect(blocks(last)).toEqual(['paragraph: L1L2', 'bulletList: L3']);

    // An empty line inside the block: two soft breaks in a row (a blank line
    // in the file would be a paragraph boundary).
    const afterEmpty = makeEditor('');
    afterEmpty.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'L1' }, { type: 'softBreak' }, { type: 'softBreak' }, { type: 'text', text: 'L3' }] }],
    });
    caretAtLine(afterEmpty, 3);
    type(afterEmpty, '- ');
    expect(blocks(afterEmpty)).toEqual(['paragraph: L1', 'bulletList: L3']);
  });

  it('a line typed after it joins the list the line above made', () => {
    const ed = makeEditor(KEEP_NOTE);
    caretAtLine(ed, 2);
    type(ed, '- ');
    // L3 is now a block's first line: the usual rule.
    ed.commands.setTextSelection(ed.state.doc.content.size - 3);
    type(ed, '- ');
    expect(blocks(ed)).toEqual(['paragraph: L1', 'bulletList: L2L3']);
    expect(editorMarkdown(ed)).toBe('L1\n\n- L2\n- L3');
  });

  it('undo straight after (Backspace\'s undo of the rule, or Ctrl+Z) gives back the typed marker with the lines joined', () => {
    for (const undo of [(ed: Editor) => ed.commands.undoInputRule(), (ed: Editor) => ed.commands.undo()]) {
      const ed = makeEditor(KEEP_NOTE);
      caretAtLine(ed, 2);
      type(ed, '- ');
      expect(ed.state.doc.childCount).toBe(3);
      undo(ed);
      expect(blocks(ed)).toEqual(['paragraph: L1- L2L3']);
      expect(breaks(ed)).toHaveLength(2);
      expect(ed.state.selection.from).toBe(breaks(ed)[0]! + 3);
    }
  });

  it('the Backspace key itself undoes the rule', () => {
    const ed = makeEditor(KEEP_NOTE);
    caretAtLine(ed, 2);
    type(ed, '- ');
    expect(ed.state.doc.childCount).toBe(3);
    ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    expect(blocks(ed)).toEqual(['paragraph: L1- L2L3']);
    expect(breaks(ed)).toHaveLength(2);
  });
});

describe('a marker after a line break that stays text', () => {
  it('typed mid-line', () => {
    const ed = makeEditor(KEEP_NOTE);
    ed.commands.setTextSelection(breaks(ed)[0]! + 2);
    type(ed, '- ');
    expect(blocks(ed)).toEqual(['paragraph: L1L- 2L3']);
  });

  it('after a hard break (Shift+Enter), which the writer put inside one paragraph on purpose', () => {
    const ed = makeEditor('L1\\\nL2');
    caretAtLine(ed, 2, 'hardBreak');
    type(ed, '- ');
    expect(blocks(ed)).toEqual(['paragraph: L1- L2']);
  });

  it('in a list item, where a split would change the list', () => {
    const ed = makeEditor('- L1\n  L2');
    expect(breaks(ed)).toHaveLength(1);
    caretAtLine(ed, 2);
    type(ed, '- ');
    expect(blocks(ed)).toEqual(['bulletList: L1- L2']);
  });

  it('in a table cell, where a split would turn the table into HTML', () => {
    const ed = makeEditor('');
    ed.commands.setContent({
      type: 'doc',
      content: [{
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [{
            type: 'tableCell',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'L1' }, { type: 'softBreak' }, { type: 'text', text: 'L2' }] }],
          }],
        }],
      }],
    });
    caretAtLine(ed, 2);
    type(ed, '- ');
    const cell = ed.state.doc.firstChild!.firstChild!.firstChild!;
    expect(cell.childCount).toBe(1);
    expect(cell.textContent).toBe('L1- L2');
  });

  it('a year opening the line', () => {
    const ed = makeEditor(KEEP_NOTE);
    caretAtLine(ed, 2);
    type(ed, '1984. ');
    expect(blocks(ed)).toEqual(['paragraph: L11984. L2L3']);
  });

  it('a marker and Enter (the rules fire only on the typed space)', () => {
    const ed = makeEditor(KEEP_NOTE);
    caretAtLine(ed, 2);
    type(ed, '-');
    ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    let lists = 0;
    ed.state.doc.descendants((n) => {
      if (n.type.name === 'bulletList') lists++;
    });
    expect(lists).toBe(0);
  });
});
