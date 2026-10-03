import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * What a picked colour is written as in the file, in the engine Filo ships.
 * The style text comes from Chromium's style serialiser, not from Filo, so
 * `#e03e3e` from the colour picker is saved as `rgb(224, 62, 62)`: the file
 * format depends on the engine. These are today's bytes, pinned so an
 * Electron upgrade that changes them fails here instead of re-spelling notes.
 * Writing the colour as picked is planned work (the Markdown profile); when
 * that lands on purpose, this test changes with it.
 *
 * The values are what the picker hands the toolbar: lower-case hex, or
 * `rgba(…)` for a translucent colour (`ColorPicker.svelte`).
 */

const editors: Editor[] = [];
function makeEditor(markdown: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  loadMarkdownIntoEditor(ed, markdown);
  editors.push(ed);
  return ed;
}
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

const START = 'Alpha beta gamma';

const CASES: { name: string; run: (ed: Editor) => unknown; saved: string }[] = [
  {
    name: 'a picked text colour is written as rgb()',
    run: (e) => e.chain().setColor('#e03e3e').run(),
    saved: '<span style="color: rgb(224, 62, 62);">Alpha beta gamma</span>',
  },
  {
    name: 'a preset text colour',
    run: (e) => e.chain().setColor('#1a73e8').run(),
    saved: '<span style="color: rgb(26, 115, 232);">Alpha beta gamma</span>',
  },
  {
    name: 'a translucent text colour keeps its rgba()',
    run: (e) => e.chain().setColor('rgba(224, 62, 62, 0.5)').run(),
    saved: '<span style="color: rgba(224, 62, 62, 0.5);">Alpha beta gamma</span>',
  },
  {
    name: 'a highlight colour: the picked value in data-color, rgb() in the style, plus color: inherit',
    run: (e) => e.chain().setHighlight({ color: '#ffe066' }).run(),
    saved: '<mark data-color="#ffe066" style="background-color: rgb(255, 224, 102); color: inherit;">Alpha beta gamma</mark>',
  },
  {
    name: 'a translucent highlight colour',
    run: (e) => e.chain().setHighlight({ color: 'rgba(255, 224, 102, 0.4)' }).run(),
    saved:
      '<mark data-color="rgba(255, 224, 102, 0.4)" style="background-color: rgba(255, 224, 102, 0.4); color: inherit;">Alpha beta gamma</mark>',
  },
  {
    name: 'colour, font and size on bold text: one span, in that order',
    run: (e) => e.chain().setColor('#e03e3e').setFontFamily('Georgia').setMark('textStyle', { fontSize: '20px' }).toggleBold().run(),
    saved: '<span style="color: rgb(224, 62, 62); font-family: Georgia; font-size: 20px;">**Alpha beta gamma**</span>',
  },
  {
    name: 'a coloured bold word in a centred paragraph (the HTML line)',
    run: (e) => {
      e.chain().setTextAlign('center').run();
      e.commands.setTextSelection({ from: 7, to: 11 });
      return e.chain().setColor('#e03e3e').toggleBold().run();
    },
    saved: '<p style="text-align: center;">Alpha <span style="color: rgb(224, 62, 62);"><strong>beta</strong></span> gamma</p>',
  },
];

describe('colours as Chromium writes them', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const ed = makeEditor(START);
      ed.commands.setTextSelection({ from: 1, to: 1 + START.length });
      c.run(ed);
      const disk = editorMarkdown(ed);
      expect(disk).toBe(c.saved);

      // What Chromium writes, Chromium reads back: the note stays editable.
      const ed2 = makeEditor('');
      expect(loadMarkdownIntoEditor(ed2, disk).lossy).toBe(false);
      expect(editorMarkdown(ed2)).toBe(disk);
    });
  }
});
