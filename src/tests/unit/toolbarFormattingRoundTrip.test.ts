import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { clearBlockTextStyle } from '../../renderer/lib/editor/blockTextStyle';
import { applyLink, linkAllowedAt, linkTargetAt } from '../../renderer/lib/editor/insertLink';
import { normaliseLinkUrl } from '../../renderer/lib/editor/linkUrl';

/**
 * No toolbar button may produce formatting the file can't hold. Each command
 * the formatting toolbar runs (`lib/editor/toolbarConfig.ts`) is applied to a
 * real editor, the note is saved, reloaded into a fresh editor and saved
 * again. The reloaded document must equal the edited one, the reload must not
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

/**
 * The document with equivalent spellings made equal: the browser reads a
 * colour back as `rgb(…)` and an absent style as `''`, and "left" is the
 * default alignment. None of these change what the note shows.
 */
function normalised(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalised);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      let next = normalised(v);
      if (next === '') next = null;
      if (k === 'textAlign' && next === 'left') next = null;
      if (typeof next === 'string') {
        const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(next);
        if (rgb) next = `#${rgb.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
      }
      out[k] = next;
    }
    return out;
  }
  return value;
}

/** Select the text of the first block. */
function selectFirstBlock(ed: Editor): void {
  const first = ed.state.doc.firstChild!;
  ed.commands.setTextSelection({ from: 1, to: 1 + first.content.size });
}

interface Case {
  name: string;
  start?: string;
  run: (ed: Editor) => unknown;
  /** A substring the saved file must contain (proves the formatting was written). */
  saved?: string;
}

const CASES: Case[] = [
  { name: 'bold', run: (e) => e.chain().toggleBold().run(), saved: '**' },
  { name: 'italic', run: (e) => e.chain().toggleItalic().run(), saved: '*' },
  { name: 'underline', run: (e) => e.chain().toggleUnderline().run(), saved: '<u>' },
  { name: 'text colour', run: (e) => e.chain().setColor('#ff0000').run(), saved: 'color' },
  { name: 'highlight', run: (e) => e.chain().setHighlight({ color: '#ffcc00' }).run(), saved: '<mark' },
  { name: 'font family', run: (e) => e.chain().setFontFamily('Georgia').run(), saved: 'Georgia' },
  { name: 'font size', run: (e) => e.chain().setMark('textStyle', { fontSize: '20px' }).run(), saved: '20px' },
  { name: 'align left', run: (e) => e.chain().setTextAlign('left').run() },
  { name: 'align centre', run: (e) => e.chain().setTextAlign('center').run(), saved: 'text-align: center' },
  { name: 'align right', run: (e) => e.chain().setTextAlign('right').run(), saved: 'text-align: right' },
  { name: 'justify', run: (e) => e.chain().setTextAlign('justify').run(), saved: 'text-align: justify' },
  // The toolbar's Undo / Redo while an editor has the focus.
  { name: 'bold, then undo', run: (e) => e.chain().toggleBold().run() && e.chain().undo().run(), saved: 'Alpha beta gamma' },
  {
    name: 'bold, undo, then redo',
    run: (e) => e.chain().toggleBold().run() && e.chain().undo().run() && e.chain().redo().run(),
    saved: '**Alpha beta gamma**',
  },
  { name: 'indent', run: (e) => e.chain().increaseIndent().run(), saved: 'margin-left: 24px' },
  { name: 'indent twice', run: (e) => e.chain().increaseIndent().increaseIndent().run(), saved: 'margin-left: 48px' },
  { name: 'indent then outdent', run: (e) => e.chain().increaseIndent().decreaseIndent().run() },
  ...[1, 2, 3, 4, 5, 6].map((level): Case => ({
    name: `heading ${level}`,
    run: (e) => e.chain().setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run(),
    saved: `${'#'.repeat(level)} `,
  })),
  // The heading dropdown's own chain: it clears the block's inline font size first.
  ...[1, 2, 3, 4, 5, 6].map((level): Case => ({
    name: `heading ${level} from the dropdown, over a font size`,
    start: 'Alpha <span style="font-size: 20px">beta</span> **gamma**',
    run: (e) => e.chain().command(clearBlockTextStyle).setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run(),
    saved: `${'#'.repeat(level)} Alpha beta **gamma**`,
  })),
  {
    name: 'normal text from the dropdown, over a font size',
    start: '## Alpha <span style="font-size: 20px">beta</span>',
    run: (e) => e.chain().command(clearBlockTextStyle).setParagraph().run(),
    saved: 'Alpha beta',
  },
  {
    name: 'insert link at a bare caret',
    run: (e) => {
      e.commands.setTextSelection(e.state.doc.content.size - 1);
      return applyLink(e, linkTargetAt(e), 'site', 'https://example.com');
    },
    saved: 'gamma[site](https://example.com)',
  },
  {
    name: 'insert link over a selection, keeping its text and bold',
    start: 'Alpha **beta** gamma',
    run: (e) => {
      e.commands.setTextSelection({ from: 7, to: 11 });
      const target = linkTargetAt(e);
      return applyLink(e, target, target.text, 'https://example.com');
    },
    saved: '[**beta**](https://example.com)',
  },
  {
    name: 'insert link over a selection with new text',
    run: (e) => {
      e.commands.setTextSelection({ from: 7, to: 11 });
      return applyLink(e, linkTargetAt(e), 'Example', 'https://example.com');
    },
    saved: 'Alpha [Example](https://example.com) gamma',
  },
  {
    name: 'edit a link from a caret inside it',
    start: 'Alpha [beta](https://old.example) gamma',
    run: (e) => {
      e.commands.setTextSelection(9);
      return applyLink(e, linkTargetAt(e), 'Beta!', 'https://new.example');
    },
    saved: 'Alpha [Beta!](https://new.example) gamma',
  },
  {
    name: 'edit a link from a caret right after it',
    start: 'Alpha [beta](https://old.example) gamma',
    run: (e) => {
      e.commands.setTextSelection(11);
      return applyLink(e, linkTargetAt(e), 'Beta!', 'https://new.example');
    },
    saved: 'Alpha [Beta!](https://new.example) gamma',
  },
  {
    name: 'insert link at a caret right before a link, leaving that link alone',
    start: 'Alpha [beta](https://old.example) gamma',
    run: (e) => {
      e.commands.setTextSelection(7);
      return applyLink(e, linkTargetAt(e), 'new', 'https://new.example');
    },
    saved: 'Alpha [new](https://new.example)[beta](https://old.example) gamma',
  },
  {
    name: 'insert link to a bare domain, as the popup normalises it',
    run: (e) => {
      e.commands.setTextSelection({ from: 7, to: 11 });
      const href = normaliseLinkUrl('example.com');
      expect(href).toBe('https://example.com');
      return applyLink(e, linkTargetAt(e), '', href ?? '');
    },
    saved: 'Alpha [beta](https://example.com) gamma',
  },
  {
    name: 'a link a click would not open (ftp:) is refused and nothing is written',
    run: (e) => {
      e.commands.setTextSelection({ from: 7, to: 11 });
      expect(normaliseLinkUrl('ftp://files.example.com')).toBeNull();
      expect(normaliseLinkUrl('sms:+441234567890')).toBeNull();
    },
    saved: 'Alpha beta gamma',
  },
  {
    name: 'a link in a code block is refused and nothing is written',
    start: '```\ncode here\n```',
    run: (e) => {
      const target = linkTargetAt(e);
      expect(linkAllowedAt(e, target)).toBe(false);
      expect(applyLink(e, target, '', 'https://example.com')).toBe(false);
    },
    saved: '```\ncode here\n```',
  },
  {
    name: 'centred heading',
    run: (e) => e.chain().setHeading({ level: 2 }).setTextAlign('center').run(),
    saved: '<h2 style="text-align: center;">',
  },
  {
    name: 'indented heading',
    run: (e) => e.chain().setHeading({ level: 3 }).increaseIndent().run(),
    saved: '<h3 style="margin-left: 24px;">',
  },
  { name: 'bullet list', run: (e) => e.chain().toggleBulletList().run(), saved: '- ' },
  { name: 'numbered list', run: (e) => e.chain().toggleOrderedList().run(), saved: '1. ' },
  { name: 'task list', run: (e) => e.chain().toggleTaskList().run(), saved: '[ ]' },
  {
    name: 'nested list item',
    start: '- one\n- two',
    run: (e) => {
      const end = e.state.doc.content.size;
      e.commands.setTextSelection(end - 3);
      return e.chain().sinkListItem('listItem').run();
    },
  },
  {
    name: 'centred list item',
    start: '- one\n- two',
    run: (e) => {
      e.commands.setTextSelection(3);
      return e.chain().setTextAlign('center').run();
    },
    saved: 'text-align: center',
  },
  { name: 'link', run: (e) => e.chain().setLink({ href: 'https://example.com' }).run(), saved: '](https://example.com)' },
  { name: 'filo link', run: (e) => e.chain().setLink({ href: 'filo://note/Other.md' }).run(), saved: 'filo://' },
  { name: 'remove text colour', start: '<span style="color: red">Alpha</span> beta', run: (e) => e.chain().unsetColor().run() },
  { name: 'remove highlight', start: '<mark>Alpha</mark> beta', run: (e) => e.chain().unsetHighlight().run() },
  { name: 'heading back to paragraph', start: '## Alpha beta', run: (e) => e.chain().setParagraph().run() },
  {
    name: 'outdent a nested list item',
    start: '- one\n  - two',
    run: (e) => {
      const end = e.state.doc.content.size;
      e.commands.setTextSelection(end - 4);
      return e.chain().liftListItem('listItem').run();
    },
  },
  { name: 'remove link', start: '[Alpha](https://example.com) beta', run: (e) => e.chain().unsetLink().run() },
  { name: 'code block', run: (e) => e.chain().toggleCodeBlock().run(), saved: '```' },
  { name: 'table', run: (e) => e.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), saved: '|' },
  {
    name: 'clear formatting',
    start: '**Alpha** beta *gamma*',
    run: (e) => e.chain().clearNodes().unsetAllMarks().run(),
  },
  {
    name: 'centred paragraph with bold, italic, a link and a tag',
    start: 'Alpha **bold** *it* [link](https://example.com) #tag end',
    run: (e) => e.chain().setTextAlign('center').run(),
    saved: '<p style="text-align: center;">',
  },
  {
    name: 'centred and indented',
    run: (e) => e.chain().setTextAlign('right').increaseIndent().run(),
    saved: 'text-align: right; margin-left: 24px;',
  },
  // Two lines of a note from another app, joined by a single newline (a soft break).
  { name: 'bold over a soft break', start: 'Alpha\nbeta', run: (e) => e.chain().toggleBold().run(), saved: '**Alpha\nbeta**' },
  {
    name: 'typing on the line after a soft break',
    start: 'Alpha\nbeta',
    run: (e) => {
      e.commands.setTextSelection(e.state.doc.content.size - 1);
      return e.chain().insertContent(' gamma').run();
    },
    saved: 'Alpha\nbeta gamma',
  },
  { name: 'heading over a soft break', start: 'Alpha\nbeta', run: (e) => e.chain().setHeading({ level: 2 }).run(), saved: '## Alpha<br data-filo-soft-break>beta' },
  { name: 'centred paragraph with a soft break', start: 'Alpha\nbeta', run: (e) => e.chain().setTextAlign('center').run(), saved: 'text-align: center' },
  { name: 'bullet list over a soft break', start: 'Alpha\nbeta', run: (e) => e.chain().toggleBulletList().run(), saved: '- Alpha\n  beta' },
  { name: 'quote over a soft break', start: 'Alpha\nbeta', run: (e) => e.chain().toggleBlockquote().run(), saved: '> Alpha\n> beta' },
  { name: 'table cell text over a soft break', start: 'Alpha\nbeta', run: (e) => e.chain().insertTable({ rows: 2, cols: 1, withHeaderRow: true }).run() },
  {
    name: 'centred text with characters HTML must escape',
    start: 'a < b & c > d',
    run: (e) => e.chain().setTextAlign('center').run(),
    saved: '&lt;',
  },
];

describe('every toolbar command survives save and reload', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const ed = makeEditor();
      loadMarkdownIntoEditor(ed, c.start ?? 'Alpha beta gamma');
      selectFirstBlock(ed);
      c.run(ed);
      const disk = editorMarkdown(ed);
      if (c.saved) expect(disk).toContain(c.saved);

      const ed2 = makeEditor();
      const { lossy } = loadMarkdownIntoEditor(ed2, disk);
      expect(lossy).toBe(false);
      expect(normalised(ed2.getJSON())).toEqual(normalised(ed.getJSON()));
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
