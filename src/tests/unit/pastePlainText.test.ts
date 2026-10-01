import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { pasteEdges } from '../../renderer/lib/editor/pastePlainText';

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

  it('saves pasted lines with bare newlines, as the same text opened from a file', () => {
    const ed = makeEditor();
    pastePlain(ed, 'Name: Aria\nAge: 24\nHome: the river');
    expect(editorMarkdown(ed)).toBe('Name: Aria\nAge: 24\nHome: the river');
    const literal = makeEditor();
    pastePlain(literal, 'Name: Aria\nAge: 24', true);
    expect(editorMarkdown(literal)).toBe('Name: Aria\nAge: 24');
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
    expect(doc.child(0).content.content.map((n) => n.type.name)).toEqual(['text', 'softBreak', 'text']);
  });
});

/** Pastes `text`, types after it, and returns what is saved (checking it reopens the same). */
function savedAfterTyping(text: string, opts: { into?: string; literal?: boolean } = {}): string {
  const ed = makeEditor(opts.into ?? '');
  pastePlain(ed, text, opts.literal ?? false);
  ed.commands.insertContent('typed after');
  const saved = editorMarkdown(ed);
  expect(editorMarkdown(makeEditor(saved))).toBe(saved);
  return saved;
}

describe('a newline closing the paste', () => {
  it('is a soft break: typing goes on on the next line, saved as a bare newline', () => {
    expect(savedAfterTyping('just one line\n')).toBe('just one line\ntyped after');
    expect(savedAfterTyping('line one\nline two\n')).toBe('line one\nline two\ntyped after');
    const ed = makeEditor();
    pastePlain(ed, 'just one line\n');
    expect(ed.state.doc.firstChild?.content.content.map((n) => n.type.name)).toEqual(['text', 'softBreak']);
  });

  it('is the same with Windows line endings', () => {
    expect(savedAfterTyping('a\r\nb\r\n')).toBe('a\nb\ntyped after');
    expect(savedAfterTyping('just one line\r\n')).toBe('just one line\ntyped after');
  });

  it('pasted after text, moves the text after it to the next line', () => {
    expect(savedAfterTyping('pasted\n', { into: 'existing' })).toBe('existingpasted\ntyped after');
  });

  it('drops the spaces before it, which would read back as a hard break', () => {
    expect(savedAfterTyping('abc  \n')).toBe('abc\ntyped after');
    expect(savedAfterTyping('word ', { into: 'existing' })).toBe('existingword typed after');
  });

  it('two or more close the paragraph, as a blank line does', () => {
    expect(savedAfterTyping('abc\n\n')).toBe('abc\n\ntyped after');
    expect(savedAfterTyping('abc\r\n\r\n\r\n')).toBe('abc\n\ntyped after');
  });

  it('after several paragraphs, goes on the last one', () => {
    expect(savedAfterTyping('a\n\nb\n', { into: 'existing' })).toBe('existinga\n\nb\ntyped after');
  });

  it('after a list or heading, still closes that block', () => {
    expect(savedAfterTyping('- a\n- b\n')).toBe('- a\n- btyped after');
    expect(savedAfterTyping('# Head\n')).toBe('# Headtyped after');
  });

  it('newlines opening the paste are dropped, as Ctrl+Shift+V drops them', () => {
    expect(savedAfterTyping('\nabc', { into: 'existing' })).toBe('existingabctyped after');
    expect(savedAfterTyping('\r\n\r\nabc', { into: 'existing' })).toBe('existingabctyped after');
    expect(savedAfterTyping('\nabc', { into: 'existing', literal: true })).toBe('existingabctyped after');
  });

  it('Ctrl+Shift+V is unchanged', () => {
    expect(savedAfterTyping('line one\nline two\n', { literal: true })).toBe('line one\nline two\ntyped after');
    expect(savedAfterTyping('abc\n\n', { literal: true })).toBe('abc\n\ntyped after');
  });
});

describe('pasteEdges', () => {
  it('splits off the closing newlines and the spaces before them', () => {
    expect(pasteEdges('abc')).toEqual({ body: 'abc', newlinesAtEnd: 0 });
    expect(pasteEdges('abc  ')).toEqual({ body: 'abc  ', newlinesAtEnd: 0 });
    expect(pasteEdges('abc \t\r\n')).toEqual({ body: 'abc', newlinesAtEnd: 1 });
    expect(pasteEdges('abc\n \n')).toEqual({ body: 'abc', newlinesAtEnd: 2 });
    expect(pasteEdges('\n\r\nabc\ndef\n')).toEqual({ body: 'abc\ndef', newlinesAtEnd: 1 });
    expect(pasteEdges('\n\n')).toEqual({ body: '', newlinesAtEnd: 0 });
  });
});

describe('copying out', () => {
  it('puts the text as shown on text/plain, without Markdown escapes', () => {
    const ed = makeEditor('C:\\\\Users and 5 \\* 3 and a &lt; b');
    expect(ed.getText()).toBe('C:\\Users and 5 * 3 and a < b');
    expect(copiedText(ed)).toBe('C:\\Users and 5 * 3 and a < b');
  });
});
