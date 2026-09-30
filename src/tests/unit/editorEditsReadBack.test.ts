import { describe, it, expect, afterEach } from 'vitest';
import type { Editor, JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Formatting edits whose saved Markdown read back as a different note. Each
 * case makes the edit the way the editor does, saves, reopens the file in a
 * fresh editor and checks that it opens editable, shows the same document,
 * and saves to the same bytes.
 *
 * A mark on a line break is left out of the comparison: a break shows no
 * formatting, and the file can't say whether it had one.
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
  while (editors.length) editors.pop()?.destroy();
});

function load(md: string): Editor {
  const ed = makeEditor();
  loadMarkdownIntoEditor(ed, md);
  return ed;
}

/** The position right after the first occurrence of `text`. */
function posAfter(ed: Editor, text: string): number {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (pos >= 0) return false;
    if (node.isText && node.text?.includes(text)) pos = p + node.text.indexOf(text) + text.length;
    return true;
  });
  if (pos < 0) throw new Error(`no "${text}" in the note`);
  return pos;
}

function select(ed: Editor, from: number, to = from): void {
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)));
}

/** Types `text` as keystrokes do, so input rules fire. */
function typeText(ed: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = ed.state.selection;
    const handled = ed.view.someProp('handleTextInput', (f) => f(ed.view, from, to, ch, () => ed.state.tr.insertText(ch, from, to)));
    if (!handled) ed.view.dispatch(ed.state.tr.insertText(ch, from, to));
  }
}

/** The document without marks on line breaks. */
function shown(value: JSONContent): JSONContent {
  const out: JSONContent = { ...value };
  if (value.type === 'softBreak' || value.type === 'hardBreak') delete out.marks;
  if (value.content) out.content = value.content.map(shown);
  return out;
}

interface ReadBack {
  md: string;
  lossy: boolean;
  again: string;
  sameDoc: boolean;
}

/** Saves `ed`, reopens the file in a fresh editor, and saves that again. */
function readBack(ed: Editor): ReadBack {
  const md = editorMarkdown(ed);
  const reopened = makeEditor();
  const { lossy } = loadMarkdownIntoEditor(reopened, md);
  const sameDoc = JSON.stringify(shown(reopened.getJSON())) === JSON.stringify(shown(ed.getJSON()));
  return { md, lossy, again: editorMarkdown(reopened), sameDoc };
}

function expectReadsBack(ed: Editor, md: string): void {
  expect(readBack(ed)).toEqual({ md, lossy: false, again: md, sameDoc: true });
}

