import { Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * The editor's text node, with the Markdown escaping a note's text needs.
 *
 * tiptap-markdown escapes `<` and `>` in text, but not `&`. Typed text such
 * as `&amp;` or `&copy;` was then saved as-is, and markdown-it read it back as
 * the character it names (`&`, `©`): the note changed meaning on reopen. An
 * `&` that starts a character reference is written as `&amp;`, which reads
 * back as the `&` that was typed. Any other `&` stays as it is.
 */

interface TextSerializeState {
  text(text: string, escape?: boolean): void;
  inAutolink?: boolean;
}

/** `&` followed by what markdown-it would read as a named or numeric character reference. */
const CHARACTER_REFERENCE = /&(?=(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)/g;

/** Text as it is written to the file, before prosemirror-markdown's own escaping. */
export function escapeNoteText(text: string, inAutolink = false): string {
  // The reference escape runs first, so the `&` of the `&lt;` added below stays.
  const refsKept = inAutolink ? text : text.replace(CHARACTER_REFERENCE, '&amp;');
  return refsKept.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const NoteText = Node.create({
  name: 'text',
  group: 'inline',

  addStorage() {
    return {
      markdown: {
        serialize(state: TextSerializeState, node: ProseMirrorNode): void {
          // An autolink's text is its URL, where `&…;` is part of the address.
          state.text(escapeNoteText(node.text ?? '', state.inAutolink === true));
        },
        parse: {},
      },
    };
  },
});
