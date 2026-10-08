import { expect } from 'vitest';
import type { Editor } from '@tiptap/core';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { clearBlockTextStyle } from '../../renderer/lib/editor/blockTextStyle';
import { applyLink, linkAllowedAt, linkTargetAt } from '../../renderer/lib/editor/insertLink';
import { normaliseLinkUrl } from '../../renderer/lib/editor/linkUrl';

/**
 * Every command the formatting toolbar runs (`lib/editor/toolbarConfig.ts`),
 * as a case: the note it starts from, the command, and what its save must
 * hold. Shared by the save → reload suite (`toolbarFormattingRoundTrip.test.ts`)
 * and the check that a saved note reads the same in another Markdown parser
 * (`markdownContentElsewhere.test.ts`). Gate `toolbar-formatting-saved`
 * fails when a toolbar command has no case here.
 */

const DEFAULT_START = 'Alpha beta gamma';

/**
 * The document with equivalent spellings made equal: the browser reads a
 * colour back as `rgb(…)` and an absent style as `''`, and "left" is the
 * default alignment. None of these change what the note shows.
 */
export function normalisedDoc(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalisedDoc);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      let next = normalisedDoc(v);
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
export function selectFirstBlock(ed: Editor): void {
  const first = ed.state.doc.firstChild!;
  ed.commands.setTextSelection({ from: 1, to: 1 + first.content.size });
}

/** The position just inside `text`'s first occurrence (after its first character). */
function insideText(ed: Editor, text: string): number {
  let pos = -1;
  ed.state.doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text!.includes(text)) pos = p + n.text!.indexOf(text) + 1;
    return pos < 0;
  });
  if (pos < 0) throw new Error(`"${text}" isn't in the note`);
  return pos;
}

/** A caret inside `text`, as a click on its line leaves it. */
function caretIn(ed: Editor, text: string): void {
  ed.commands.setTextSelection(insideText(ed, text));
}

/** Lines of a note from another app, joined by single newlines (soft breaks), as Keep and Canvas write them. */
const LINES = 'Dear Aria,\nThe ferry leaves at dawn.\nBring the letter.';

export interface ToolbarCase {
  name: string;
  start?: string;
  run: (ed: Editor) => unknown;
  /** A substring the saved file must contain (proves the formatting was written). */
  saved?: string;
}

