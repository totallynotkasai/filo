import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { TOOLBAR_CASES, applyToolbarCase, normalisedDoc } from '../helpers/toolbarCases';

/**
 * The toolbar suite's promise (`unit/toolbarFormattingRoundTrip.test.ts`)
 * checked in the engine Filo ships: every toolbar command, applied in real
 * Chromium, saved, reloaded into a fresh editor and saved again, gives the
 * same document and the same bytes, and the reload doesn't open read-only.
 * jsdom serialises styles and parses HTML with its own code; the bytes a
 * colour, a font or an alignment is written as come from the engine.
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
  document.body.innerHTML = '';
});

describe('every toolbar command survives save and reload in Chromium', () => {
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
