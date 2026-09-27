import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Tab, Shift+Tab and Backspace in a note behave as in a word processor, never
 * let Tab fall through to the browser (which moved focus off the note), and
 * every tab survives save → reload byte for byte.
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

/** Put the caret `offset` characters into the first occurrence of `text`. */
function caretAt(ed: Editor, text: string, offset = 0): number {
  let at = -1;
  ed.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text) + offset;
  });
  if (at < 0) throw new Error(`no "${text}" in the note`);
  ed.commands.setTextSelection(at);
  return at;
}

/** Saves, reloads into a fresh editor, and checks the reload is exact. */
function reloads(ed: Editor): Editor {
  const disk = editorMarkdown(ed);
  const ed2 = makeEditor('');
  const { lossy } = loadMarkdownIntoEditor(ed2, disk);
  expect(lossy).toBe(false);
  expect(ed2.getJSON()).toEqual(ed.getJSON());
  expect(editorMarkdown(ed2)).toBe(disk);
  return ed2;
}

describe('Tab types a tab at the caret', () => {
  it('mid-line: a tab character in the file; Backspace deletes it', () => {
    const ed = makeEditor('Alpha');
    caretAt(ed, 'Alpha', 2);
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('Al\tpha');
    reloads(ed);

    press(ed, 'Backspace');
    expect(editorMarkdown(ed)).toBe('Alpha');
  });

  it('at the start of a line: saved as &#9; so it stays a paragraph, not a code block', () => {
    const ed = makeEditor('Alpha');
    caretAt(ed, 'Alpha');
    press(ed, 'Tab');
    press(ed, 'Tab');
    expect(editorMarkdown(ed)).toBe('&#9;&#9;Alpha');
    const back = reloads(ed);
    expect(back.state.doc.firstChild!.type.name).toBe('paragraph');
  });

  it('at the end of a line, in a heading, and after a line break', () => {
    const end = makeEditor('Alpha');
    caretAt(end, 'Alpha', 5);
    press(end, 'Tab');
    expect(editorMarkdown(end)).toBe('Alpha&#9;');
    reloads(end);

    const heading = makeEditor('## Title');
    caretAt(heading, 'Title');
    press(heading, 'Tab');
    expect(editorMarkdown(heading)).toBe('## &#9;Title');
    reloads(heading);

    const broken = makeEditor('One\\\nTwo');
    caretAt(broken, 'Two');
    press(broken, 'Tab');
    expect(editorMarkdown(broken)).toBe('One\\\n&#9;Two');
    reloads(broken);
  });

  it('replaces a selection within the line', () => {
    const ed = makeEditor('Alpha beta');
    const from = caretAt(ed, 'Alpha', 5);
    ed.commands.setTextSelection({ from, to: from + 1 });
    press(ed, 'Tab');
    expect(editorMarkdown(ed)).toBe('Alpha\tbeta');
  });

  it('a note that already holds tabs opens editable and saves the same bytes', () => {
    for (const md of ['Col a\tCol b\tCol c', '&#9;Indented start', '**Bold\tspaced** and\ttext']) {
      const ed = makeEditor('');
      const { lossy } = loadMarkdownIntoEditor(ed, md);
      expect({ md, lossy, saved: editorMarkdown(ed) }).toEqual({ md, lossy: false, saved: md });
    }
  });

  it('a tab in an aligned paragraph is a tab character in its HTML line', () => {
    const ed = makeEditor('Alpha');
    caretAt(ed, 'Alpha', 2);
    press(ed, 'Tab');
    ed.chain().setTextAlign('center').run();
    expect(editorMarkdown(ed)).toBe('<p style="text-align: center;">Al\tpha</p>');
    reloads(ed);
  });
});

