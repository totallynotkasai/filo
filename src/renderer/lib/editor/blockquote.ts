import { Blockquote } from '@tiptap/extension-blockquote';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * A quote as it is written to the file.
 *
 * An empty paragraph inside a quote has no Markdown form and is written as
 * nothing, but as the quote's first block it still left a bare `>` line
 * behind, which Markdown drops: the note reopened different, and read-only.
 * The quote is written without its empty paragraphs, which is what every
 * other position already wrote.
 */

interface QuoteSerializeState {
  wrapBlock(delim: string, firstDelim: string | null, node: ProseMirrorNode, f: () => void): void;
  renderContent(parent: ProseMirrorNode): void;
}

function isEmptyParagraph(node: ProseMirrorNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

export const FiloBlockquote = Blockquote.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: QuoteSerializeState, node: ProseMirrorNode): void {
          const kept: ProseMirrorNode[] = [];
          node.forEach((child) => {
            if (!isEmptyParagraph(child)) kept.push(child);
          });
          const written = kept.length > 0 && kept.length < node.childCount ? node.copy(Fragment.fromArray(kept)) : node;
          state.wrapBlock('> ', null, node, () => state.renderContent(written));
        },
        parse: {},
      },
    };
  },
});
