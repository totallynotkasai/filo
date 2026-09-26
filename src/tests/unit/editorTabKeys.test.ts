import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Tab and Shift+Tab in a note never let the key fall through to the browser
 * (which moved focus off the note), and what they do survives save → reload.
 */

const editors: Editor[] = [];
function makeEditor(markdown: string, host?: HTMLElement): Editor {
  const el = document.createElement('div');
  (host ?? document.body).appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  loadMarkdownIntoEditor(ed, markdown);
  editors.push(ed);
  return ed;
}
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

/** Press a key through ProseMirror's keydown handling; true when it was handled. */
function press(ed: Editor, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  return ed.view.someProp('handleKeyDown', (f) => f(ed.view, event)) ?? false;
}

/** Put the caret inside the first occurrence of `text`. */
function caretIn(ed: Editor, text: string): void {
  let at = -1;
  ed.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text) + 1;
  });
  if (at < 0) throw new Error(`no "${text}" in the note`);
  ed.commands.setTextSelection(at);
}

function reloads(ed: Editor): void {
  const disk = editorMarkdown(ed);
  const ed2 = makeEditor(disk);
  expect(editorMarkdown(ed2)).toBe(disk);
}

describe('Tab in a paragraph or heading', () => {
  it('indents, and Shift+Tab outdents; saved and reloaded', () => {
    const ed = makeEditor('Alpha\n\nBeta');
    caretIn(ed, 'Beta');
    expect(press(ed, 'Tab')).toBe(true);
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('Alpha\n\n<p style="margin-left: 48px;">Beta</p>');
    reloads(ed);

    expect(press(ed, 'Tab', true)).toBe(true);
    expect(editorMarkdown(ed)).toBe('Alpha\n\n<p style="margin-left: 24px;">Beta</p>');
    press(ed, 'Tab', true);
    expect(editorMarkdown(ed)).toBe('Alpha\n\nBeta');
  });

  it('Shift+Tab at no indent keeps the key (focus stays on the note)', () => {
    const ed = makeEditor('Alpha');
    caretIn(ed, 'Alpha');
    expect(press(ed, 'Tab', true)).toBe(true);
    expect(editorMarkdown(ed)).toBe('Alpha');
  });

  it('indents every selected block', () => {
    const ed = makeEditor('One\n\nTwo\n\nThree');
    ed.commands.setTextSelection({ from: 2, to: ed.state.doc.child(0).nodeSize + 3 });
    press(ed, 'Tab');
    expect(editorMarkdown(ed)).toBe(
      '<p style="margin-left: 24px;">One</p>\n\n<p style="margin-left: 24px;">Two</p>\n\nThree',
    );
    reloads(ed);
  });

  it('indents a heading', () => {
    const ed = makeEditor('## Title');
    caretIn(ed, 'Title');
    press(ed, 'Tab');
    expect(editorMarkdown(ed)).toContain('margin-left: 24px');
    reloads(ed);
  });
});

describe('Tab in lists and code', () => {
  it('nests a list item, and Shift+Tab un-nests it; saved as Markdown nesting', () => {
    const ed = makeEditor('- one\n- two');
    caretIn(ed, 'two');
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('- one\n  - two');
    reloads(ed);
    expect(press(ed, 'Tab', true)).toBe(true);
    expect(editorMarkdown(ed)).toBe('- one\n- two');
  });

  it('on a first list item (nothing to nest under) keeps the key and changes nothing', () => {
    const ed = makeEditor('- one\n- two');
    caretIn(ed, 'one');
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('- one\n- two');
  });

  it('nests a task item', () => {
    const ed = makeEditor('- [ ] one\n- [ ] two');
    caretIn(ed, 'two');
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('- [ ] one\n  - [ ] two');
    reloads(ed);
  });

  it('inserts a tab character in a code block', () => {
    const ed = makeEditor('```\ncode\n```');
    caretIn(ed, 'code');
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('```\nc\tode\n```');
    reloads(ed);
  });
});

describe('read-only and Escape', () => {
  it('a read-only note leaves Tab to the browser', () => {
    const ed = makeEditor('Alpha');
    caretIn(ed, 'Alpha');
    ed.setEditable(false);
    expect(press(ed, 'Tab')).toBe(false);
  });

  it('Escape moves focus to the tile and leaves the key for the app', () => {
    const tile = document.createElement('div');
    tile.tabIndex = 0;
    document.body.appendChild(tile);
    const ed = makeEditor('Alpha', tile);
    ed.commands.focus();
    expect(press(ed, 'Escape')).toBe(false);
    expect(document.activeElement).toBe(tile);
  });
});
