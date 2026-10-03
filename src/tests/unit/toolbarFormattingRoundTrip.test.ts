import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { TOOLBAR_CASES, applyToolbarCase, normalisedDoc, selectFirstBlock } from '../helpers/toolbarCases';

/**
 * No toolbar button may produce formatting the file can't hold. Each command
 * the formatting toolbar runs (`lib/editor/toolbarConfig.ts`; the cases are in
 * `helpers/toolbarCases.ts`) is applied to a real editor, the note is saved,
 * reloaded into a fresh editor and saved again. The reloaded document must equal the edited one, the reload must not
 * be flagged lossy (a lossy note opens read-only), and the second save must
 * give the same bytes.
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

describe('every toolbar command survives save and reload', () => {
  for (const c of TOOLBAR_CASES) {
    it(c.name, () => {
      const ed = makeEditor();
      const disk = applyToolbarCase(ed, c);
      if (c.saved) expect(disk).toContain(c.saved);

      const ed2 = makeEditor();
      const { lossy } = loadMarkdownIntoEditor(ed2, disk);
      expect(lossy).toBe(false);
      expect(normalisedDoc(ed2.getJSON())).toEqual(normalisedDoc(ed.getJSON()));
      expect(editorMarkdown(ed2)).toBe(disk);
    });
  }
});

describe('aligned blocks in the file', () => {
  it('only the aligned paragraph is HTML; its neighbours stay Markdown', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'First **one**\n\nSecond **two**\n\nThird **three**');
    ed.commands.setTextSelection(ed.state.doc.child(0).nodeSize + 2);
    ed.chain().setTextAlign('center').run();
    expect(editorMarkdown(ed)).toBe(
      'First **one**\n\n<p style="text-align: center;">Second <strong>two</strong></p>\n\nThird **three**',
    );
  });

  it('a link is saved without the editor-only target / rel / class attributes', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, '[site](https://example.com)');
    selectFirstBlock(ed);
    ed.chain().setTextAlign('center').run();
    expect(editorMarkdown(ed)).toBe('<p style="text-align: center;"><a href="https://example.com">site</a></p>');
  });

  it('a list item an earlier Filo aligned opens read-only, and the banner names its line', () => {
    const ed = makeEditor();
    const { lossy, changes } = loadMarkdownIntoEditor(ed, '- plain\n- <p style="text-align: center;">centred item</p>');
    expect(lossy).toBe(true);
    expect(changes).toEqual([{ original: '- <p style="text-align: center;">centred item</p>', filo: '- centred item' }]);
  });

  it('a body #tag is saved as bare text', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'see #project/alpha now');
    selectFirstBlock(ed);
    ed.chain().setTextAlign('center').run();
    const disk = editorMarkdown(ed);
    expect(disk).toContain('#project/alpha');
    expect(disk).not.toContain('filo-tag');
  });
});
