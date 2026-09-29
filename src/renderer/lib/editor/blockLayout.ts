/**
 * blockLayout — how a paragraph or heading with alignment or indent is saved.
 *
 * Markdown has no syntax for "centred" or "indented", so such a block is
 * written as one line of HTML, the way the note would render it:
 *
 *     <p style="text-align: center; margin-left: 48px">Some <strong>bold</strong></p>
 *
 * A Markdown parser doesn't read Markdown inside a block-level HTML tag, so the
 * block's inline formatting is written as HTML too. Only blocks that carry a
 * layout are written this way; every other block stays plain Markdown. On load,
 * markdown-it passes the line through as an HTML block and the editor's schema
 * reads the `text-align` / `margin-left` styles back (TextAlign and Indent
 * `parseHTML`).
 *
 * DECISION: the user chose to keep the alignment and indent buttons, accepting
 * that those paragraphs are HTML in the file (KNOWN_LIMITATIONS #17).
 */
import { getHTMLFromFragment } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { withLeadSpaceNodes } from './leadSpace';

/** True when `node` (a paragraph or heading) is aligned or indented. */
export function hasBlockLayout(node: ProseMirrorNode): boolean {
  const align: unknown = node.attrs.textAlign;
  const indent: unknown = node.attrs.indent;
  return (typeof align === 'string' && align !== 'left') || (typeof indent === 'number' && indent > 0);
}

/** `node` as one line of HTML, with its alignment and indent as inline styles. */
export function blockLayoutHtml(node: ProseMirrorNode): string {
  // A leading space is kept as the lead-space span (`leadSpace.ts`).
  const html = getHTMLFromFragment(Fragment.from(withLeadSpaceNodes(node)), node.type.schema);
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  // Link's rendering attributes are for the live editor, not the file.
  for (const a of Array.from(body.querySelectorAll('a'))) {
    for (const attr of ['target', 'rel', 'class']) a.removeAttribute(attr);
  }
  // A tab is a plain tab character in the file; loading turns it back into
  // the editor's tab item (`tabNode.ts`).
  for (const tab of Array.from(body.querySelectorAll('span[data-filo-tab]'))) {
    tab.replaceWith(body.ownerDocument.createTextNode('\t'));
  }
  return body.innerHTML.replace(/\r?\n/g, ' ');
}
