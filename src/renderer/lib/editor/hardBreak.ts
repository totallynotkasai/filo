import { HardBreak } from '@tiptap/extension-hard-break';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { writeLineBreak, type BreakSerializeState } from './softBreak';

/**
 * A line break (Shift+Enter) as it is written to the file.
 *
 * In running text it is Markdown's `\` at the end of the line. A heading and
 * a table cell are one line each in Markdown, so there the break is written
 * as `<br>`; written as `\` and a new line, a break in a heading ended the
 * heading, and the rest reopened as a paragraph. A break with nothing after
 * it in its block shows nothing and isn't written (`writeLineBreak`, shared
 * with the soft break a file's single newline loads as).
 */

export const FiloHardBreak = HardBreak.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: BreakSerializeState, _node: ProseMirrorNode, parent: ProseMirrorNode, index: number): void {
          writeLineBreak(state, parent, index, false);
        },
        parse: {},
      },
    };
  },
});