export const TOOLBAR_CASES: ToolbarCase[] = [
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
  ...[1, 2, 3, 4, 5, 6].map((level): ToolbarCase => ({
    name: `heading ${level}`,
    run: (e) => e.chain().setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run(),
    saved: `${'#'.repeat(level)} `,
  })),
  // The heading dropdown's own chain: it clears the block's inline font size first.
  ...[1, 2, 3, 4, 5, 6].map((level): ToolbarCase => ({
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
  // The toolbar's list buttons (and Ctrl+Shift+7 / 8 / 9) run Filo's switch (`listSwitch.ts`).
  { name: 'the Checklist button on a line', run: (e) => e.chain().switchList('taskList').run(), saved: '- [ ] ' },
  {
    name: 'the Checklist button on a nested bullet list',
    start: '- one\n- two\n  - nested',
    run: (e) => e.chain().selectAll().switchList('taskList').run(),
    saved: '- [ ] one\n- [ ] two\n  - [ ] nested',
  },
  {
    name: 'the Numbered button on a checklist with a sub-task',
    start: '- [ ] one\n  - [ ] sub',
    run: (e) => e.chain().selectAll().switchList('orderedList').run(),
    saved: '1. one\n   1. sub',
  },
  {
    name: 'the Bulleted button with the caret in an item that has a sub-item',
    start: '1. one\n   1. sub',
    run: (e) => {
      e.commands.setTextSelection(3);
      return e.chain().switchList('bulletList').run();
    },
    saved: '- one\n  1. sub',
  },
  {
    name: 'nested list item',
    start: '- one\n- two',
    run: (e) => {
      const end = e.state.doc.content.size;
      e.commands.setTextSelection(end - 3);
      return e.chain().sinkListItem('listItem').run();
    },
  },
  // Alignment doesn't apply inside lists (D2): an aligned item was written as
  // an HTML line that swallowed its sub-items.
  {
    name: 'centring a list item leaves the list as it is',
    start: '- one\n- two',
    run: (e) => {
      e.commands.setTextSelection(3);
      expect(e.can().setTextAlign('center')).toBe(false);
      return e.chain().setTextAlign('center').run();
    },
    saved: '- one\n- two',
  },
  {
    name: 'select all, centre, on a note with a nested list: only the text outside the list is centred',
    start: 'Characters\n\n- Aria\n  - scout\n- Kasai',
    run: (e) => e.chain().selectAll().setTextAlign('center').run(),
    saved: '<p style="text-align: center;">Characters</p>\n\n- Aria\n  - scout\n- Kasai',
  },
  {
    name: 'select all, right, on a numbered list with a nested item',
    start: 'Intro\n\n1. First\n   1. sub a\n2. Second',
    run: (e) => e.chain().selectAll().setTextAlign('right').run(),
    saved: '<p style="text-align: right;">Intro</p>\n\n1. First\n   1. sub a\n2. Second',
  },
  {
    name: 'select all, centre, on a checklist with a sub-task',
    start: 'Intro\n\n- [ ] task\n  - [ ] subtask',
    run: (e) => e.chain().selectAll().setTextAlign('center').run(),
    saved: '<p style="text-align: center;">Intro</p>\n\n- [ ] task\n  - [ ] subtask',
  },
  {
    name: 'an indented paragraph made into a list, then given a sub-item, keeps no indent',
    run: (e) => {
      e.chain().increaseIndent().toggleBulletList().run();
      e.commands.focus('end');
      e.chain().splitListItem('listItem').sinkListItem('listItem').insertContent('nested').run();
    },
    saved: '- Alpha beta gamma\n  - nested',
  },
  {
    name: 'a centred paragraph made into a checklist item keeps no alignment',
    run: (e) => e.chain().setTextAlign('center').toggleTaskList().run(),
    saved: '- [ ] Alpha beta gamma',
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
  // A block command with the caret on one line of soft-broken lines acts on
  // that line alone; the lines around it keep their form (`lineBlocks.ts`).
  {
    name: 'heading on one line of soft-broken lines',
    start: LINES,
    run: (e) => {
      caretIn(e, 'The ferry');
      return e.chain().setHeading({ level: 3 }).run();
    },
    saved: 'Dear Aria,\n\n### The ferry leaves at dawn.\n\nBring the letter.',
  },
  {
    name: 'heading from the dropdown on the first of soft-broken lines',
    start: LINES,
    run: (e) => {
      caretIn(e, 'Dear');
      return e.chain().command(clearBlockTextStyle).setHeading({ level: 2 }).run();
    },
    saved: '## Dear Aria,\n\nThe ferry leaves at dawn.\nBring the letter.',
  },
  {
    name: 'heading shortcut on the last of soft-broken lines',
    start: LINES,
    run: (e) => {
      caretIn(e, 'Bring');
      return e.chain().toggleHeading({ level: 1 }).run();
    },
    saved: 'Dear Aria,\nThe ferry leaves at dawn.\n\n# Bring the letter.',
  },
  {
    name: 'heading on two selected lines of three: those two, the third left',
    start: LINES,
    run: (e) => {
      e.commands.setTextSelection({ from: insideText(e, 'The ferry'), to: insideText(e, 'Bring') });
      return e.chain().setHeading({ level: 3 }).run();
    },
    saved: 'Dear Aria,\n\n### The ferry leaves at dawn.<br data-filo-soft-break>Bring the letter.',
  },
  {
    name: 'normal text on one line of a soft-broken heading',
    start: '## Dear Aria,<br data-filo-soft-break>The ferry leaves at dawn.',
    run: (e) => {
      caretIn(e, 'The ferry');
      return e.chain().command(clearBlockTextStyle).setParagraph().run();
    },
    saved: '## Dear Aria,\n\nThe ferry leaves at dawn.',
  },
  {
    name: 'centre one line of soft-broken lines',
    start: LINES,
    run: (e) => {
      caretIn(e, 'The ferry');
      return e.chain().setTextAlign('center').run();
    },
    saved: 'Dear Aria,\n\n<p style="text-align: center;">The ferry leaves at dawn.</p>\n\nBring the letter.',
  },
  {
    name: 'indent one line of soft-broken lines',
    start: LINES,
    run: (e) => {
      caretIn(e, 'The ferry');
      return e.chain().increaseIndent().run();
    },
    saved: 'Dear Aria,\n\n<p style="margin-left: 24px;">The ferry leaves at dawn.</p>\n\nBring the letter.',
  },
  {
    name: 'quote one line of soft-broken lines',
    start: LINES,
    run: (e) => {
      caretIn(e, 'The ferry');
      return e.chain().toggleBlockquote().run();
    },
    saved: 'Dear Aria,\n\n> The ferry leaves at dawn.\n\nBring the letter.',
  },
  ...([
    ['bulletList', '- '],
    ['orderedList', '1. '],
    ['taskList', '- [ ] '],
  ] as const).map(([kind, marker]): ToolbarCase => ({
    name: `the ${kind} button on one line of soft-broken lines`,
    start: LINES,
    run: (e) => {
      caretIn(e, 'The ferry');
      return e.chain().switchList(kind).run();
    },
    saved: `Dear Aria,\n\n${marker}The ferry leaves at dawn.\n\nBring the letter.`,
  })),
  {
    name: 'heading on a line after Shift+Enter takes its whole paragraph',
    start: 'Dear Aria,\\\nThe ferry leaves at dawn.',
    run: (e) => {
      caretIn(e, 'The ferry');
      return e.chain().setHeading({ level: 3 }).run();
    },
    saved: '### Dear Aria,<br>The ferry leaves at dawn.',
  },
  {
    name: 'centred text with characters HTML must escape',
    start: 'a < b & c > d',
    run: (e) => e.chain().setTextAlign('center').run(),
    saved: '&lt;',
  },
];

/** Loads the case's note, selects its first block, runs the command, and returns what a save writes. */
export function applyToolbarCase(ed: Editor, c: ToolbarCase): string {
  loadMarkdownIntoEditor(ed, c.start ?? DEFAULT_START);
  selectFirstBlock(ed);
  c.run(ed);
  return editorMarkdown(ed);
}
