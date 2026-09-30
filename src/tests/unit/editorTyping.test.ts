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
