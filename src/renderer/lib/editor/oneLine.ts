import { Extension, Node } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * A title or label is one line: a tile's, a card's or a frame's title, and a
 * connection's label. Its editor holds one paragraph, and whatever would make
 * it two (Enter, a pasted line break or paragraph, a title saved over two
 * paragraphs) is refused or joined with a space. A paste put a newline into a
 * note's `title:`, and the placeholder rename then named the file
 * `Chapter One--The River.md`.
 */

/** One paragraph, and nothing else. */
export const OneLineDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: 'paragraph',
});

/**
 * Enter (with Shift or Ctrl too) does nothing in the editor, so the host's
 * keydown handler commits the text as it is; the editor's own Enter ran first
 * and split the title in two ("Chap" and "ter One"). ProseMirror runs no
 * keymap while an IME is composing, so the Enter that confirms a composition
 * stays the IME's.
 */
export const OneLineEnter = Extension.create({
  name: 'filoOneLineEnter',
  priority: 1000,

  addKeyboardShortcuts() {
    const nothing = (): boolean => true;
    return { Enter: nothing, 'Shift-Enter': nothing, 'Mod-Enter': nothing };
  },
});

/** Line breaks in pasted plain text, with the spaces around them. */
const TEXT_LINE_BREAKS = /[ \t]*(?:\r\n?|\n)+[ \t]*/g;

/** `nodes` with each line break made a space. */
function breaksAsSpaces(nodes: readonly ProseMirrorNode[], schema: Schema): ProseMirrorNode[] {
  return nodes.map((node) => (node.type.name === 'hardBreak' ? schema.text(' ', node.marks) : node));
}

/**
 * `slice` as one line: the inline content of its blocks joined with a space,
 * each line break a space, formatting kept. Returns `slice` itself when it is
 * one line already.
 */
export function oneLineSlice(slice: Slice, schema: Schema): Slice {
  let blocks = 0;
  let breaks = 0;
  slice.content.descendants((node) => {
    if (node.isTextblock) blocks++;
    if (node.type.name === 'hardBreak') breaks++;
    return true;
  });
  if (blocks <= 1 && breaks === 0) return slice;
  const top: ProseMirrorNode[] = [];
  slice.content.forEach((node) => top.push(node));
  // Inline content only: a slice of one line's text.
  if (blocks === 0) return new Slice(Fragment.fromArray(breaksAsSpaces(top, schema)), slice.openStart, slice.openEnd);
  const inline: ProseMirrorNode[] = [];
  slice.content.descendants((node) => {
    if (!node.isTextblock) return true;
    if (inline.length > 0 && node.content.size > 0) inline.push(schema.text(' '));
    const children: ProseMirrorNode[] = [];
    node.forEach((child) => children.push(child));
    inline.push(...breaksAsSpaces(children, schema));
    return false;
  });
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) return slice;
  return new Slice(Fragment.from(paragraph.create(null, inline)), 1, 1);
}

/** Pasted text and content as one line. */
export const OneLinePaste = Extension.create({
  name: 'filoOneLinePaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('filoOneLinePaste'),
        props: {
          transformPastedText: (text: string) => text.replace(TEXT_LINE_BREAKS, ' '),
          transformPasted: (slice: Slice, view) => oneLineSlice(slice, view.state.schema),
        },
      }),
    ];
  },
});

/**
 * `html` (a saved title or label) as one paragraph: its blocks' contents
 * joined with a space, each `<br>` a space. A one-paragraph document would
 * otherwise drop every paragraph after the first, and the title's words with
 * them.
 */
export function oneLineHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  const breaks = root.querySelectorAll('br');
  for (const br of Array.from(breaks)) br.replaceWith(' ');
  const blocks = Array.from(root.children);
  if (blocks.length <= 1) return breaks.length > 0 ? template.innerHTML : html;
  return `<p>${blocks.map((el) => el.innerHTML.trim()).filter((s) => s.length > 0).join(' ')}</p>`;
}
