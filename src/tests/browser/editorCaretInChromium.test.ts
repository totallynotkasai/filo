import { describe, it, expect, afterEach } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Editor } from '@tiptap/core';
import '../../css/style.css';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Caret behaviour jsdom can't lay out, with real key presses in Chromium and
 * the app's own editor styles. The jsdom suites (`softBreakEnter.test.ts`,
 * `editorTabKeys.test.ts`) hand a keydown straight to ProseMirror; here the
 * browser places the caret (End, Home, the arrows, Shift+Down) and any key the
 * editor doesn't take gets the browser's own action: a Tab that fell through
 * would move focus off the note.
 *
 * Each caret key is followed by `caretAt`, which waits until the editor has
 * the position the browser gave the caret, and checks it. The editor learns
 * of a caret move from the browser's `selectionchange` event, which comes a
 * moment after the key; a person's keys are tens of milliseconds apart, but
 * keys sent back to back can reach the editor before it.
 *
 * Positions: in `one⏎two` (a soft break between the lines) the first line is
 * 1–4, the break 4–5, the second line 5–8. No case puts the caret on the
 * document's very start by a key: within 200 ms of the editor taking focus,
 * ProseMirror takes that for the browser resetting the caret and puts the old
 * one back.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

/** A note editor in the page with the caret at `caret`, focused. */
function editorWith(markdown: string, caret: number): Editor {
  const el = document.createElement('div');
  el.style.width = '480px';
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  ed.view.focus();
  ed.commands.setTextSelection(caret);
  return ed;
}

/** Waits until the editor's selection is `from`–`to` (a caret when `to` is left out). */
async function caretAt(ed: Editor, from: number, to: number = from): Promise<void> {
  await expect.poll(() => [ed.state.selection.from, ed.state.selection.to]).toEqual([from, to]);
}

/** Waits until a save would write `markdown`. */
async function savesAs(ed: Editor, markdown: string): Promise<void> {
  await expect.poll(() => editorMarkdown(ed)).toBe(markdown);
}

/**
 * Waits until a save would write `markdown`, and checks the editor shows what
 * reopening that file shows. The save alone can't tell: a break left at the
 * end of a paragraph is an empty line on screen but isn't written.
 */
async function showsAndSavesAs(ed: Editor, markdown: string): Promise<void> {
  await savesAs(ed, markdown);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const reopened = createTiptapEditor({ element: el, content: '' });
  editors.push(reopened);
  loadMarkdownIntoEditor(reopened, markdown);
  expect(ed.getJSON()).toEqual(reopened.getJSON());
}

describe('Enter beside a soft break', () => {
  // After Enter at the end of `one`: `one` is 1–4, the new empty line's caret
  // place is 6, and `two` starts at 8.
  it('End on the first line, then Enter: a new empty line under it, no HTML, and typing goes there', async () => {
    const ed = editorWith('one\ntwo', 1);
    await userEvent.keyboard('{End}');
    await caretAt(ed, 4);
    await userEvent.keyboard('{Enter}');
    await caretAt(ed, 6);
    await showsAndSavesAs(ed, 'one\n\n\ntwo');
    await userEvent.keyboard('new');
    await showsAndSavesAs(ed, 'one\n\nnew\n\ntwo');
  });

  it('Home on the second line, then Enter: a new empty line above it, the caret stays on the line', async () => {
    const ed = editorWith('one\ntwo', 8);
    await userEvent.keyboard('{Home}');
    await caretAt(ed, 5);
    await userEvent.keyboard('{Enter}');
    await caretAt(ed, 8);
    await showsAndSavesAs(ed, 'one\n\n\ntwo');
  });

  it('the new line shows: the note grows by a line, and typing never joins the next line', async () => {
    const ed = editorWith('Strength - raw power\nEndurance - stamina\nVitality - HP pool', 2);
    await userEvent.keyboard('{End}');
    await caretAt(ed, 21);
    const before = ed.view.dom.getBoundingClientRect().height;
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => ed.view.dom.getBoundingClientRect().height).toBeGreaterThan(before);
    await userEvent.keyboard('Speed');
    await showsAndSavesAs(ed, 'Strength - raw power\n\nSpeed\n\nEndurance - stamina\nVitality - HP pool');
  });

  it('in a list item: a new empty item between the two lines, which become items', async () => {
    // The item's text starts at 3: list, item and paragraph each open one position.
    const ed = editorWith('- one\n  two', 3);
    await userEvent.keyboard('{End}');
    await caretAt(ed, 6);
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('mid');
    await showsAndSavesAs(ed, '- one\n- mid\n- two');
  });

  it('away from a break, Enter splits as before', async () => {
    const ed = editorWith('one\ntwo', 2);
    await userEvent.keyboard('{Enter}');
    await showsAndSavesAs(ed, 'o\n\nne\ntwo');
  });
});