describe('bold, italic or strikethrough selected from the end of a line (A26-05)', () => {
  // [name, note, end of the first line, end of the second, mark, saved]
  it.each([
    ['a quote, soft break, Ctrl+I', '> Name: Aria\n> Age: 24', 'Aria', '24', 'italic', '> Name: Aria\n> *Age: 24*'],
    ['a quote, hard break, Ctrl+B', '> Name: Aria\\\n> Age: 24', 'Aria', '24', 'bold', '> Name: Aria\\\n> **Age: 24**'],
    ['a quote, soft break, strikethrough', '> one\n> two', 'one', 'two', 'strike', '> one\n> ~~two~~'],
    ['a quote in a list item, Ctrl+B', '- item\n\n  > Name: Aria\n  > Age: 24', 'Aria', '24', 'bold', '- item\n\n  > Name: Aria\n  > **Age: 24**'],
    ['a paragraph, soft break, Ctrl+B', 'Name: Aria\nAge: 24', 'Aria', '24', 'bold', 'Name: Aria\n**Age: 24**'],
    ['a checklist item, soft break, Ctrl+I', '- [ ] Name: Aria\n  Age: 24', 'Aria', '24', 'italic', '- [ ] Name: Aria\n  *Age: 24*'],
  ])('%s', (_name, start, lineOneEnd, lineTwoEnd, mark, saved) => {
    const ed = load(start);
    select(ed, posAfter(ed, lineOneEnd), posAfter(ed, lineTwoEnd));
    if (mark === 'bold') ed.chain().toggleBold().run();
    if (mark === 'italic') ed.chain().toggleItalic().run();
    if (mark === 'strike') ed.chain().toggleStrike().run();
    expectReadsBack(ed, saved);
  });

  it('a heading with Shift+Enter, Ctrl+B from the end of its first line', () => {
    const ed = load('# Title');
    ed.commands.focus('end');
    ed.commands.setHardBreak();
    ed.commands.insertContent('Sub');
    select(ed, posAfter(ed, 'Title'), posAfter(ed, 'Sub'));
    ed.chain().toggleBold().run();
    expectReadsBack(ed, '# Title<br>**Sub**');
  });

  it('a heading made from a one-line-per-thought paragraph, Ctrl+I from the end of its first line', () => {
    const ed = load('Title line\nsubtitle\n\nBody');
    select(ed, posAfter(ed, 'Title'));
    ed.chain().setHeading({ level: 1 }).run();
    select(ed, posAfter(ed, 'Title line'), posAfter(ed, 'subtitle'));
    ed.chain().toggleItalic().run();
    expectReadsBack(ed, '# Title line<br data-filo-soft-break>*subtitle*\n\nBody');
  });

  it('a table cell with Shift+Enter, Ctrl+I from the end of its first line', () => {
    const ed = load('| a | b |\n| --- | --- |\n| c | d |');
    select(ed, posAfter(ed, 'c'));
    ed.commands.setHardBreak();
    ed.commands.insertContent('more');
    select(ed, posAfter(ed, 'c'), posAfter(ed, 'more'));
    ed.chain().toggleItalic().run();
    expectReadsBack(ed, '| a | b |\n| --- | --- |\n| c<br>*more* | d |\n');
  });

  it('bold across the break, where both lines are bold, stays one run', () => {
    const ed = load('one\ntwo');
    ed.chain().selectAll().toggleBold().run();
    expectReadsBack(ed, '**one\ntwo**');
  });
});

describe('bold, italic or strikethrough Markdown cannot read as a run (A26-11)', () => {
  const t = (text: string, ...marks: string[]): JSONContent => ({ type: 'text', text, marks: marks.map((type) => ({ type })) });
  const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });

  it.each<[string, JSONContent[], string]>([
    ['a note opening with bold "A)" before a letter', [p(t('A)', 'bold'), t('Answer'))], '<strong>A)</strong>Answer'],
    ['italic on one comma between letters', [p(t('a'), t(',', 'italic'), t('b'))], 'a<em>,</em>b'],
    ['bold "Name:" then italic "Aria"', [p(t('Name:', 'bold'), t('Aria', 'italic'))], '<strong>Name:</strong>*Aria*'],
    ['a note opening with bold "well-" before "known"', [p(t('well-', 'bold'), t('known'))], '<strong>well-</strong>known'],
    ['bold "Wow!" mid-line before a letter', [p(t('Say '), t('Wow!', 'bold'), t('yes'))], 'Say <strong>Wow!</strong>yes'],
    ['strikethrough "old," before a letter', [p(t('old,', 'strike'), t('new'))], '<s>old,</s>new'],
    ['italic on an em dash between letters', [p(t('before'), t('—', 'italic'), t('after'))], 'before<em>—</em>after'],
    ['a list item opening with bold "Name:" before a letter', [{ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('Name:', 'bold'), t('Aria'))] }] }], '- <strong>Name:</strong>Aria'],
    // Runs Markdown reads as they are stay Markdown.
    ['bold "Name:" then a space', [p(t('Name:', 'bold'), t(' Aria'))], '**Name:** Aria'],
    ['bold word then letters', [p(t('Kasai', 'bold'), t('san'))], '**Kasai**san'],
    // `***` between them could open and close, which Markdown may pair either way.
    ['bold then italic, both words', [p(t('bold', 'bold'), t('italic', 'italic'))], '<strong>bold</strong>*italic*'],
    // The second `*` sits between two letters, so it could close too, and
    // with the bold still open Markdown reads it as closing.
    ['bold throughout, italic on its first and last letters', [p(t('A', 'bold', 'italic'), t('b', 'bold'), t('c', 'bold', 'italic'))], '***A*b<em>c</em>**'],
    [
      'underlined bold, then italic, then both',
      [p(t('A', 'bold', 'underline'), t('b', 'italic', 'underline'), t('c', 'bold', 'italic', 'underline'))],
      '<strong><u>A</u></strong>*<u>b</u><strong><u>c</u></strong>*',
    ],
  ])('%s', (_name, content, saved) => {
    const ed = load('x');
    ed.commands.setContent({ type: 'doc', content });
    expectReadsBack(ed, saved);
  });
});

