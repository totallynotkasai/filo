import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { setImageNote } from '../../renderer/lib/editor/noteImages';

/**
 * An image a note embeds shows from the vault. Its address is relative to the
 * note (`![map](images/map.png)`); the page resolved it against the app's own
 * address, which the app's security policy doesn't load media from, so the
 * image never showed. The editor shows it through `filo://media/`, and the
 * note saves the address as written.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

/** An editor showing `markdown` as the note at `notePath`, as a note's view loads it. */
function noteEditor(notePath: string, markdown: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  setImageNote(ed, notePath);
  loadMarkdownIntoEditor(ed, markdown);
  return ed;
}

describe('an image embedded in a note', () => {
  it('shows from the vault, resolved from the note\'s folder', () => {
    const ed = noteEditor('Notes/Chapter.md', 'The realm:\n\n![map](images/map.png)');
    const img = ed.view.dom.querySelector('img');
    expect(img?.getAttribute('src')).toBe('filo://media/Notes/images/map.png');
    expect(img?.getAttribute('alt')).toBe('map');
  });

  it('saves the address as the file has it, and the note reopens editable', () => {
    const md = 'The realm:\n\n![World map](images/World%20Map.png "The north")';
    const ed = noteEditor('Notes/Chapter.md', md);
    expect(ed.view.dom.querySelector('img')?.getAttribute('src')).toBe('filo://media/Notes/images/World%20Map.png');
    const saved = editorMarkdown(ed);
    expect(saved).toBe(md);
    const { lossy } = loadMarkdownIntoEditor(noteEditor('Notes/Chapter.md', ''), saved);
    expect(lossy).toBe(false);
  });

  it('an HTML image in a note shows the same way', () => {
    const ed = noteEditor('Chapter.md', 'Text <img src="art/sword.png" alt="sword"> more.');
    expect(ed.view.dom.querySelector('img')?.getAttribute('src')).toBe('filo://media/art/sword.png');
    expect(editorMarkdown(ed)).toContain('art/sword.png');
    expect(editorMarkdown(ed)).not.toContain('filo://');
  });

  it('an image moved by a change keeps showing from the vault', () => {
    const ed = noteEditor('Notes/Chapter.md', '![map](map.png)');
    ed.commands.focus('start');
    ed.commands.insertContent('A ');
    expect(ed.view.dom.querySelector('img')?.getAttribute('src')).toBe('filo://media/Notes/map.png');
  });

  it('a web address is left to the app\'s security policy, as written', () => {
    const ed = noteEditor('Chapter.md', '![a](https://example.com/a.png)');
    expect(ed.view.dom.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
  });
});
