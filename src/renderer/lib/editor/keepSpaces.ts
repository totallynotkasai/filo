/**
 * Keeps runs of spaces in a note's text when it loads.
 *
 * ProseMirror's default parse collapses every whitespace run to one space, so
 * `end.  Next` loaded as `end. Next`, the note no longer matched its file and
 * opened read-only. The load therefore parses with `preserveWhitespace: true`
 * (`loadMarkdownIntoEditor`). Kept whitespace would also keep what the default
 * parse is right to drop, so before the parse this pass tidies the HTML that
 * markdown-it rendered:
 *  - a newline left in the text (inside HTML the note holds as HTML) becomes
 *    one space, as a browser shows it; left as a newline, it would load as a
 *    hard break. A soft line break in Markdown never gets here: it loads as
 *    its own node (`softBreak.ts`);
 *  - whitespace at the start or end of a block's text (the space after a task
 *    item's checkbox, the newline before a nested list) is dropped.
 * Code blocks keep every character.
 */
import { Extension } from '@tiptap/core';

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE',
  'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TR', 'PRE', 'DIV', 'HR',
]);

function isBlock(node: Node | null): boolean {
  return node instanceof Element && BLOCK_TAGS.has(node.tagName);
}

/** The sibling next to `node` on one side, skipping a task item's checkbox. */
function neighbour(node: Node, side: 'previous' | 'next'): Node | null {
  let n = side === 'previous' ? node.previousSibling : node.nextSibling;
  while (n instanceof HTMLInputElement) n = side === 'previous' ? n.previousSibling : n.nextSibling;
  return n;
}

export function tidyParsedWhitespace(root: Element): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const text of texts) {
    if (text.parentElement?.closest('pre')) continue;
    let value = text.data;
    const inBlock = isBlock(text.parentNode);
    const prev = neighbour(text, 'previous');
    const next = neighbour(text, 'next');
    // Tabs are left alone: they are the note's own tab characters, which the
    // Tab node (`tabNode.ts`) turns into its own items after this pass.
    if (inBlock && (prev === null || isBlock(prev))) value = value.replace(/^[ \r\n]+/, '');
    if (inBlock && (next === null || isBlock(next))) value = value.replace(/[ \r\n]+$/, '');
    value = value.replace(/ *(?:\r\n|\r|\n) */g, ' ');
    if (value !== text.data) text.data = value;
  }
}

/** Registers `tidyParsedWhitespace` with tiptap-markdown's parse. */
export const KeepSpaces = Extension.create({
  name: 'keepSpaces',
  addStorage() {
    return {
      markdown: {
        parse: {
          updateDOM(element: Element): void {
            tidyParsedWhitespace(element);
          },
        },
      },
    };
  },
});