describe('a numbered-looking line after a line break (A26-12)', () => {
  it.each([
    ['01. Arrival', 'Chapters:\\\n01\\. Arrival'],
    ['001) x', 'Chapters:\\\n001\\) x'],
    ['01) x', 'Chapters:\\\n01\\) x'],
    // Only a number worth 1 can start a list under a line of text.
    ['0. zero', 'Chapters:\\\n0. zero'],
    ['02. Departure', 'Chapters:\\\n02. Departure'],
  ])('Shift+Enter, then "%s"', (typed, saved) => {
    const ed = load('Chapters:');
    ed.commands.focus('end');
    ed.commands.setHardBreak();
    typeText(ed, typed);
    expectReadsBack(ed, saved);
  });

  it('a one-line-per-thought line edited to start with "01. "', () => {
    const ed = load('Chapters:\nArrival');
    const at = posAfter(ed, 'Arrival') - 'Arrival'.length;
    ed.view.dispatch(ed.state.tr.insertText('01. ', at, at));
    expectReadsBack(ed, 'Chapters:\n01\\. Arrival');
  });
});

describe('a one-line-per-thought paragraph made into code (A26-22)', () => {
  it('from the toolbar keeps its lines', () => {
    const ed = load('one\ntwo\nthree');
    select(ed, posAfter(ed, 'one'));
    ed.chain().toggleCodeBlock().run();
    expect(ed.state.doc.firstChild?.textContent).toBe('one\ntwo\nthree');
    expectReadsBack(ed, '```\none\ntwo\nthree\n```');
  });

  it('by typing a fence at its start keeps its lines', () => {
    const ed = load('one\ntwo');
    select(ed, 1);
    typeText(ed, '``` ');
    expect(ed.state.doc.firstChild?.type.name).toBe('codeBlock');
    expect(ed.state.doc.firstChild?.textContent).toBe('one\ntwo');
  });

  it('toggling code off leaves the lines as hard breaks, as before', () => {
    const ed = load('```\none\ntwo\n```');
    select(ed, 2);
    ed.chain().toggleCodeBlock().run();
    expectReadsBack(ed, 'one\\\ntwo');
  });

  it('in a list item keeps its lines', () => {
    const ed = load('- one\n  two');
    select(ed, posAfter(ed, 'one'));
    ed.chain().toggleCodeBlock().run();
    expect(editorMarkdown(ed)).toBe('```\none\ntwo\n```');
  });
});

describe('a nested numbered list that does not start at 1 (A26-23)', () => {
  it('right under its item\'s text, the list is written loose so it stays a list', () => {
    const ed = load('x');
    const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    ed.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [p('parent'), { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p('child')] }] }],
        }],
      }],
    });
    const rb = readBack(ed);
    expect(rb.md).toBe('- parent\n\n  3. child');
    expect(rb.lossy).toBe(false);
    expect(rb.again).toBe(rb.md);
    const item = load(rb.md).state.doc.firstChild?.firstChild;
    expect([item?.child(0).type.name, item?.child(1).type.name]).toEqual(['paragraph', 'orderedList']);
    expect(item?.child(1).attrs.start).toBe(3);
  });

  it('starting at 1 it stays tight', () => {
    const ed = load('- parent\n  1. child');
    expectReadsBack(ed, '- parent\n  1. child');
  });
});
