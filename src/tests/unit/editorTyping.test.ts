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

  it('soft line breaks still join with one space, not a hard break', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'line one\nline two');
    expect(editorMarkdown(ed)).toBe('line one line two');
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