describe('Shift+Tab and Backspace', () => {
  it('Shift+Tab removes the tab before the caret', () => {
    const ed = makeEditor('Alpha');
    caretAt(ed, 'Alpha', 2);
    press(ed, 'Tab');
    expect(press(ed, 'Tab', true)).toBe(true);
    expect(editorMarkdown(ed)).toBe('Alpha');
  });

  it('Shift+Tab with nothing to remove keeps the key (focus stays on the note)', () => {
    const ed = makeEditor('Alpha');
    caretAt(ed, 'Alpha');
    expect(press(ed, 'Tab', true)).toBe(true);
    expect(editorMarkdown(ed)).toBe('Alpha');
  });

  it('with several lines selected, Tab indents them all and Shift+Tab outdents', () => {
    const ed = makeEditor('One\n\nTwo\n\nThree');
    ed.commands.setTextSelection({ from: 2, to: ed.state.doc.child(0).nodeSize + 3 });
    press(ed, 'Tab');
    expect(editorMarkdown(ed)).toBe(
      '<p style="margin-left: 24px;">One</p>\n\n<p style="margin-left: 24px;">Two</p>\n\nThree',
    );
    reloads(ed);
    press(ed, 'Tab', true);
    expect(editorMarkdown(ed)).toBe('One\n\nTwo\n\nThree');
  });

  it('Backspace at the start of an indented paragraph removes one indent step', () => {
    const ed = makeEditor('<p style="margin-left: 48px;">Alpha</p>');
    caretAt(ed, 'Alpha');
    expect(press(ed, 'Backspace')).toBe(true);
    expect(editorMarkdown(ed)).toBe('<p style="margin-left: 24px;">Alpha</p>');
    press(ed, 'Backspace');
    expect(editorMarkdown(ed)).toBe('Alpha');
  });

  it('Backspace at the start of an indented paragraph under another outdents it, not joins it', () => {
    const ed = makeEditor('Alpha\n\n<p style="margin-left: 24px;">Beta</p>');
    caretAt(ed, 'Beta');
    expect(press(ed, 'Backspace')).toBe(true);
    expect(editorMarkdown(ed)).toBe('Alpha\n\nBeta');
    press(ed, 'Backspace');
    expect(editorMarkdown(ed)).toBe('AlphaBeta');
  });

  it('Tab over lines that reach into a list indents only the plain lines; the list stays Markdown', () => {
    const ed = makeEditor('Intro\n\n- one\n- two');
    const listEnd = ed.state.doc.content.size - 3;
    ed.commands.setTextSelection({ from: 2, to: listEnd });
    press(ed, 'Tab');
    expect(editorMarkdown(ed)).toBe('<p style="margin-left: 24px;">Intro</p>\n\n- one\n- two');
    reloads(ed);
  });

  it.each([
    ['closing', 'bold\tafter', 1, 6, '**bold**\tafter'],
    ['opening', 'before\tbold', 7, 12, 'before\t**bold**'],
    ['closing, after two tabs', 'bold\t\tafter', 1, 7, '**bold**\t\tafter'],
  ])('a tab %s a bold run is saved outside it, so the bold survives reload', (_, md, from, to, expected) => {
    const ed = makeEditor(md);
    ed.commands.setTextSelection({ from, to });
    ed.commands.toggleBold();
    const saved = editorMarkdown(ed);
    expect(saved).toBe(expected);
    const ed2 = makeEditor('');
    expect(loadMarkdownIntoEditor(ed2, saved).lossy).toBe(false);
    expect(ed2.getHTML()).toContain('<strong>bold</strong>');
    expect(editorMarkdown(ed2)).toBe(saved);
  });

  it('a tab inside a bold run keeps its character', () => {
    const ed = makeEditor('**a\tb**');
    expect(editorMarkdown(ed)).toBe('**a\tb**');
    reloads(ed);
  });

  it('Backspace anywhere else is ordinary', () => {
    const ed = makeEditor('Alpha\n\nBeta');
    caretAt(ed, 'Beta');
    press(ed, 'Backspace');
    expect(editorMarkdown(ed)).toBe('AlphaBeta');
  });
});

describe('Tab in lists and code', () => {
  it('nests a list item, and Shift+Tab un-nests it; saved as Markdown nesting', () => {
    const ed = makeEditor('- one\n- two');
    caretAt(ed, 'two', 1);
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('- one\n  - two');
    reloads(ed);
    expect(press(ed, 'Tab', true)).toBe(true);
    expect(editorMarkdown(ed)).toBe('- one\n- two');
  });

  it('on a first list item (nothing to nest under) keeps the key and changes nothing', () => {
    const ed = makeEditor('- one\n- two');
    caretAt(ed, 'one', 1);
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('- one\n- two');
  });

  it('nests a task item', () => {
    const ed = makeEditor('- [ ] one\n- [ ] two');
    caretAt(ed, 'two', 1);
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('- [ ] one\n  - [ ] two');
    reloads(ed);
  });

  it('inserts a tab character in a code block, and Shift+Tab takes it out', () => {
    const ed = makeEditor('```\ncode\n```');
    caretAt(ed, 'code', 1);
    expect(press(ed, 'Tab')).toBe(true);
    expect(editorMarkdown(ed)).toBe('```\nc\tode\n```');
    reloads(ed);
    press(ed, 'Tab', true);
    expect(editorMarkdown(ed)).toBe('```\ncode\n```');
  });
});

describe('read-only and Escape', () => {
  it('a read-only note leaves Tab to the browser', () => {
    const ed = makeEditor('Alpha');
    caretAt(ed, 'Alpha');
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
