import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Text typed key by key, through the editor's text-input handlers, so input
 * rules run exactly as they do for a user. Inserting content directly skips
 * them, which is how a rule that ate typed spaces went unnoticed.
 */

const editors: Editor[] = [];
function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
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

describe('typing is saved as typed', () => {
  it('a #word followed by a space keeps the space', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '');
    ed.commands.focus('end');
    type(ed, 'Meeting notes #project follow up');
    expect(editorMarkdown(ed)).toBe('Meeting notes #project follow up');
  });

  it('a typed double space is saved and reloads without making the note lossy', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '');
    ed.commands.focus('end');
    type(ed, 'End of one.  Start of two.');
    const saved = editorMarkdown(ed);
    expect(saved).toBe('End of one.  Start of two.');
    const other = makeEditor();
    expect(loadMarkdownIntoEditor(other, saved).lossy).toBe(false);
    expect(editorMarkdown(other)).toBe(saved);
  });

  it.each([
    'a  b',
    '**bold  text** and  *it*',
    '# Head  ing',
    '- item  one\n- item two',
    '- [ ] task  one',
    '> quote  here',
    '1. a\n   - b  c',
    '| a  b | c |\n| --- | --- |\n| d  e | f |\n',
  ])('an imported double space round-trips: %j', (md) => {
    const ed = makeEditor();
    expect(loadMarkdownIntoEditor(ed, md).lossy).toBe(false);
    expect(editorMarkdown(ed)).toBe(md);
  });

  it('a soft line break is kept as a single newline, not joined or made a hard break', () => {
    const ed = makeEditor();
    expect(loadMarkdownIntoEditor(ed, 'line one\nline two').lossy).toBe(false);
    expect(editorMarkdown(ed)).toBe('line one\nline two');
  });

  it('a nested #tag/sub in the middle of a line stays plain text', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '');
    ed.commands.focus('end');
    type(ed, 'a #tag/sub b');
    expect(editorMarkdown(ed)).toBe('a #tag/sub b');
    expect(ed.getHTML()).not.toContain('filo-tag');
  });
});

describe('typed text that Markdown would read as something else', () => {
  /** Types `text` into a fresh note, saves, reloads, and returns both sides. */
  function typeSaveReload(text: string): { saved: string; reloaded: Editor } {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '');
    ed.commands.focus('end');
    type(ed, text);
    const saved = editorMarkdown(ed);
    const reloaded = makeEditor();
    expect(loadMarkdownIntoEditor(reloaded, saved).lossy).toBe(false);
    return { saved, reloaded };
  }

  it('"1) Buy milk" stays a line of text, not a numbered list', () => {
    const { saved, reloaded } = typeSaveReload('1) Buy milk');
    expect(saved).toBe('1\\) Buy milk');
    expect(reloaded.getHTML()).toBe('<p>1) Buy milk</p>');
    expect(editorMarkdown(reloaded)).toBe(saved);
  });

  it('a "3)" later in the line is left alone', () => {
    const { saved } = typeSaveReload('Step 3) done');
    expect(saved).toBe('Step 3) done');
  });

  it.each(['&amp;', 'AT&amp;T', '&copy; 2026', '&#169;', '&#x1F600;'])('a typed %j reopens as typed', (text) => {
    const { reloaded } = typeSaveReload(text);
    expect(reloaded.state.doc.textContent).toBe(text);
  });

  it('a lone & is saved as it is', () => {
    const { saved } = typeSaveReload('Tom & Jerry; R&D');
    expect(saved).toBe('Tom & Jerry; R&D');
  });
});

/** The document position where `text` first starts. */
function posOf(ed: Editor, text: string): number {
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text)) found = pos + node.text.indexOf(text);
    return true;
  });
  return found;
}

describe('typing next to a link', () => {
  it('a space typed at the end of a link ends the link', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Go [here](https://example.com)');
    ed.commands.focus('end');
    type(ed, ' now');
    expect(editorMarkdown(ed)).toBe('Go [here](https://example.com) now');
  });

  it('so does one typed at the end of a link inside a line', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Go [here](https://example.com) x');
    ed.commands.setTextSelection(posOf(ed, 'here') + 'here'.length);
    type(ed, ' there');
    expect(editorMarkdown(ed)).toBe('Go [here](https://example.com) there x');
  });
});

describe('undo straight after an auto-format', () => {
  it.each(['# ', '- ', '1. ', '> ', '[ ] '])('typing %j then undo gives back the typed text, and a second undo removes it', (typed) => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '');
    ed.commands.focus('end');
    type(ed, typed);
    expect(ed.state.doc.firstChild?.type.name).not.toBe('paragraph');
    ed.commands.undo();
    expect(ed.state.doc.childCount).toBe(1);
    expect(ed.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(ed.state.doc.textContent).toBe(typed);
    ed.commands.undo();
    expect(ed.state.doc.textContent).toBe('');
  });

  it.each([
    ['x **bold**', 'bold'],
    ['x *it*', 'italic'],
    ['x ~~gone~~', 'strike'],
  ])('typing %j then undo gives back the typed text without the %s mark', (typed, mark) => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '');
    ed.commands.focus('end');
    type(ed, typed);
    expect(ed.getHTML()).not.toContain(typed);
    ed.commands.undo();
    expect(ed.state.doc.textContent).toBe(typed);
    let marked = false;
    ed.state.doc.descendants((node) => {
      if (node.marks.some((m) => m.type.name === mark)) marked = true;
    });
    expect(marked).toBe(false);
  });
});

describe('Enter in a checklist', () => {
  // A real keydown, as the key arrives from the page. TipTap's
  // `keyboardShortcut` command replays a split differently and leaves the new
  // item ticked, which a user never sees.
  function pressEnter(ed: Editor): void {
    ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }

  it('at the start of a ticked item keeps that item ticked, and the new item above starts unticked', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '- [ ] a\n- [x] done');
    ed.commands.setTextSelection(posOf(ed, 'done'));
    pressEnter(ed);
    expect(editorMarkdown(ed)).toBe('- [ ] a\n- [ ] \n- [x] done');
  });
});
