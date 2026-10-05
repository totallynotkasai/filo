import { describe, it, expect, afterEach } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Spaces typed at the end of a line, with real keys in Chromium. Markdown
 * drops them there, or reads two before a newline as a line break, so they
 * were saved and then gone (or a line break) once the note reopened, and its
 * next save wrote different bytes. They are left out of the file.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

function makeEditor(): Editor {
  const el = document.createElement('div');
  el.style.width = '480px';
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}

/** A note holding `markdown`, the caret after `caretAfter`, then `keys` typed. */
async function typeInto(markdown: string, caretAfter: string, keys: string): Promise<Editor> {
  const ed = makeEditor();
  loadMarkdownIntoEditor(ed, markdown);
  ed.view.focus();
  let pos = -1;
  ed.state.doc.descendants((node, at) => {
    if (pos < 0 && node.isText && node.text?.includes(caretAfter)) pos = at + (node.text.indexOf(caretAfter) + caretAfter.length);
    return pos < 0;
  });
  ed.commands.setTextSelection(pos);
  await userEvent.keyboard(keys);
  await new Promise((r) => setTimeout(r, 50));
  return ed;
}

/** Saves, reopens, and saves again: the note reads back as written. */
function expectReadsBack(ed: Editor): string {
  const md = editorMarkdown(ed);
  const again = makeEditor();
  const { lossy } = loadMarkdownIntoEditor(again, md);
  expect(lossy).toBe(false);
  expect(editorMarkdown(again)).toBe(md);
  return md;
}

describe('spaces typed at the end of a line are left out of the file', () => {
  it('at the end of each paragraph', async () => {
    const ed = await typeInto('Start.', 'Start.', '  {Enter}line two  ');
    expect(ed.state.doc.child(0).textContent).toBe('Start.  ');
    expect(expectReadsBack(ed)).toBe('Start.\n\nline two');
  });

  it('before a single newline, where two would read back as a line break', async () => {
    const ed = await typeInto('Alpha\nbeta', 'Alpha', '  ');
    expect(expectReadsBack(ed)).toBe('Alpha\nbeta');
  });

  it('at the end of a list item', async () => {
    const ed = await typeInto('- one', 'one', '  {Enter}two ');
    expect(expectReadsBack(ed)).toBe('- one\n- two');
  });

  it('but kept before a Shift+Enter line break, where they stay on the line', async () => {
    const ed = await typeInto('Start.', 'Start.', '  {Shift>}{Enter}{/Shift}next');
    expect(expectReadsBack(ed)).toBe('Start.  \\\nnext');
  });
});
