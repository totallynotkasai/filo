import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { tiptapToolbar } from '../../renderer/lib/editor/toolbarConfig';
import { fontFromStack } from '../../shared/fontStack';

/**
 * A font picked from the toolbar applies to the text, saves, and reopens
 * editable, whatever its name. An imported font is named after its file, and
 * a name CSS can't read unquoted ("28 Days Later", "Lora[wght]") was set
 * bare: Chromium dropped the style, the text kept its font, and the note
 * saved an empty span that reopened read-only.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) {
    const ed = editors.pop()!;
    tiptapToolbar.releaseEditor(ed);
    ed.destroy();
  }
  document.body.innerHTML = '';
});

function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}

const NAMES = ['Georgia', 'Arial Rounded MT', 'Cinzel-Regular', '28 Days Later', '1942 report', 'Roboto-VariableFont_wdth,wght', 'Lora[wght]'];

describe('a font picked from the toolbar', () => {
  for (const name of NAMES) {
    it(`"${name}" is applied, saved, and reopens editable`, () => {
      const ed = makeEditor();
      loadMarkdownIntoEditor(ed, 'Alpha beta gamma');
      ed.commands.setTextSelection({ from: 7, to: 11 }); // "beta"
      tiptapToolbar.setActiveEditor(ed);
      tiptapToolbar.setFontFamily(name);
      const span = ed.view.dom.querySelector('span');
      expect(span?.textContent).toBe('beta');
      // The page reads the family as the font picked.
      expect(fontFromStack(getComputedStyle(span!).fontFamily)).toBe(name);
      expect(fontFromStack(ed.getAttributes('textStyle').fontFamily ?? '')).toBe(name);

      const disk = editorMarkdown(ed);
      expect(disk).not.toMatch(/<span>/);
      const reopened = makeEditor();
      const { lossy } = loadMarkdownIntoEditor(reopened, disk);
      expect(lossy).toBe(false);
      expect(editorMarkdown(reopened)).toBe(disk);
      const again = reopened.view.dom.querySelector('span');
      expect(fontFromStack(getComputedStyle(again!).fontFamily)).toBe(name);
    });
  }

  it('a plain name is written bare, as notes already hold it', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Alpha beta gamma');
    ed.commands.setTextSelection({ from: 7, to: 11 });
    tiptapToolbar.setActiveEditor(ed);
    tiptapToolbar.setFontFamily('Georgia');
    expect(editorMarkdown(ed)).toBe('Alpha <span style="font-family: Georgia;">beta</span> gamma');
  });
});
