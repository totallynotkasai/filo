import { describe, it, expect, afterEach } from 'vitest';
import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import {
  withBlockEndSpacesTrimmed,
  withLineEndSpacesDropped,
  withoutLineEndSpaces,
} from '../../renderer/lib/editor/lineEndSpaces';

/**
 * Spaces typed at the end of a line are left out of the file: Markdown drops
 * them there (or reads two before a newline as a line break), so the note
 * reopened different and its next save wrote different bytes.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function newEditor(content?: JSONContent): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  if (content) ed.commands.setContent(content);
  return ed;
}

const text = (t: string, ...marks: string[]): JSONContent => ({ type: 'text', text: t, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const soft: JSONContent = { type: 'softBreak' };
const hard: JSONContent = { type: 'hardBreak' };
const tab: JSONContent = { type: 'tab' };
const leadSpace: JSONContent = { type: 'leadSpace' };
const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });

/** `content` as a paragraph node of the editor's schema. */
function paragraph(...content: JSONContent[]): ProseMirrorNode {
  return newEditor().schema.nodeFromJSON(para(...content));
}

/** The inline children of `block`, as JSON. */
function kids(block: ProseMirrorNode): JSONContent[] {
  return (block.toJSON() as JSONContent).content ?? [];
}

/** `content` written as a note, read back and written again. */
function savedTwice(...blocks: JSONContent[]): { first: string; second: string; lossy: boolean } {
  const ed = newEditor({ type: 'doc', content: blocks });
  const first = editorMarkdown(ed);
  const { lossy } = loadMarkdownIntoEditor(ed, first);
  return { first, second: editorMarkdown(ed), lossy };
}

describe('withLineEndSpacesDropped', () => {
  it('drops the spaces ending a paragraph and each line before a soft break', () => {
    expect(kids(withLineEndSpacesDropped(paragraph(text('one  '), soft, text('two ')))))
      .toEqual([text('one'), soft, text('two')]);
  });

  it('drops them from a bold, italic or struck run too, whose delimiters push them out', () => {
    expect(kids(withLineEndSpacesDropped(paragraph(text('a'), text('b  ', 'bold')))))
      .toEqual([text('a'), text('b', 'bold')]);
  });

  it('keeps spaces a tag closes after, which Markdown keeps', () => {
    const block = paragraph(text('a  ', 'underline'), soft, text('b'));
    expect(withLineEndSpacesDropped(block)).toBe(block);
  });

  it('drops spaces inside a tag that stays open across the break', () => {
    const block = paragraph(text('a  ', 'underline'), { ...soft, marks: [{ type: 'underline' }] }, text('b', 'underline'));
    expect(kids(withLineEndSpacesDropped(block))[0]).toEqual(text('a', 'underline'));
  });

  it('drops a node left with nothing, so the tab before it ends the line', () => {
    expect(kids(withLineEndSpacesDropped(paragraph(text('a'), tab, text('   ')))))
      .toEqual([text('a'), tab]);
  });

  it('drops line breaks left at the end, which are not written', () => {
    expect(kids(withLineEndSpacesDropped(paragraph(text('a  '), hard, text(' ')))))
      .toEqual([text('a')]);
  });

  it('keeps spaces before a hard break, which writes `\\` after them', () => {
    const block = paragraph(text('a  '), hard, text('b'));
    expect(withLineEndSpacesDropped(block)).toBe(block);
  });

  it('leaves a line of only spaces as it is: its opening space is written `&#32;`', () => {
    const block = paragraph(text('   '));
    expect(withLineEndSpacesDropped(block)).toBe(block);
  });

  it('in a heading or table cell, keeps spaces before a soft break (written `<br>`)', () => {
    const block = paragraph(text('a  '), soft, text('b  '));
    expect(kids(withLineEndSpacesDropped(block, false))).toEqual([text('a  '), soft, text('b')]);
  });

  it('returns the block itself when nothing changes', () => {
    const block = paragraph(text('a'), soft, text('b'));
    expect(withLineEndSpacesDropped(block)).toBe(block);
  });
});

describe('withBlockEndSpacesTrimmed', () => {
  it('trims the plain spaces ending each paragraph of a block written as HTML', () => {
    const ed = newEditor();
    const quote = ed.schema.nodeFromJSON({ type: 'blockquote', content: [para(text('a  ')), para(text('b', 'bold'), text('c '))] });
    const trimmed = withBlockEndSpacesTrimmed(quote).toJSON() as JSONContent;
    expect(trimmed.content?.map((p) => p.content)).toEqual([[text('a')], [text('b', 'bold'), text('c')]]);
  });

  it('keeps spaces inside a tag, and a line of only spaces keeps one', () => {
    const marked = paragraph(text('a  ', 'underline'));
    expect(withBlockEndSpacesTrimmed(marked)).toBe(marked);
    expect(kids(withBlockEndSpacesTrimmed(paragraph(text('   '))))).toEqual([text(' ')]);
  });

  it('leaves code alone', () => {
    const code = newEditor().schema.nodeFromJSON({ type: 'codeBlock', content: [text('x  ')] });
    expect(withBlockEndSpacesTrimmed(code)).toBe(code);
  });
});

describe('withoutLineEndSpaces', () => {
  it('cuts the spaces before each line end, telling of each cut, the last first', () => {
    const cuts: [number, number][] = [];
    expect(withoutLineEndSpaces('a  \nb ', [3, 6, 3], (at, count) => cuts.push([at, count]))).toBe('a\nb');
    expect(cuts).toEqual([[5, 1], [1, 2]]);
  });

  it('keeps tabs, which Markdown keeps', () => {
    expect(withoutLineEndSpaces('a\t \nb', [3], () => {})).toBe('a\t\nb');
  });

  it('returns the text itself when no line ends in a space', () => {
    const md = 'a\nb';
    expect(withoutLineEndSpaces(md, [1, 3], () => {})).toBe(md);
  });
});

describe('a note with spaces typed at the end of a line', () => {
  it('is saved without them, and reopens to the same bytes', () => {
    const { first, second, lossy } = savedTwice(para(text('line one  '), soft, text('line two ')), para(text('next')));
    expect(first).toBe('line one\nline two\n\nnext');
    expect(second).toBe(first);
    expect(lossy).toBe(false);
  });

  it('ends the line with the tab typed before them, written so it reads back', () => {
    const { first, second, lossy } = savedTwice(para(text('a'), tab, text('  ')), para(text('b'), tab, text('  '), soft, text('c')));
    // At the paragraph's end the tab is written `&#9;`; before a newline Markdown keeps it.
    expect(first).toBe('a&#9;\n\nb\t\nc');
    expect(second).toBe(first);
    expect(lossy).toBe(false);
  });

  it('cut after the text is written, moves the bold runs that follow with the text', () => {
    // A space written mid-line by a lead space is cut only once the line is
    // written; the bold run after it still becomes `<strong>` where it stands.
    const { first, second } = savedTwice(para(text('x'), leadSpace, soft, text('a.', 'bold'), text('b')));
    expect(first).toBe('x\n<strong>a.</strong>b');
    expect(second).toBe(first);
  });

  it('keeps a line holding only a no-break space after a line break', () => {
    const nbsp = ' ';
    const { first, second, lossy } = savedTwice(para(soft, text(nbsp)), para(text('a'), soft, text(nbsp)), para(text('z')));
    expect(first).toBe(`<br data-filo-soft-break>&#160;\n\na\n${nbsp}\n\nz`);
    expect(second).toBe(first);
    expect(lossy).toBe(false);
  });
});
