import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Formatting words one by one inside a bold or italic phrase, then saving and
 * reopening. Colouring "Aria" red and "Kasai" blue inside a bold "Aria Kasai"
 * left a bold-only space between them, which the save wrote inside the red
 * span: the note reopened read-only. Making a word bold with the space after
 * it, inside an underlined or highlighted phrase, left a gap in the
 * underline or highlight on reopen.
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

/** Selects the first `needle` in the note's text, across marks. */
function select(ed: Editor, needle: string): void {
  let text = '';
  const pos: number[] = [];
  ed.state.doc.descendants((node, p) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        text += node.text[i];
        pos.push(p + i);
      }
    }
    return true;
  });
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no "${needle}" in the note`);
  ed.commands.setTextSelection({ from: pos[at]!, to: pos[at + needle.length - 1]! + 1 });
}

/** Saves, reopens, and checks the reopened note is editable and saves the same bytes. */
function saveAndReopen(ed: Editor): Editor {
  const disk = editorMarkdown(ed);
  const reopened = makeEditor();
  const { lossy } = loadMarkdownIntoEditor(reopened, disk);
  expect({ disk, lossy }).toEqual({ disk, lossy: false });
  expect(editorMarkdown(reopened)).toBe(disk);
  return reopened;
}

/** The mark names on each character of `text` in the note. */
function marksAlong(ed: Editor, text: string): string[] {
  const out: string[] = [];
  let all = '';
  const marks: string[] = [];
  ed.state.doc.descendants((node: ProseMirrorNode) => {
    if (node.isText && node.text) {
      for (const ch of node.text) {
        all += ch;
        marks.push(node.marks.map((m) => m.type.name).sort().join('+'));
      }
    }
    return true;
  });
  const at = all.indexOf(text);
  for (let i = 0; i < text.length; i++) out.push(marks[at + i] ?? '');
  return out;
}

describe('words formatted one by one inside a bold or italic phrase', () => {
  it('a bold name in two colours reopens editable, each word in its colour', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Allies: Aria Kasai today');
    select(ed, 'Aria Kasai');
    ed.chain().toggleBold().run();
    select(ed, 'Aria');
    ed.chain().setColor('#e03e3e').run();
    select(ed, 'Kasai');
    ed.chain().setColor('#3f51b5').run();
    const reopened = saveAndReopen(ed);
    expect(marksAlong(reopened, 'Aria')).toEqual(Array(4).fill('bold+textStyle'));
    expect(marksAlong(reopened, 'Kasai')).toEqual(Array(5).fill('bold+textStyle'));
  });

  it('an italic thought with one word coloured and the next made bigger reopens editable', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'She thought: never again, not ever.');
    select(ed, 'never again, not ever.');
    ed.chain().toggleItalic().run();
    select(ed, 'never');
    ed.chain().setColor('#e03e3e').run();
    select(ed, 'again,');
    ed.chain().setMark('textStyle', { fontSize: '20px' }).run();
    saveAndReopen(ed);
  });

  it('a bold phrase with one word coloured and the next highlighted reopens editable', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'The sword of dawn lies here');
    select(ed, 'sword of dawn');
    ed.chain().toggleBold().run();
    select(ed, 'of');
    ed.chain().setColor('#e03e3e').run();
    select(ed, 'dawn');
    ed.chain().setHighlight({ color: '#ffe066' }).run();
    const reopened = saveAndReopen(ed);
    expect(marksAlong(reopened, 'dawn')).toEqual(Array(4).fill('bold+highlight'));
  });

  it('a struck phrase with two coloured words reopens editable', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Cut: old plan here');
    select(ed, 'old plan');
    ed.chain().toggleStrike().run();
    select(ed, 'old');
    ed.chain().setColor('#e03e3e').run();
    select(ed, 'plan');
    ed.chain().setColor('#3f51b5').run();
    saveAndReopen(ed);
  });
});

describe('a word made bold with the space after it (a double-click selection)', () => {
  for (const [name, apply, mark] of [
    ['underlined', (e: Editor) => e.chain().toggleUnderline().run(), 'underline'],
    ['highlighted', (e: Editor) => e.chain().setHighlight({ color: '#ffe066' }).run(), 'highlight'],
  ] as const) {
    it(`inside an ${name} phrase leaves no gap in it`, () => {
      const ed = makeEditor();
      loadMarkdownIntoEditor(ed, 'Note: one two three end');
      select(ed, 'one two three');
      apply(ed);
      select(ed, 'two ');
      ed.chain().toggleBold().run();
      const reopened = saveAndReopen(ed);
      // Every character of the phrase keeps the mark; "two" is also bold.
      expect(marksAlong(reopened, 'one two three').every((m) => m.split('+').includes(mark))).toBe(true);
      expect(marksAlong(reopened, 'two')).toEqual(Array(3).fill(['bold', mark].sort().join('+')));
    });
  }
});
