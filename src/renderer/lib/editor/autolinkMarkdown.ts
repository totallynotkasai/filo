import MarkdownIt from 'markdown-it';
import { Link } from '@tiptap/extension-link';
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { defaultMarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown';

/**
 * How a link whose text is its own address is written.
 *
 * prosemirror-markdown writes such a link as an autolink, `<https://…>`. But
 * Markdown shows an autolink's address decoded (`%20` as a space, a
 * punycode host in its own script), so a link typed or pasted as
 * `https://example.com/My%20File.pdf` reopened with different text, and
 * read-only. A link whose address Markdown would show differently is written
 * `[text](address)` instead.
 */

const LINK_SPEC = defaultMarkdownSerializer.marks.link ?? noLinkWriter();

function noLinkWriter(): never {
  throw new Error('prosemirror-markdown has no link writer to build on');
}

/** Only used for its link-text normalisation, which reads no options. */
const renderer = new MarkdownIt();

/** True when Markdown shows `href`, written as an autolink, exactly as written. */
export function autolinkShowsAsWritten(href: string): boolean {
  return renderer.normalizeLinkText(href) === href;
}

/** The serializer state's autolink flag, set by the link's opening and read by its text and closing. */
type AutolinkState = MarkdownSerializerState & { inAutolink?: boolean };

function openLink(state: MarkdownSerializerState, mark: Mark, parent: ProseMirrorNode, index: number): string {
  const open = typeof LINK_SPEC.open === 'string' ? LINK_SPEC.open : LINK_SPEC.open(state, mark, parent, index);
  if (open !== '<' || autolinkShowsAsWritten(String(mark.attrs.href))) return open;
  (state as AutolinkState).inAutolink = false;
  return '[';
}

/** TipTap's Link, written as above. */
export const FiloLink = Link.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: { ...LINK_SPEC, open: openLink },
        parse: {},
      },
    };
  },
});