describe('Tab, Shift+Tab and Backspace', () => {
  it('Tab types a tab and the note keeps the focus; a letter typed next lands after it; Backspace takes each back', async () => {
    const ed = editorWith('Alpha', 3);
    await userEvent.keyboard('{Tab}');
    await savesAs(ed, 'Al\tpha');
    expect(document.activeElement).toBe(ed.view.dom);

    await userEvent.keyboard('x');
    await savesAs(ed, 'Al\txpha');
    await userEvent.keyboard('{Backspace}');
    await savesAs(ed, 'Al\tpha');
    await userEvent.keyboard('{Backspace}');
    await savesAs(ed, 'Alpha');
  });

  it('Shift+Tab removes the tab before the caret; with none left, it keeps the focus on the note', async () => {
    const ed = editorWith('Alpha', 3);
    await userEvent.keyboard('{Tab}{Tab}');
    await savesAs(ed, 'Al\t\tpha');
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await savesAs(ed, 'Al\tpha');
    await userEvent.keyboard('{Shift>}{Tab}{Tab}{/Shift}');
    await savesAs(ed, 'Alpha');
    expect(document.activeElement).toBe(ed.view.dom);
  });

  it('Backspace at the start of an indented paragraph removes one indent step at a time, then joins as usual', async () => {
    // `Alpha` is 1–6; the indented paragraph's text starts at 8.
    const ed = editorWith('Alpha\n\n<p style="margin-left: 48px;">Beta</p>', 1);
    await userEvent.keyboard('{ArrowDown}');
    await caretAt(ed, 8);
    await userEvent.keyboard('{Backspace}');
    await savesAs(ed, 'Alpha\n\n<p style="margin-left: 24px;">Beta</p>');
    await userEvent.keyboard('{Backspace}');
    await savesAs(ed, 'Alpha\n\nBeta');
    await userEvent.keyboard('{Backspace}');
    await savesAs(ed, 'AlphaBeta');
  });

  it('lines selected with Shift+Down: Tab indents them all, Shift+Tab outdents', async () => {
    // `One` is 1–4; `Two` starts at 6.
    const ed = editorWith('One\n\nTwo\n\nThree', 1);
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await caretAt(ed, 1, 6);
    await userEvent.keyboard('{Tab}');
    await savesAs(ed, '<p style="margin-left: 24px;">One</p>\n\n<p style="margin-left: 24px;">Two</p>\n\nThree');
    expect(document.activeElement).toBe(ed.view.dom);
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await savesAs(ed, 'One\n\nTwo\n\nThree');
  });
});

describe('arrow keys across a soft break', () => {
  it('ArrowRight at the end of a line moves to the start of the next', async () => {
    const ed = editorWith('one\ntwo', 1);
    await userEvent.keyboard('{End}');
    await caretAt(ed, 4);
    await userEvent.keyboard('{ArrowRight}');
    await caretAt(ed, 5);
    await userEvent.keyboard('X');
    await savesAs(ed, 'one\nXtwo');
  });

  it('ArrowLeft at the start of a line moves to the end of the one above', async () => {
    const ed = editorWith('one\ntwo', 8);
    await userEvent.keyboard('{Home}');
    await caretAt(ed, 5);
    await userEvent.keyboard('{ArrowLeft}');
    await caretAt(ed, 4);
    await userEvent.keyboard('X');
    await savesAs(ed, 'oneX\ntwo');
  });

  it('ArrowDown and ArrowUp keep the column', async () => {
    // Two equal lines, so the column is the same character count on both.
    const down = editorWith('abcd\nabcd', 3);
    await userEvent.keyboard('{ArrowDown}');
    await caretAt(down, 8);
    await userEvent.keyboard('X');
    await savesAs(down, 'abcd\nabXcd');

    const up = editorWith('abcd\nabcd', 8);
    await userEvent.keyboard('{ArrowUp}');
    await caretAt(up, 3);
    await userEvent.keyboard('Y');
    await savesAs(up, 'abYcd\nabcd');
  });
});
