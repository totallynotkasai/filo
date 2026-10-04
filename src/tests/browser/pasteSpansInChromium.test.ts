import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Rich text pasted from Word, Google Docs or a web page, through the real
 * paste in Chromium, then saved and reopened. A styled span that sets no
 * colour, font or size (Word's two spaces after a full stop, a web page's
 * bold or underline span, a Docs tab) once became an empty text-style mark,
 * saved as a bare `<span>` that reopened the note read-only.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}

/** Pastes `html` at the end of a note holding "Start.", saves, and reopens the save. */
function pasteSaveReopen(html: string): { disk: string; lossy: boolean; reopened: Editor } {
  const ed = makeEditor();
  loadMarkdownIntoEditor(ed, 'Start.');
  ed.commands.focus('end');
  ed.view.pasteHTML(html);
  const disk = editorMarkdown(ed);
  const reopened = makeEditor();
  const { lossy } = loadMarkdownIntoEditor(reopened, disk);
  return { disk, lossy, reopened };
}

const SPANS_WITH_NO_KEPT_STYLE: { name: string; html: string; text: string }[] = [
  {
    name: 'Word: two spaces after a full stop (mso-spacerun)',
    html: `<p class=MsoNormal><span lang=EN-GB>She left.<span style='mso-spacerun:yes'>&nbsp; </span>He stayed.<o:p></o:p></span></p>`,
    text: 'He stayed.',
  },
  {
    name: 'web page: a bold span',
    html: `<p>The <span style="font-weight: bold">dragon</span> slept.</p>`,
    text: 'The dragon slept.',
  },
  {
    name: 'web page: an underlined span',
    html: `<p>The <span style="text-decoration: underline">dragon</span> slept.</p>`,
    text: 'The dragon slept.',
  },
  {
    name: 'Google Docs: a tab between styled runs',
    html: `<p dir="ltr"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;">Name:</span><span style="white-space:pre;">\t</span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;">Aria</span></p>`,
    text: 'Aria',
  },
];

describe('a pasted span with no colour, font or size', () => {
  for (const c of SPANS_WITH_NO_KEPT_STYLE) {
    it(`${c.name}: the saved note has no bare <span> and reopens editable`, () => {
      const { disk, lossy, reopened } = pasteSaveReopen(c.html);
      expect(disk).not.toMatch(/<span>/);
      expect(lossy).toBe(false);
      expect(reopened.getText()).toContain(c.text);
      // The reopened note saves the same bytes again.
      expect(editorMarkdown(reopened)).toBe(disk);
    });
  }
});

describe('a pasted span that does carry a colour, font or size', () => {
  it('keeps it as formatting, and the note reopens editable', () => {
    const { disk, lossy, reopened } = pasteSaveReopen(
      `<p>A <span style="color: rgb(200, 30, 30); font-weight: bold">red</span> word.</p>`,
    );
    // The bold in the same span becomes bold, the colour a coloured span.
    expect(disk).toMatch(/<span style="color: rgb\(200, 30, 30\);?">\*\*red\*\*<\/span>/);
    expect(lossy).toBe(false);
    expect(editorMarkdown(reopened)).toBe(disk);
  });
});
