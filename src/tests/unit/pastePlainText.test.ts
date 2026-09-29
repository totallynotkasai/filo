import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Plain text pasted into a note keeps what it says: text that looks like a
 * tag (`List<String>`) stays text, and each line stays a line. Markdown still
 * pastes with its formatting. Ctrl+Shift+V pastes the text literally. Copying
 * out puts the text as shown on the clipboard, not its Markdown source.
 */

const editors: Editor[] = [];
function makeEditor(markdown = ''): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  ed.commands.focus('end');
  return ed;
}
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

/** A paste of `text/plain` only, as the browser hands it to ProseMirror (`plain`: Ctrl+Shift+V). */
function pastePlain(ed: Editor, text: string, plain = false): void {
  const view = ed.view;
  const slice = view.someProp('clipboardTextParser', (f) => f(text, view.state.selection.$from, plain, view));
  if (!slice) throw new Error('no clipboard text parser took the paste');
  view.dispatch(view.state.tr.replaceSelection(slice));
}

function copiedText(ed: Editor): string {
  ed.commands.selectAll();
  return ed.view.serializeForClipboard(ed.state.selection.content()).text;
}

describe('pasting plain text', () => {
  it('keeps text that looks like a tag', () => {
    const ed = makeEditor();
    pastePlain(ed, 'Use List<String> and press <Enter>, not <!-- this -->');
    expect(ed.getText()).toBe('Use List<String> and press <Enter>, not <!-- this -->');
  });

  it('keeps two lines as two lines', () => {
    const ed = makeEditor();
    pastePlain(ed, 'first line\nsecond line');
    expect(ed.getText({ blockSeparator: '\n' })).toBe('first line\nsecond line');
    expect(ed.state.doc.firstChild?.childCount).toBe(3); // text, line break, text
  });

  it('still reads Markdown formatting', () => {
    const ed = makeEditor();
    pastePlain(ed, 'some **bold** text');
    expect(editorMarkdown(ed)).toBe('some **bold** text');
  });

  it('Ctrl+Shift+V pastes literally: no Markdown, a paragraph per blank line, a break per newline', () => {
    const ed = makeEditor();
    pastePlain(ed, '**not bold** __init__\nnext\n\nsecond para', true);
    const doc = ed.state.doc;
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).textContent).toBe('**not bold** __init__next');
    expect(doc.child(1).textContent).toBe('second para');
    expect(doc.child(0).content.content.map((n) => n.type.name)).toEqual(['text', 'hardBreak', 'text']);
  });
});

describe('copying out', () => {
  it('puts the text as shown on text/plain, without Markdown escapes', () => {
    const ed = makeEditor('C:\\\\Users and 5 \\* 3 and a &lt; b');
    expect(ed.getText()).toBe('C:\\Users and 5 * 3 and a < b');
    expect(copiedText(ed)).toBe('C:\\Users and 5 * 3 and a < b');
  });
});
