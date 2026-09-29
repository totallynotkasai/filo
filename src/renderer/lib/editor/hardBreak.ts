import { HardBreak } from '@tiptap/extension-hard-break';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * A line break (Shift+Enter) as it is written to the file.
 *
 * In running text it is Markdown's `\` at the end of the line. A heading and
 * a table cell are one line each in Markdown, so there the break is written
 * as `<br>`; written as `\` and a new line, a break in a heading ended the
 * heading, and the rest reopened as a paragraph. A break with nothing after
 * it in its block shows nothing and isn't written.
 */

interface BreakSerializeState {
  inTable?: boolean;
  write(content?: string): void;
}

export const FiloHardBreak = HardBreak.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: BreakSerializeState, node: ProseMirrorNode, parent: ProseMirrorNode, index: number): void {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type === node.type) continue;
            if (state.inTable || parent.type.name === 'heading') {
              state.write('<br>');
              return;
            }
            state.write('\\\n');
            // Start the next line now (a quote's `> `, a list's indent). Left
            // to the next write, a bold, italic or strikethrough run opening
            // that line records its start before the prefix, and
            // tiptap-markdown's delimiter tidy then cut the `> ` out.
            state.write();
            return;
          }
        },
        parse: {},
      },
    };
  },
});
